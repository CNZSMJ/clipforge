/**
 * Per-model video request shapes for the third-party video families the app can reach.
 *
 * The families disagree on how the same intent is expressed (Seedance wants last_image on one
 * variant and end_image_url on another; Kling drives from start_image_url; Hailuo encodes the
 * variant in the model id). These specs are what lets the capability layer answer "can this model
 * take a product reference / an end frame / reference audio?" without hard-coding vendor names.
 *
 * NOTE: this file is provider-agnostic and must NOT be deleted along with any single vendor.
 * fal-specific request building lives in fal-video-params.ts.
 */

/** How a model expects reference materials for reference-to-video generation */
export type ReferenceShape =
  | 'paired-arrays' // reference_images[] + reference_videos[] (Seedance family)
  | 'refers' // one mixed refers[] of image/video/audio URLs (MiniMax H3)
  | 'images-plus-video' // images[] + a single video string (Kling O3)
  | 'images-videos' // images[] + videos[] (Wan 2.7)

export interface VideoParamSpec {
  /** Field carrying the first-frame image (present on i2v variants) */
  firstFrameKey?: 'image'
  /** Field carrying the pinned last frame, when the model supports one */
  lastFrameKey?: 'last_image' | 'end_image'
  /** Allowed integer durations in seconds; omit for free-form integer duration */
  durationEnum?: number[]
  /** Model exposes no duration parameter at all (e.g. Hailuo 2.3 i2v-pro) */
  noDuration?: boolean
  /** Allowed resolution tier strings, verbatim from the schema */
  resolutionEnum?: string[]
  /** Aspect-ratio field name and its allowed values */
  ratioKey?: 'ratio' | 'aspect_ratio'
  ratioEnum?: string[]
  /** Audio on/off boolean field, when the model exposes one */
  audioKey?: 'generate_audio' | 'sound' | 'audio'
  /** How reference materials are expressed (reference-to-video variants only) */
  referenceShape?: ReferenceShape
  /** Max reference IMAGES the schema accepts (reference-to-video variants); omit = unknown, don't gate */
  maxReferenceImages?: number
  supportsSeed?: boolean
  supportsWatermark?: boolean
  /**
   * Schema-required params with their schema defaults, applied when the caller
   * provided nothing to derive them from (e.g. H3 requires resolution+duration).
   */
  requiredDefaults?: { resolution?: string; duration?: number }
}

// ==================== Curated specs (transcribed from published schemas) ====================

const H3_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const H3_MAX_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const KLING_O3_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const SEEDANCE_MINI_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const SEEDANCE_MINI_RESOLUTIONS = ['480p', '720p', '720p-SR', '1080p-SR', '1440p-SR']
const SEEDANCE_MINI_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']
// Seedance 2.5: schema also allows -1 (model decides), deliberately excluded — we always send explicit durations
const SEEDANCE_25_DURATIONS = Array.from({ length: 27 }, (_, i) => i + 4) // 4..30
// Verified against the published schema (2026-09). Native 480p/720p/1080p are separate products
// from the -sr/-esr upscale tiers and are priced differently: an earlier transcription omitted
// native 1080p entirely, so every "1080p" request was resolved to the pricier 1080p-sr (issue #28).
const SEEDANCE_25_RESOLUTIONS = [
  '480p', '720p', '720p-sr', '720p-esr',
  '1080p', '1080p-sr', '1080p-esr', '1080p-esr & 60fps',
  '1440p-sr', '1440p-esr', '4k-esr',
]
const SEEDANCE_25_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']
const WAN_30_DURATIONS = Array.from({ length: 29 }, (_, i) => i + 2) // 2..30
const WAN_30_RESOLUTIONS = ['480p', '720p', '1080p', '720p-esr', '1080p-esr', '1440p-esr', '4k-esr']
const WAN_30_RATIOS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16']

