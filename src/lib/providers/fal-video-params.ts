/** fal endpoint contracts checked against public OpenAPI on 2026-09-17.
 * Runtime request construction and UI capability/preflight use this SAME registry.
 * A reference sibling is advertised only when its concrete endpoint was verified.
 */
export interface FalVideoSpec {
  firstFrame?: 'image_url' | 'start_image_url'
  lastFrame?: 'end_image_url'
  firstFrameRequired?: boolean
  lastFrameRequired?: boolean
  referenceImages?: 'image_urls' | 'reference_image_urls'
  referenceVideos?: 'video_urls' | 'reference_video_urls'
  referenceAudio?: 'audio_urls' | 'reference_audio_urls'
  referenceTask?: string
  maxReferenceImages?: number
  maxReferenceVideos?: number
  maxReferenceAudios?: number
  durationFormat?: 'number' | 'string' | 'seconds'
  durations?: number[]
  durationRange?: [number, number]
  fixedDuration?: number
  defaultDuration?: number
  frameCount?: { min: number; max: number; default: number; fps: number }
  audio?: 'generate_audio'
  nativeAudio?: boolean
  usesGuidanceScale?: boolean
  seed?: boolean
  negativePrompt?: boolean
  usesResolution?: boolean
  usesAspectRatio?: boolean
  resolutions?: string[]
  aspects?: string[]
  allowedFields?: string[]
}

