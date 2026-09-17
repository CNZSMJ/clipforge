import { isFalOpenRouter } from "@/lib/llm-models";

/**
 * fal.ai "one key covers everything" preset for quick onboarding.
 *
 * A single fal key unlocks script generation (LLM), product-image analysis (Vision), image
 * generation, video generation and voiceover (TTS) — so the onboarding panel never has to send a
 * beginner hunting for a second vendor's key.
 *
 * The LLM route is fal's OpenRouter gateway: OpenAI-compatible, shares the fal key.
 * Use the documented `Authorization: Key <FAL_KEY>` scheme for this gateway.
 *
 * The gateway has no GET /models. Settings discover names via OpenRouter's public catalogue
 * without forwarding the Fal key; the selected model still needs a separate connection test.
 */

/** OpenAI-compatible chat gateway on fal (OpenRouter router); NOT the media queue host. */
export const FAL_LLM_BASE_URL = "https://fal.run/openrouter/router/openai/v1";

/** Media queue host — image / video / TTS calls all live here. */
export const FAL_BASE_URL = "https://queue.fal.run";

/** Default narration endpoint + voice (fal MiniMax Speech-02 family). */
export const FAL_TTS_MODEL = "fal-ai/minimax/speech-02-hd";
export const FAL_TTS_VOICE = "Wise_Woman";

/** Deep link to the fal API-key console. */
export const FAL_KEYS_URL = "https://fal.ai/dashboard/keys";

export const FAL_ONEKEY_MODELS = {
  /** Quality-first script model. Selection evidence: docs/llm-vision-model-selection.md. */
  llm: "anthropic/claude-fable-5.1",
  /** Product/frame understanding and reference-aware visual quality checks (not generation). */
  vision: "openai/gpt-6-astra",
  /**
   * Image generation: GPT Image 2.5 Sunburst Edit — the product-photo path feeds references, and
   * the /edit routes are the ones that accept image_urls. Swap to `.../sunburst/text-to-image`
   * for prompt-only work with no reference image.
   */
  image: "openai/gpt-image-2.5/sunburst/edit",
  /** Video generation: Seedance 2.5 image-to-video (the product photo becomes the first frame). */
  video: "bytedance/seedance-2.5/image-to-video",
} as const;

/**
 * Default image/video gen models: keep the user's existing choice; fall back to the fal defaults
 * only when nothing is configured (never overwrite user settings).
 */
export function fillFalModelDefaults(current: { image?: string; video?: string }): {
  image: string;
  video: string;
} {
  return {
    image: current.image?.trim() ? current.image : FAL_ONEKEY_MODELS.image,
    video: current.video?.trim() ? current.video : FAL_ONEKEY_MODELS.video,
  };
}

/** Upgrade only the retired default on the official Fal chat gateway; keep custom choices. */
export function upgradeFalQualityDefaults<T extends { baseUrl: string; model: string; visionModel?: string }>(current: T): T {
  if (!isFalOpenRouter(current.baseUrl)) return current;
  const legacy = "google/gemini-2.5-flash";
  const oldText = current.model === legacy;
  const oldVision = current.visionModel === legacy || (oldText && !current.visionModel?.trim());
  if (!oldText && !oldVision) return current;
  return { ...current,
    ...(oldText && { model: FAL_ONEKEY_MODELS.llm }),
    ...(oldVision && { visionModel: FAL_ONEKEY_MODELS.vision }),
  };
}
