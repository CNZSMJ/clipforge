// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/llm/models/route";
import {
  discoverModels, isFalOpenRouter, listModels, llmAuthHeaders, modelListHint,
  OPENROUTER_PUBLIC_MODELS_URL,
} from "@/lib/llm-models";
import { FAL_LLM_BASE_URL, FAL_ONEKEY_MODELS } from "@/lib/fal-onekey";
import { settings } from "@/lib/i18n/messages/settings";

const KEY = "test-fal-secret:must-not-be-forwarded";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const catalogue = () => json({ data: [{ id: FAL_ONEKEY_MODELS.llm }, { id: "anthropic/example" }] });
afterEach(() => vi.unstubAllGlobals());

// Regression for the screenshot: chat works but GET {falBase}/models does not exist.
describe("Fal OpenRouter model discovery", () => {
  it.each([FAL_LLM_BASE_URL, `${FAL_LLM_BASE_URL}/`, `  ${FAL_LLM_BASE_URL}//  `])("uses the public catalogue for %s, without leaking the fal key", async (base) => {
    const fetchMock = vi.fn().mockResolvedValue(catalogue());
    const result = await discoverModels(base, KEY, fetchMock);
    expect(result).toEqual({ ok: true, source: "openrouter-public", models: [FAL_ONEKEY_MODELS.llm, "anthropic/example"] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_PUBLIC_MODELS_URL);
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(KEY);
    expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("listing works without a key; it is not a credential validation or a generation request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(catalogue());
    expect((await discoverModels(FAL_LLM_BASE_URL, "", fetchMock)).ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined(); // GET, never a paid POST
    expect(llmAuthHeaders(FAL_LLM_BASE_URL, KEY)).toEqual({ Authorization: `Key ${KEY}` });
  });

  it.each([
    "https://fal.run.attacker.invalid/openrouter/router/openai/v1",
    "https://proxy.example/openrouter/router/openai/v1",
    "https://fal.run/something-else/v1",
    "https://fal.run/openrouter/router/openai/v10",
    "http://fal.run/openrouter/router/openai/v1",
    "https://fal.run:444/openrouter/router/openai/v1",
    `${FAL_LLM_BASE_URL}?proxy=yes`,
    `${FAL_LLM_BASE_URL}#extra`,
    "https://user:password@fal.run/openrouter/router/openai/v1",
  ])("does not rewrite custom/ambiguous endpoints: %s", (base) => {
    expect(isFalOpenRouter(base)).toBe(false);
  });

  it.each(["http://127.0.0.1:11434/v1", "https://openrouter.ai/api/v1", "https://proxy.example/v1"])("preserves endpoint-specific discovery/auth for %s", async (base) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [{ id: "custom:tag" }] }));
    expect(await discoverModels(`${base}/`, "own-key", fetchMock)).toMatchObject({ ok: true, source: "endpoint", models: ["custom:tag"] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/models`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer own-key" });
  });

  it("normalizes valid IDs and removes duplicates without inventing unavailable models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [null, {}, { id: 5 }, { id: " a " }, { id: "a" }, { id: " " }, { id: "b" }] }));
    expect(await listModels(FAL_LLM_BASE_URL, KEY, fetchMock)).toEqual(["a", "b"]);
  });

  it.each([[401, "MODEL_LIST_AUTH"], [403, "MODEL_LIST_AUTH"], [404, "MODEL_LIST_UNSUPPORTED"], [405, "MODEL_LIST_UNSUPPORTED"], [501, "MODEL_LIST_UNSUPPORTED"], [429, "MODEL_LIST_UNAVAILABLE"], [503, "MODEL_LIST_UNAVAILABLE"]])("reports HTTP %s separately (%s)", async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: KEY }, status as number));
    const result = await discoverModels("https://provider.example/v1", KEY, fetchMock);
    expect(result).toMatchObject({ ok: false, errorCode: code, models: [] });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([{}, null, { data: {} }, { data: [{ id: null }] }])("rejects malformed payloads: %j", async (body) => {
    expect(await discoverModels(FAL_LLM_BASE_URL, KEY, vi.fn().mockResolvedValue(json(body)))).toMatchObject({ ok: false, errorCode: "MODEL_LIST_INVALID_RESPONSE" });
  });

  it("treats a genuine empty catalogue as successful, not as a bad key", async () => {
    expect(await discoverModels(FAL_LLM_BASE_URL, KEY, vi.fn().mockResolvedValue(json({ data: [] })))).toEqual({ ok: true, source: "openrouter-public", models: [] });
  });

  it("handles timeout/network/JSON failures without leaking raw error details", async () => {
    const timeout = Object.assign(new Error(KEY), { name: "TimeoutError" });
    expect(await discoverModels(FAL_LLM_BASE_URL, KEY, vi.fn().mockRejectedValue(timeout))).toMatchObject({ ok: false, errorCode: "MODEL_LIST_TIMEOUT" });
    const fetchMock = vi.fn().mockRejectedValue(new Error(KEY));
    expect(await discoverModels(FAL_LLM_BASE_URL, KEY, fetchMock)).toMatchObject({ ok: false, errorCode: "MODEL_LIST_UNAVAILABLE" });
    expect(await listModels(FAL_LLM_BASE_URL, KEY, fetchMock)).toEqual([]);
    expect(await discoverModels(FAL_LLM_BASE_URL, KEY, vi.fn().mockResolvedValue(new Response("<html>not-json</html>")))).toMatchObject({ ok: false, errorCode: "MODEL_LIST_INVALID_RESPONSE" });
  });

  it("public model hints do not claim Fal account access or change preset defaults", () => {
    const defaultsBefore = { ...FAL_ONEKEY_MODELS };
    const hint = modelListHint([FAL_ONEKEY_MODELS.llm], "missing-model", FAL_LLM_BASE_URL)!;
    expect(hint.zh).toContain("公共模型目录");
    expect(hint.en).toContain("does not verify Fal account access");
    expect(FAL_ONEKEY_MODELS).toEqual(defaultsBefore);
  });
});

const request = (body: unknown) => new NextRequest("http://localhost/api/llm/models", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
describe("Settings model-list API", () => {
  it("exercises the actual API -> Fal discovery -> public response path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(catalogue());
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request({ baseUrl: FAL_LLM_BASE_URL, apiKey: KEY }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, source: "openrouter-public", models: [FAL_ONEKEY_MODELS.llm, "anthropic/example"] });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(KEY);
  });

  it("retains catalogue origin and stable error codes on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`upstream leaked ${KEY}`)));
    const response = await POST(request({ baseUrl: FAL_LLM_BASE_URL, apiKey: KEY }));
    const result = await response.json();
    expect(result).toMatchObject({ ok: false, models: [], source: "openrouter-public", errorCode: "MODEL_LIST_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("returns a successful empty list so the UI can show its empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: [] })));
    expect(await (await POST(request({ baseUrl: "http://localhost:11434/v1" }))).json()).toMatchObject({ ok: true, models: [] });
  });

  it.each([null, {}, { baseUrl: 5 }, { baseUrl: "file:///etc/passwd" }, { baseUrl: "https://u:p@host/v1" }, { baseUrl: "https://host/v1", apiKey: {} }, { baseUrl: "https://host/v1?key=secret" }])("rejects invalid settings %j before any network call", async (body) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a stable 400", async () => {
    const response = await POST(new NextRequest("http://localhost/api/llm/models", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect((await response.json()).errorCode).toBe("INVALID_REQUEST");
  });

  it("provides all new UI messages in both supported locales", () => {
    for (const key of ["modelListPublicButton", "modelListPublicNote", "modelListPublicFailed", "modelListAuthFailed", "modelListUnsupported", "modelListTimedOut"]) {
      expect(settings.zh[key]).toBeTruthy(); expect(settings.en[key]).toBeTruthy();
    }
    expect(settings.zh.presetFalTip).not.toContain("需手填");
  });
});
