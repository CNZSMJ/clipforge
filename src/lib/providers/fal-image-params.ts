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

export interface FalImageSpec {
  /** Reference-image field. Absent ⇒ the endpoint is text-to-image only. */
  referenceField?: 'image_url' | 'image_urls'
  /** The endpoint rejects the request unless a reference is supplied (every /edit route does). */
  requiresReference?: boolean
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
  maxImages?: number
  maxSteps?: number
}

const GPT25 = (referenceField?: 'image_urls', requiresReference?: boolean): FalImageSpec => ({
  ...(referenceField && { referenceField }),
  ...(requiresReference && { requiresReference: true }),
  sizeObject: true,
  sizePresets: [...STD_PRESETS, 'auto'],
  // gpt-image wants multiples of 16, and no endpoint in the family declares a seed field
  multipleOf: 16,
  numImages: true, maxImages: 10,
})

export const FAL_IMAGE_SPECS: Record<string, FalImageSpec> = {
  'openai/gpt-image-2.5/sunburst/text-to-image': GPT25(),
  'openai/gpt-image-2.5/flare/text-to-image': GPT25(),
  'openai/gpt-image-2.5/sunburst/edit': GPT25('image_urls', true),
  'openai/gpt-image-2.5/flare/edit': GPT25('image_urls', true),
  'openai/gpt-image-2': { ...GPT25(), maxImages: 4 },
  'openai/gpt-image-2/edit': { ...GPT25('image_urls', true), maxImages: 4 },

  'fal-ai/gpt-image-1.5': {
    sizePresets: ['1024x1024', '1536x1024', '1024x1536'],
    numImages: true,
  },
  'fal-ai/gpt-image-1.5/edit': { referenceField: 'image_urls', requiresReference: true, sizePresets: ['1024x1024', '1536x1024', '1024x1536'], numImages: true },

  'fal-ai/bytedance/seedream/v5/lite/text-to-image': { sizeObject: true, sizePresets: [...STD_PRESETS, 'auto_2K', 'auto_3K', 'auto_4K'], maxSide: 4096, numImages: true, maxImages: 6 },
  'fal-ai/bytedance/seedream/v5/lite/edit': {
    referenceField: 'image_urls',
    requiresReference: true,
    sizeObject: true,
    sizePresets: [...STD_PRESETS, 'auto_2K', 'auto_3K', 'auto_4K'],
    numImages: true, maxImages: 6,
  },

  'fal-ai/flux/schnell': {
    sizeObject: true, sizePresets: STD_PRESETS,
    seed: true, steps: true, maxSteps: 12, guidanceScale: true, numImages: true,
  },
  'fal-ai/flux/dev': {
    sizeObject: true, sizePresets: STD_PRESETS,
    seed: true, steps: true, maxSteps: 50, guidanceScale: true, numImages: true,
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
    return { referenceField: 'image_urls', requiresReference: true, sizeObject: true, sizePresets: STD_PRESETS }
  }
  return { sizeObject: true, sizePresets: STD_PRESETS }
}

/**
 * Edit <-> text-to-image pairs for the same model tier. Verified against both endpoints' OpenAPI:
 * each /edit route requires image_urls, each text-to-image route requires only prompt.
 * NOTE gpt-image-2 and gpt-image-1.5 do not use a /text-to-image suffix.
 */
const FAL_IMAGE_SIBLINGS: ReadonlyArray<[edit: string, textOnly: string]> = [
  ['openai/gpt-image-2.5/sunburst/edit', 'openai/gpt-image-2.5/sunburst/text-to-image'],
  ['openai/gpt-image-2.5/flare/edit', 'openai/gpt-image-2.5/flare/text-to-image'],
  ['openai/gpt-image-2/edit', 'openai/gpt-image-2'],
  ['fal-ai/gpt-image-1.5/edit', 'fal-ai/gpt-image-1.5'],
  ['fal-ai/bytedance/seedream/v5/lite/edit', 'fal-ai/bytedance/seedream/v5/lite/text-to-image'],
]

/**
 * The sibling endpoint that actually fits what we have.
 *
 * A storyboard mixes product shots (which carry the product photo) with plain B-roll shots (which
 * do not), so one "default image model" cannot be right for every call. Rather than making the user
 * switch per shot — or submitting a /edit call with no image_urls, which fal rejects with a 422 and
 * still reports as COMPLETED — route to the sibling of the same tier.
 */
