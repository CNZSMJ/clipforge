/**
 * Per-endpoint request contracts for fal.ai IMAGE models.
 *
 * Same rationale as fal-video-params.ts: fal validates a request against the target endpoint's
 * published schema, and the families disagree on which fields exist at all —
 *   - flux/* takes seed + num_inference_steps + guidance_scale + enable_safety_checker
 *   - recraft/v4 takes none of those (prompt + image_size + colors + background_color only)
 *   - every gpt-image endpoint takes quality/background/output_format and NO seed
 *   - the /edit routes require `image_urls` (plural); plain image-to-image takes `image_url`
 *   - gpt-image-1.5 accepts only three literal size strings; everything else takes the
 *     {width,height} object and/or the square_hd-style presets
 *
 * Every field below was read off the endpoint's own OpenAPI:
 *   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<modelId>
 */

/** Aspect buckets shared by the square_hd preset family. */
const PRESET_RATIOS: ReadonlyArray<[string, number]> = [
  ['landscape_16_9', 16 / 9],
  ['landscape_4_3', 4 / 3],
  ['square_hd', 1],
  ['portrait_4_3', 3 / 4],
  ['portrait_16_9', 9 / 16],
]

const STD_PRESETS = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9']

/** quality enum shared by the gpt-image-2 / 2.5 endpoints */
const GPT_QUALITY = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

export interface FalImageSpec {
  /** Reference-image field. Absent ⇒ the endpoint is text-to-image only. */
  referenceField?: 'image_url' | 'image_urls'
  /** Accepts the {width,height} object form of image_size. */
  sizeObject?: boolean
  /** Accepted preset strings (in addition to, or instead of, the object form). */
  sizePresets?: string[]
  /** object-form constraints */
  multipleOf?: number
  minSide?: number
  maxSide?: number
  maxArea?: number
  /** Optional scalar fields the endpoint actually declares. */
  seed?: boolean
  negativePrompt?: boolean
  guidanceScale?: boolean
  steps?: boolean
  numImages?: boolean
}

const GPT25 = (referenceField?: 'image_urls'): FalImageSpec => ({
  ...(referenceField && { referenceField }),
  sizeObject: true,
  sizePresets: [...STD_PRESETS, 'auto'],
  // gpt-image wants multiples of 16, and no endpoint in the family declares a seed field
  multipleOf: 16,
  numImages: true,
})

export const FAL_IMAGE_SPECS: Record<string, FalImageSpec> = {
  'openai/gpt-image-2.5/sunburst/text-to-image': GPT25(),
  'openai/gpt-image-2.5/flare/text-to-image': GPT25(),
  'openai/gpt-image-2.5/sunburst/edit': GPT25('image_urls'),
  'openai/gpt-image-2.5/flare/edit': GPT25('image_urls'),
  'openai/gpt-image-2': GPT25(),
  'openai/gpt-image-2/edit': GPT25('image_urls'),

  'fal-ai/gpt-image-1.5': {
    sizePresets: ['1024x1024', '1536x1024', '1024x1536'],
  },

  'fal-ai/bytedance/seedream/v5/lite/edit': {
    referenceField: 'image_urls',
    sizeObject: true,
    sizePresets: [...STD_PRESETS, 'auto_2K', 'auto_3K', 'auto_4K'],
    numImages: true,
  },

  'fal-ai/flux/schnell': {
    sizeObject: true, sizePresets: STD_PRESETS,
    seed: true, steps: true, guidanceScale: true, numImages: true,
  },
  'fal-ai/flux/dev': {
    sizeObject: true, sizePresets: STD_PRESETS,
    seed: true, steps: true, guidanceScale: true, numImages: true,
  },
  'fal-ai/flux-pro/v1.1': {
    sizeObject: true, sizePresets: STD_PRESETS,
    seed: true, numImages: true,
  },
  'fal-ai/flux-2-pro': {
    sizeObject: true, sizePresets: STD_PRESETS,
    multipleOf: 16, minSide: 256, maxSide: 2560, maxArea: 4194304,
    seed: true,
  },
  // recraft declares none of seed / num_images / steps / guidance_scale
  'fal-ai/recraft/v4/pro/text-to-image': {
    sizeObject: true, sizePresets: STD_PRESETS,
  },
}

