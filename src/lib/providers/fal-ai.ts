/**
 * fal.ai Provider implementation
 * Built on the fal.ai REST API, supporting a wide range of image and video generation models
 * API docs: https://fal.ai/docs
 */

import { BaseProvider, ProviderError } from './base'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'
import { buildFalImageRequest } from './fal-image-params'
import {
  getFalVideoSpec,
  falFrameSibling,
  nearestFalAspectRatio,
  nearestFalDuration,
  nearestFalResolution,
  type FalVideoSpec,
} from './fal-video-params'

// ==================== fal.ai API response types ====================

interface FalSubmitResponse {
  request_id: string
  [key: string]: unknown
}

interface FalStatusResponse {
  request_id: string
  status: string
  progress?: number
  response_url?: string
  [key: string]: unknown
}

interface FalResultResponse {
  images?: Array<{ url: string; width?: number; height?: number }>
  video?: { url: string; content_type?: string }
  videos?: Array<{ url: string }>
  seed?: number
  timings?: { inference?: number }
  [key: string]: unknown
}

/**
 * Exact queue URLs fal returned for a request id, captured at submit time.
 *
 * fal's response/status URLs are authoritative — for `fal-ai/flux/schnell` fal answers with
 * `fal-ai/flux/requests/<id>`, i.e. the app path, not the endpoint path. They are handed back
 * once, at submit, so remember them for the life of the process; a restarted server falls back to
 * the derivation below, which is correct for every app fal currently exposes.
 */
const falQueueUrls = new Map<string, { statusUrl?: string; responseUrl?: string }>()

function rememberFalQueueUrls(requestId: string, payload: { status_url?: unknown; response_url?: unknown }): void {
  if (!requestId) return
  falQueueUrls.set(requestId, {
    statusUrl: typeof payload.status_url === 'string' ? payload.status_url : undefined,
    responseUrl: typeof payload.response_url === 'string' ? payload.response_url : undefined,
  })
  if (falQueueUrls.size > 500) {
    // bounded: drop the oldest entries so a long-lived process cannot grow without limit
    for (const key of falQueueUrls.keys()) {
      falQueueUrls.delete(key)
      if (falQueueUrls.size <= 400) break
    }
  }
}

// ==================== request building ====================

/** fal's storage control plane (upload staging) is a separate host from the model queue. */
const FAL_STORAGE_BASE = 'https://rest.alpha.fal.ai'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
}

/**
 * fal's queue endpoints live under the APP path, not the full endpoint id.
 *
 * A submit to `fal-ai/flux/schnell` answers:
 *   status_url = https://queue.fal.run/fal-ai/flux/requests/<id>/status
 * i.e. only the first two path segments (owner/app) are part of the request URL. Polling the full
 * endpoint id answers 405 Method Not Allowed, which surfaced as "任务状态查询连续失败 5 次" for
 * every fal model with a variant path (nearly all of them) — the submission was billed, then
 * every poll was rejected.
 */
export function falQueueAppPath(modelId: string): string {
  const segments = modelId.split('/').filter(Boolean)
  // Router-style apps own a third segment: the queue serves /workflows/<name>/requests/... and
  // /comfy/<name>/requests/..., not /workflows/requests/... (same rule as the Go router in
  // axiom-azimo: applicationSegments = 2, 3 for workflows/comfy).
  const applicationSegments = segments[0] === 'workflows' || segments[0] === 'comfy' ? 3 : 2
  return segments.slice(0, applicationSegments).join('/')
}

function mimeTypeForFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/**
 * Build the endpoint-specific request body for a fal video model.
 *
 * Exported for tests: the frame/reference field names differ per family and a wrong name is
 * dropped upstream, so this mapping is the part worth pinning down.
 */
