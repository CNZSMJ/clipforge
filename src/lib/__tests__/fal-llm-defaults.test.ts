import { beforeEach, describe, expect, it } from "vitest";
import { FAL_LLM_BASE_URL, FAL_ONEKEY_MODELS } from "../fal-onekey";
import { LLM_PRESETS } from "../llm-presets";
import { migrateSettings, useSettingsStore, type SettingsState } from "../stores/settings-store";
const model = "google/gemini-3.8-flash";
const old = "google/gemini-2.5-flash";
const fresh = () => JSON.parse(JSON.stringify(useSettingsStore.getInitialState())) as SettingsState;
beforeEach(() => useSettingsStore.setState(useSettingsStore.getInitialState(), true));

describe("balanced Fal defaults and one-time migration", () => {
  it("initial store and Fal preset share explicit text/vision defaults without inventing a key", () => {
    expect(FAL_ONEKEY_MODELS).toMatchObject({ llm: model, vision: model,
      image: "openai/gpt-image-2.5/sunburst/edit", video: "bytedance/seedance-2.5/image-to-video" });
    expect(useSettingsStore.getInitialState().llm).toMatchObject({ model, visionModel: model, apiKey: "", baseUrl: FAL_LLM_BASE_URL });
    expect(LLM_PRESETS.find(p => p.baseUrl === FAL_LLM_BASE_URL)?.model).toBe(model);
    expect(useSettingsStore.persist.getOptions().version).toBe(8);
  });
  it("upgrades the old official Fal preset while preserving keys and all media choices", () => {
    const state = fresh();
    state.llm = { provider: "fal.ai", baseUrl: `${FAL_LLM_BASE_URL}/`, apiKey: "KEEP", model: old, visionModel: old };
    state.defaultImageModel = "my-image"; state.defaultVideoModel = "my-video";
    const changed = migrateSettings(state, 6);
    expect(changed.llm).toMatchObject({ model, visionModel: model, apiKey: "KEEP", baseUrl: `${FAL_LLM_BASE_URL}/` });
    expect(changed.defaultImageModel).toBe("my-image"); expect(changed.defaultVideoModel).toBe("my-video");
  });
  it.each(["", undefined])("fills an unset vision default (%s) when upgrading bundled text", (visionModel) => {
    const state = fresh(); state.llm = { ...state.llm, model: old, visionModel };
    expect(migrateSettings(state, 6).llm).toMatchObject({ model, visionModel: model });
  });
  it("preserves a custom vision model while upgrading bundled text", () => {
    const state = fresh(); state.llm = { ...state.llm, model: old, visionModel: "custom-vision" };
    expect(migrateSettings(state, 6).llm).toMatchObject({ model, visionModel: "custom-vision" });
  });
  it("preserves a custom text model and its deliberate vision fallback", () => {
    const state = fresh(); state.llm = { ...state.llm, model: "custom-text", visionModel: "" };
    expect(migrateSettings(state, 6).llm).toMatchObject({ model: "custom-text", visionModel: "" });
  });
  it("upgrades bundled vision without replacing custom text", () => {
    const state = fresh(); state.llm = { ...state.llm, model: "custom-text", visionModel: old };
    expect(migrateSettings(state, 6).llm).toMatchObject({ model: "custom-text", visionModel: model });
  });
  it.each(["https://openrouter.ai/api/v1", "https://example.com/openrouter/router/openai/v1", "https://fal.run.evil.invalid/openrouter/router/openai/v1"]) (
    "does not migrate models on another gateway: %s", (baseUrl) => {
      const state = fresh(); state.llm = { ...state.llm, baseUrl, model: old, visionModel: old };
      expect(migrateSettings(state, 6).llm).toMatchObject({ baseUrl, model: old, visionModel: old });
    });
  it("does not undo a manual re-selection of the old model after v7", () => {
    const state = fresh(); state.llm = { ...state.llm, model: old, visionModel: old };
    expect(migrateSettings(state, 7).llm).toMatchObject({ model: old, visionModel: old });
  });
  it("rehydrates a real v6 persisted store through the registered migration", async () => {
    const state = fresh(); state.llm = { ...state.llm, apiKey: "KEEP", model: old, visionModel: old };
    localStorage.setItem("daihuo-jianshou-settings", JSON.stringify({ state, version: 6 }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().llm).toMatchObject({ apiKey: "KEEP", model, visionModel: model });
    expect(JSON.parse(localStorage.getItem("daihuo-jianshou-settings")!).version).toBe(8);
  });
  it("key rotation keeps custom Fal model selections", () => {
    useSettingsStore.setState({ llm: { provider: "fal.ai", baseUrl: FAL_LLM_BASE_URL, apiKey: "OLD", model: "custom", visionModel: "custom-v" } });
    useSettingsStore.getState().applyFalOneKey("ROTATED");
    expect(useSettingsStore.getState().llm).toMatchObject({ apiKey: "ROTATED", model: "custom", visionModel: "custom-v" });
  });
  it("switching from another provider uses the Fal model IDs, not vendor-native names", () => {
    useSettingsStore.setState({ llm: { provider: "other", baseUrl: "https://example.com/v1", apiKey: "OLD", model: "native-model" } });
    useSettingsStore.getState().applyFalOneKey("FAL");
    expect(useSettingsStore.getState().llm).toMatchObject({ apiKey: "FAL", baseUrl: FAL_LLM_BASE_URL, model, visionModel: model });
  });
});


describe("cost requirement supersedes the parallel v7 premium default", () => {
  it("upgrades the exact former premium pair once and preserves its key", () => {
    const state = fresh();
    state.llm = { ...state.llm, model: "anthropic/claude-fable-5.1", visionModel: "openai/gpt-6-astra", apiKey: "KEEP" };
    expect(migrateSettings(state, 7).llm).toMatchObject({ model, visionModel: model, apiKey: "KEEP" });
  });
  it("does not replace an independently selected model in a mixed premium/custom pair", () => {
    const state = fresh();
    state.llm = { ...state.llm, model: "anthropic/claude-fable-5.1", visionModel: "my-vision" };
    expect(migrateSettings(state, 7).llm).toMatchObject({ model: "anthropic/claude-fable-5.1", visionModel: "my-vision" });
  });
  it("leaves a manually reselected premium pair alone after v8", () => {
    const state = fresh();
    state.llm = { ...state.llm, model: "anthropic/claude-fable-5.1", visionModel: "openai/gpt-6-astra" };
    expect(migrateSettings(state, 8).llm).toMatchObject({ model: "anthropic/claude-fable-5.1", visionModel: "openai/gpt-6-astra" });
  });
});
