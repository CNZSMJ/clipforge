// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compileFrame, defaultFrameWorkspace, sanitizeFrameWorkspace, framePlanningPrompt, parseFramePlan, FRAME_TYPE_DIRECTION, type FrameContext, type FrameReference, type FrameWorkspace } from "../keyframe-direction";
import type { Shot } from "../db/schema";
const shots: Shot[] = [1, 2, 3].map(shotId => ({ shotId, type: "demo", duration: 4, description: `咖啡机前完成第${shotId}步，再把咖啡杯放到托盘`, prompt: "cinematic photorealistic woman making coffee", camera: "eye level", voiceover: "", visualSource: "ai_generate", transition: "direct_concat" }));
const context: FrameContext = { contentType: "product", videoMode: "live_presenter", styleType: "scene", productName: "测试咖啡机", characters: [{ id: "barista", name: "冲煮者", gender: "female", persona: "calm", appearance: "short hair, white shirt" }] };
function workspace(c: FrameContext = context) {
  const w = defaultFrameWorkspace(shots, c); w.style.medium = "3d";
  w.style.palette = "white, grey and one red accent"; w.scenes[0].layout = "machine on north wall, window on west wall";
  Object.assign(w.specs[0], { moment: "cup upright under the outlet before extraction", blocking: "torso toward machine", hands: "right index over start button, left hand relaxed", gaze: "cup under outlet", contacts: "cup supported by drip tray", state: "cup empty, portafilter already locked", characterIds: ["barista"] });
  return w;
}
const ref = (id: string, role: FrameReference["role"], extra: Partial<FrameReference> = {}): FrameReference => ({ id, role, url: `/api/files/p/${id}.png`, label: id, ...extra });
function compile(w: FrameWorkspace = workspace(), c: FrameContext = context) { return compileFrame({ shot: shots[0], shots, workspace: sanitizeFrameWorkspace(w, shots, c), context: c }); }

