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

  const duration = nearestFalDuration(options.duration, spec.durations) ?? options.duration
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
   * Generate an image
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const w = options.width ?? 0
    const h = options.height ?? 0
    // GPT Image series does not accept negative_prompt / guidance / steps
    const isGptImage = options.modelId.includes('gpt-image')
    // gpt-image-1.5: image_size only accepts string enum values (1024x1024 / 1536x1024 / 1024x1536)
    const isGptImage15 = options.modelId.includes('gpt-image-1.5')
    // gpt-image-2: image_size accepts {width,height} (must be multiples of 16) or a preset name
    const isGptImage2 = options.modelId.includes('gpt-image-2')
    // edit/image-to-image endpoints: gpt-image-1.5/edit and seedream/edit use image_urls; gpt-image-2/image-to-image also supports image_urls
    const isEdit = options.modelId.includes('/edit') || options.modelId.includes('/image-to-image')

    const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16)
    const imageSize = (() => {
      if (isGptImage15) {
        if (w > h) return '1536x1024'
        if (h > w) return '1024x1536'
        return '1024x1024'
      }
      if (!w || !h) return undefined
      // gpt-image-2 requires width and height to be multiples of 16
      return isGptImage2
        ? { width: round16(w), height: round16(h) }
        : { width: w, height: h }
    })()

    const body = {
      prompt: options.prompt,
      negative_prompt: isGptImage ? undefined : options.negativePrompt,
      image_size: imageSize,
      num_images: options.count ?? 1,
      guidance_scale: isGptImage ? undefined : options.guidanceScale,
      num_inference_steps: isGptImage ? undefined : options.steps,
      seed: options.seed,
      // edit/image-to-image: multi-image endpoints use image_urls array; regular image-to-image uses image_url
      ...((options.referenceImageUrls?.length || options.referenceImageUrl) && isEdit && {
        image_urls: options.referenceImageUrls?.length
          ? options.referenceImageUrls
          : [options.referenceImageUrl!],
      }),
      ...(options.referenceImageUrl && !options.referenceImageUrls?.length && !isEdit && {
        image_url: options.referenceImageUrl,
      }),
      ...options.extra,
    }

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

    const statusResponse = await this.request<FalStatusResponse>(
      `/${modelId}/requests/${requestId}/status`,
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
      const result = await this.request<FalResultResponse>(
        `/${modelId}/requests/${requestId}`
      )
      taskStatus.result = this.parseResult(taskId, result, modelId)
    }

    return taskStatus
  }

  /**
   * Get the list of available models
   * fal.ai models are dynamic; this returns the commonly used ones
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    // model list verified against the fal.ai platform (2026-03)
    const models: Model[] = [
      // ==================== image generation ====================
      // OpenAI GPT Image 2 (fal endpoint: openai/gpt-image-2; strong prompt adherence, great product quality)
      {
        id: 'openai/gpt-image-2',
        name: 'GPT Image 2',
        description: 'OpenAI 最新图像模型，强提示词遵循、构图与细节保真（带货商品主图首选）',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'openai/gpt-image-2/image-to-image',
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
