#!/usr/bin/env python3
"""Reconcile the cost requirement on top of the parallel quality-first update."""
from pathlib import Path
import hashlib, json, re
planned = {}
def edit(path, old, new):
    text = planned.get(path, Path(path).read_text())
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one match in {path}: {old[:100]}')
    planned[path] = text.replace(old, new, 1)
def source(name, sha):
    data = (Path('.github/balanced-defaults') / name).read_bytes()
    if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != sha:
        raise RuntimeError('Source checksum mismatch: ' + name)
    return data.decode()

# Keep the parallel independent vision preset, JSON mode and premium compatibility.
p = 'src/lib/fal-onekey.ts'
edit(p, 'llm: "anthropic/claude-fable-5.1"', 'llm: "google/gemini-3.8-flash"')
edit(p, 'vision: "openai/gpt-6-astra"', 'vision: "google/gemini-3.8-flash"')
edit(p, '/** Quality-first script model. Selection evidence: docs/llm-vision-model-selection.md. */',
     '/** Balanced script default. Evidence and price validity: docs/llm-model-selection.md. */')
edit(p, '/** Product/frame understanding and reference-aware visual quality checks (not generation). */',
     '/** Product/frame understanding and visual QC; low reasoning, not image generation. */')

p = 'src/lib/stores/settings-store.ts'
edit(p, 'import { FAL_IMAGE_SPECS }', 'import { isFalOpenRouter } from "@/lib/llm-models";\nimport { FAL_IMAGE_SPECS }')
edit(p, '  const llm = state?.llm;', '''  // v8: supersede only the exact v7 quality-first default pair on the official gateway.
  // A manually selected cheaper 2.5 on v7, or either independent custom model, stays intact.
  if (fromVersion === 7 && state.llm && isFalOpenRouter(state.llm.baseUrl) &&
      state.llm.model === "anthropic/claude-fable-5.1" && state.llm.visionModel === "openai/gpt-6-astra") {
    state.llm = { ...state.llm, model: FAL_ONEKEY_MODELS.llm, visionModel: FAL_ONEKEY_MODELS.vision };
  }
  const llm = state?.llm;''')
edit(p, '''      llm: {
        provider: "",
        baseUrl: "",
        apiKey: "",
        model: "",
        visionModel: "",
      },''', '''      llm: {
        provider: "fal.ai",
        baseUrl: FAL_LLM_BASE_URL,
        apiKey: "",
        model: FAL_ONEKEY_MODELS.llm,
        visionModel: FAL_ONEKEY_MODELS.vision,
      },''')
edit(p, '''            video: state.defaultVideoModel,
          });
          return {''', '''            video: state.defaultVideoModel,
          });
          const keepLlm = isFalOpenRouter(state.llm.baseUrl);
          return {''')
edit(p, '''              model: FAL_ONEKEY_MODELS.llm,
              visionModel: FAL_ONEKEY_MODELS.vision,''', '''              model: keepLlm && state.llm.model.trim() ? state.llm.model : FAL_ONEKEY_MODELS.llm,
              visionModel: keepLlm && (state.llm.model.trim() || state.llm.visionModel?.trim()) ? state.llm.visionModel : FAL_ONEKEY_MODELS.vision,''')
edit(p, '      version: 7,', '      // v8: balanced defaults; preserve keys, custom choices and v7 manual cheap-model selections.\n      version: 8,')

# New policy is based on the actual request model, never a moving default constant.
policy = source('policy.ts', '7c7426e3ab087939142d2b5b73907e6ee813e14b')
policy = policy.replace('baseFetch: typeof fetch = fetch): typeof fetch {', 'baseFetch: typeof fetch = fetch, probe = false): typeof fetch {')
policy = policy.replace('balancedChatBody(baseUrl, body);', 'balancedChatBody(baseUrl, body, probe);')
planned['src/lib/llm-balanced.ts'] = policy
p = 'src/lib/llm-quality-policy.ts'
edit(p, 'import { FAL_ONEKEY_MODELS } from "@/lib/fal-onekey";',
     'import { balancedChatFetch } from "@/lib/llm-balanced";\n\n// Keep opt-in premium compatibility independent of the current balanced defaults.\nconst PREMIUM_MODELS = new Set(["anthropic/claude-fable-5.1", "openai/gpt-6-astra"]);')
edit(p, 'export function qualityModelFetch(', 'function premiumModelFetch(')
edit(p, 'if (body.model !== FAL_ONEKEY_MODELS.llm && body.model !== FAL_ONEKEY_MODELS.vision) {',
     'if (typeof body.model !== "string" || !PREMIUM_MODELS.has(body.model)) {')
planned[p] += '''
/** Preserve opt-in premium behavior; the balanced default gets its own bounded policy. */
export function qualityModelFetch(baseUrl: string | undefined, baseFetch: typeof fetch = fetch, probe = false): typeof fetch {
  if (!isOpenRouterChatBase(baseUrl)) return baseFetch;
  return balancedChatFetch(baseUrl, premiumModelFetch(baseUrl, baseFetch, probe), probe);
}
'''
p = 'src/lib/llm-error.ts'
edit(p, 'import { isOpenRouterChatBase, qualityModelFetch }',
     'import { usesBalancedLlmPolicy } from "@/lib/llm-balanced";\nimport { isOpenRouterChatBase, qualityModelFetch }')
edit(p, '''    if (!sent || !sent.includes('"max_tokens"')) return res;''', '''    if (!sent || !sent.includes('"max_tokens"')) return res;
    // Never turn this known model's bounded request into an unlimited paid retry.
    try {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (usesBalancedLlmPolicy(target.replace(/\\/chat\\/completions$/, ""), JSON.parse(sent).model)) return res;
    } catch { /* leave other models' existing recovery unchanged */ }''')
