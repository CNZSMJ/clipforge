/**
 * Model discovery for OpenAI-compatible endpoints.
 *
 * Kept dependency-free so both the connection probe and the generation error path can use it without
 * an import cycle. Purpose is narrow: when a model name turns out to be wrong, say which names are
 * right instead of leaving the user to guess (issue #19 follow-up — a local Ollama was serving
 * `qwen2.5:7b-instruct` while the app asked for `qwen2.5`, and all the user ever saw was a 404).
 */

const MODELS_TIMEOUT_MS = 8000;

/** Bilingual text, structurally identical to llm-error's LLMMessagePair (declared here to stay dep-free). */
export interface ModelHint {
  zh: string;
  en: string;
}

/** Strip trailing slashes so `${base}/models` never doubles up. */
export function normalizeBase(baseUrl: string): string {
  return String(baseUrl).trim().replace(/\/+$/, "");
}


/**
 * Base URL used for chat and model-list calls. Kept as a named seam so every caller normalises the
 * same way; a vendor that serves chat and media on different paths is handled by its own preset.
 */
export function normalizeChatBase(baseUrl: string): string {
  return normalizeBase(baseUrl);
}

/** fal's OpenAI-shaped API uses fal credentials, not an OpenAI Bearer key. */
export function llmAuthHeaders(baseUrl: string | undefined, apiKey: string): Record<string, string> {
  let fal = false;
  try { const url = new URL(baseUrl || ""); fal = url.hostname === "fal.run" && url.pathname.startsWith("/openrouter/router/openai/"); } catch { /* custom/default client */ }
  return { Authorization: `${fal ? "Key" : "Bearer"} ${apiKey}` };
}

/** True for a local Ollama endpoint — its model ids carry a `:tag` that must be typed in full. */
export function isOllama(baseUrl?: string): boolean {
  return /:11434(\/|$)|\bollama\b/i.test(baseUrl || "");
}

/** Only the official fal chat gateway uses OpenRouter's public discovery service.
 * Custom gateways (including proxies with a similar path) retain their own /models endpoint.
 */
export function isFalOpenRouter(baseUrl?: string): boolean {
  try {
    const url = new URL(normalizeChatBase(baseUrl || ""));
    return url.protocol === "https:" && url.hostname === "fal.run" && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/openrouter/router/openai/v1";
  } catch { return false; }
}

export const OPENROUTER_PUBLIC_MODELS_URL = "https://openrouter.ai/api/v1/models";
export type ModelListSource = "endpoint" | "openrouter-public";
export type ModelListErrorCode =
  | "MODEL_LIST_AUTH" | "MODEL_LIST_UNSUPPORTED" | "MODEL_LIST_TIMEOUT"
  | "MODEL_LIST_UNAVAILABLE" | "MODEL_LIST_INVALID_RESPONSE";
export type ModelDiscoveryResult =
  | { ok: true; models: string[]; source: ModelListSource }
  | { ok: false; models: string[]; source: ModelListSource; errorCode: ModelListErrorCode };

/**
 * Discover names, NOT account permissions. fal exposes chat completions but no GET /models.
 * Use the public OpenRouter catalogue for that gateway WITHOUT forwarding the fal key.
 * Empty, unsupported, authentication failure and transient failure are different outcomes.
 * No generation requests, static model guesses or persisted-setting changes occur here.
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelDiscoveryResult> {
  const source: ModelListSource = isFalOpenRouter(baseUrl) ? "openrouter-public" : "endpoint";
  const failure = (errorCode: ModelListErrorCode): ModelDiscoveryResult => ({ ok: false, models: [], source, errorCode });
  const signal = AbortSignal.timeout(MODELS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(source === "openrouter-public"
      ? OPENROUTER_PUBLIC_MODELS_URL : `${normalizeChatBase(baseUrl)}/models`, {
      // A Fal key must never reach OpenRouter, including through redirects or cookies.
      headers: source === "openrouter-public" ? { Accept: "application/json" } : llmAuthHeaders(baseUrl, apiKey),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!res.ok) {
      // Consume/cancel unused responses so failed lookups do not tie up HTTP connections.
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) return failure("MODEL_LIST_AUTH");
      if (res.status === 404 || res.status === 405 || res.status === 501) return failure("MODEL_LIST_UNSUPPORTED");
      return failure("MODEL_LIST_UNAVAILABLE");
    }
    let json: { data?: Array<{ id?: unknown }> } | null;
    try { json = await res.json(); }
    catch { return failure(signal.aborted ? "MODEL_LIST_TIMEOUT" : "MODEL_LIST_INVALID_RESPONSE"); }
    if (signal.aborted) return failure("MODEL_LIST_TIMEOUT");
    if (!Array.isArray(json?.data)) return failure("MODEL_LIST_INVALID_RESPONSE");
    const models = [...new Set(json.data.map((m) => typeof m?.id === "string" ? m.id.trim() : "").filter(Boolean))];
    // A genuine empty catalogue is OK. A populated payload with no valid IDs is malformed.
    if (json.data.length > 0 && models.length === 0) return failure("MODEL_LIST_INVALID_RESPONSE");
    return { ok: true, models, source };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name));
    return failure(timedOut ? "MODEL_LIST_TIMEOUT" : "MODEL_LIST_UNAVAILABLE");
  }
}

/** Best-effort wrapper for existing error hints; discovery failures never mask a generation error. */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return (await discoverModels(baseUrl, apiKey, fetchImpl)).models;
}

/**
 * Turn "model not found" into something actionable: name the models the endpoint really has, and —
 * the common local-Ollama case — point at the pulled tag when the typed name is a prefix of it.
 */
export function modelListHint(models: string[], wanted?: string, baseUrl?: string): ModelHint | undefined {
  if (models.length === 0) {
    return isOllama(baseUrl)
      ? {
          zh: "（本机 Ollama 一个模型都没读到：先在终端跑 `ollama pull qwen2.5`，并确认 Ollama 正在运行）",
          en: "(no models found on this local Ollama: run `ollama pull qwen2.5` and make sure Ollama is running)",
        }
      : undefined;
  }

  const wantedLower = wanted?.toLowerCase();
  const guess = wantedLower
    ? models.find((m) => m.toLowerCase().startsWith(`${wantedLower}:`)) ||
      models.find((m) => m.toLowerCase().includes(wantedLower))
    : undefined;

  const shown = models.slice(0, 8);
  const list = `${shown.join("、")}${models.length > shown.length ? `…（共 ${models.length} 个）` : ""}`;
  const listEn = `${shown.join(", ")}${models.length > shown.length ? `… (${models.length} total)` : ""}`;
  const tagNote = isOllama(baseUrl) ? "（Ollama 的模型名必须写全，含 :tag）" : "";
  const tagNoteEn = isOllama(baseUrl) ? " (Ollama model names must include the :tag)" : "";

  if (isFalOpenRouter(baseUrl)) {
    return {
      zh: `OpenRouter 公共模型目录：${list}。这不是 Fal 账户授权列表，请用所选模型测试连接。`,
      en: `OpenRouter public model catalogue: ${listEn}. This does not verify Fal account access; test the selected model's connection.`,
    };
  }

  return {
    zh: `${guess ? `是不是想填「${guess}」？` : ""}该地址实际可用的模型：${list}${tagNote}`,
    en: `${guess ? `Did you mean "${guess}"? ` : ""}Models this endpoint actually exposes: ${listEn}${tagNoteEn}`,
  };
}
