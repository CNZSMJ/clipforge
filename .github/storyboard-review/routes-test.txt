// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, scripts, assets, type Shot } from "../db/schema";
const m = vi.hoisted(() => ({ generateScript: vi.fn(), analyzeProduct: vi.fn(), generateTopicScript: vi.fn(), judge: vi.fn(), tracked: vi.fn(), grid: vi.fn(), film: vi.fn(), video: vi.fn(), createProvider: vi.fn() }));
vi.mock("../script-engine/generator", async original => ({ ...await original<typeof import("../script-engine/generator")>(), generateScript: m.generateScript, generateTopicScript: m.generateTopicScript, analyzeProduct: m.analyzeProduct, completeWithJsonRetry: m.judge }));
vi.mock("../providers", () => ({ createProvider: m.createProvider }));
vi.mock("../tracked-image", () => ({ generateTrackedImage: m.tracked }));
vi.mock("../storyboard-grid-persistence", async original => ({ ...await original<typeof import("../storyboard-grid-persistence")>(), persistStoryboardGrid: m.grid }));
vi.mock("../storyboard-film-persistence", () => ({ persistGeneratedFilm: m.film }));
vi.mock("../remote-image", () => ({ toProviderImage: async (url: string) => `https://fal.media/staged/${encodeURIComponent(url)}` }));
let root: string;
let db: ReturnType<typeof import("../db")["getDb"]>;
let commerce: typeof import("@/app/api/llm/script/route")["POST"];
let topic: typeof import("@/app/api/topic/script/route")["POST"];
let patch: typeof import("@/app/api/project/[id]/scripts/route")["PATCH"];
let grid: typeof import("@/app/api/project/[id]/storyboard-grid/route")["POST"];
let film: typeof import("@/app/api/project/[id]/storyboard-film/route")["POST"];
let judge: typeof import("@/app/api/project/[id]/script-judge/route")["POST"];
const fixtureShots: Shot[] = [1, 2].map(shotId => ({ shotId, type: "demo", duration: 4, description: `白盒黑盖第${shotId}步，左侧柔光`, camera: "固定近景", prompt: "White square box, black lid closed, left soft light", visualSource: "ai_generate", transition: "direct_concat", voiceover: "", speakerVisible: false }));
const llmConfig = { baseUrl: "https://example.test/v1", apiKey: "fixture-key", model: "unchanged" };
const request = (body: object) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clipforge-prompt-route-")); vi.stubEnv("APP_DATA_DIR", root);
  db = (await import("../db")).getDb();
  commerce = (await import("@/app/api/llm/script/route")).POST; topic = (await import("@/app/api/topic/script/route")).POST;
  patch = (await import("@/app/api/project/[id]/scripts/route")).PATCH; grid = (await import("@/app/api/project/[id]/storyboard-grid/route")).POST;
  film = (await import("@/app/api/project/[id]/storyboard-film/route")).POST; judge = (await import("@/app/api/project/[id]/script-judge/route")).POST;
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
beforeEach(() => {
  for (const mock of Object.values(m)) mock.mockReset();
  const generated = [{ title: "fixture", styleType: "scene", totalDuration: 8, shots: fixtureShots }];
  m.generateScript.mockResolvedValue(generated); m.generateTopicScript.mockResolvedValue(generated);
  m.tracked.mockResolvedValue({ imageUrls: ["https://fal.media/generated.png"], taskId: "grid-handle", modelId: "image-model" });
  m.grid.mockResolvedValue({ gridPath: "/api/files/grid.png", cells: [] });
  m.video.mockResolvedValue({ videoUrls: ["https://fal.media/generated.mp4"], taskId: "film-handle", modelId: "video-model" });
  m.film.mockResolvedValue({ url: "/api/output/film.mp4" });
  m.createProvider.mockReturnValue({ generateVideo: m.video });
  m.judge.mockResolvedValue({ verdicts: [], rewrites: [], descriptionRewrites: [] });
});
function fixture(contentType: "product" | "topic" = "product") {
  const project = db.insert(projects).values({ name: "Prompt fixture", contentType, videoMode: "graphic_montage", creativeIntent: { subject: "白盒", palette: "白底红色强调", action: "顶盖慢慢抬起" }, visualBible: { characterAnchors: [], productAnchors: ["黑盖不换成白盖"], wardrobeAnchors: [], environmentAnchors: [], lightingAnchors: ["左侧柔光"], forbiddenChanges: [] } }).returning().get();
  const script = db.insert(scripts).values({ projectId: project.id, styleType: "product_pov", shots: fixtureShots, selected: true }).returning().get();
  for (const shot of fixtureShots) db.insert(assets).values({ projectId: project.id, shotId: shot.shotId, type: "ai_generated", selected: true, filePath: `/api/files/fixture/${shot.shotId}.png`, status: "done" }).run();
  return { project, script };
}
describe("real persisted configuration reaches actual prompt entrypoints; inference is mocked", () => {
  it("commerce uses persisted mode and approved art direction before generating", async () => {
    const { project } = fixture();
    const response = await commerce(request({ projectId: project.id, productName: "白盒", styleType: "scene", llmConfig, insightMode: false }));
    expect(response.status).toBe(200); expect(m.generateScript).toHaveBeenCalledTimes(1);
    expect(m.generateScript.mock.calls[0][0]).toMatchObject({ videoMode: "graphic_montage", styleType: "scene" });
    expect(m.generateScript.mock.calls[0][0].projectDirection).toContain("白底红色强调");
    expect(m.generateScript.mock.calls[0][0].projectDirection).toContain("黑盖不换成白盖");
  });
  it("wrong-content and nonexistent projects fail before paid analysis/script work", async () => {
    const { project } = fixture("topic");
    const wrong = await commerce(request({ projectId: project.id, productName: "白盒", productImages: ["https://example.test/x.png"], llmConfig }));
    expect(wrong.status).toBe(409); expect(m.analyzeProduct).not.toHaveBeenCalled(); expect(m.generateScript).not.toHaveBeenCalled();
    const missing = await commerce(request({ projectId: "missing", productName: "白盒", llmConfig }));
    expect(missing.status).toBe(404); expect(m.generateScript).not.toHaveBeenCalled();
  });
  it("topic forwards its actual narration style, user brief and persisted art constraints", async () => {
    const { project } = fixture("topic");
    const response = await topic(request({ projectId: project.id, topic: "一条真实的旅行路线", narrationStyle: "travel", customRequirements: "只用真实目的地素材", llmConfig }));
    expect(response.status).toBe(200); expect(m.generateTopicScript).toHaveBeenCalledTimes(1);
    expect(m.generateTopicScript.mock.calls[0][0]).toMatchObject({ narrationStyle: "travel", customRequirements: "只用真实目的地素材" });
    expect(m.generateTopicScript.mock.calls[0][0].projectDirection).toContain("白底红色强调");
  });
  it("description edits clear stale image prompts without changing timing, source, camera or voice flags", async () => {
    const { project, script } = fixture();
    const result = await patch(request({ scriptId: script.id, shotTexts: [{ shotId: 1, description: "白盒顶盖半开并停住" }] }), params(project.id));
    expect(result.status).toBe(200);
    const updated = db.select().from(scripts).where(eq(scripts.id, script.id)).get()!.shots!;
    expect(updated[0].prompt).toBeUndefined(); expect(updated[0].description).toBe("白盒顶盖半开并停住");
    expect(updated[0]).toMatchObject({ duration: 4, camera: "固定近景", visualSource: "ai_generate", speakerVisible: false });
    expect(updated[1]).toEqual(fixtureShots[1]);
  });
  it("unchanged descriptions or voice/camera-only edits retain approved stills", async () => {
    const { project, script } = fixture();
    const response = await patch(request({ scriptId: script.id, shotTexts: [{ shotId: 1, voiceover: "新旁白", description: `  ${fixtureShots[0].description}  `, camera: "微距" }] }), params(project.id));
    expect(response.status).toBe(200);
    const updated = db.select().from(scripts).where(eq(scripts.id, script.id)).get()!.shots![0];
    expect(updated.prompt).toBe(fixtureShots[0].prompt); expect(updated.speakerVisible).toBe(false);
  });
  it("grid provider receives project mode/bible and approved initial keyframes, not a generic phone look", async () => {
    const { project, script } = fixture();
    const response = await grid(request({ scriptId: script.id, provider: "fal-ai", apiKey: "test", model: "image-model" }), params(project.id));
    expect(response.status).toBe(200); expect(m.tracked).toHaveBeenCalledTimes(1);
    const prompt = m.tracked.mock.calls[0][1].prompt;
    expect(prompt).toContain("白底红色强调"); expect(prompt).toContain("黑盖不换成白盖");
    expect(prompt).toContain("不添加真人、脸、手"); expect(prompt).toContain(fixtureShots[0].prompt!);
    expect(prompt).not.toContain("保留毛孔细节");
  });
  it("film preview and paid provider receive the identical contextual prompt and ordered staged references", async () => {
    const { project, script } = fixture();
    const input = { scriptId: script.id, provider: "fal-ai", apiKey: "test", model: "bytedance/seedance-2.5/reference-to-video", options: { width: 1280, height: 720 } };
    const previewResponse = await film(request({ ...input, dryRun: true }), params(project.id));
    expect(previewResponse.status).toBe(200); expect(m.video).not.toHaveBeenCalled();
    const preview = await previewResponse.json();
    const response = await film(request(input), params(project.id));
    expect(response.status).toBe(200); expect(m.video).toHaveBeenCalledTimes(1);
    const submitted = m.video.mock.calls[0][0];
    expect(submitted.prompt).toBe(preview.prompt); expect(submitted.prompt).toContain("画幅 16:9");
    expect(submitted.prompt).toContain("不添加真人、脸、手"); expect(submitted.prompt).toContain("白底红色强调");
    expect(submitted.referenceImageUrls).toEqual(fixtureShots.map(s => `https://fal.media/staged/${encodeURIComponent(`/api/files/fixture/${s.shotId}.png`)}`));
    expect(submitted).toMatchObject({ duration: 8, audioEnabled: true });
  });
  it("the judge route reviews a fully silent visual sequence and sees the real mode/state", async () => {
    const { project, script } = fixture();
    const response = await judge(request({ scriptId: script.id, llmConfig }), params(project.id));
    expect(response.status).toBe(200); expect(m.judge).toHaveBeenCalledTimes(1);
    const prompt = m.judge.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain("台词「」"); expect(prompt).toContain("offscreen");
    expect(prompt).toContain("不添加真人、脸、手"); expect(prompt).toContain("白底红色强调");
  });
});
