import { isFalOpenRouter, normalizeChatBase } from "@/lib/llm-models";

/** Contract-specific policy; changing a default model does not automatically opt it into this one. */
const GEMINI_38 = "google/gemini-3.8-flash";

export function usesBalancedLlmPolicy(baseUrl: string | undefined, model: unknown): boolean {
  return model === GEMINI_38 && (isFalOpenRouter(baseUrl) ||
    normalizeChatBase(baseUrl || "") === "https://openrouter.ai/api/v1");
}

/**
 * Application defaults for the reviewed model, not a generic rewrite for every provider.
 * Google 3.8 removes sampling knobs and accepts low/medium/high thinking, NOT minimal/none.
 * Small legacy vision caps were written for visible JSON; give thinking + JSON 4096 total
 * tokens. Larger existing caps and explicit max_completion_tokens remain intact. These are
 * ceilings, not fixed charges; low thinking is not a hard reasoning-token budget.
 */
export function balancedChatBody(
  baseUrl: string | undefined,
  body: Record<string, unknown>,
  probe = false,
): Record<string, unknown> {
  if (!usesBalancedLlmPolicy(baseUrl, body.model)) return body;
  const result = { ...body };
  delete result.temperature;
  delete result.top_p;
  delete result.top_k;
  const visual = Array.isArray(body.messages) && body.messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => part && typeof part === "object" &&
      ["image_url", "input_image", "video_url", "input_audio"].includes((part as { type?: string }).type || ""));
  });
  const cap = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) ? body.max_tokens : undefined;
  if (body.reasoning === undefined && body.reasoning_effort === undefined) {
    // Scripts/planning keep medium reasoning; visual extraction and short utility calls use low.
    result.reasoning = { effort: probe || visual || (cap !== undefined && cap <= 4096) ? "low" : "medium" };
  }
  if (probe) {
    result.max_tokens = 512;
  } else if (body.max_completion_tokens === undefined) {
    if (body.max_tokens === undefined) result.max_tokens = 16000;
    else if (cap !== undefined && cap > 0 && cap < 4096) result.max_tokens = 4096;
  }
  return result;
}

/** Only chat POSTs to the exact configured gateway are eligible; never rewrite media/other URLs. */
export function balancedChatFetch(baseUrl: string | undefined, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (url, init) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== `${normalizeChatBase(baseUrl || "")}/chat/completions` ||
      init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return baseFetch(url, init);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(init.body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return baseFetch(url, init);
      body = parsed as Record<string, unknown>;
    } catch { return baseFetch(url, init); }
    const adjusted = balancedChatBody(baseUrl, body);
    return baseFetch(url, adjusted === body ? init : { ...init, body: JSON.stringify(adjusted) });
  };
}