export const VIDEO_PARAM_SPECS: Record<string, VideoParamSpec> = {
  // --- MiniMax H3 (Hailuo 3.0): native stereo audio, no audio toggle ---
  'minimax/h3/text-to-video': {
    durationEnum: H3_DURATIONS,
    resolutionEnum: ['768P', '2K'],
    ratioKey: 'ratio',
    ratioEnum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    requiredDefaults: { resolution: '2K', duration: 8 },
  },
  'minimax/h3/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'end_image',
    durationEnum: H3_DURATIONS,
    resolutionEnum: ['768P', '2K'],
    ratioKey: 'ratio',
    ratioEnum: ['adaptive'],
    requiredDefaults: { resolution: '2K', duration: 8 },
  },
  'minimax/h3/reference-to-video': {
    referenceShape: 'refers',
    durationEnum: H3_DURATIONS,
    resolutionEnum: ['480P', '768P', '2K'],
    ratioKey: 'ratio',
    ratioEnum: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    requiredDefaults: { resolution: '2K', duration: 8 },
  },
  // --- MiniMax H3 Max: cheapest of the H3 line for per-shot i2v. Native tops out at 768P
  // (no 1080p), ratio is adaptive-only, and there is no reference-to-video variant, so the
  // one-call film pass cannot use it. Schema verified 2026-09. ---
  'minimax/h3-max/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'end_image',
    durationEnum: H3_MAX_DURATIONS,
    resolutionEnum: ['480P', '768P', '1440p-sr', '4k-sr'],
    ratioKey: 'ratio',
    ratioEnum: ['adaptive'],
    requiredDefaults: { resolution: '768P', duration: 8 },
  },
  // --- MiniMax Hailuo 2.3 (no audio params, no resolution/ratio params) ---
  'minimax/hailuo-2.3/t2v-standard': { durationEnum: [6, 10] },
  'minimax/hailuo-2.3/i2v-standard': { firstFrameKey: 'image', durationEnum: [6, 10] },
  'minimax/hailuo-2.3/i2v-pro': { firstFrameKey: 'image', noDuration: true },
  // --- Kling Video O3 Std (sound boolean, i2v has no aspect_ratio) ---
  'kwaivgi/kling-video-o3-std/text-to-video': {
    durationEnum: KLING_O3_DURATIONS,
    ratioKey: 'aspect_ratio',
    ratioEnum: ['16:9', '9:16', '1:1'],
    audioKey: 'sound',
  },
  'kwaivgi/kling-video-o3-std/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'end_image',
    durationEnum: KLING_O3_DURATIONS,
    audioKey: 'sound',
  },
  'kwaivgi/kling-video-o3-std/reference-to-video': {
    referenceShape: 'images-plus-video',
    durationEnum: KLING_O3_DURATIONS,
    ratioKey: 'aspect_ratio',
    ratioEnum: ['16:9', '9:16', '1:1'],
    audioKey: 'sound',
  },
  // --- Google Veo 3.1 ---
  'google/veo3.1/text-to-video': {
    durationEnum: [4, 6, 8],
    resolutionEnum: ['720p', '1080p', '4k'],
    ratioKey: 'aspect_ratio',
    ratioEnum: ['16:9', '9:16'],
    audioKey: 'generate_audio',
    supportsSeed: true,
  },
  'google/veo3.1/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'last_image',
    durationEnum: [4, 6, 8],
    resolutionEnum: ['720p', '1080p', '4k'],
    ratioKey: 'aspect_ratio',
    ratioEnum: ['16:9', '9:16'],
    audioKey: 'generate_audio',
    supportsSeed: true,
  },
  // --- Alibaba Wan 2.7 (free-form integer duration; audio param is a voice URL, not a toggle) ---
  'alibaba/wan-2.7/text-to-video': {
    resolutionEnum: ['720P', '1080P', '1080P-SR', '1440P-SR'],
    ratioKey: 'ratio',
    ratioEnum: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsSeed: true,
  },
  'alibaba/wan-2.7/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'last_image',
    resolutionEnum: ['720P', '1080P'],
    supportsSeed: true,
  },
  'alibaba/wan-2.7/reference-to-video': {
    referenceShape: 'images-videos',
    resolutionEnum: ['720P', '1080P'],
    ratioKey: 'ratio',
    ratioEnum: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsSeed: true,
  },
  // --- Wan 3.0 / 3.0 Prime (reference-to-video only — the variants whose schemas are verified).
  // Native 480p/720p/1080p plus -esr upscale tiers; audio costs the same either way. ---
  'alibaba/wan-3.0/reference-to-video': {
    referenceShape: 'refers',
    durationEnum: WAN_30_DURATIONS,
    resolutionEnum: WAN_30_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: WAN_30_RATIOS,
    audioKey: 'audio',
    supportsSeed: true,
  },
  'alibaba/wan-3.0-prime/reference-to-video': {
    referenceShape: 'refers',
    durationEnum: WAN_30_DURATIONS,
    resolutionEnum: WAN_30_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: WAN_30_RATIOS,
    audioKey: 'audio',
    supportsSeed: true,
  },
  // --- ByteDance Seedance 2.5 (flagship: 4-30s durations, no seed param in schema; i2v ratio is adaptive-only) ---
  'bytedance/seedance-2.5/text-to-video': {
    durationEnum: SEEDANCE_25_DURATIONS,
    resolutionEnum: SEEDANCE_25_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: SEEDANCE_25_RATIOS,
    audioKey: 'generate_audio',
    supportsWatermark: true,
  },
  'bytedance/seedance-2.5/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'last_image',
    durationEnum: SEEDANCE_25_DURATIONS,
    resolutionEnum: SEEDANCE_25_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: ['adaptive'], // output preserves the source image's aspect ratio
    audioKey: 'generate_audio',
    supportsWatermark: true,
  },
  'bytedance/seedance-2.5/reference-to-video': {
    referenceShape: 'paired-arrays',
    maxReferenceImages: 9,
    durationEnum: SEEDANCE_25_DURATIONS,
    resolutionEnum: SEEDANCE_25_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: SEEDANCE_25_RATIOS,
    audioKey: 'generate_audio',
    supportsWatermark: true,
  },
  // --- ByteDance Seedance 2.0 Mini (Seedance protocol but resolution enum has no plain "1080p") ---
  'bytedance/seedance-2.0-mini/text-to-video': {
    durationEnum: SEEDANCE_MINI_DURATIONS,
    resolutionEnum: SEEDANCE_MINI_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: SEEDANCE_MINI_RATIOS,
    audioKey: 'generate_audio',
    supportsSeed: true,
    supportsWatermark: true,
  },
  'bytedance/seedance-2.0-mini/image-to-video': {
    firstFrameKey: 'image',
    lastFrameKey: 'last_image',
    durationEnum: SEEDANCE_MINI_DURATIONS,
    resolutionEnum: SEEDANCE_MINI_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: SEEDANCE_MINI_RATIOS,
    audioKey: 'generate_audio',
    supportsSeed: true,
    supportsWatermark: true,
  },
  'bytedance/seedance-2.0-mini/reference-to-video': {
    referenceShape: 'paired-arrays',
    maxReferenceImages: 9,
    durationEnum: SEEDANCE_MINI_DURATIONS,
    resolutionEnum: SEEDANCE_MINI_RESOLUTIONS,
    ratioKey: 'ratio',
    ratioEnum: SEEDANCE_MINI_RATIOS,
    audioKey: 'generate_audio',
    supportsSeed: true,
    supportsWatermark: true,
  },
}

