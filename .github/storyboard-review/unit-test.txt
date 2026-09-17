// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUserPrompt, buildBatchPrompt, buildTopicPrompt, buildTopicBatchPrompt, styleNameMap, topicNarrationNameMap, VIDEO_MODE_DIRECTIVES, type ScriptGenerationInput, type TopicNarrationStyle } from "../script-engine/prompts";
import { COMMERCE_DIRECTION, TOPIC_DIRECTION, buildPlatformDirection } from "../script-engine/storyboard-direction";
import { buildStoryboardGridPrompt } from "../storyboard-grid";
import { buildStoryboardFilmPrompt } from "../storyboard-film";
import { renderModeDirection, shotScopedIntent, shotSpeakerVisible, projectVisualDirection } from "../storyboard-render-direction";
import { buildMotionPrompt } from "../motion-prompt";
import { buildJudgePrompt, parseJudgeResponse } from "../script-judge";
import { buildAssetRows } from "../assets-view";
import { parseScriptResponse, generateScript, generateTopicScript } from "../script-engine/generator";
import { buildTranslatePrompt, translateShots } from "../script-engine/translate";
import type { Shot, ScriptCharacter } from "../db/schema";

const product: ScriptGenerationInput = { productName: "方形白盒", category: "home", styleType: "pain_point", targetDuration: 24, productDescription: "白色方形外壳，黑色顶盖，600ml；没有测试数据" };
const modes = Object.keys(VIDEO_MODE_DIRECTIVES) as NonNullable<ScriptGenerationInput["videoMode"]>[];
const commerceStyles = Object.keys(COMMERCE_DIRECTION) as (keyof typeof COMMERCE_DIRECTION)[];
const topics = Object.keys(TOPIC_DIRECTION) as TopicNarrationStyle[];
const shot = (id: number, overrides: Partial<Shot> = {}): Shot => ({ shotId: id, type: "demo", duration: 4, description: "白盒盖闭合→顶盖打开一半→停在半开状态", prompt: "White square box, black lid closed, soft left light", camera: "固定近景", visualSource: "ai_generate", voiceover: "看看这个细节", transition: "direct_concat", ...overrides });
const cast: ScriptCharacter[] = [{ id: "box", name: "盒子", gender: "female", appearance: "白色方形外壳，黑色顶盖", persona: "克制幽默的画外声音" }];
afterEach(() => vi.unstubAllGlobals());

describe("genre-specific, single-call storyboard planning", () => {
  it("covers every public style and separates commerce/story from topic/story", () => {
    expect(commerceStyles.sort()).toEqual(Object.keys(styleNameMap).filter(s => s !== "custom").sort());
    expect(topics.sort()).toEqual(Object.keys(topicNarrationNameMap).sort());
    expect(COMMERCE_DIRECTION.story).not.toBe(TOPIC_DIRECTION.story);
    expect(modes).toHaveLength(4);
  });
  it.each(commerceStyles)("%s receives its own causal/visual/continuity contract, not every genre", styleType => {
    const prompt = buildUserPrompt({ ...product, styleType });
    expect(prompt).toContain(COMMERCE_DIRECTION[styleType]);
    expect(prompt).toContain("唯一主动作→结束状态");
    expect(prompt).toContain("动作开始前的定格");
    expect(prompt).toContain("目标总时长 24秒");
    expect(prompt.match(/【单次创作协议/g)).toHaveLength(1);
    expect(prompt).not.toContain("年销售额");
    expect(prompt).not.toContain("指向下方购物车");
  });
  it.each(topics)("topic %s receives its own payoff and never commerce conversion hints", narrationStyle => {
    const prompt = buildTopicPrompt({ topic: "一个真实观察", narrationStyle, targetDuration: 36, platforms: "TikTok" });
    expect(prompt).toContain(TOPIC_DIRECTION[narrationStyle]);
    expect(prompt).toContain("目标总时长 36秒");
    expect(prompt).not.toContain("TikTok Shop");
    expect(prompt).not.toContain("四范式");
    expect(prompt).not.toContain("软性紧迫感");
    expect(prompt).not.toContain("product_image");
  });
  it.each(commerceStyles.flatMap(styleType => modes.map(videoMode => ({ styleType, videoMode }))))("$styleType / $videoMode has the real mode boundary and keeps a user medium", ({ styleType, videoMode }) => {
    const prompt = buildBatchPrompt({ ...product, styleType, videoMode, customRequirements: "白色三维模型，透明亚克力；不要真人" }, 2);
    expect(prompt).toContain(VIDEO_MODE_DIRECTIVES[videoMode]);
    expect(prompt).toContain("事实与参考图、视频模式的人物/素材边界优先");
    expect(prompt).toContain("白色三维模型，透明亚克力；不要真人");
    expect(prompt).toContain("保持选定风格、视频模式、事实与人物参考不变");
    expect(prompt).toContain('"speakerVisible": false');
  });
  it("custom, reference pacing, approved art direction and English constraints survive single/batch assembly", () => {
    const input = { ...product, productName: "Square case", productDescription: "White case with black lid", styleType: "custom" as const, referenceStructure: "2s setup / 4s observation / 2s resolution", projectDirection: "Palette: white, red accent", customRequirements: "No people. Macro miniature animation." };
    for (const prompt of [buildUserPrompt(input), buildBatchPrompt(input, 2)]) {
      expect(prompt).toContain(input.referenceStructure); expect(prompt).toContain(input.projectDirection);
      expect(prompt).toContain(input.customRequirements); expect(prompt).toContain("LANGUAGE");
      expect(prompt).toContain("不假定参考片的效果已验证");
    }
    expect(buildTopicBatchPrompt({ topic: "A quiet walk", narrationStyle: "travel", projectDirection: "Palette: gray", customRequirements: "Only real destination footage" }, 2)).toContain("Palette: gray");
  });
  it("normalizes primary platforms and never treats generic commerce as TikTok Shop", () => {
    expect(buildPlatformDirection(" TIKTOK , reels", "product")).toContain("四范式");
    expect(buildPlatformDirection(undefined, "product")).not.toContain("四范式");
    expect(buildPlatformDirection("reels", "product")).toContain("Instagram Reels");
    expect(buildPlatformDirection("tiktok", "topic")).not.toContain("TikTok Shop");
  });
});

