/** Request compatibility for the researched quality-first Fal/OpenRouter defaults.
 * Keep this transport-only: never change prompts, model IDs, credentials or media inputs.
 */
import { isFalOpenRouter, normalizeChatBase } from "@/lib/llm-models";
import { FAL_ONEKEY_MODELS } from "@/lib/fal-onekey";

export function isOpenRouterChatBase(baseUrl?: string): boolean {
  if (isFalOpenRouter(baseUrl)) return true;
  try {
    const url = new URL(normalizeChatBase(baseUrl || ""));
    return url.protocol === "https:" && url.hostname === "openrouter.ai" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/api/v1";
  } catch { return false; }
}

/** Total completion budget includes hidden reasoning; it is not a target output length. */
export const QUALITY_COMPLETION_BUDGET = 32_768;
export const QUALITY_PROBE_BUDGET = 2_048;

export function qualityModelFetch(
  baseUrl: string | undefined,
  baseFetch: typeof fetch = fetch,
  probe = false,
): typeof fetch {
  if (!isOpenRouterChatBase(baseUrl)) return baseFetch;
  const completionUrl = `${normalizeChatBase(baseUrl || "")}/chat/completions`;
  return async (url, init) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== completionUrl || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      return baseFetch(url, init);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(init.body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return baseFetch(url, init);
      body = { ...parsed };
    } catch { return baseFetch(url, init); }
    // Inspect the actual request model: image analysis may differ from config.model.
    if (body.model !== FAL_ONEKEY_MODELS.llm && body.model !== FAL_ONEKEY_MODELS.vision) {
      return baseFetch(url, init);
    }
    // Neither selected model advertises sampling/logprob controls in OpenRouter's catalogue.
    for (const key of ["temperature", "top_p", "logprobs", "top_logprobs"]) delete body[key];
    if (body.reasoning === undefined && body.reasoning_effort === undefined) {
      body.reasoning = { effort: probe ? "low" : "high", exclude: true };
    }
    // Preserve an explicit max_completion_tokens contract. Legacy internal max_tokens caps
    // (2k for product analysis, 16k for scripts) need space for mandatory reasoning.
    if (body.max_completion_tokens === undefined) {
      const cap = body.max_tokens;
      if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
        body.max_tokens = Math.max(cap, probe ? QUALITY_PROBE_BUDGET : QUALITY_COMPLETION_BUDGET);
      } else if (cap === undefined && !probe) {
        body.max_tokens = QUALITY_COMPLETION_BUDGET;
      }
    }
    // No retries here. In particular, never consume/replace successful streaming responses.
    return baseFetch(url, { ...init, body: JSON.stringify(body) });
  };
}