export function buildFalVideoRequest(options: VideoOptions): {
  modelId: string
  body: Record<string, unknown>
} {
  // models that support audio can describe it directly in the prompt
  let prompt = options.prompt
  if (options.audioEnabled && options.voiceover) {
    prompt = `${options.prompt}. The narrator says: "${options.voiceover}"`
  }

  // remap to the sibling endpoint when the frames we have do not fit this one
  const modelId = falFrameSibling(options.modelId, Boolean(options.firstFrameUrl)) ?? options.modelId
  const spec: FalVideoSpec = getFalVideoSpec(modelId)

  if (options.firstFrameUrl && !spec.firstFrame) {
    // Silently dropping the keyframe would turn an image-to-video shot into a text-to-video one
    // that no longer matches the storyboard.
    throw new Error(
      `模型 ${modelId} 是文生视频端点，不接受首帧图；请改用同档位的图生视频端点（.../image-to-video）。` +
        ' 否则这一镜会退化成纯文字生成，和分镜画面不一致。'
    )
  }

  const snappedDuration = nearestFalDuration(options.duration, spec.durations) ?? options.duration
  // endpoints that publish min/max instead of an enum (Hailuo 3.0: 5-15s) still need a legal value
  const duration =
    spec.durationRange && snappedDuration != null
      ? Math.min(Math.max(snappedDuration, spec.durationRange[0]), spec.durationRange[1])
      : snappedDuration
  const referenceImages = options.referenceImageUrls?.length ? options.referenceImageUrls : undefined
  const referenceVideos = options.referenceVideoUrls?.length ? options.referenceVideoUrls : undefined
  const referenceAudios = options.referenceAudioUrls?.length ? options.referenceAudioUrls : undefined

  const body: Record<string, unknown> = {
    prompt,
    negative_prompt: options.negativePrompt,
    seed: options.seed,
    ...(spec.usesResolution && {
      resolution: nearestFalResolution(options.width, options.height, spec.resolutions),
    }),
    ...(spec.usesAspectRatio && {
      aspect_ratio: nearestFalAspectRatio(options.width, options.height),
    }),
    ...(duration != null && { duration: spec.durationAsString ? `${duration}s` : duration }),
    // first/last frame: the field name is per family — never assume image_url
    ...(options.firstFrameUrl && spec.firstFrame && { [spec.firstFrame]: options.firstFrameUrl }),
    ...(options.lastFrameUrl && spec.lastFrame && { [spec.lastFrame]: options.lastFrameUrl }),
    // multimodal reference packs
    ...(referenceImages && spec.referenceImages && { [spec.referenceImages]: referenceImages }),
    ...(referenceVideos && spec.referenceVideos && { [spec.referenceVideos]: referenceVideos }),
    ...(referenceAudios && spec.referenceAudio && { [spec.referenceAudio]: referenceAudios }),
    ...(spec.referenceTask && { task: spec.referenceTask }),
    // legacy single reference video, only when the endpoint has no reference-video array
    ...(options.referenceVideoUrl && !spec.referenceVideos && { video_url: options.referenceVideoUrl }),
    ...(spec.audio && options.audioEnabled != null && { [spec.audio]: Boolean(options.audioEnabled) }),
    ...(spec.usesGuidanceScale && options.guidanceScale != null && {
      guidance_scale: options.guidanceScale,
    }),
    ...options.extra,
  }

  // drop undefined so fal never sees an explicit null it would reject
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key]
  }

  return { modelId, body }
}

// ==================== Provider implementation ====================