p = 'src/lib/llm-probe.ts'
edit(p, 'import { qualityModelFetch }', 'import { usesBalancedLlmPolicy } from "@/lib/llm-balanced";\nimport { qualityModelFetch }')
edit(p, '''
  if (!res.ok && (res.status === 400 || res.status === 422) && isTokenCapRejection(text)) {''',
     '''
  if (!res.ok && !usesBalancedLlmPolicy(base, model) && (res.status === 400 || res.status === 422) && isTokenCapRejection(text)) {''')

# Change only the four obsolete premium-default tips; retain model-list error improvements.
p = 'src/lib/i18n/messages/settings.ts'
lines = Path(p).read_text().splitlines(keepends=True)
for key, values in {
    'oneKeyDesc': [
        '填 fal.ai API Key，默认使用 Gemini 3.8 Flash 写脚本、看图与质检，按任务控制推理强度，兼顾效果与费用；图/视频/配音配置保持独立，不会自动发起收费测试。',
        'Use one fal.ai key for Gemini 3.8 Flash scripts and vision/QC with task-specific reasoning. Balance quality and cost; image, video and narration models remain separate. No automatic paid test.'
    ],
    'presetFalTip': [
        '均衡默认：Gemini 3.8 Flash 脚本与视觉；同一个 Fal Key，脚本 medium、常规视觉 low。模型目录不代表账户权限。',
        'Balanced: Gemini 3.8 Flash for scripts and vision with one Fal key; medium reasoning for scripts, low for routine vision. Catalogue visibility is not account authorization.'
    ],
}.items():
    matches = [i for i, line in enumerate(lines) if re.match(r'\s*' + key + ':', line)]
    if len(matches) != 2: raise RuntimeError('Expected bilingual message: ' + key)
    for i, value in zip(matches, values): lines[i] = '    ' + key + ': ' + json.dumps(value, ensure_ascii=False) + ',\n'
planned[p] = ''.join(lines)

# Preserve premium transport regressions; update only expectations for the changed defaults.
p = 'src/lib/__tests__/llm-quality-defaults.test.ts'
text = Path(p).read_text()
head, tail = text.split('describe("reasoning-model transport compatibility"', 1)
head = head.replace('{ llm: FABLE, vision: ASTRA,', '{ llm: "google/gemini-3.8-flash", vision: "google/gemini-3.8-flash",')
head = head.replace('model: FABLE', 'model: FAL_ONEKEY_MODELS.llm').replace('visionModel: ASTRA', 'visionModel: FAL_ONEKEY_MODELS.vision')
head = head.replace('getOptions().version).toBe(7)', 'getOptions().version).toBe(8)')
head = head.replace('describe("quality-first model defaults"', 'describe("current defaults with preserved premium compatibility"')
head = head.replace('one-key setup configures distinct script and vision models', 'one-key setup configures the current script and vision defaults')
planned[p] = head + 'describe("reasoning-model transport compatibility"' + tail

planned['src/lib/__tests__/llm-balanced.test.ts'] = source('transport-tests.ts', '75da0e8fe18b9f07f572243608229c184fe0d775')
tests = source('defaults-tests.ts', 'e5477844f41f3e7082bac9ca110a92e4f05fd1b6')
tests = tests.replace('getOptions().version).toBe(7)', 'getOptions().version).toBe(8)').replace(').version).toBe(7)', ').version).toBe(8)')
tests += '''
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
'''
planned['src/lib/__tests__/fal-llm-defaults.test.ts'] = tests
research = source('research.md', 'a0cfc0eb4d5af53d1b40b98e7af45fb1e2d6db91')
research = research.replace('设置版本升至 **7**', '设置版本升至 **8**')
research = research.replace('新增 28 项回归', '新增 31 项回归')
research = research.replace('提交前相关 7 个测试文件共 222 项通过；TypeScript 与修改文件 ESLint 通过。', '并行更新前相关 7 个测试文件共 222 项通过；本次整合后的完整源码重新在 CI 验证，不沿用本地旧快照结果。')
research += '''
## 并行修改整合

本次提交基于并行的 `ae9fce8` 质量优先更新，按用户追加的费用约束将推荐默认改为均衡方案。保留独立视觉预设、路由 JSON 模式和手动选择 Fable/Astra 时的兼容适配，但将高推理／32768 输出策略绑定到这两个明确型号，不能让更新后的 Flash 默认错误继承昂贵策略。v8 仅迁移官方 Fal 的完整旧 Fable/Astra 默认组合；不同的自定义组合以及 v7 手动改回的廉价 2.5 均保留。v8 以后再手动选择昂贵组合也不强行覆盖。

`docs/llm-vision-model-selection.md` 是先前“不设费用约束”的质量优先方案记录；当前默认和费用取舍以本文为准。没有替换或撤销其他并行功能修改。
'''
planned['docs/llm-model-selection.md'] = research
p = 'docs/llm-vision-model-selection.md'
planned[p] = '> 历史质量优先方案。用户随后要求兼顾费用；当前默认已调整，见 [均衡选型](llm-model-selection.md)。本页不再代表当前默认配置。\n\n' + Path(p).read_text()

# Validate all replacements and source objects before touching tracked files.
for path, text in planned.items():
    f = Path(path); f.parent.mkdir(parents=True, exist_ok=True); f.write_text(text)
for name in ['policy.ts','transport-tests.ts','defaults-tests.ts','research.md']:
    (Path('.github/balanced-defaults') / name).unlink()
Path('.github/balanced-defaults').rmdir()
Path('.github/apply-balanced-defaults.py').unlink()
Path('.github/workflows/balanced-defaults.yml').unlink()
print('Applied and reconciled balanced defaults:', len(planned), 'files; no inference or credentials used.')
