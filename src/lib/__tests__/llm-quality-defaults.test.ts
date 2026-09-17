import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FAL_LLM_BASE_URL, FAL_ONEKEY_MODELS, upgradeFalQualityDefaults } from "@/lib/fal-onekey";
import { LLM_PRESETS } from "@/lib/llm-presets";
import { createLLMClient, jsonModeParams } from "@/lib/llm-error";
import { probeLLMEndpoint } from "@/lib/llm-probe";
import { migrateSettings, useSettingsStore, type SettingsState } from "@/lib/stores/settings-store";
import { isOpenRouterChatBase, qualityModelFetch } from "@/lib/llm-quality-policy";

const OLD = "google/gemini-2.5-flash";
const FABLE = "anthropic/claude-fable-5.1";
const ASTRA = "openai/gpt-6-astra";
const old = () => ({ provider: "fal.ai", baseUrl: FAL_LLM_BASE_URL, apiKey: "TEST-ONLY", model: OLD, visionModel: OLD });
const fresh = () => JSON.parse(JSON.stringify(useSettingsStore.getInitialState())) as SettingsState;
beforeEach(() => { useSettingsStore.setState(useSettingsStore.getInitialState(), true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("quality-first model defaults", () => {
  it("uses the verified router IDs without changing image/video defaults", () => {
    expect(FAL_ONEKEY_MODELS).toMatchObject({ llm: FABLE, vision: ASTRA,
      image: "openai/gpt-image-2.5/sunburst/edit", video: "bytedance/seedance-2.5/image-to-video" });
  });
  it("one-key setup configures distinct script and vision models", () => {
    useSettingsStore.getState().applyFalOneKey("TEST-ONLY");
    expect(useSettingsStore.getState().llm).toMatchObject({ model: FABLE, visionModel: ASTRA, apiKey: "TEST-ONLY", baseUrl: FAL_LLM_BASE_URL });
  });
  it.each(["fal.ai (OpenRouter)", "OpenRouter"])("%s preset contains the same pair", (label) => {
    expect(LLM_PRESETS.find(p => p.label === label)).toMatchObject({ model: FABLE, visionModel: ASTRA });
  });
  it("the settings button does not overwrite the vision preset with the text model", () => {
    expect(readFileSync("src/app/settings/page.tsx", "utf8")).toContain("visionModel: preset.visionModel ?? preset.model");
  });
  it("migrates the legacy pair without changing credentials", () => {
    expect(upgradeFalQualityDefaults(old())).toEqual({ ...old(), model: FABLE, visionModel: ASTRA });
  });
  it("migrates an implicit vision fallback together with the legacy script model", () => {
    expect(upgradeFalQualityDefaults({ ...old(), visionModel: "" })).toMatchObject({ model: FABLE, visionModel: ASTRA });
  });
  it("preserves independently selected script and vision models", () => {
    expect(upgradeFalQualityDefaults({ ...old(), model: "custom-text" })).toMatchObject({ model: "custom-text", visionModel: ASTRA });
    expect(upgradeFalQualityDefaults({ ...old(), visionModel: "custom-vision" })).toMatchObject({ model: FABLE, visionModel: "custom-vision" });
    expect(upgradeFalQualityDefaults({ ...old(), model: "custom-text", visionModel: "" })).toMatchObject({ model: "custom-text", visionModel: "" });
  });
  it.each(["https://proxy.example/v1", "https://fal.run.evil.test/openrouter/router/openai/v1", "https://fal.run:444/openrouter/router/openai/v1", "http://fal.run/openrouter/router/openai/v1", "https://fal.run/openrouter/router/openai/v1?x=1"])("does not migrate noncanonical base %s", (baseUrl) => {
    const input = { ...old(), baseUrl }; expect(upgradeFalQualityDefaults(input)).toEqual(input);
  });
  it("v7 migrates persisted settings once and preserves media, narration and spend limits", () => {
    const state = fresh(); state.llm = old(); const before = structuredClone(state);
    const result = migrateSettings(state, 6);
    expect(result.llm).toMatchObject({ model: FABLE, visionModel: ASTRA });
    expect(result.tts).toEqual(before.tts); expect(result.defaultImageModel).toBe(before.defaultImageModel);
    expect(result.defaultVideoModel).toBe(before.defaultVideoModel); expect(result.spendCapUsd).toBe(before.spendCapUsd);
    const manuallyReverted = fresh(); manuallyReverted.llm = old();
    expect(migrateSettings(manuallyReverted, 7).llm).toEqual(old());
    expect(useSettingsStore.persist.getOptions().version).toBe(7);
  });
  it("is idempotent and leaves an empty, unconfigured provider alone", () => {
    const once = upgradeFalQualityDefaults(old()); expect(upgradeFalQualityDefaults(once)).toEqual(once);
    expect(migrateSettings(fresh(), 6).llm).toEqual(fresh().llm);
  });
});

describe("reasoning-model transport compatibility", () => {
  it.each([FABLE, ASTRA])("adapts %s before the first request, retaining payload and auth", async (model) => {
    const response = new Response("stream untouched");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const body = { model, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://images.test/p.png", detail: "high" } }] }], temperature: 0.2, top_p: 0.9, max_tokens: 2000, stream: true, response_format: { type: "json_object" } };
    const init = { method: "POST", headers: { Authorization: "Key TEST-ONLY" }, body: JSON.stringify(body) };
    expect(await qualityModelFetch(FAL_LLM_BASE_URL, fetchMock)(`${FAL_LLM_BASE_URL}/chat/completions`, init)).toBe(response);
    const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent).toMatchObject({ model, max_tokens: 32768, reasoning: { effort: "high", exclude: true }, messages: body.messages, stream: true, response_format: body.response_format });
    expect(sent.temperature).toBeUndefined(); expect(sent.top_p).toBeUndefined();
    expect(fetchMock.mock.calls[0][1]!.headers).toEqual(init.headers); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(init.body)).toEqual(body);
  });
  it("preserves explicit reasoning and completion-budget settings", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const body = { model: ASTRA, reasoning: { effort: "low" }, max_completion_tokens: 5000 };
    await qualityModelFetch(FAL_LLM_BASE_URL, fetchMock)(`${FAL_LLM_BASE_URL}/chat/completions`, { method: "POST", body: JSON.stringify(body) });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual(body);
  });
  it.each(["https://proxy.example/v1", "https://openrouter.ai.evil.test/api/v1", "http://openrouter.ai/api/v1", "https://openrouter.ai/api/v1?token=bad"])("leaves custom endpoint %s untouched", (base) => {
    const fetchMock = vi.fn<typeof fetch>(); expect(qualityModelFetch(base, fetchMock)).toBe(fetchMock); expect(isOpenRouterChatBase(base)).toBe(false);
  });
  it("leaves other models, unrelated paths, and malformed bodies untouched", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok"));
    for (const [path, body] of [["/chat/completions", JSON.stringify({ model: OLD, temperature: 0.8, max_tokens: 10 })], ["/models", JSON.stringify({ model: FABLE })], ["/chat/completions", "not json"], ["/chat/completions", "null"], ["/chat/completions", "[]"]]) {
      const init = { method: "POST", body };
      await qualityModelFetch(FAL_LLM_BASE_URL, fetchMock)(`${FAL_LLM_BASE_URL}${path}`, init);
      expect(fetchMock.mock.lastCall![1]).toBe(init);
    }
  });
  it("the shared SDK uses the actual vision model, not the client text-model setting", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "test", object: "chat.completion", created: 1, model: ASTRA, choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    // Shared clients execute in API routes, not in a browser; keep the SDK browser guard enabled.
    vi.stubGlobal("window", undefined);
    const client = createLLMClient({ ...old(), model: FABLE });
    const result = await client.chat.completions.create({ model: ASTRA, messages: [{ role: "user", content: "Return JSON" }], temperature: 0.3, max_tokens: 2000 });
    expect(result.choices[0].message.content).toBe('{"ok":true}');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ model: ASTRA, max_tokens: 32768 });
    expect(new Headers(fetchMock.mock.calls[0][1]!.headers).get("Authorization")).toBe("Key TEST-ONLY");
  });
  it("connection probes remain small and do not run with the production high-effort budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    expect((await probeLLMEndpoint({ ...old(), model: FABLE, fetchImpl: fetchMock })).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ model: FABLE, max_tokens: 2048, reasoning: { effort: "low", exclude: true } });
  });
  it("enables JSON object mode only for trusted router bases in addition to existing providers", () => {
    expect(jsonModeParams(FAL_LLM_BASE_URL)).toEqual({ response_format: { type: "json_object" } });
    expect(jsonModeParams("https://openrouter.ai/api/v1")).toEqual({ response_format: { type: "json_object" } });
    expect(jsonModeParams("https://proxy.example/v1")).toEqual({});
  });
});