export class FalAIProvider extends BaseProvider {
  readonly name = 'fal-ai'
  readonly displayName = 'fal.ai'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://queue.fal.run',
    })
  }

  /**
   * Get authentication headers - fal.ai uses Key authentication
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Key ${this.config.apiKey}`,
    }
  }

  /**
   * Generate an image (submit + poll).
   * The request body is derived from the endpoint's own schema — see fal-image-params.ts.
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    // Build strictly from the endpoint's schema: the fal image families disagree on both the
    // image_size shape (object vs preset vs three literal strings) and on whether seed /
    // negative_prompt / num_images exist at all.
    const { body } = buildFalImageRequest({
      modelId: options.modelId,
      prompt: options.prompt,
      width: options.width,
      height: options.height,
      count: options.count,
      seed: options.seed,
      steps: options.steps,
      guidanceScale: options.guidanceScale,
      negativePrompt: options.negativePrompt,
      referenceImageUrl: options.referenceImageUrl,
      referenceImageUrls: options.referenceImageUrls,
      extra: options.extra,
    })

    // submit async task
    const submitResponse = await this.request<FalSubmitResponse>(
      `/${options.modelId}`,
      { method: 'POST', body }
    )

    // guard: submit occasionally returns no request_id; without this, taskId becomes "model::undefined",
    // parseTaskId does not throw, but the subsequent status endpoint returns 404
    if (!submitResponse.request_id) {
      throw new ProviderError('未返回请求ID', 'NO_REQUEST_ID', this.name)
    }
    rememberFalQueueUrls(submitResponse.request_id, submitResponse as never)
    // getTaskStatus needs the "modelId::requestId" format to locate the query endpoint; assemble it here before polling
    const taskId = `${options.modelId}::${submitResponse.request_id}`
    const finalStatus = await this.pollTaskStatus(taskId, {
      interval: 2000,
    })

    return this.requireResult(finalStatus.result) as ImageResult
  }

  /**
   * Generate a video (submit + wait).
   * Prefer submitVideoTask + waitForTask when the caller persists the task id first.
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options)
    const finalStatus = await this.waitForTask(taskId, { interval: 5000 })
    return this.requireResult(finalStatus.result) as VideoResult
  }

  /**
   * Submit a video task without waiting for the result (two-phase mode).
   *
   * The body is built from the endpoint's own schema (buildFalVideoRequest): fal rejects or
   * silently drops fields that do not belong to the target model, which is how first/last-frame
   * chaining and product-reference packs break when one generic body is reused across families.
   * The model is remapped to its sibling endpoint BEFORE the billable call when the frames we
   * have do not match the endpoint (e.g. a text-to-video id with a first frame supplied).
   */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const { modelId, body } = buildFalVideoRequest(options)
    const submitResponse = await this.request<FalSubmitResponse>(`/${modelId}`, {
      method: 'POST',
      body,
    })

    // guard: submit occasionally returns no request_id; without this, taskId becomes "model::undefined",
    // parseTaskId does not throw, but the subsequent status endpoint returns 404
    if (!submitResponse.request_id) {
      throw new ProviderError('未返回请求ID', 'NO_REQUEST_ID', this.name)
    }
    rememberFalQueueUrls(submitResponse.request_id, submitResponse as never)
    // getTaskStatus needs the "modelId::requestId" format to locate the query endpoint
    return { taskId: `${modelId}::${submitResponse.request_id}`, modelId }
  }

  /**
   * Upload a local file to fal's CDN and return its public URL.
   *
   * fal accepts binary inputs (reference video/audio, chained frames read from the project
   * workspace) by URL only. Per the fal Storage API: POST /storage/upload/initiate returns a
   * short-lived signed URL plus the final CDN URL, then the bytes are PUT to the signed URL.
   * The storage control plane lives on a different host than the model queue, so it does not go
   * through this.request (which prefixes the queue baseUrl).
   */
  async uploadLocalMedia(filePath: string): Promise<string> {
    const { readFile } = await import('fs/promises')
    const { basename } = await import('path')
    const bytes = await readFile(filePath)
    const fileName = basename(filePath)
    const contentType = mimeTypeForFile(fileName)

    const initiated = await fetch(`${FAL_STORAGE_BASE}/storage/upload/initiate`, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    })
    if (!initiated.ok) {
      const text = await initiated.text().catch(() => '')
      throw new ProviderError(
        `参考素材上传失败: ${initiated.status} ${text.slice(0, 200)}`,
        'UPLOAD_FAILED',
        this.name,
        initiated.status
      )
    }
    const { upload_url: uploadUrl, file_url: fileUrl } = (await initiated.json()) as {
      upload_url?: string
      file_url?: string
    }
    if (!uploadUrl || !fileUrl) {
      throw new ProviderError('参考素材上传成功但未返回地址', 'UPLOAD_FAILED', this.name)
    }

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    })
    if (!put.ok) {
      const text = await put.text().catch(() => '')
      throw new ProviderError(
        `参考素材上传失败: ${put.status} ${text.slice(0, 200)}`,
        'UPLOAD_FAILED',
        this.name,
        put.status
      )
    }
    return fileUrl
  }

  /**
   * Query task status
   * fal.ai uses the queue API to poll status
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    // fal.ai taskId format: "modelId::requestId"
    const [modelId, requestId] = this.parseTaskId(taskId)
    // Queue polling hangs off the APP path, not the full endpoint id — see falQueueAppPath.
    const queuePath = falQueueAppPath(modelId)

    const statusResponse = await this.request<FalStatusResponse>(
      `/${queuePath}/requests/${requestId}/status`,
      {
        // use fal.ai status query baseUrl
        headers: {},
      }
    )

    const status = this.mapStatus(statusResponse.status)

    const taskStatus: TaskStatus = {
      taskId,
      status,
      progress: statusResponse.progress,
    }

    // fetch the result once the task completes
    if (status === 'completed') {
      // Prefer the URL fal itself handed back (at submit, or on this status response) — it is
      // authoritative. The derived app path is the fallback.
      const responseUrl =
        falQueueUrls.get(requestId)?.responseUrl ||
        (typeof statusResponse.response_url === 'string' ? statusResponse.response_url : '')
      // Result URL candidates, in the order fal's own behaviour proves out:
      //   1. `{app}/requests/{id}`            — what azimo's router uses and what fal returns
      //   2. `{app}/requests/{id}/response`   — the suffix printed in fal's async-inference docs
      //   3. the absolute response_url        — fal's authoritative pointer, when it is usable
      const derivedPath = `/${queuePath}/requests/${requestId}`
      const candidates: Array<() => Promise<FalResultResponse>> = [
        () => this.request<FalResultResponse>(derivedPath),
        () => this.request<FalResultResponse>(`${derivedPath}/response`),
        ...(responseUrl ? [() => this.fetchAbsolute<FalResultResponse>(responseUrl)] : []),
      ]
      let result: FalResultResponse | undefined
      let lastError: unknown
      for (const attempt of candidates) {
        try {
          result = await attempt()
          break
        } catch (error) {
          lastError = error
        }
      }
      if (!result) {
        throw new ProviderError(
          `取回结果失败（模型 ${modelId}）：fal 的队列接口没有返回可用结果（任务 ${requestId} 状态为 COMPLETED）。` +
            '该任务已在云端完成并计费，但结果地址不可用——请在设置里换一个生图/生视频模型后重试。' +
            `（最后一个错误：${lastError instanceof Error ? lastError.message : String(lastError)}）`,
          'RESULT_URL_REJECTED',
          this.name
        )
      }
      taskStatus.result = this.parseResult(taskId, result, modelId)
    }

    return taskStatus
  }

  /**
   * GET an absolute URL outside the configured baseUrl.
   * fal answers status queries with fully-qualified response URLs; following them keeps the
   * provider working even if the queue's path scheme changes.
   */
  private async fetchAbsolute<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { ...this.getAuthHeaders() } })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(
        `API 请求失败: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
        'API_ERROR',
        this.name,
        res.status
      )
    }
    return (await res.json()) as T
  }

  /**
   * Get the list of available models
   * fal.ai models are dynamic; this returns the commonly used ones
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    // model list verified against the fal.ai platform (2026-03)
    const models: Model[] = [
      // ==================== image generation ====================
      // OpenAI GPT Image 2.5 — Flare is the speed tier, Sunburst the precision tier. Endpoint ids
      // verified against each endpoint's own OpenAPI; the /edit routes REQUIRE image_urls, and
      // quality is an enum (auto|low|medium|high|xhigh|max, default high).
      {
        id: 'openai/gpt-image-2.5/sunburst/text-to-image',
        name: 'GPT Image 2.5 Sunburst',
        description: 'OpenAI 图像旗舰（精度优先），提示词遵循与细节保真最强，商品主图/海报首选',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'openai/gpt-image-2.5/flare/text-to-image',
        name: 'GPT Image 2.5 Flare',
        description: 'OpenAI 图像旗舰（速度优先），适合批量出图与快速迭代',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'openai/gpt-image-2.5/sunburst/edit',
        name: 'GPT Image 2.5 Sunburst Edit',
        description: 'GPT Image 2.5 编辑（精度优先），基于参考图重绘/换背景，商品保真首选',
        modes: ['image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'openai/gpt-image-2.5/flare/edit',
        name: 'GPT Image 2.5 Flare Edit',
        description: 'GPT Image 2.5 编辑（速度优先），适合批量改图',
        modes: ['image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      // OpenAI GPT Image 2 (previous generation, kept so existing selections keep working)
      {
        id: 'openai/gpt-image-2',
        name: 'GPT Image 2',
        description: 'OpenAI 最新图像模型，强提示词遵循、构图与细节保真（带货商品主图首选）',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        // Verified against the endpoint's own OpenAPI: the edit route is `/edit`.
        // `openai/gpt-image-2/image-to-image` does not exist — submitting to it returned a request
        // id and a COMPLETED status, but its result URL 404s with "Path /image-to-image not found".
        id: 'openai/gpt-image-2/edit',
        name: 'GPT Image 2 Edit',
        description: 'GPT Image 2 编辑，精确局部重绘/扩图，适合商品保真',
        modes: ['image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      // kept for backward compatibility with the previous generation gpt-image-1.5
      {
        id: 'fal-ai/gpt-image-1.5',
        name: 'GPT Image 1.5',
        description: 'OpenAI 图像模型上一代，强提示词遵循',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/bytedance/seedream/v5/lite/edit',
        name: 'Seedream V5 Lite Edit',
        description: '字节 Seedream 智能图像编辑，多图融合，商品换背景/锁主体',
        modes: ['image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/flux/schnell',
        name: 'FLUX.1 [schnell]',
        description: '快速文生图，适合原型迭代',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/flux/dev',
        name: 'FLUX.1 [dev]',
        description: '高质量文生图模型',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/flux-pro/v1.1',
        name: 'FLUX.1 Pro v1.1',
        description: '专业级文生图',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/flux-2-pro',
        name: 'FLUX.2 [pro]',
        description: 'FLUX 第二代专业版',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'fal-ai/recraft/v4/pro/text-to-image',
        name: 'Recraft V4 Pro',
        description: '高质量设计风格生图',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },

      // ==================== video generation ====================
      // --- ByteDance Seedance 2.5 (flagship: 4-30s, native audio/speech; fal endpoint has no fal-ai/ prefix) ---
      // reference-to-video deliberately not listed: fal's variant needs a dedicated reference_image_urls
      // body this provider builds from the endpoint spec (see fal-video-params.ts)
      {
        id: 'bytedance/seedance-2.5/text-to-video',
        name: 'Seedance 2.5 (文生视频)',
        description: '字节旗舰视频模型，原生音频/人声，4-30秒',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'bytedance/seedance-2.5/image-to-video',
        name: 'Seedance 2.5 (图生视频)',
        description: '首帧/尾帧图生视频，原生音频/人声，4-30秒',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      // --- Kling series ---
      {
        id: 'fal-ai/kling-video/v3/pro/text-to-video',
        name: 'Kling 3.0 Pro (文生视频)',
        description: '可灵 3.0 Pro，支持原生音频、多分镜、人脸绑定',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'fal-ai/kling-video/v3/pro/image-to-video',
        name: 'Kling 3.0 Pro (图生视频)',
        description: '可灵 3.0 Pro 图生视频，支持原生音频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },

      // --- Google Veo series ---
      {
        id: 'fal-ai/veo3',
        name: 'Veo 3',
        description: 'Google Veo 3，原生对话/音效/环境音，支持唇形同步',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },

      // --- MiniMax Hailuo series ---
      {
        id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
        name: 'MiniMax Hailuo-02 (768p)',
        description: 'MiniMax 海螺 02，768p 分辨率，性价比高',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
        name: 'MiniMax Hailuo-02 (图生视频)',
        description: 'MiniMax 海螺 02 图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },

      // --- MiniMax Hailuo 3.0 (fal id hailuo-03; 2K, native stereo, 5-15s) ---
      {
        id: 'fal-ai/minimax/hailuo-03/text-to-video',
        name: 'MiniMax Hailuo 3.0 (文生视频)',
        description: '海螺 3.0，2K 原生立体声，4-15 秒，运动与物理表现强',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'fal-ai/minimax/hailuo-03/image-to-video',
        name: 'MiniMax Hailuo 3.0 (图生视频)',
        description: '海螺 3.0 图生视频，支持首帧+尾帧，2K 原生立体声',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'fal-ai/minimax/hailuo-03/reference-to-video',
        name: 'MiniMax Hailuo 3.0 (参考生视频)',
        description: '海螺 3.0 参考生视频，图/视频/音频混合参考保主体，2K',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },

      // --- Vidu series (Shengshu Tech) ---
      {
        id: 'fal-ai/vidu/q2/image-to-video/pro',
        name: 'Vidu Q2 Pro (图生视频)',
        description: '生数 Vidu Q2 Pro，720p/1080p，支持 BGM',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/vidu/start-end-to-video',
        name: 'Vidu 首尾帧过渡',
        description: '指定首帧和尾帧，生成平滑过渡视频（适合转场）',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/vidu/reference-to-video',
        name: 'Vidu 参考图生视频',
        description: '基于参考图生成主体一致的视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },

      // --- MiniMax Hailuo 2.3 series (latest) ---
      {
        id: 'fal-ai/minimax/hailuo-2.3/standard/text-to-video',
        name: 'Hailuo 2.3 Standard (文生视频)',
        description: '海螺 2.3 标准版 768p，运动物理逼真',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/minimax/hailuo-2.3/standard/image-to-video',
        name: 'Hailuo 2.3 Standard (图生视频)',
        description: '海螺 2.3 标准版 768p 图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/minimax/hailuo-2.3/pro/image-to-video',
        name: 'Hailuo 2.3 Pro (图生视频)',
        description: '海螺 2.3 Pro 1080p 高清图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },

      // --- Luma Ray 2 series ---
      {
        id: 'fal-ai/luma-dream-machine/ray-2',
        name: 'Luma Ray 2 (文生视频)',
        description: 'Luma Ray 2，真实运动和物理效果，5s/9s',
        modes: ['text-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'fal-ai/luma-dream-machine/ray-2/image-to-video',
        name: 'Luma Ray 2 (图生视频)',
        description: 'Luma Ray 2 图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },

      // --- Wan series (Alibaba Wanxiang) ---
      {
        id: 'fal-ai/wan/v2.2-a14b/image-to-video',
        name: 'Wan 2.2 (图生视频)',
        description: '阿里万相 2.2，支持 LoRA',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
    ]

    if (mediaType) {
      return models.filter((m) => m.mediaType === mediaType)
    }

    return models
  }

  // ==================== private methods ====================

  /** Map fal.ai task status to unified status */
  private mapStatus(falStatus: string): TaskStatusEnum {
    const statusMap: Record<string, TaskStatusEnum> = {
      IN_QUEUE: 'pending',
      IN_PROGRESS: 'processing',
      COMPLETED: 'completed',
      FAILED: 'failed',
    }
    return statusMap[falStatus] ?? 'pending'
  }

  /**
   * Parse a taskId
   * fal.ai task IDs are encoded as "modelId::requestId"
   */
  private parseTaskId(taskId: string): [string, string] {
    const separatorIndex = taskId.indexOf('::')
    if (separatorIndex === -1) {
      throw new ProviderError(
        '无效的任务 ID 格式，应为 "modelId::requestId"',
        'INVALID_TASK_ID',
        this.name
      )
    }
    return [
      taskId.substring(0, separatorIndex),
      taskId.substring(separatorIndex + 2),
    ]
  }

  /** Parse fal.ai response into the unified result format */
  private parseResult(
    taskId: string,
    result: FalResultResponse,
    modelId: string
  ): ImageResult | VideoResult {
    // image result
    if (result.images && result.images.length > 0) {
      return {
        taskId,
        imageUrls: result.images.map((img) => img.url),
        modelId,
        seed: result.seed,
        duration: result.timings?.inference,
      }
    }

    // video result (single video)
    if (result.video) {
      return {
        taskId,
        videoUrls: [result.video.url],
        modelId,
        processingTime: result.timings?.inference,
      }
    }

    // video result (multiple videos)
    if (result.videos && result.videos.length > 0) {
      return {
        taskId,
        videoUrls: result.videos.map((v) => v.url),
        modelId,
        processingTime: result.timings?.inference,
      }
    }

    throw new ProviderError('无法解析返回结果', 'PARSE_ERROR', this.name)
  }
}