export const FAL_VIDEO_SPECS: Record<string, FalVideoSpec> = {
  'bytedance/seedance-2.5/text-to-video': {
    audio: 'generate_audio',
    usesResolution: true,
    resolutions: ['480p', '720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durationFormat: 'string',
    durations: [4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0],
    allowedFields: ['end_user_id', 'bitrate_mode', 'prompt', 'aspect_ratio', 'generate_audio', 'duration', 'resolution']
  },
  'bytedance/seedance-2.5/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    audio: 'generate_audio',
    usesResolution: true,
    resolutions: ['480p', '720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['auto'],
    durationFormat: 'string',
    durations: [4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0],
    allowedFields: ['bitrate_mode', 'prompt', 'aspect_ratio', 'end_user_id', 'duration', 'end_image_url', 'image_url', 'generate_audio', 'resolution']
  },
  'bytedance/seedance-2.5/reference-to-video': {
    referenceImages: 'image_urls',
    maxReferenceImages: 9,
    referenceVideos: 'video_urls',
    maxReferenceVideos: 3,
    referenceAudio: 'audio_urls',
    maxReferenceAudios: 3,
    referenceTask: 'reference',
    audio: 'generate_audio',
    usesResolution: true,
    resolutions: ['480p', '720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durationFormat: 'string',
    durations: [4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0],
    seed: true,
    allowedFields: ['seed', 'bitrate_mode', 'prompt', 'aspect_ratio', 'end_user_id', 'audio_urls', 'duration', 'task', 'video_urls', 'image_urls', 'generate_audio', 'resolution']
  },
  'fal-ai/kling-video/v3/pro/text-to-video': {
    audio: 'generate_audio',
    usesAspectRatio: true,
    aspects: ['16:9', '9:16', '1:1'],
    durationFormat: 'string',
    durations: [3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0],
    defaultDuration: 5.0,
    negativePrompt: true,
    allowedFields: ['multi_prompt', 'aspect_ratio', 'cfg_scale', 'shot_type', 'prompt', 'negative_prompt', 'duration', 'generate_audio']
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    firstFrame: 'start_image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    audio: 'generate_audio',
    durationFormat: 'string',
    durations: [3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0],
    defaultDuration: 5.0,
    negativePrompt: true,
    allowedFields: ['end_image_url', 'multi_prompt', 'cfg_scale', 'shot_type', 'elements', 'prompt', 'negative_prompt', 'start_image_url', 'duration', 'generate_audio']
  },
  'fal-ai/veo3': {
    audio: 'generate_audio',
    usesResolution: true,
    resolutions: ['720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['16:9', '9:16'],
    durationFormat: 'seconds',
    durations: [4.0, 6.0, 8.0],
    defaultDuration: 8.0,
    seed: true,
    negativePrompt: true,
    allowedFields: ['seed', 'safety_tolerance', 'prompt', 'aspect_ratio', 'negative_prompt', 'duration', 'auto_fix', 'generate_audio', 'resolution']
  },
  'fal-ai/minimax/hailuo-02/standard/text-to-video': {
    durationFormat: 'string',
    durations: [6.0, 10.0],
    defaultDuration: 6.0,
    allowedFields: ['prompt_optimizer', 'prompt', 'duration']
  },
  'fal-ai/minimax/hailuo-02/standard/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    usesResolution: true,
    resolutions: ['512P', '768P'],
    durationFormat: 'string',
    durations: [6.0, 10.0],
    defaultDuration: 6.0,
    allowedFields: ['image_url', 'prompt_optimizer', 'prompt', 'resolution', 'end_image_url', 'duration']
  },
  'fal-ai/minimax/hailuo-2.3/standard/text-to-video': {
    durationFormat: 'string',
    durations: [6.0, 10.0],
    defaultDuration: 6.0,
    allowedFields: ['prompt_optimizer', 'prompt', 'duration']
  },
  'fal-ai/minimax/hailuo-2.3/standard/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    durationFormat: 'string',
    durations: [6.0, 10.0],
    defaultDuration: 6.0,
    allowedFields: ['image_url', 'prompt_optimizer', 'prompt', 'duration']
  },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    fixedDuration: 6,
    allowedFields: ['image_url', 'prompt_optimizer', 'prompt']
  },
  'fal-ai/minimax/hailuo-03/text-to-video': {
    nativeAudio: true,
    usesResolution: true,
    resolutions: ['2K'],
    usesAspectRatio: true,
    aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durationFormat: 'number',
    durationRange: [5, 15],
    defaultDuration: 5.0,
    allowedFields: ['aspect_ratio', 'prompt', 'resolution', 'duration']
  },
  'fal-ai/minimax/hailuo-03/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    nativeAudio: true,
    usesResolution: true,
    resolutions: ['2K'],
    durationFormat: 'number',
    durationRange: [5, 15],
    defaultDuration: 5.0,
    allowedFields: ['image_url', 'end_image_url', 'prompt', 'resolution', 'duration']
  },
  'fal-ai/minimax/hailuo-03/reference-to-video': {
    referenceImages: 'reference_image_urls',
    maxReferenceImages: 9,
    referenceVideos: 'reference_video_urls',
    maxReferenceVideos: 3,
    referenceAudio: 'reference_audio_urls',
    maxReferenceAudios: 3,
    nativeAudio: true,
    usesResolution: true,
    resolutions: ['2K'],
    usesAspectRatio: true,
    aspects: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durationFormat: 'number',
    durationRange: [5, 15],
    defaultDuration: 5.0,
    allowedFields: ['reference_image_urls', 'reference_audio_urls', 'aspect_ratio', 'prompt', 'reference_video_urls', 'resolution', 'duration']
  },
  'fal-ai/vidu/q2/image-to-video/pro': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    usesResolution: true,
    resolutions: ['720p', '1080p'],
    durationFormat: 'number',
    durations: [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
    defaultDuration: 4.0,
    seed: true,
    allowedFields: ['bgm', 'seed', 'prompt', 'movement_amplitude', 'duration', 'end_image_url', 'resolution', 'image_url']
  },
  'fal-ai/vidu/start-end-to-video': {
    firstFrame: 'start_image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: true,
    fixedDuration: 4,
    seed: true,
    allowedFields: ['end_image_url', 'seed', 'prompt', 'movement_amplitude', 'start_image_url']
  },
  'fal-ai/vidu/reference-to-video': {
    referenceImages: 'reference_image_urls',
    maxReferenceImages: 3,
    usesAspectRatio: true,
    aspects: ['16:9', '9:16', '1:1'],
    fixedDuration: 4,
    seed: true,
    allowedFields: ['aspect_ratio', 'seed', 'prompt', 'reference_image_urls', 'movement_amplitude']
  },
  'fal-ai/luma-dream-machine/ray-2': {
    usesResolution: true,
    resolutions: ['540p', '720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['16:9', '9:16', '4:3', '3:4', '21:9', '9:21'],
    durationFormat: 'seconds',
    durations: [5.0, 9.0],
    defaultDuration: 5.0,
    allowedFields: ['duration', 'aspect_ratio', 'prompt', 'resolution', 'loop']
  },
  'fal-ai/luma-dream-machine/ray-2/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: false,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    usesResolution: true,
    resolutions: ['540p', '720p', '1080p'],
    usesAspectRatio: true,
    aspects: ['16:9', '9:16', '4:3', '3:4', '21:9', '9:21'],
    durationFormat: 'seconds',
    durations: [5.0, 9.0],
    defaultDuration: 5.0,
    allowedFields: ['duration', 'aspect_ratio', 'end_image_url', 'resolution', 'image_url', 'prompt', 'loop']
  },
  'fal-ai/wan/v2.2-a14b/image-to-video': {
    firstFrame: 'image_url',
    firstFrameRequired: true,
    lastFrame: 'end_image_url',
    lastFrameRequired: false,
    usesResolution: true,
    resolutions: ['480p', '580p', '720p'],
    usesAspectRatio: true,
    aspects: ['auto', '16:9', '9:16', '1:1'],
    frameCount: {
      min: 17,
      max: 161,
      default: 81,
      fps: 16
    },
    defaultDuration: 5.0,
    usesGuidanceScale: true,
    seed: true,
    negativePrompt: true,
    allowedFields: ['num_frames', 'num_inference_steps', 'acceleration', 'seed', 'prompt', 'guidance_scale_2', 'enable_output_safety_checker', 'image_url', 'adjust_fps_for_interpolation', 'aspect_ratio', 'guidance_scale', 'num_interpolated_frames', 'enable_safety_checker', 'video_write_mode', 'end_image_url', 'video_quality', 'shift', 'resolution', 'enable_prompt_expansion', 'frames_per_second', 'negative_prompt', 'interpolator_model']
  }
}