export function falImageSibling(modelId: string, needsReference: boolean): string | undefined {
  const spec = FAL_IMAGE_SPECS[modelId] ?? getFalImageSpec(modelId)
  const acceptsReference = Boolean(spec.referenceField)
  if (needsReference === acceptsReference) return undefined
  for (const [edit, textOnly] of FAL_IMAGE_SIBLINGS) {
    if (needsReference && modelId === textOnly) return edit
    if (!needsReference && modelId === edit) return textOnly
  }
  return undefined
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
    const step = spec.multipleOf ?? 1
    while (w * h > spec.maxArea) { if (w >= h) w -= step; else h -= step }
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
  for (const value of [options.width, options.height, options.count]) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error('图片尺寸和数量必须是正数')
  }
  if (options.seed != null && !Number.isSafeInteger(options.seed)) throw new Error('seed 必须是安全整数')
  const refs = options.referenceImageUrls?.length
    ? options.referenceImageUrls
    : options.referenceImageUrl
      ? [options.referenceImageUrl]
      : undefined

  // Route to the sibling that fits what we have BEFORE validating: a B-roll shot carries no
  // reference and must never be submitted to an /edit route.
  if (refs?.some((url) => typeof url !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(url))) throw new Error('参考图必须是上传完成后的 URL')
  const modelId = falImageSibling(options.modelId, refs != null) ?? options.modelId
  const spec = getFalImageSpec(modelId)
  const count = options.count ?? 1
  const maxCount = spec.numImages ? spec.maxImages ?? 4 : 1
  if (!Number.isInteger(count) || count > maxCount) throw new Error(`该端点每次最多生成 ${maxCount} 张图片`)
  if (refs && refs.length > 16) throw new Error('参考图超过上限，不能静默丢弃身份或商品条件')
  if ((options.width == null) !== (options.height == null)) throw new Error('图片宽高必须同时指定')
  if (refs && spec.referenceField === 'image_url' && refs.length > 1) throw new Error('该模型仅支持一张参考图，无法保留当前多参考条件')
  const w = options.width ?? 0
  const h = options.height ?? 0

  const body: Record<string, unknown> = { prompt: options.prompt }

  if (w && h) {
    const object = spec.sizeObject ? sizeObjectFor(w, h, spec) : undefined
    const preset = nearestFalImagePreset(w, h, spec.sizePresets)
    const size = object ?? preset
    if (size !== undefined) body.image_size = size
  }

  if (refs && !spec.referenceField) {
    // Dropping the reference silently is the worst outcome: the caller asked for a product-faithful
    // render and would get an invented one. Fail loudly and name the endpoint to switch to.
    throw new Error(
      `模型 ${options.modelId} 是文生图端点，不接受参考图；请改用同档位的编辑端点（.../edit）。` +
        ' 否则商品图会被忽略，生成的画面与实物不符。'
    )
  }
  if (!refs && spec.requiresReference) {
    // No sibling could be resolved: fail before submitting so nothing is queued or billed.
    throw new Error(
      '模型 ' + modelId + ' 必须提供参考图（image_urls）才能提交；这一镜头没有参考图，' +
        ' 请在设置里改用同档位的文生图端点（.../text-to-image）。'
    )
  }
  if (refs && spec.referenceField === 'image_urls') body.image_urls = refs
  else if (refs && spec.referenceField === 'image_url') body.image_url = refs[0]

  if (spec.numImages) body.num_images = options.count ?? 1
  if (spec.seed && options.seed != null) body.seed = options.seed
  if (spec.negativePrompt && options.negativePrompt) body.negative_prompt = options.negativePrompt
  if (spec.guidanceScale && options.guidanceScale != null) {
    if (!Number.isFinite(options.guidanceScale) || options.guidanceScale < 1 || options.guidanceScale > 20) throw new Error('guidanceScale 必须在 1 到 20 之间')
    body.guidance_scale = options.guidanceScale
  }
  if (spec.steps && options.steps != null) {
    if (!Number.isInteger(options.steps) || options.steps < 1) throw new Error('steps 必须是正整数')
    body.num_inference_steps = Math.min(options.steps, spec.maxSteps ?? 50)
  }

  const extra = { ...options.extra }
  for (const key of ['prompt', 'image_url', 'image_urls', 'image_size', 'num_images', 'seed', 'num_inference_steps', 'guidance_scale', 'negative_prompt', 'sync_mode', 'max_images']) delete extra[key]
  // Queue results must remain retrievable; sync_mode=true removes them from request history.
  // Keep provider defaults for sync_mode=false and max_images=1 rather than allowing hidden fan-out.
  return { modelId, body: { ...extra, ...body } }
}
