#!/usr/bin/env python3
"""Apply reviewed default/request changes; leave concurrent code untouched."""
from pathlib import Path
import hashlib, json, re
REPLACEMENTS = [
 ('src/lib/fal-onekey.ts', '/**\n * fal.ai', 'import { isFalOpenRouter } from "@/lib/llm-models";\n\n/**\n * fal.ai'),
 ('src/lib/fal-onekey.ts',
  '  /**\n   * Script (LLM): fast multimodal model with clean JSON output. Swap for\n   * `anthropic/claude-sonnet-4` when script quality matters more than cost.\n   */\n  llm: "google/gemini-2.5-flash",\n  /** Product-image analysis (Vision) — same multimodal model. */\n  vision: "google/gemini-2.5-flash",',
  '  /** Quality-first script model. Selection evidence: docs/llm-vision-model-selection.md. */\n  llm: "anthropic/claude-fable-5.1",\n  /** Product/frame understanding and reference-aware visual quality checks (not generation). */\n  vision: "openai/gpt-6-astra",'),
 ('src/lib/llm-presets.ts', '  model: string;\n', '  model: string;\n  /** A distinct vision default; omit to reuse the text model. */\n  visionModel?: string;\n'),
 ('src/lib/llm-presets.ts', 'model: FAL_ONEKEY_MODELS.llm, tipKey:', 'model: FAL_ONEKEY_MODELS.llm, visionModel: FAL_ONEKEY_MODELS.vision, tipKey:'),
 ('src/lib/llm-presets.ts', 'model: "openai/gpt-4o", tipKey: "presetOpenrouterTip"', 'model: FAL_ONEKEY_MODELS.llm, visionModel: FAL_ONEKEY_MODELS.vision, tipKey: "presetOpenrouterTip"'),
 ('src/app/settings/page.tsx', 'visionModel: preset.model,', 'visionModel: preset.visionModel ?? preset.model,'),
 ('src/lib/stores/settings-store.ts', 'FAL_TTS_VOICE, fillFalModelDefaults }', 'FAL_TTS_VOICE, fillFalModelDefaults, upgradeFalQualityDefaults }'),
 ('src/lib/stores/settings-store.ts', 'export function migrateSettings(state: SettingsState): SettingsState {', 'export function migrateSettings(state: SettingsState, fromVersion = 0): SettingsState {'),
 ('src/lib/stores/settings-store.ts', '  const llm = state?.llm;', '  // v7: migrate the old official Fal defaults once, retaining custom choices and keys.\n  if (fromVersion < 7 && state.llm) state.llm = upgradeFalQualityDefaults(state.llm);\n  const llm = state?.llm;'),
 ('src/lib/stores/settings-store.ts', '      version: 6,\n      migrate: (persisted) => migrateSettings(persisted as SettingsState),', '      version: 7,\n      migrate: (persisted, version) => migrateSettings(persisted as SettingsState, version),'),
 ('src/lib/llm-error.ts', 'import { llmAuthHeaders }', 'import { isOpenRouterChatBase, qualityModelFetch } from "@/lib/llm-quality-policy";\nimport { llmAuthHeaders }'),
 ('src/lib/llm-error.ts', 'return /deepseek|openai\\.com|moonshot|bigmodel\\.cn|siliconflow|dashscope/i.test(baseUrl || "")', 'return isOpenRouterChatBase(baseUrl) || /deepseek|openai\\.com|moonshot|bigmodel\\.cn|siliconflow|dashscope/i.test(baseUrl || "")'),
 ('src/lib/llm-error.ts', 'fetch: optionalParamRetryFetch(tokenCapRetryFetch(retryFreePool402 ? freePoolRetryFetch() : fetch)),', 'fetch: qualityModelFetch(config.baseUrl, optionalParamRetryFetch(tokenCapRetryFetch(retryFreePool402 ? freePoolRetryFetch() : fetch))),'),
 ('src/lib/llm-probe.ts', 'import { explainLLMStatus,', 'import { qualityModelFetch } from "@/lib/llm-quality-policy";\nimport { explainLLMStatus,'),
 ('src/lib/llm-probe.ts', 'const res = await fetchImpl(`${base}/chat/completions`, {', 'const res = await qualityModelFetch(base, fetchImpl, true)(`${base}/chat/completions`, {'),
 ('src/lib/__tests__/llm-model-discovery.test.ts', 'id: "google/gemini-2.5-flash"', 'id: FAL_ONEKEY_MODELS.llm'),
 ('src/lib/__tests__/llm-model-discovery.test.ts', '    const hint = modelListHint(', '    const defaultsBefore = { ...FAL_ONEKEY_MODELS };\n    const hint = modelListHint('),
 ('src/lib/__tests__/llm-model-discovery.test.ts', '    expect(FAL_ONEKEY_MODELS.llm).toBe("google/gemini-2.5-flash");\n    expect(FAL_ONEKEY_MODELS.vision).toBe("google/gemini-2.5-flash");', '    expect(FAL_ONEKEY_MODELS).toEqual(defaultsBefore);'),
]
LINES = [
 ('oneKeyDesc', 0, '填 fal.ai API Key，默认使用 Claude Fable 5.1 写脚本、GPT-6 Astra 看图与质检，并配置图/视频/配音。质量优先，推理耗时与费用高于 Flash；不会自动发起收费测试。'),
 ('oneKeyDesc', 1, 'Use one fal.ai key for Claude Fable 5.1 scripts, GPT-6 Astra vision/QC, images, video and narration. Quality first: higher latency and cost than Flash. No automatic paid test.'),
 ('presetFalTip', 0, '质量优先：Claude Fable 5.1 脚本 + GPT-6 Astra 视觉；同一个 Fal Key，费用高于 Flash。模型目录不代表账户权限。'),
 ('presetFalTip', 1, 'Quality first: Claude Fable 5.1 scripts + GPT-6 Astra vision with one Fal key; costs more than Flash. Catalogue visibility is not account authorization.'),
]
UPGRADER = '''

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
'''
# Validate everything in memory before touching tracked files.
planned = {}
for filename, old, new in REPLACEMENTS:
    text = planned.get(filename, Path(filename).read_text())
    if text.count(old) != 1: raise RuntimeError(f"Expected one match in {filename}: {old[:80]}")
    planned[filename] = text.replace(old, new, 1)
