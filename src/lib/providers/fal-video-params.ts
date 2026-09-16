/**
 * Per-endpoint request specs for fal.ai video models.
 *
 * fal validates every request body against the target endpoint's published schema, and the
 * field that carries a frame differs per model family:
 *   - Seedance / Hailuo / Luma / Wan take the driving frame as `image_url`
 *   - Kling v3 and Vidu start-end take it as `start_image_url`
 *   - the end frame is `end_image_url` on every family that supports one
 *   - reference packs are `image_urls` (Seedance 2.5) or `reference_image_urls` (Vidu)
 *
 * Sending the wrong field name is silently dropped (or rejected), which is exactly how
 * first/last-frame chaining and product-identity reference packs break when a generic
 * body builder is reused across families.
 *
 * Verified against each endpoint's OpenAPI schema:
 *   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<modelId>
 */

export interface FalVideoSpec {
  /** Field carrying the driving/first frame. Absent ⇒ the endpoint is text-to-video only. */
  firstFrame?: 'image_url' | 'start_image_url'
  /** Field carrying the optional end frame. */
  lastFrame?: 'end_image_url'
  /** Array field for reference images (product / character packs). */
  referenceImages?: 'image_urls' | 'reference_image_urls'
  /** Array field for reference videos (multimodal reference-to-video). */
  referenceVideos?: 'video_urls'
  /** Array field for reference audio. */
  referenceAudio?: 'audio_urls'
  /** Discriminator fal requires alongside a reference payload. */
  referenceTask?: string
  /** Endpoint wants `"4s"` instead of `4`. */
  durationAsString?: boolean
  /** Endpoint accepts a native-audio toggle under this field name. */
  audio?: 'generate_audio'
  /** Endpoint accepts guidance_scale. */
  usesGuidanceScale?: boolean
  /** Endpoint accepts `resolution` / `aspect_ratio` enums instead of a width/height size. */
  usesResolution?: boolean
  usesAspectRatio?: boolean
  /** Allowed resolution enum values, used to snap a requested size to a legal one. */
  resolutions?: string[]
  /** Allowed duration values, used to snap a requested duration to a legal one. */
  durations?: number[]
}

export const FAL_VIDEO_SPECS: Record<string, FalVideoSpec> = {
  // --- ByteDance Seedance 2.5 (4-30s, native audio) ---
  'bytedance/seedance-2.5/text-to-video': {
    usesResolution: true, usesAspectRatio: true, resolutions: ['480p', '720p', '1080p'],
    audio: 'generate_audio',
  },
  'bytedance/seedance-2.5/image-to-video': {
    firstFrame: 'image_url', lastFrame: 'end_image_url',
    usesResolution: true, usesAspectRatio: true, resolutions: ['480p', '720p', '1080p'],
    audio: 'generate_audio',
  },
  'bytedance/seedance-2.5/reference-to-video': {
    referenceImages: 'image_urls', referenceVideos: 'video_urls', referenceAudio: 'audio_urls',
    referenceTask: 'reference',
    usesResolution: true, usesAspectRatio: true, resolutions: ['480p', '720p', '1080p'],
    audio: 'generate_audio',
  },

  // --- Kling v3 Pro (image-to-video drives from start_image_url, not image_url) ---
  'fal-ai/kling-video/v3/pro/text-to-video': {
    usesAspectRatio: true, durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    audio: 'generate_audio',
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    firstFrame: 'start_image_url', lastFrame: 'end_image_url',
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    audio: 'generate_audio',
  },

  // --- Google Veo 3 (duration is a "4s"/"6s"/"8s" string, no image input on this endpoint) ---
  'fal-ai/veo3': {
    durationAsString: true, durations: [4, 6, 8],
    usesResolution: true, usesAspectRatio: true, resolutions: ['720p', '1080p'],
    audio: 'generate_audio',
  },

  // --- MiniMax Hailuo ---
  'fal-ai/minimax/hailuo-02/standard/text-to-video': {},
  'fal-ai/minimax/hailuo-02/standard/image-to-video': { firstFrame: 'image_url' },
  'fal-ai/minimax/hailuo-2.3/standard/text-to-video': {},
  'fal-ai/minimax/hailuo-2.3/standard/image-to-video': { firstFrame: 'image_url' },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': { firstFrame: 'image_url' },

  // --- Vidu ---
  'fal-ai/vidu/q2/image-to-video/pro': { firstFrame: 'image_url' },
  'fal-ai/vidu/start-end-to-video': { firstFrame: 'start_image_url', lastFrame: 'end_image_url' },
  'fal-ai/vidu/reference-to-video': { referenceImages: 'reference_image_urls', usesAspectRatio: true },

  // --- Luma Ray 2 ---
  'fal-ai/luma-dream-machine/ray-2': {
    usesResolution: true, usesAspectRatio: true, resolutions: ['540p', '720p', '1080p', '4k'],
  },
  'fal-ai/luma-dream-machine/ray-2/image-to-video': {
    firstFrame: 'image_url', lastFrame: 'end_image_url',
    usesResolution: true, usesAspectRatio: true, resolutions: ['540p', '720p', '1080p', '4k'],
  },

  // --- Alibaba Wan 2.2 ---
  'fal-ai/wan/v2.2-a14b/image-to-video': {
    firstFrame: 'image_url', lastFrame: 'end_image_url',
    usesResolution: true, usesAspectRatio: true, resolutions: ['480p', '580p', '720p'],
    usesGuidanceScale: true,
  },
}

