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
  Model,
  MediaType,
} from './types'
import { submitFalTask, readFalTask } from './fal-queue'
import { uploadFalFile } from './fal-storage'
export { falQueueAppPath } from './fal-queue'
import { buildFalImageRequest } from './fal-image-params'
import {
  getFalVideoSpec,
  falFrameSibling,
  nearestFalAspectRatio,
  effectiveFalDuration,
  falReferenceSibling,
  nearestFalResolution,
  type FalVideoSpec,
} from './fal-video-params'

interface FalResultResponse {
  images?: Array<{ url: string; width?: number; height?: number }>
  video?: { url: string; content_type?: string }
  videos?: Array<{ url: string }>
  seed?: number
  timings?: { inference?: number }
  [key: string]: unknown
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
  for (const dimension of [options.width, options.height]) {
    if (dimension != null && (!Number.isFinite(dimension) || dimension <= 0)) throw new Error('视频尺寸必须是正数')
  }
  const hasReferences = Boolean(options.referenceImageUrls?.length || options.referenceVideoUrls?.length || options.referenceAudioUrls?.length || options.referenceVideoUrl)
  const modelId = (hasReferences ? falReferenceSibling(options.modelId) : falFrameSibling(options.modelId, Boolean(options.firstFrameUrl))) ?? options.modelId
  const spec: FalVideoSpec = getFalVideoSpec(modelId)
  const first = options.firstFrameUrl
  const last = options.lastFrameUrl
  for (const url of [first, last]) if (url && (typeof url !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(url))) throw new Error('首尾帧必须使用上传完成后的图片 URL')
  if (options.seed != null && !Number.isSafeInteger(options.seed)) throw new Error('seed 必须是安全整数')
  if (first && !spec.firstFrame) throw new Error(`模型 ${modelId} 不接受首帧图；请选择兼容端点，避免分镜一致性丢失`)
  if (last && !spec.lastFrame) throw new Error(`模型 ${modelId} 不接受尾帧图；不能静默丢弃镜头衔接约束`)
  if (spec.firstFrameRequired && !first) throw new Error(`模型 ${modelId} 必须提供首帧图`)
  if (spec.lastFrameRequired && !last) throw new Error(`模型 ${modelId} 必须同时提供首帧和尾帧图`)
  const references = [
    [options.referenceImageUrls, spec.referenceImages, spec.maxReferenceImages, '参考图片'],
    [options.referenceVideoUrls?.length ? options.referenceVideoUrls : options.referenceVideoUrl ? [options.referenceVideoUrl] : undefined, spec.referenceVideos, spec.maxReferenceVideos, '参考视频'],
    [options.referenceAudioUrls, spec.referenceAudio, spec.maxReferenceAudios, '参考音频'],
  ] as const
  for (const [urls, field, limit, label] of references) {
    if (!urls?.length) continue
    if (!field) throw new Error(`模型 ${modelId} 不支持${label}；无法保证该条件，未提交付费生成`)
    if (limit != null && urls.length > limit) throw new Error(`${label}数量 ${urls.length} 超过模型上限 ${limit}，请明确调整参考包后再提交`)
    if (urls.some((url) => typeof url !== 'string' || !/^(https?:\/\/|data:)/i.test(url))) throw new Error(`${label}须使用上传完成后的可访问 URL`)
  }
  if (spec.referenceImages && !references.some(([urls]) => urls?.length)) throw new Error('参考生成端点缺少参考素材')
  const nativeAudio = Boolean(spec.audio || spec.nativeAudio)
  if (options.audioEnabled && !nativeAudio) throw new Error(`模型 ${modelId} 不支持原生对白，请在生成方案中改为后期配音`)
  const duration = effectiveFalDuration(spec, options.duration, options.fps)
  const body: Record<string, unknown> = { ...options.extra }
  // No extra option may replace compiled visual/audio constraints, URLs or timelines.
  const protectedFields = ['prompt', 'negative_prompt', 'seed', 'duration', 'resolution', 'aspect_ratio', 'image_url', 'start_image_url', 'end_image_url',
    'image_urls', 'reference_image_urls', 'video_url', 'video_urls', 'reference_video_urls', 'audio_urls', 'reference_audio_urls',
    'generate_audio', 'task', 'guidance_scale', 'frames_per_second', 'num_frames']
  for (const key of protectedFields) delete body[key]
  if (spec.allowedFields) {
    for (const key of Object.keys(body)) if (!spec.allowedFields.includes(key)) throw new Error(`模型 ${modelId} 不支持参数 ${key}`)
  }
  if (spec.allowedFields?.includes('prompt_optimizer') && body.prompt_optimizer == null) body.prompt_optimizer = false
  if (spec.allowedFields?.includes('enable_prompt_expansion') && body.enable_prompt_expansion == null) body.enable_prompt_expansion = false
  body.prompt = options.audioEnabled && options.voiceover
    ? `${options.prompt}\nSpoken dialogue (verbatim; retain the speaker defined above): "${options.voiceover}"`
    : options.prompt
  if (spec.negativePrompt && options.negativePrompt) body.negative_prompt = options.negativePrompt
  if (spec.seed && options.seed != null) body.seed = options.seed
  if (spec.usesResolution) body.resolution = nearestFalResolution(options.width, options.height, spec.resolutions)
  if (spec.usesAspectRatio) body.aspect_ratio = nearestFalAspectRatio(options.width, options.height, spec.aspects)
  if (duration != null && spec.durationFormat) body.duration = spec.durationFormat === 'seconds' ? `${duration}s` : spec.durationFormat === 'string' ? String(duration) : duration
  if (spec.frameCount && duration != null) {
    body.frames_per_second = options.fps ?? spec.frameCount.fps
    body.num_frames = Math.round(duration * Number(body.frames_per_second)) + 1
  }
  if (first && spec.firstFrame) body[spec.firstFrame] = first
  if (last && spec.lastFrame) body[spec.lastFrame] = last
  for (const [urls, field] of references) if (urls?.length && field) body[field] = urls
  if (spec.referenceTask) body.task = spec.referenceTask
  if (spec.audio) body[spec.audio] = Boolean(options.audioEnabled)
  if (spec.usesGuidanceScale && options.guidanceScale != null) body.guidance_scale = options.guidanceScale
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]

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
    const { taskId } = await this.submitImageTask(options)
    const finalStatus = await this.waitForTask(taskId, { interval: 2000 })
    return this.requireResult(finalStatus.result) as ImageResult
  }

  async submitImageTask(options: ImageOptions): Promise<{ taskId: string; modelId: string }> {
    const { modelId, body } = buildFalImageRequest({
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

    const taskId = await submitFalTask(this.config, modelId, body)
    return { taskId, modelId }
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
    const taskId = await submitFalTask(this.config, modelId, body)
    return { taskId, modelId }
  }

  async uploadLocalMedia(filePath: string): Promise<string> {
    return uploadFalFile(filePath, this.config.apiKey)
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const state = await readFalTask(this.config, taskId)
    const status: TaskStatus = {
      taskId, status: state.status, progress: state.progress,
      ...(state.error && { error: state.error, errorCode: 'TASK_FAILED' }),
    }
    if (state.status === 'completed' && state.data) {
      status.result = this.parseResult(taskId, state.data as FalResultResponse, state.modelId)
    }
    return status
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

  /** Parse fal.ai response into the unified result format */
  private parseResult(
    taskId: string,
    result: FalResultResponse,
    modelId: string
  ): ImageResult | VideoResult {
    // fal stores a REJECTED submission as the request's outcome and still reports COMPLETED, so the
    // "result" body can be a validation error. Surface the platform's own reason instead of letting
    // the caller report a vague "result URL unavailable".
    const detail = (result as { detail?: unknown }).detail
    if (!result.images?.length && !result.video && !result.videos?.length && detail !== undefined) {
      throw new ProviderError(
        `平台拒绝了这次请求（${modelId}）：${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`,
        'PLATFORM_REJECTED',
        this.name
      )
    }

    const mediaUrl = (value: unknown): string => {
      if (typeof value !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(value)) throw new ProviderError('fal 返回了无效媒体地址；请恢复该任务，不要重新生成', 'PARSE_ERROR', this.name)
      return value
    }
    // image result
    if (result.images && result.images.length > 0) {
      return {
        taskId,
        imageUrls: result.images.map((img) => mediaUrl(img?.url)),
        modelId,
        seed: result.seed,
        duration: result.timings?.inference,
      }
    }

    // video result (single video)
    if (result.video) {
      return {
        taskId,
        videoUrls: [mediaUrl(result.video.url)],
        modelId,
        processingTime: result.timings?.inference,
      }
    }

    // video result (multiple videos)
    if (result.videos && result.videos.length > 0) {
      return {
        taskId,
        videoUrls: result.videos.map((v) => mediaUrl(v?.url)),
        modelId,
        processingTime: result.timings?.inference,
      }
    }

    throw new ProviderError('无法解析返回结果', 'PARSE_ERROR', this.name)
  }
}