export function getFalVideoSpec(modelId: string): FalVideoSpec {
  if (FAL_VIDEO_SPECS[modelId]) return FAL_VIDEO_SPECS[modelId]
  // Keep exact custom endpoints usable with conventional media fields. These are inferred,
  // never advertised as verified capabilities, and never used to invent a paid sibling ID.
  if (/\/start-end-to-video$/.test(modelId)) return { firstFrame: 'image_url', lastFrame: 'end_image_url', firstFrameRequired: true, lastFrameRequired: true }
  if (/\/image-to-video$/.test(modelId)) return { firstFrame: 'image_url', firstFrameRequired: true }
  return {}
}
export function falReferenceSibling(modelId: string): string | undefined {
  if (FAL_VIDEO_SPECS[modelId]?.referenceImages) return modelId
  const sibling = modelId.replace(/\/(?:text|image)-to-video$/, '/reference-to-video')
  return FAL_VIDEO_SPECS[sibling]?.referenceImages ? sibling : undefined
}
export function falFrameSibling(modelId: string, needsFirstFrame: boolean): string | undefined {
  const spec = FAL_VIDEO_SPECS[modelId]
  if (!spec || needsFirstFrame === Boolean(spec.firstFrame)) return undefined
  const sibling = modelId.includes('/luma-dream-machine/ray-2')
    ? (needsFirstFrame ? 'fal-ai/luma-dream-machine/ray-2/image-to-video' : 'fal-ai/luma-dream-machine/ray-2')
    : modelId.replace(/\/(?:text|image)-to-video$/, needsFirstFrame ? '/image-to-video' : '/text-to-video')
  const other = FAL_VIDEO_SPECS[sibling]
  return other && Boolean(other.firstFrame) === needsFirstFrame ? sibling : undefined
}

/** Choose a legal duration that covers the script, never round dialogue DOWN. */
export function nearestFalDuration(seconds: number | undefined, allowed?: number[]): number | undefined {
  if (seconds == null || !allowed?.length) return undefined
  return [...allowed].sort((a, b) => a - b).find((d) => d >= seconds) ?? Math.max(...allowed)
}
export function effectiveFalDuration(spec: FalVideoSpec, requested?: number, fps?: number): number | undefined {
  if (requested != null && (!Number.isFinite(requested) || requested <= 0)) throw new Error('视频时长必须是正数')
  const max = spec.fixedDuration ?? (spec.durations?.length ? Math.max(...spec.durations) : spec.durationRange?.[1])
  if (requested != null && max != null && requested > max) throw new Error(`脚本需要 ${requested}s，但模型最多支持 ${max}s；请拆分镜头或选择更长时长模型`)
  if (spec.fixedDuration) return spec.fixedDuration
  if (spec.frameCount) {
    const rate = fps ?? spec.frameCount.fps
    if (!Number.isInteger(rate) || rate < 4 || rate > 60) throw new Error('Wan 帧率须为 4–60 的整数')
    const frames = requested == null ? spec.frameCount.default : Math.max(spec.frameCount.min, Math.ceil(requested * rate / 4) * 4 + 1)
    if (frames > spec.frameCount.max) throw new Error(`时长与帧率组合超过 Wan ${spec.frameCount.max} 帧上限，请拆分镜头`)
    return (frames - 1) / rate
  }
  if (requested == null) return spec.defaultDuration
  if (spec.durations) return nearestFalDuration(requested, spec.durations)
  if (spec.durationRange) return Math.max(spec.durationRange[0], Math.ceil(requested))
  return requested
}

export function nearestFalAspectRatio(width?: number, height?: number, allowed: string[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']): string | undefined {
  if (allowed.length === 1) return allowed[0]
  if (!width || !height) return undefined
  const target = width / height
  const ratios = allowed.filter((v) => /^\d+:\d+$/.test(v))
  return ratios.sort((a, b) => {
    const [aw, ah] = a.split(':').map(Number); const [bw, bh] = b.split(':').map(Number)
    return Math.abs(Math.log(aw / ah / target)) - Math.abs(Math.log(bw / bh / target))
  })[0] ?? allowed[0]
}
function parseFalResTier(value: string): number | undefined {
  const p = value.match(/^(\d+)p$/i)
  if (p) return Number(p[1])
  const k = value.match(/^(\d+)k$/i)
  return k ? Number(k[1]) * 540 : undefined
}
export function nearestFalResolution(width: number | undefined, height: number | undefined, allowed?: string[]): string | undefined {
  if (!allowed?.length) return undefined
  const tiers = allowed.map((value) => ({ value, tier: parseFalResTier(value) })).filter((v): v is { value: string; tier: number } => v.tier !== undefined).sort((a, b) => a.tier - b.tier)
  const side = Math.min(width ?? 720, height ?? 720)
  return (tiers.find((v) => v.tier >= side) ?? tiers.at(-1))?.value
}