/** Curated spec lookup by exact model ID */
export function getVideoParamSpec(modelId: string): VideoParamSpec | undefined {
  return VIDEO_PARAM_SPECS[modelId]
}

// ==================== Value pickers ====================

/** Nearest allowed duration; ties break toward the shorter (cheaper/faster) option */
export function pickEnumDuration(allowed: number[], want: number): number | undefined {
  const candidates = allowed.filter((v) => Number.isFinite(v) && v > 0)
  if (candidates.length === 0) return undefined
  let best = candidates[0]
  for (const c of candidates) {
    const d = Math.abs(c - want)
    const bd = Math.abs(best - want)
    if (d < bd || (d === bd && c < best)) best = c
  }
  return best
}

/**
 * Parse a resolution tier string into a comparable pixel-height class.
 * Handles "480p" / "768P" / "1080p-SR" (leading digits) and "2K" / "4k" shorthands.
 */
function parseResTier(value: string): number | undefined {
  const lower = value.toLowerCase()
  const p = lower.match(/^(\d+)\s*p/)
  if (p) return Number(p[1])
  // k-shorthands carry suffixes too ("4k-esr"), so match the prefix rather than the whole string
  const k = lower.match(/^(\d+)\s*k/)
  if (!k) return undefined
  const n = Number(k[1])
  return n === 1 ? 1080 : n === 2 ? 1440 : n === 4 ? 2160 : undefined
}

/**
 * Pick the smallest tier that still covers the requested short side (quality-first
 * ceiling; equal-cost per-request pricing means never silently downgrading).
 * Plain tiers win over suffixed variants of the same class (720p over 720p-SR).
 */
export function pickResolution(allowed: string[], width: number, height: number): string | undefined {
  const minSide = Math.min(width, height)
  const parsed = allowed
    .map((v) => ({ v, tier: parseResTier(v) }))
    .filter((e): e is { v: string; tier: number } => e.tier !== undefined)
    .sort((a, b) => a.tier - b.tier || a.v.length - b.v.length)
  if (parsed.length === 0) return undefined
  const covering = parsed.find((e) => e.tier >= minSide)
  return (covering ?? parsed[parsed.length - 1]).v
}

/**
 * Pick the allowed aspect value nearest to width/height. Numeric "a:b" entries are
 * preferred over "adaptive" when dimensions are known (deterministic output framing);
 * an enum that only offers "adaptive" returns it as-is.
 */
export function pickRatio(allowed: string[], width: number, height: number): string | undefined {
  if (allowed.length === 0) return undefined
  const target = width / height
  let best: string | undefined
  let bestDiff = Infinity
  for (const value of allowed) {
    const m = value.match(/^(\d+):(\d+)$/)
    if (!m) continue
    const diff = Math.abs(Number(m[1]) / Number(m[2]) - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = value
    }
  }
  return best ?? (allowed.includes('adaptive') ? 'adaptive' : allowed[0])
}

// ==================== Body builder ====================

/**
 * Build the /model/generateVideo request body for a model with a known param spec.
 * Only fields the model's schema actually declares are emitted, so vendors with
 * strict input validation never see foreign params (the pre-billing failure mode
 * of issue #18, now avoided for video too).
 */
// ==================== Runtime spec derivation (dynamic discovery) ====================

interface OpenApiProperty {
  type?: string
  enum?: unknown[]
  default?: unknown
}

interface OpenApiInput {
  properties?: Record<string, OpenApiProperty>
  required?: string[]
}

/**
 * Derive a param spec from a model's published input schema
 * (each vendor's published model schema).
 * Returns undefined when the JSON doesn't look like an input schema, in which
 * case the caller falls back to the legacy request body.
 */
