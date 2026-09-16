/**
 * fal.ai "one key covers everything" preset for quick onboarding.
 *
 * A single fal key unlocks script generation (LLM), product-image analysis (Vision), image
 * generation, video generation and voiceover (TTS) — so the onboarding panel never has to send a
 * beginner hunting for a second vendor's key.
 *
 * The LLM route is fal's OpenRouter gateway: OpenAI-compatible, shares the fal key.
 * Verified 2026-09-15, all HTTP 200 with a normal completion, using `Authorization: Bearer <FAL_KEY>`
 * (fal also accepts `Key <FAL_KEY>`):
 *   openai/gpt-4o-mini · google/gemini-2.5-flash · deepseek/deepseek-chat · anthropic/claude-sonnet-4
 *
 * Caveat: `GET {base}/models` returns 404, so the settings "read available models" button cannot
 * enumerate this endpoint — the model id has to be typed.
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
  /**
   * Script (LLM): fast multimodal model with clean JSON output. Swap for
   * `anthropic/claude-sonnet-4` when script quality matters more than cost.
   */
  llm: "google/gemini-2.5-flash",
  /** Product-image analysis (Vision) — same multimodal model. */
  vision: "google/gemini-2.5-flash",
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