planned['src/lib/fal-onekey.ts'] = planned['src/lib/fal-onekey.ts'].rstrip() + UPGRADER
filename = 'src/lib/i18n/messages/settings.ts'
lines = Path(filename).read_text().splitlines(keepends=True)
for key, occurrence, value in LINES:
    matches = [i for i, line in enumerate(lines) if re.match(r'\s*' + key + r':', line)]
    if len(matches) != 2: raise RuntimeError(f"Expected bilingual {key}")
    lines[matches[occurrence]] = '    ' + key + ': ' + json.dumps(value, ensure_ascii=False) + ',\n'
planned[filename] = ''.join(lines)
new_files = [
 ('policy.txt', 'src/lib/llm-quality-policy.ts', 'f35f9babfbc21bf1a96d5d8b91492339af184caf'),
 ('tests.txt', 'src/lib/__tests__/llm-quality-defaults.test.ts', '97c3f2cfd7de63c66a028c42495e46e8eb044dc6'),
 ('research.md', 'docs/llm-vision-model-selection.md', 'ab4ba413de2098b166f8eff70d0acf655a1bb431'),
]
for source, destination, expected in new_files:
    if Path(destination).exists(): raise RuntimeError(f"Refusing to overwrite {destination}")
    data = (Path('.github/quality-defaults') / source).read_bytes()
    actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    if actual != expected: raise RuntimeError(f"Source checksum mismatch: {source}")
    planned[destination] = data.decode('utf-8')
for filename, text in planned.items():
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
for source, _, _ in new_files:
    (Path('.github/quality-defaults') / source).unlink()
Path('.github/quality-defaults').rmdir()
for filename in ['.github/apply-quality-defaults.py', '.github/workflows/quality-defaults.yml']:
    Path(filename).unlink(missing_ok=True)
print('Applied quality defaults to', len(planned), 'files; no inference executed.')