/** Endpoints whose only difference is the frame/reference field naming. */
const I2V_SIBLINGS: ReadonlyArray<[RegExp, string]> = [
  [/\/text-to-video$/, '/image-to-video'],
  [/\/image-to-video$/, '/text-to-video'],
]

/**
 * Spec lookup. Unknown (user-entered) model ids fall back to naming conventions so a custom
 * fal endpoint still gets the most likely frame field instead of nothing.
 */
export function getFalVideoSpec(modelId: string): FalVideoSpec {
  const known = FAL_VIDEO_SPECS[modelId]
  if (known) return known
  return inferFalVideoSpec(modelId)
}

function inferFalVideoSpec(modelId: string): FalVideoSpec {
  const id = modelId.toLowerCase()
  if (/start-end-to-video/.test(id)) return { firstFrame: 'start_image_url', lastFrame: 'end_image_url' }
  if (/reference-to-video/.test(id)) return { referenceImages: 'reference_image_urls' }
  if (/(image-to-video|\/i2v)/.test(id)) return { firstFrame: 'image_url' }
  return {}
}

/** The sibling endpoint that accepts the frames we actually have, if the current one cannot. */
export function falFrameSibling(
  modelId: string,
  needsFirstFrame: boolean,
): string | undefined {
  const spec = getFalVideoSpec(modelId)
  const hasFirstFrameField = Boolean(spec.firstFrame)
  if (needsFirstFrame === hasFirstFrameField) return undefined
  for (const [pattern, replacement] of I2V_SIBLINGS) {
    if (!pattern.test(modelId)) continue
    const sibling = modelId.replace(pattern, replacement)
    const siblingSpec = getFalVideoSpec(sibling)
    if (needsFirstFrame ? siblingSpec.firstFrame : !siblingSpec.firstFrame) return sibling
  }
  return undefined
}

const ASPECTS: ReadonlyArray<[string, number]> = [
  ['21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['9:16', 9 / 16],
]

/** Nearest legal aspect-ratio enum for a requested pixel size. */
export function nearestFalAspectRatio(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined
  const target = width / height
  let best: string | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const [label, ratio] of ASPECTS) {
    const delta = Math.abs(ratio - target)
    if (delta < bestDelta) { best = label; bestDelta = delta }
  }
  return best
}

/** Parse a resolution tier label ("720p", "768P", "4k") into a comparable short-side class. */
function parseFalResTier(value: string): number | undefined {
  const lower = value.toLowerCase()
  const p = lower.match(/^(\d+)\s*p/)
  if (p) return Number.parseInt(p[1], 10)
  const k = lower.match(/^(\d+)\s*k/)
  if (k) return Number.parseInt(k[1], 10) * 540
  return undefined
}

/**
 * Snap a requested output size onto the endpoint's resolution enum.
 *
 * The tier is the SHORT side — a 720x1280 portrait request is 720p, not 1080p — and the smallest
 * tier that covers the request wins, so a request is never silently downscaled below what was asked
 * (matches the shared pickResolution convention in atlas-video-params).
 */
export function nearestFalResolution(
  width: number | undefined,
  height: number | undefined,
  allowed?: string[],
): string | undefined {
  if (!allowed?.length) return undefined
  const tiers = allowed
    .map((value) => ({ value, tier: parseFalResTier(value) }))
    .filter((entry): entry is { value: string; tier: number } => entry.tier !== undefined)
    .sort((a, b) => a.tier - b.tier)
  if (tiers.length === 0) return undefined
  const minSide = Math.min(width ?? 720, height ?? 720)
  const covering = tiers.find((entry) => entry.tier >= minSide)
  return (covering ?? tiers[tiers.length - 1]).value
}

/** Snap a requested duration onto the endpoint's legal values. */
export function nearestFalDuration(seconds: number | undefined, allowed?: number[]): number | undefined {
  if (!allowed?.length || !seconds) return undefined
  let best = allowed[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const option of allowed) {
    const delta = Math.abs(option - seconds)
    if (delta < bestDelta) { best = option; bestDelta = delta }
  }
  return best
}