/** Unknown/custom endpoint: fall back to the naming convention for the reference field. */
export function getFalImageSpec(modelId: string): FalImageSpec {
  const known = FAL_IMAGE_SPECS[modelId]
  if (known) return known
  const id = modelId.toLowerCase()
  if (id.includes('/edit') || id.includes('image-to-image') || id.includes('seededit')) {
    return { referenceField: 'image_urls', sizeObject: true, sizePresets: STD_PRESETS }
  }
  return { sizeObject: true, sizePresets: STD_PRESETS }
}

/** Nearest preset for a requested aspect; "1024x1024"-style enums are matched by orientation. */
export function nearestFalImagePreset(
  width: number,
  height: number,
  presets?: string[],
): string | undefined {
  if (!presets?.length) return undefined
  const literal = presets.find((p) => /^\d+x\d+$/.test(p))
  if (literal) {
    if (width > height) return presets.find((p) => /^(\d+)x(\d+)$/.test(p) && Number(RegExp.$1) > Number(RegExp.$2)) ?? literal
    if (height > width) return presets.find((p) => /^(\d+)x(\d+)$/.test(p) && Number(RegExp.$2) > Number(RegExp.$1)) ?? literal
    return literal
  }
  const target = width / height
  let best: string | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const [name, ratio] of PRESET_RATIOS) {
    if (!presets.includes(name)) continue
    const delta = Math.abs(ratio - target)
    if (delta < bestDelta) { best = name; bestDelta = delta }
  }
  return best
}

/** Snap a requested size to the endpoint's constraints; returns the object form or undefined. */
function sizeObjectFor(
  width: number,
  height: number,
  spec: FalImageSpec,
): { width: number; height: number } | undefined {
  const round = (n: number) => {
    const step = spec.multipleOf ?? 1
    return Math.max(step, Math.round(n / step) * step)
  }
  let w = round(width)
  let h = round(height)
  if (spec.minSide) { w = Math.max(w, spec.minSide); h = Math.max(h, spec.minSide) }
  if (spec.maxSide) { w = Math.min(w, spec.maxSide); h = Math.min(h, spec.maxSide) }
  if (spec.maxArea && w * h > spec.maxArea) {
    const scale = Math.sqrt(spec.maxArea / (w * h))
    w = round(w * scale)
    h = round(h * scale)
  }
  return { width: w, height: h }
}

/**
 * Build the endpoint-specific image request body.
 * Exported for tests — the point of this module is that unsupported fields are never sent.
 */
export function buildFalImageRequest(options: {
  modelId: string
  prompt: string
  width?: number
  height?: number
  count?: number
  seed?: number
  steps?: number
  guidanceScale?: number
  negativePrompt?: string
  referenceImageUrl?: string
  referenceImageUrls?: string[]
  extra?: Record<string, unknown>
}): { modelId: string; body: Record<string, unknown> } {
  const spec = getFalImageSpec(options.modelId)
  const w = options.width ?? 0
  const h = options.height ?? 0

  const body: Record<string, unknown> = { prompt: options.prompt }

  if (w && h) {
    const object = spec.sizeObject ? sizeObjectFor(w, h, spec) : undefined
    const preset = nearestFalImagePreset(w, h, spec.sizePresets)
    const size = object ?? preset
    if (size !== undefined) body.image_size = size
  }

  const refs = options.referenceImageUrls?.length
    ? options.referenceImageUrls
    : options.referenceImageUrl
      ? [options.referenceImageUrl]
      : undefined
  if (refs && !spec.referenceField) {
    // Dropping the reference silently is the worst outcome: the caller asked for a product-faithful
    // render and would get an invented one. Fail loudly and name the endpoint to switch to.
    throw new Error(
      `模型 ${options.modelId} 是文生图端点，不接受参考图；请改用同档位的编辑端点（.../edit）。` +
        ' 否则商品图会被忽略，生成的画面与实物不符。'
    )
  }
  if (refs && spec.referenceField === 'image_urls') body.image_urls = refs
  else if (refs && spec.referenceField === 'image_url') body.image_url = refs[0]

  if (spec.numImages) body.num_images = options.count ?? 1
  if (spec.seed && options.seed != null) body.seed = options.seed
  if (spec.negativePrompt && options.negativePrompt) body.negative_prompt = options.negativePrompt
  if (spec.guidanceScale && options.guidanceScale != null) body.guidance_scale = options.guidanceScale
  if (spec.steps && options.steps != null) body.num_inference_steps = options.steps

  return { modelId: options.modelId, body: { ...body, ...options.extra } }
}
