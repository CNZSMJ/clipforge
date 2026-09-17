import { beforeEach, describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore, type SettingsState } from '../stores/settings-store';
import { FAL_BASE_URL, FAL_LLM_BASE_URL, FAL_ONEKEY_MODELS, FAL_TTS_MODEL } from '../fal-onekey';
import { llmAuthHeaders } from '../llm-models';
const fresh = () => JSON.parse(JSON.stringify(useSettingsStore.getInitialState())) as SettingsState;
beforeEach(() => { useSettingsStore.setState(useSettingsStore.getInitialState(), true); });
describe('Atlas retirement and Fal credential separation', () => {
  it('removes retired providers/custom models and never copies their credentials to Fal', () => {
    const state = fresh();
    state.providers = { 'atlas-cloud': { enabled: true, apiKey: 'OLD-SECRET', baseUrl: 'https://api.atlascloud.ai' } };
    state.customModels = [{ id: 'old-model', name: 'old', provider: 'atlas-cloud', mediaType: 'video', modelId: 'old-model' }];
    state.defaultVideoModel = 'old-model'; state.defaultImageModel = 'old-image';
    state.llm = { provider: 'atlas', baseUrl: 'https://api.atlascloud.ai/v1', apiKey: 'OLD-SECRET', model: 'old' };
    state.tts = { enabled: true, provider: 'openai', baseUrl: 'https://api.atlascloud.ai/v1', apiKey: 'OLD-SECRET', model: 'old', voice: 'old' };
    const updated = migrateSettings(state);
    expect(JSON.stringify(updated)).not.toContain('OLD-SECRET'); expect(updated.providers['atlas-cloud']).toBeUndefined(); expect(updated.customModels).toEqual([]);
    expect(updated.providers['fal-ai']).toMatchObject({ enabled: false, apiKey: '', baseUrl: FAL_BASE_URL });
    expect(updated.defaultVideoModel).toBe(FAL_ONEKEY_MODELS.video); expect(updated.defaultImageModel).toBe(FAL_ONEKEY_MODELS.image);
    expect(updated.llm).toMatchObject({ apiKey: '', baseUrl: FAL_LLM_BASE_URL }); expect(updated.tts).toMatchObject({ enabled: false, apiKey: '' });
  });
  it('also clears an Atlas URL mislabeled as fal-ai', () => {
    const state = fresh(); state.providers = { 'fal-ai': { enabled: true, apiKey: 'OLD-SECRET', baseUrl: 'https://api.atlascloud.ai/v1' } };
    expect(migrateSettings(state).providers['fal-ai']).toEqual({ enabled: false, apiKey: '', baseUrl: FAL_BASE_URL });
  });
  it('preserves other configured providers, selected models and independent narration', () => {
    const state = fresh(); state.providers = { replicate: { enabled: true, apiKey: 'REPLICATE' } }; state.defaultVideoModel = 'my-replicate-model';
    state.tts = { enabled: true, provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'INDEPENDENT', model: 'tts-1', voice: 'alloy' };
    const updated = migrateSettings(state);
    expect(updated.defaultVideoModel).toBe('my-replicate-model'); expect(updated.providers.replicate.apiKey).toBe('REPLICATE'); expect(updated.tts.apiKey).toBe('INDEPENDENT');
  });
  it('one-key setup and key rotation update Fal image/video, LLM and speech together', () => {
    useSettingsStore.getState().applyFalOneKey('FIRST');
    let state = useSettingsStore.getState();
    expect(state.providers['fal-ai']).toMatchObject({ apiKey: 'FIRST', enabled: true });
    expect(state.llm.apiKey).toBe('FIRST'); expect(state.tts).toMatchObject({ enabled: true, apiKey: 'FIRST', model: FAL_TTS_MODEL });
    state.applyFalOneKey('ROTATED'); state = useSettingsStore.getState();
    expect(state.providers['fal-ai'].apiKey).toBe('ROTATED'); expect(state.llm.apiKey).toBe('ROTATED'); expect(state.tts.apiKey).toBe('ROTATED');
  });
  it('keeps unrelated enabled TTS credentials when applying Fal for media', () => {
    useSettingsStore.setState({ tts: { enabled: true, provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'INDEPENDENT', model: 'tts-1', voice: 'alloy' } });
    useSettingsStore.getState().applyFalOneKey('FAL'); expect(useSettingsStore.getState().tts.apiKey).toBe('INDEPENDENT');
  });
  it('uses Fal Key authentication only on the Fal OpenRouter gateway', () => {
    expect(llmAuthHeaders(FAL_LLM_BASE_URL, 'k')).toEqual({ Authorization: 'Key k' });
    expect(llmAuthHeaders('https://api.openai.com/v1', 'k')).toEqual({ Authorization: 'Bearer k' });
    expect(llmAuthHeaders('https://fal.run.attacker.invalid/openrouter/router/openai/v1', 'k')).toEqual({ Authorization: 'Bearer k' });
  });
});
