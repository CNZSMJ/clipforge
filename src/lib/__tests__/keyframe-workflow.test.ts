// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
const env = vi.hoisted(() => {
  const previous = process.env.APP_DATA_DIR, root = `/tmp/clipforge-keyframe-${process.pid}-${Date.now()}`;
  process.env.APP_DATA_DIR = root; return { previous, root };
});
const m = vi.hoisted(() => ({ create: vi.fn(), submit: vi.fn(), wait: vi.fn(), upload: vi.fn(), persist: vi.fn(), review: vi.fn(), status: vi.fn(), llm: vi.fn() }));
vi.mock("../providers", () => ({ createProvider: m.create }));
vi.mock("../asset-persistence", async original => ({ ...await original<typeof import("../asset-persistence")>(), persistAssetSource: m.persist }));
vi.mock("../generation-quality-evaluator", () => ({ evaluateGenerationQuality: m.review }));
vi.mock("../llm-error", async original => ({ ...await original<typeof import("../llm-error")>(), createLLMClient: () => ({ withOptions: () => ({ chat: { completions: { create: m.llm } } }) }) }));
import { getDb } from "../db";
import { projects, scripts, assets, characters, keyframeRenders, keyframeWorkspaces, aiTasks, type Shot } from "../db/schema";
import { frameView, frameShotKey, assertFrameApproved, assertSelectedFramesApproved } from "../keyframe-store";
import { saveFrameWorkspace, previewFrame, generateFrame, resumeFrame, approveFrame, reviewFrame, reconcileFrame, planFrames } from "../keyframe-service";
import { POST, PATCH } from "@/app/api/project/[id]/keyframes/route";
import { POST as legacyImage } from "@/app/api/ai/image/route";
import { POST as video } from "@/app/api/ai/video/route";
import { POST as taskRecovery } from "@/app/api/ai/video/task/route";
import { ProviderError } from "../providers/base";
import type { GenerationQualityReport } from "../generation-quality";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYElEQVR4nO3PQQ0AIBDAMMC/50MEj4ZkVbDtmVk/OzrgVQNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgPaBXKqA31N0fbGAAAAAElFTkSuQmCC", "base64");
const db = getDb(), model = "openai/gpt-image-2.5/sunburst/edit", key = "test-secret-never-store";
const llm = { model: "text-model", visionModel: "vision-model", apiKey: key, baseUrl: "https://example.test/v1" };
const rawShots: Shot[] = [1, 2, 3].map(shotId => ({ shotId, type: "demo", duration: 4, description: `咖啡机前第${shotId}步`, prompt: "legacy image hint", camera: "fixed close view", voiceover: "", visualSource: "ai_generate", transition: "direct_concat" }));
let p: string, output: string, oldAsset: string;
const request = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = () => ({ params: Promise.resolve({ id: p }) });
const input = (shotId = 1) => ({ shotId, model, provider: "fal-ai", options: { width: 1024, height: 1024, count: 9, prompt: "cannot override", referenceImageUrls: ["https://evil.invalid/private"] } });
async function prepared() {
  const view = frameView(p), w = structuredClone(view.workspace);
  w.style = { medium: "3d", palette: "white/red", lighting: "west window", texture: "matte white acrylic" };
  w.specs.forEach(s => Object.assign(s, { moment: `cup supported before action ${s.shotId}`, state: "cup empty", contacts: "cup on tray", blocking: "toward coffee machine" }));
  w.specs[1].sceneId = w.specs[0].sceneId;
  return saveFrameWorkspace(p, w, view.revision, view.sourceKey);
}
async function generate(shotId = 1, id = crypto.randomUUID()) {
  const config = input(shotId), preview = await previewFrame(p, config);
  return generateFrame(p, { ...config, apiKey: key, requestId: id, expectedPlanKey: preview.planKey, confirmPaid: true });
}
beforeEach(async () => {
  vi.clearAllMocks(); for (const mock of Object.values(m)) mock.mockReset();
  p = db.insert(projects).values({ name: "Coffee frame test", productName: "咖啡机", contentType: "product", videoMode: "scene_demo" }).returning().get().id;
  await mkdir(join(env.root, "uploads", p), { recursive: true });
  for (const file of ["product.png", "old.png", "output.png", "style.png", "layout.png"]) await writeFile(join(env.root, "uploads", p, file), PNG);
  db.update(projects).set({ productImages: [`/api/files/${p}/product.png`] }).where(eq(projects.id, p)).run();
  db.insert(scripts).values({ projectId: p, styleType: "scene", selected: true, shots: structuredClone(rawShots) }).run();
  oldAsset = db.insert(assets).values({ projectId: p, shotId: 1, type: "user_upload", filePath: `/api/files/${p}/old.png`, selected: true, status: "done" }).returning().get().id;
  output = `/api/files/${p}/output.png`;
  m.upload.mockImplementation(async (path: string) => `https://fal.media/staged/${path.split("/").at(-1)}`);
  m.submit.mockResolvedValue({ taskId: "cloud-handle", modelId: model });
  m.wait.mockResolvedValue({ status: "completed", result: { imageUrls: ["https://fal.media/result.png"] } });
  m.persist.mockResolvedValue(output);
  m.status.mockResolvedValue({ status: "processing" });
  m.create.mockReturnValue({ name: "fal-ai", uploadLocalMedia: m.upload, submitImageTask: m.submit, waitForTask: m.wait, getTaskStatus: m.status });
});
afterAll(async () => { if (env.previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = env.previous; await rm(env.root, { recursive: true, force: true }); });

describe("real database and routes, mocked billable boundary", () => {
  it("free preview contains assigned refs and a single-image budget; unknown options cannot change authority", async () => {
    await prepared(); const v = frameView(p), w = structuredClone(v.workspace);
    w.references.push({ id: "style", role: "style", url: `/api/files/${p}/style.png`, label: "approved style" }, { id: "pose", role: "layout", url: `/api/files/${p}/layout.png`, label: "hand sketch", shotId: 1 });
    await saveFrameWorkspace(p, w, v.revision, v.sourceKey);
    const result = await previewFrame(p, input());
    expect(result.options.count).toBe(1); expect(result.compilation.references.map(r => r.role)).toEqual(["product", "style", "layout"]);
    expect(result.options.prompt).toContain("Image 3 — layout"); expect(JSON.stringify(result)).not.toContain("evil.invalid"); expect(m.create).not.toHaveBeenCalled();
  });
  it("persists the acknowledged handle before polling, submits staged URLs in exact order and never auto-selects the image", async () => {
    await prepared(); m.wait.mockImplementation(async () => {
      expect(db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).get()).toMatchObject({ taskId: "cloud-handle", status: "processing" });
      return { status: "completed", result: { imageUrls: ["https://fal.media/result.png"] } };
    });
    const saved = await generate(); expect(m.submit).toHaveBeenCalledOnce();
    expect(m.submit.mock.calls[0][0]).toMatchObject({ count: 1, referenceImageUrls: ["https://fal.media/staged/product.png"] });
    expect(saved.asset?.selected).toBe(false); expect(db.select().from(assets).where(eq(assets.id, oldAsset)).get()?.selected).toBe(true);
    expect(JSON.stringify(db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).all())).not.toContain(key);
    expect(m.review).not.toHaveBeenCalled(); expect(m.llm).not.toHaveBeenCalled();
    await expect(assertFrameApproved(p, 1, output)).rejects.toThrow("Approve");
    const v = frameView(p); await approveFrame(p, saved.asset!.id, v.sourceKey, v.revision, false, false);
    await expect(assertFrameApproved(p, 1, output)).resolves.toBeUndefined();
    await expect(assertFrameApproved(p, 1, `/api/files/${p}/old.png`)).rejects.toThrow("Approve");
    await expect(assertFrameApproved(p, 1, undefined, undefined, [output])).resolves.toBeUndefined();
    await expect(assertFrameApproved(p, 1, `/api/files/${p}/old.png`, undefined, [output])).rejects.toThrow("Approve");
  });
  it("coalesces repeat clicks with the same request ID and recovers without another purchase", async () => {
    await prepared(); const config = input(), preview = await previewFrame(p, config);
    const payload = { ...config, requestId: crypto.randomUUID(), apiKey: key, expectedPlanKey: preview.planKey, confirmPaid: true };
    const [a, b] = await Promise.all([generateFrame(p, payload), generateFrame(p, payload)]);
    expect(a.asset?.id).toBe(b.asset?.id); expect(m.submit).toHaveBeenCalledOnce();
    await generateFrame(p, payload); expect(m.submit).toHaveBeenCalledOnce();
  });
  it("upload failure occurs before any paid intent or submission", async () => {
    await prepared(); m.upload.mockRejectedValue(new Error("upload offline")); await expect(generate()).rejects.toThrow("offline");
    expect(m.submit).not.toHaveBeenCalled(); expect(db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).all()).toHaveLength(0);
  });
  it("rejects a stale preview and rechecks source after an asynchronous upload", async () => {
    await prepared(); const config = input(), preview = await previewFrame(p, config); const v = frameView(p);
    await saveFrameWorkspace(p, { ...v.workspace, style: { ...v.workspace.style, palette: "blue" } }, v.revision, v.sourceKey);
    await expect(generateFrame(p, { ...config, requestId: crypto.randomUUID(), apiKey: key, expectedPlanKey: preview.planKey, confirmPaid: true })).rejects.toThrow("Preview changed");
    m.upload.mockImplementationOnce(async () => { const current = frameView(p); await saveFrameWorkspace(p, { ...current.workspace, style: { ...current.workspace.style, palette: "green" } }, current.revision, current.sourceKey); return "https://fal.media/staged/product.png"; });
    await expect(generate()).rejects.toThrow("changed during"); expect(m.submit).not.toHaveBeenCalled();
  });
  it("missing frame moments cannot be bought, and a real-footage shot cannot silently become AI", async () => {
    await expect(generate()).rejects.toThrow("still moment"); await prepared();
    const v = frameView(p); db.update(scripts).set({ shots: v.shots.map(s => ({ ...s, visualSource: "product_image" })) }).where(eq(scripts.id, v.scriptId)).run();
    await expect(generate()).rejects.toThrow("replacing a real-footage"); expect(m.submit).not.toHaveBeenCalled();
  });
  it("poll and download failures retain the original cloud task and unselected candidate history", async () => {
    await prepared(); m.wait.mockRejectedValueOnce(new Error("temporary poll failure")); await expect(generate()).rejects.toThrow("resume");
    const row = db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).get()!;
    expect(row.taskId).toBe("cloud-handle"); m.persist.mockRejectedValueOnce(new Error("disk full")); await expect(resumeFrame(p, row.id, key)).rejects.toThrow("resume");
    const result = await resumeFrame(p, row.id, key); expect(result.asset?.selected).toBe(false); expect(m.submit).toHaveBeenCalledOnce(); expect(m.wait).toHaveBeenCalledTimes(2);
  });
  it("blocks a second paid request while a different request for this shot is unresolved", async () => {
    await prepared(); m.wait.mockRejectedValueOnce(new Error("poll lost")); await expect(generate()).rejects.toThrow("resume");
    await expect(generate()).rejects.toThrow("existing task"); expect(m.submit).toHaveBeenCalledOnce();
  });
  it("uncertain acknowledgement is never retried and has an explicit reconciliation path", async () => {
    await prepared(); m.submit.mockRejectedValueOnce(new Error(`socket closed ${key}`)); await expect(generate()).rejects.toThrow("uncertain");
    const row = db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).get()!;
    expect(row.error).not.toContain(key); await expect(generate()).rejects.toThrow("existing task");
    await expect(reconcileFrame(p, row.id, { apiKey: key, notAccepted: true, confirmed: false })).rejects.toThrow("explicitly");
    await reconcileFrame(p, row.id, { apiKey: key, requestId: "real-provider-request", confirmed: true });
    expect(m.status).toHaveBeenCalledOnce(); expect(db.select().from(keyframeRenders).where(eq(keyframeRenders.id, row.id)).get()?.taskId).toContain("real-provider-request"); expect(m.submit).toHaveBeenCalledOnce();
  });
  it("definitive provider rejection is surfaced, not trapped as an unresolvable submission", async () => {
    await prepared(); m.submit.mockRejectedValueOnce(new ProviderError("insufficient permission", "API_ERROR", "fal-ai", 403));
    await expect(generate()).rejects.toThrow("Provider rejected"); expect(frameView(p).pending).toHaveLength(0); expect(m.submit).toHaveBeenCalledOnce();
  });
  it("approval+scene pin is one atomic revision and invalidates only same-scene dependents", async () => {
    const initial = await prepared(); const saved = await generate(); const v = frameView(p);
    const pinned = await approveFrame(p, saved.asset!.id, v.sourceKey, v.revision, true, false);
    expect(pinned.revision).toBe(v.revision + 1); expect(pinned.shotKeys[2]).not.toBe(initial.shotKeys[2]); expect(pinned.shotKeys[3]).toBe(initial.shotKeys[3]);
    expect(pinned.workspace.approvals[0].sourceKey).toBe(pinned.shotKeys[1]); await assertFrameApproved(p, 1, output);
    await expect(approveFrame(p, saved.asset!.id, v.sourceKey, v.revision, true, false)).rejects.toThrow("changed");
    expect(db.select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, p)).get()?.revision).toBe(pinned.revision);
  });
  it("style changes invalidate all frames; scene-local state edits don't invalidate unrelated scenes", async () => {
    await prepared(); const v = frameView(p), w = structuredClone(v.workspace);
    w.scenes[0].layout = "new topology"; expect(frameShotKey(v, w, 1)).not.toBe(v.shotKeys[1]); expect(frameShotKey(v, w, 3)).toBe(v.shotKeys[3]);
    w.style.medium = "photography"; expect(frameShotKey(v, w, 3)).not.toBe(v.shotKeys[3]);
  });
  it("keeps scene sample IDs unique when a shot is regrouped and explicitly re-approved", async () => {
    await prepared(); const result = await generate(); let v = frameView(p);
    const firstScene = v.workspace.specs[0].sceneId;
    v = await approveFrame(p, result.asset!.id, v.sourceKey, v.revision, true, false);
    const w = structuredClone(v.workspace), secondScene = w.specs[2].sceneId;
    expect(secondScene).not.toBe(firstScene);
    w.specs[0].sceneId = secondScene;
    v = await saveFrameWorkspace(p, w, v.revision, v.sourceKey);
    v = await approveFrame(p, result.asset!.id, v.sourceKey, v.revision, true, true);
    const samples = v.workspace.references.filter(r => r.role === "scene");
    expect(samples.map(r => r.sceneId).sort()).toEqual([firstScene, secondScene].sort());
    expect(new Set(samples.map(r => r.id)).size).toBe(2);
    expect(frameView(p).workspace.references.filter(r => r.role === "scene")).toHaveLength(2);
    expect(() => assertFrameApproved(p, 1, output)).not.toThrow();
    expect(m.submit).toHaveBeenCalledOnce();
  });
  it("validates uploaded bytes/scope and rejects stale saves or forged approval documents", async () => {
    const v = await prepared(); await writeFile(join(env.root, "uploads", p, "bad.png"), "not a PNG");
    await expect(saveFrameWorkspace(p, { ...v.workspace, references: [{ id: "bad", role: "style", url: `/api/files/${p}/bad.png`, label: "bad" }] }, v.revision, v.sourceKey)).rejects.toThrow("valid image");
    await expect(saveFrameWorkspace(p, { ...v.workspace, references: [{ id: "other", role: "style", url: "/api/files/other/style.png", label: "other" }] }, v.revision, v.sourceKey)).rejects.toThrow("belong");
    await expect(saveFrameWorkspace(p, null, v.revision, v.sourceKey)).rejects.toThrow("object");
    const saved = await saveFrameWorkspace(p, { ...v.workspace, approvals: [{ shotId: 1, assetId: oldAsset, sourceKey: v.shotKeys[1] }] }, v.revision, v.sourceKey);
    expect(saved.workspace.approvals).toEqual([]); await expect(saveFrameWorkspace(p, v.workspace, v.revision, v.sourceKey)).rejects.toThrow();
  });
  it("vision check uses a still-specific physical/style contract, caches it, and critical rejection requires human override", async () => {
    await prepared(); const saved = await generate();
    const report: GenerationQualityReport = { version: 1, summary: "Hand contact is impossible", overall: 80, confidence: .8, verdict: "reject", dimensions: [], issues: [{ code: "contact", dimension: "action-binding", severity: "critical", summary: "reversed wrist", suggestedFix: "align grip" }], evaluatedAt: new Date().toISOString() };
    m.review.mockResolvedValue(report);
    await reviewFrame(p, saved.renderId, llm, "en"); await reviewFrame(p, saved.renderId, llm, "en"); expect(m.review).toHaveBeenCalledOnce();
    const input = m.review.mock.calls[0][0]; expect(input.contract.dimensions.find((d: { id: string }) => d.id === "action-binding").criteria.join(" ")).toContain("STILL moment");
    expect(input.referenceImageUrls).toHaveLength(1); expect(input.sampleContext).toContain("image 2: product");
    const v = frameView(p); await expect(approveFrame(p, saved.asset!.id, v.sourceKey, v.revision, false, false)).rejects.toThrow("human recheck");
    await approveFrame(p, saved.asset!.id, v.sourceKey, v.revision, false, true); await assertFrameApproved(p, 1, output);
  });
  it("changing a reusable identity reference invalidates its approved frame contract", async () => {
    db.update(projects).set({ videoMode: "live_presenter" }).where(eq(projects.id, p)).run();
    const person = db.insert(characters).values({ name: "Presenter", referenceImages: [`/api/files/${p}/old.png`] }).returning().get();
    const view = await prepared(), w = structuredClone(view.workspace); w.specs[0].characterIds = [person.id];
    await saveFrameWorkspace(p, w, view.revision, view.sourceKey);
    const before = frameView(p); expect((await previewFrame(p, input())).compilation.references.some(r => r.role === "character")).toBe(true);
    db.update(characters).set({ referenceImages: [`/api/files/${p}/output.png`] }).where(eq(characters.id, person.id)).run();
    expect(frameView(p).shotKeys[1]).not.toBe(before.shotKeys[1]); expect(frameView(p).shotKeys[3]).toBe(before.shotKeys[3]);
  });
  it("planning is one explicit call returning a draft, with no persisted rewrite or image generation", async () => {
    const view = await prepared(); m.llm.mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ specs: view.workspace.specs, scenes: view.workspace.scenes }) } }] });
    const result = await planFrames(p, llm, view.sourceKey); expect(result.workspace.specs).toHaveLength(3); expect(frameView(p).revision).toBe(view.revision);
    expect(m.llm).toHaveBeenCalledOnce(); expect(m.submit).not.toHaveBeenCalled();
  });
  it("actual HTTP routes enforce explicit charges, independent legacy gates and scene-scoped approval before video", async () => {
    const v = await prepared();
    expect((await POST(request({ action: "generate", ...input(), apiKey: key }), params())).status).toBe(400);
    expect((await legacyImage(request({ projectId: p, shotId: 1, provider: "fal-ai", model, prompt: "bypass", apiKey: key }))).status).toBe(409);
    expect((await video(request({ projectId: p, shotId: 1, provider: "fal-ai", model: "video", prompt: "animate", imageUrl: output, apiKey: key }))).status).toBe(409);
    expect((await PATCH(request({ action: "save", revision: v.revision, sourceKey: v.sourceKey, workspace: null }), params())).status).toBe(400); expect(m.submit).not.toHaveBeenCalled();
  });
  it("global task recovery uses the same unselected candidate and never buys another image", async () => {
    await prepared(); m.wait.mockRejectedValueOnce(new Error("lost poll")); await expect(generate()).rejects.toThrow();
    const row = db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, p)).get()!;
    // Handle is unique per real provider request; remove fixtures from previous tests sharing the mock handle.
    db.delete(aiTasks).where(eq(aiTasks.taskId, "cloud-handle")).run();
    db.insert(aiTasks).values({ projectId: p, shotId: 1, provider: "fal-ai", model, taskId: "cloud-handle", mediaType: "image", mode: `keyframe:${row.id}`, status: "unknown" }).run();
    const response = await taskRecovery(request({ provider: "fal-ai", apiKey: key, taskId: "cloud-handle", wait: true }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ persisted: true, keyframeReviewRequired: true });
    expect(db.select().from(assets).where(eq(assets.id, row.id)).get()?.selected).toBe(false); expect(m.submit).toHaveBeenCalledOnce();
  });
  it("compose cannot use an unapproved or separately selected candidate", async () => {
    await prepared(); await generate(); await expect(assertSelectedFramesApproved(p)).rejects.toThrow("Approve");
  });
  it("new topic styles survive persistence and select their image direction rather than falling back to generic commerce", () => {
    const v = frameView(p); db.update(projects).set({ contentType: "topic" }).where(eq(projects.id, p)).run();
    db.update(scripts).set({ styleType: "custom", narrationStyle: "knowledge" }).where(eq(scripts.id, v.scriptId)).run();
    expect(frameView(p).context.styleType).toBe("knowledge");
  });
});