describe("single-frame direction, not isolated script-to-image translation", () => {
  it("separates onset, world-space scene, style, gaze, grip and support without a competing photorealistic legacy hint", () => {
    const { prompt } = compile();
    for (const word of ["three-dimensional animation", "white, grey", "cup upright", "torso toward machine", "right index", "cup supported", "WORLD space", "Actor-left/right"]) expect(prompt).toContain(word);
    expect(prompt).not.toContain("cinematic photorealistic woman making coffee");
    expect(prompt).toContain("not multiple moments to combine"); expect(prompt).not.toContain("buy video"); // no paid/video instruction in image prompt
  });
  it.each(Object.keys(FRAME_TYPE_DIRECTION))("injects only the relevant render direction for %s", styleType => {
    const result = compile(workspace(), { ...context, styleType });
    expect(result.prompt).toContain(FRAME_TYPE_DIRECTION[styleType]);
    if (styleType !== "unboxing") expect(result.prompt).not.toContain(FRAME_TYPE_DIRECTION.unboxing);
  });
  it.each(["pain_point", "scene", "comparison", "story", "drama", "reversal", "interview", "unboxing", "product_pov", "talking_head"].flatMap(styleType => ["product_closeup", "graphic_montage"].map(videoMode => ({ styleType, videoMode }))))("never introduces hands/faces through cast references for $styleType / $videoMode", settings => {
    const c = { ...context, ...settings }; const w = workspace(c); w.references.push(ref("face", "character", { characterId: "barista" }));
    const output = compile(w, c);
    expect(output.spec.characterIds).toEqual([]); expect(output.references.some(r => r.role === "character")).toBe(false);
    expect(output.prompt).toContain("No added hands or human body parts");
  });
  it("scene-demo accepts hands but not identity-sheet faces; topic projects do not inherit the commerce no-people default", () => {
    const demo = compile(workspace(), { ...context, videoMode: "scene_demo" });
    expect(demo.spec.characterIds).toEqual([]); expect(demo.prompt).toContain("faces out of view");
    const topic = compile(workspace(), { ...context, contentType: "topic", videoMode: "product_closeup" });
    expect(topic.spec.characterIds).toEqual(["barista"]); expect(topic.prompt).toContain("Actor-left/right");
  });
  it("binds actual ordered refs with separate identity/scene/style/layout semantics; unrelated scenes are excluded", () => {
    const w = workspace();
    w.references = [ref("person", "character", { characterId: "barista" }), ref("kitchen", "scene", { sceneId: "shot-1" }), ref("style", "style"), ref("pose", "layout", { shotId: 1 }), ref("wrong-scene", "scene", { sceneId: "shot-2" }), ref("wrong-person", "character", { characterId: "other" })];
    const output = compileFrame({ shot: shots[0], shots, workspace: w, context, automaticReferences: [{ url: "/api/files/p/product.png", role: "product", label: "product" }], editTarget: "/api/files/p/edit.png", correction: "only fix gaze" });
    expect(output.references.map(r => r.role)).toEqual(["edit-target", "product", "character", "scene", "style", "layout"]);
    expect(output.prompt).toContain("Image 6 — layout"); expect(output.prompt).toContain("remove all sketch marks"); expect(output.prompt).toContain("Borrow only medium");
    expect(output.prompt).toContain("TARGETED CORRECTION ONLY: only fix gaze"); expect(output.prompt).not.toContain("wrong-scene");
  });
  it("uses product visibility even for a hook and does not insert the product in unrelated frames", () => {
    const w = workspace(); w.references.push(ref("machine", "product"));
    const hook = { ...shots[0], type: "hook" as const };
    expect(compileFrame({ shot: hook, shots, workspace: w, context }).references).toHaveLength(1);
    w.specs[0].productVisible = false; expect(compileFrame({ shot: hook, shots, workspace: w, context }).references).toHaveLength(0);
  });
  it("does not silently trim reference packs or invent attached media", () => {
    const w = workspace(); w.references = Array.from({ length: 9 }, (_, i) => ref(`s${i}`, "style"));
    expect(() => compile(w)).toThrow("8");
    expect(compile(workspace()).prompt).toContain("No reference images attached");
  });
  it("sanitizes untrusted document shape and remote/path-traversal references without mutating inputs", () => {
    const input = { ...workspace(), references: [ref("ok", "style"), ref("remote", "style", { url: "https://evil.invalid/private" }), ref("traverse", "style", { url: "/api/files/p/../secret.png" })] };
    const result = sanitizeFrameWorkspace(input, shots, context); expect(result.references.map(r => r.id)).toEqual(["ok"]); expect(result.references[0]).not.toHaveProperty("sceneId"); expect(result.references[0]).not.toHaveProperty("characterId"); expect(input.references).toHaveLength(3);
    expect(sanitizeFrameWorkspace(null, shots, context).specs).toHaveLength(3);
  });
  it("keeps scene groups separate by default, and carries prior state only for a declared same scene", () => {
    const w = workspace(); const before = compileFrame({ shot: shots[1], shots, workspace: w, context });
    expect(before.prompt).not.toContain("Previous same-scene state");
    w.specs[1].sceneId = w.specs[0].sceneId;
    expect(compileFrame({ shot: shots[1], shots, workspace: w, context }).prompt).toContain("portafilter already locked");
  });
});
describe("one explicit planning call returns a reviewable draft", () => {
  it("specifies real espresso staging, preserves named bindings and omits reference URLs from planning input", () => {
    const w = workspace(); w.references.push(ref("private", "style"));
    const prompt = framePlanningPrompt(shots, context, w);
    expect(prompt).toContain("杯在出液口下并受托盘支撑"); expect(prompt).toContain("不能新增未要求出镜的人");
    expect(prompt).not.toContain("/api/files/p/private.png"); expect(prompt).toContain("existingSpecs");
  });
  it("requires complete exact shot IDs and usable moments, preserving immutable approved style and references", () => {
    const w = workspace(); w.specs.forEach(s => s.moment = "one still moment");
    const result = parseFramePlan({ scenes: w.scenes, specs: w.specs, style: { medium: "photography" } }, shots, context, w);
    expect(result.style.medium).toBe("3d");
    expect(() => parseFramePlan({ scenes: w.scenes, specs: [w.specs[0], w.specs[0], w.specs[2]] }, shots, context, w)).toThrow("Shot IDs");
    expect(() => parseFramePlan({ scenes: w.scenes, specs: [{ ...w.specs[0], moment: "" }, ...w.specs.slice(1)] }, shots, context, w)).toThrow("moment");
  });
  it("rejects a planner regroup that would silently detach an approved scene sample", () => {
    const w = workspace(); w.specs.forEach(s => s.moment = "one still moment"); w.references.push(ref("kitchen", "scene", { sceneId: "shot-1" }));
    expect(() => parseFramePlan({ scenes: w.scenes, specs: [{ ...w.specs[0], sceneId: "shot-2" }, ...w.specs.slice(1)] }, shots, context, w)).toThrow("bindings");
  });
});