describe("the approved storyboard survives keyframe, motion, film and judge compilation", () => {
  it("preserves explicit offscreen voice through parsing and both saved/unsaved asset views", () => {
    const [parsed] = parseScriptResponse(JSON.stringify({ shots: [shot(1, { characterId: "box", speakerVisible: false })], characters: cast }), "product_pov");
    expect(parsed.shots[0].speakerVisible).toBe(false);
    for (const saved of [[], [{ shotId: 1, status: "done", filePath: "/api/files/x.mp4" }]]) {
      const row = buildAssetRows(parsed.shots, saved, [])[0];
      expect(row.speakerVisible).toBe(false); expect(row.characterId).toBe("box");
      expect(shotSpeakerVisible(row, { videoMode: "live_presenter" })).toBe(false);
    }
    const [invalid] = parseScriptResponse(JSON.stringify({ shots: [{ ...shot(1), speakerVisible: "true" }] }), "story");
    expect(invalid.shots[0]).not.toHaveProperty("speakerVisible");
  });
  it.each(modes)("mode %s constrains legacy and explicit speaker flags", videoMode => {
    expect(shotSpeakerVisible({ characterId: "a", speakerVisible: true }, { videoMode })).toBe(videoMode === "live_presenter");
    expect(shotSpeakerVisible({ characterId: "a", speakerVisible: false }, { videoMode })).toBe(false);
    expect(shotSpeakerVisible({ characterId: "a" }, { videoMode, styleType: "product_pov" })).toBe(false);
  });
  it("does not mistake a topic project's inherited commerce mode for a face ban", () => {
    expect(renderModeDirection({ contentType: "topic", videoMode: "product_closeup" }, "zh")).not.toContain("不添加真人、脸、手");
    expect(shotSpeakerVisible({ characterId: "a" }, { contentType: "topic" })).toBe(false);
  });
  it("grid keeps starting keyframes, reference order, scene transitions and shared art anchors", () => {
    const shots = [shot(1), shot(2, { description: "第二天室外石阶，白盒黑盖仍半开", speakerVisible: false })];
    const prompt = buildStoryboardGridPrompt(shots, cast, { characterSheet: true, productImage: true }, { videoMode: "graphic_montage", creativeIntent: { subject: "case", palette: "白底红色强调" } });
    expect(prompt).toContain("第 1 张参考图是出镜人物"); expect(prompt).toContain("第 2 张参考图是商品");
    expect(prompt).toContain(shots[0].prompt!); expect(prompt).toContain(shots[1].description);
    expect(prompt).toContain("白底红色强调"); expect(prompt).toContain("明确换景/换时段时建立新场景");
    expect(prompt).toContain("动作结束状态提前画入首帧"); expect(prompt).toContain("不添加真人、脸、手");
  });
  it("film retains voice identity but does not animate a speaking product/hidden speaker", () => {
    const shots = [shot(1, { characterId: "box", speakerVisible: false }), shot(2, { voiceover: "", speakerVisible: false })];
    for (const context of [{ styleType: "product_pov", videoMode: "product_closeup" }, { videoMode: "live_presenter" }]) {
      const prompt = buildStoryboardFilmPrompt(shots, cast, { characterSheet: true }, { context });
      expect(prompt).toContain("由盒子"); expect(prompt).toContain("画外配音，不添加说话人物或口型");
      expect(prompt).toContain("画面以 @图片2 为基准"); expect(prompt).toContain("画面以 @图片3 为基准");
      expect(prompt).toContain("无台词，只保留环境音与动作声"); expect(prompt).not.toContain("真实手机直出质感");
    }
  });
  it("keeps approved action at the end of a long description and adds no random gestures or scenery", () => {
    const description = "白色方盒与黑盖固定在左侧，三维动画材质，左方柔光。".repeat(4) + "盖子只打开一半就停止，不倾倒。";
    const prompt = buildMotionPrompt({ description, camera: "固定近景", shotType: "demo", category: "food", personShot: true, talking: true });
    expect(prompt).toContain(description); expect(prompt).not.toContain("酥脆掉渣");
    expect(prompt).not.toContain("窗帘"); expect(prompt).not.toContain("极短的停顿");
    expect(prompt).not.toContain("网红脸");
    const empty = buildMotionPrompt({ videoMode: "product_closeup", shotType: "demo", category: "food", talking: true, personShot: true });
    expect(empty).toContain("保持首帧物品及其状态"); expect(empty).not.toContain("酥脆掉渣"); expect(empty).not.toContain("自然说话");
  });
  it("native-audio direction is not contradicted by an ambient-only ban", () => {
    for (const description of ["小美在桌边", "Mia at a desk"]) {
      const native = buildMotionPrompt({ description, nativeAudio: true });
      const post = buildMotionPrompt({ description, nativeAudio: false });
      expect(native).not.toContain("无人声说话"); expect(native).not.toContain("no speech");
      expect(post).toMatch(/无人声说话|no speech/);
    }
  });
  it("shared project constraints do not replace the current action/camera or mutate stored direction", () => {
    const intent = { subject: "盒子", action: "旋转整圈", camera: "orbit", motion: "快速", palette: "white/red", negative: ["warp"] };
    const scoped = shotScopedIntent(intent, { description: "顶盖慢慢抬起", camera: "locked" });
    expect(scoped).toMatchObject({ subject: "盒子", palette: "white/red", action: undefined, camera: undefined, motion: undefined });
    expect(intent.action).toBe("旋转整圈"); expect(shotScopedIntent(intent, {})).toBe(intent);
    expect(projectVisualDirection({ creativeIntent: intent }, "en")).toContain("white/red");
  });
  it("judge reviews silent visuals, scene state and per-shot voice metadata without filling silence", () => {
    const shots = [shot(1, { voiceover: "", speakerVisible: false }), shot(2)];
    const prompt = buildJudgePrompt(shots, { contentType: "topic", narrationStyle: "inspiration" });
    expect(prompt).toContain(TOPIC_DIRECTION.inspiration); expect(prompt).toContain("台词「」");
    expect(prompt).toContain("4s"); expect(prompt).toContain("offscreen"); expect(prompt).toContain("已铺垫的诗性");
    const parsed = parseJudgeResponse(JSON.stringify({ rewrites: [{ shotId: 1, voiceover: "新加的旁白", tier: "default" }] }), shots);
    expect(parsed.rewrites).toEqual([]);
  });
  it("localization preserves causal setup/payoff, facts and silent line positions", () => {
    const prompt = buildTranslatePrompt(["白盒容量600ml", "", "再看黑盖"], "en");
    expect(prompt).toContain("setup/payoff"); expect(prompt).toContain("empty string"); expect(prompt).toContain("numbers");
  });
  it("silent localization keeps shot time and never purchases an empty translation", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const silent = [shot(1, { voiceover: "", duration: 6 })];
    const result = await translateShots(silent, "en", { baseUrl: "https://example.test/v1", apiKey: "test", model: "unchanged" });
    expect(result).toEqual(silent); expect(network).not.toHaveBeenCalled();
  });
  it.each(["product", "topic"] as const)("%s sends exactly one ordinary SDK request with the new directions", async (contentType) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scripts: [{ title: "demo", shots: [shot(1)] }] }) } }] }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const llmConfig = { baseUrl: "https://provider.example/v1", apiKey: "test", model: "unchanged-model" };
    const result = contentType === "product" ? await generateScript({ ...product, llmConfig }) : await generateTopicScript({ topic: "黑盖为何挡光", narrationStyle: "knowledge", llmConfig });
    expect(result).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("unchanged-model"); expect(body.max_tokens).toBe(16000);
    expect(body.messages[1].content).toContain("【单次创作协议");
    if (contentType === "topic") expect(body.messages[1].content).not.toContain("TikTok Shop");
  });
});
