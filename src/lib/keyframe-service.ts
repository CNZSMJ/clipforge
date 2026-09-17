import { FrameError, frameView, validId, noMissingShot, frameHash, frameShotKey, assertUnchanged } from "@/lib/keyframe-store";
export { FrameError, frameView } from "@/lib/keyframe-store";
const IMAGE = /\.(png|jpe?g|webp)$/i;
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, keyframeRenders, keyframeWorkspaces } from "@/lib/db/schema";
import { compileFrame, sanitizeFrameWorkspace, framePlanningPrompt, parseFramePlan, type FrameWorkspace } from "@/lib/keyframe-direction";
import type { FrameWorkspaceView, FrameRenderRequest } from "@/lib/keyframe-types";
import { createProvider } from "@/lib/providers";
import { buildFalImageRequest, FAL_IMAGE_SPECS } from "@/lib/providers/fal-image-params";
import { generationOptions } from "@/lib/generation-input";
import { toProviderImage, toRemoteUsableImage, resolveUploadFilePath } from "@/lib/remote-image";
import { assertLocalUploadPath } from "@/lib/providers/fal-storage";
import { persistAssetSource } from "@/lib/asset-persistence";
import { validateMediaFile } from "@/lib/media-validate";
import { recordAiTask, updateAiTaskByProviderTaskId } from "@/lib/ai-tasks";
import { createLLMClient, jsonModeParams } from "@/lib/llm-error";
import { extractJSON, type LLMConfig } from "@/lib/script-engine/generator";
import { buildShotQualityContract } from "@/lib/generation-quality";
import { ProviderError } from "@/lib/providers/base";

async function validateWorkspaceReferences(projectId: string, workspace: FrameWorkspace) {
  for (const ref of workspace.references) {
    if (!ref.url.startsWith(`/api/files/${projectId}/`)) throw new FrameError("请上传到本项目，或使用本项目候选图 / Reference must belong to this project");
    const path = resolveUploadFilePath(ref.url);
    if (!path || !IMAGE.test(path)) throw new FrameError("参考图路径无效 / Invalid image reference");
    await assertLocalUploadPath(path);
    if (!(await validateMediaFile(path, "image"))) throw new FrameError("参考图不是有效图片 / Reference is not a valid image");
    if (ref.role === "scene" && !workspace.scenes.some(s => s.id === ref.sceneId)) throw new FrameError("场景参考必须绑定场景 / Bind scene reference to a scene");
    if (ref.role === "layout" && !workspace.specs.some(s => s.shotId === ref.shotId)) throw new FrameError("构图参考必须绑定镜头 / Bind layout reference to a shot");
    if (ref.role === "character" && !ref.characterId) throw new FrameError("人物参考必须填写人物ID / Bind identity reference to a character ID");
  }
}
/** Optimistic concurrency: never clobber another tab's direction or approval. */
export async function saveFrameWorkspace(projectId: string, document: unknown, expectedRevision: number, expectedSourceKey: string) {
  const view = await frameView(projectId);
  if (view.sourceKey !== expectedSourceKey) throw new FrameError("脚本或设定已改变，请刷新后保存 / Direction changed; refresh before saving", 409);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new FrameError("设定必须是对象 / Workspace must be an object");
  const next = sanitizeFrameWorkspace(document, view.shots, view.context);
  next.approvals = view.workspace.approvals; // clients cannot forge approval records through settings
  if (document && typeof document === "object" && "references" in document && Array.isArray(document.references) && document.references.length !== next.references.length) throw new FrameError("存在无效或重复的参考图 / Invalid or duplicate references");
  await validateWorkspaceReferences(projectId, next);
  getDb().transaction(tx => {
    assertUnchanged(view, projectId, true);
    const row = tx.select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, projectId)).get();
    if ((row?.revision ?? 0) !== expectedRevision) throw new FrameError("另一窗口已保存，请刷新 / Another window saved changes; refresh", 409);
    tx.insert(keyframeWorkspaces).values({ projectId, revision: expectedRevision + 1, document: next })
      .onConflictDoUpdate({ target: keyframeWorkspaces.projectId, set: { revision: expectedRevision + 1, document: next } }).run();
  });
  return frameView(projectId);
}
export function frameConfig(value: unknown): LLMConfig {
  const c = value as LLMConfig | undefined;
  if (!c || [c.baseUrl, c.apiKey, c.model].some(s => typeof s !== "string" || !s.trim())) throw new FrameError("请先配置文本/视觉模型 / Configure text/vision models first");
  return { baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, ...(typeof c.visionModel === "string" && { visionModel: c.visionModel }) };
}
export async function planFrames(projectId: string, config: LLMConfig, expectedSourceKey: string) {
  const view = await frameView(projectId);
  if (view.sourceKey !== expectedSourceKey) throw new FrameError("方案已改变，请刷新 / Plan changed; refresh", 409);
  // Single call, bounded output; SDK retries disabled for this explicitly billed planning action.
  const client = createLLMClient(config).withOptions({ maxRetries: 0 });
  const completion = await client.chat.completions.create({ model: config.model,
    messages: [{ role: "user", content: framePlanningPrompt(view.shots, view.context, view.workspace) }],
    max_tokens: Math.min(20000, 1800 + view.shots.length * 600), ...jsonModeParams(config.baseUrl) });
  if (completion.choices[0]?.finish_reason === "length") throw new FrameError("画面方案被截断，未修改现有设定 / Plan was truncated; existing settings unchanged");
  const workspace = parseFramePlan(JSON.parse(extractJSON(completion.choices[0]?.message?.content ?? "")), view.shots, view.context, view.workspace);
  // Return a draft, never silently install LLM-generated directions or overwrite a newer edit.
  return { workspace, revision: view.revision, sourceKey: view.sourceKey };
}
async function automaticReferences(view: FrameWorkspaceView, shotId: number) {
  const spec = view.workspace.specs.find(s => s.shotId === shotId)!;
  const refs: Array<{ url: string; role: "product" | "character"; label: string }> = [];
  if (spec.productVisible && view.context.productImages?.[0]) refs.push({ url: view.context.productImages[0], role: "product", label: view.context.productName || "original product" });
  for (const characterId of spec.characterIds) {
    if (view.workspace.references.some(r => r.role === "character" && r.characterId === characterId)) continue;
    const character = view.context.identityReferences?.[characterId];
    if (character) refs.push({ url: character.url, role: "character", label: `${characterId}: ${character.name}` });
  }
  return refs;
}
export async function previewFrame(projectId: string, input: { shotId: number; model: string; provider: string; options?: unknown; correction?: string; editAssetId?: string; baseUrl?: string }) {
  if (input.baseUrl) {
    let u: URL;
    try { u = new URL(input.baseUrl); } catch { throw new FrameError("平台地址无效 / Invalid gateway URL"); }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new FrameError("平台地址不可包含凭据或查询参数 / Gateway URL must not contain credentials or query parameters");
  }
  if (!FAL_IMAGE_SPECS[input.model]) throw new FrameError("此工作流需要已验证的生图端点，请在设置中选择支持参考图的已内置模型 / Select a built-in, contract-verified image endpoint for this workflow");
  const view = frameView(projectId), shot = noMissingShot(view, input.shotId);
  const edit = input.editAssetId ? view.takes.find(t => t.id === input.editAssetId && t.shotId === input.shotId) : undefined;
  if (input.editAssetId && !edit) throw new FrameError("只能修正本项目本镜候选 / Edit target must belong to this shot");
  if (input.correction && !edit) throw new FrameError("请选择要修正的候选图 / Select an edit target");
  let compilation: ReturnType<typeof compileFrame>;
  let opts: Record<string, unknown>;
  try {
    compilation = compileFrame({ shot, shots: view.shots, workspace: view.workspace, context: view.context,
      automaticReferences: await automaticReferences(view, input.shotId), editTarget: edit?.url, correction: input.correction });
    opts = generationOptions(input.options);
  } catch (error) { throw new FrameError(error instanceof Error ? error.message : "Invalid frame specification"); }
  // Each click buys precisely one candidate, not a hidden 4-image batch. No extra fields may inject references/masks/models.
  const options = { modelId: input.model, mode: compilation.references.length ? "image-to-image" as const : "text-to-image" as const,
    prompt: compilation.prompt, count: 1,
    ...(typeof opts.width === "number" && { width: opts.width }), ...(typeof opts.height === "number" && { height: opts.height }), ...(typeof opts.seed === "number" && { seed: opts.seed }),
    ...(typeof opts.steps === "number" && { steps: opts.steps }), ...(typeof opts.guidanceScale === "number" && { guidanceScale: opts.guidanceScale }),
  };
  if (input.provider !== "fal-ai") throw new FrameError("此审核生图链路目前使用 Fal；其他供应商仍可上传现有素材 / This review workflow currently uses Fal; upload existing assets for other providers");
  try {
    const checked = buildFalImageRequest({ ...options, referenceImageUrls: compilation.references.length ? compilation.references.map((_, i) => `https://reference.invalid/${i}.png`) : undefined });
    options.modelId = checked.modelId;
  } catch (error) { throw new FrameError(error instanceof Error ? error.message : "Model cannot satisfy the frame contract"); }
  const planKey = frameHash({ sourceKey: view.sourceKey, options, references: compilation.references, provider: input.provider, baseUrl: input.baseUrl || "" });
  return { compilation, options, planKey, sourceKey: view.sourceKey, shotKey: view.shotKeys[input.shotId], revision: view.revision, scriptId: view.scriptId, baseUrl: input.baseUrl || "", billing: { imageCalls: 1, autoVideoCalls: 0, autoReviewCalls: 0, priceKnown: false } };
}
const running = new Map<string, Promise<unknown>>();
async function singleFlight<T>(id: string, action: () => Promise<T>): Promise<T> {
  const existing = running.get(id); if (existing) return existing as Promise<T>;
  const result = action(); running.set(id, result);
  try { return await result; } finally { running.delete(id); }
}
function redacted(error: unknown, key: string): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(key, "[redacted]").slice(0, 1200);
}
export async function generateFrame(projectId: string, input: Parameters<typeof previewFrame>[1] & { apiKey: string; requestId: string; expectedPlanKey: string; confirmPaid: boolean; allowSynthetic?: boolean }) {
  validId(input.requestId);
  if (!input.confirmPaid || typeof input.apiKey !== "string" || !input.apiKey.trim()) throw new FrameError("确认单张生图费用并配置 Fal Key / Confirm the single-image charge and configure a Fal key");
  return singleFlight(`${projectId}:${input.requestId}`, async () => {
    const prior = getDb().select().from(keyframeRenders).where(eq(keyframeRenders.id, input.requestId)).get();
    if (prior) {
      if (prior.projectId !== projectId || prior.request.planKey !== input.expectedPlanKey) throw new FrameError("请求ID已用于另一方案 / Request ID belongs to another plan", 409);
      return resumeFrame(projectId, prior.id, input.apiKey); // same ID never buys another image
    }
    const preview = await previewFrame(projectId, input);
    if (preview.planKey !== input.expectedPlanKey) throw new FrameError("画面或参考已改变，请重新预览再生成 / Preview changed; review it before generation", 409);
    const view = frameView(projectId), shot = noMissingShot(view, input.shotId);
    if (view.sourceKey !== preview.sourceKey) throw new FrameError("设定已改变，请重新预览 / Direction changed; preview again", 409);
    if (!preview.compilation.spec.moment.trim()) throw new FrameError("请先整理画面方案或填写本镜的单帧时刻，再生图 / Prepare the plan or specify this shot's still moment first", 409);
    if (shot.visualSource !== "ai_generate" && !input.allowSynthetic) throw new FrameError("原图/真实素材镜头需要明确确认AI替换 / Explicitly confirm replacing a real-footage shot", 409);
    const provider = createProvider({ name: input.provider, apiKey: input.apiKey, baseUrl: input.baseUrl || "" });
    if (!provider.submitImageTask || !provider.waitForTask) throw new FrameError("平台不支持可恢复生图任务 / Provider lacks recoverable image tasks");
    // Validate and stage all references BEFORE writing the paid-submit intent.
    const urls = await Promise.all(preview.compilation.references.map(r => toProviderImage(r.url, provider)));
    if (urls.some(u => !u)) throw new FrameError("参考上传未完成 / Reference upload incomplete");
    const request: FrameRenderRequest = { compilation: preview.compilation, options: preview.options, planKey: preview.planKey, baseUrl: preview.baseUrl };
    getDb().transaction(tx => {
      assertUnchanged(view, projectId);
      const active = tx.select().from(keyframeRenders).where(and(eq(keyframeRenders.projectId, projectId), eq(keyframeRenders.shotId, input.shotId), inArray(keyframeRenders.status, ["submitting", "processing", "download_pending", "unknown"]))).get();
      if (active) throw new FrameError(`此镜有待恢复任务 ${active.id}，不会再次扣费 / Recover this shot's existing task first`, 409);
      tx.insert(keyframeWorkspaces).values({ projectId, revision: view.revision, document: view.workspace }).onConflictDoNothing().run();
      tx.insert(keyframeRenders).values({ id: input.requestId, projectId, scriptId: view.scriptId, shotId: input.shotId,
        sourceKey: preview.shotKey, request, provider: input.provider, model: preview.options.modelId, status: "submitting" }).run();
    });
    try {
      const started = await provider.submitImageTask({ ...preview.options, referenceImageUrl: undefined, referenceImageUrls: urls.length ? urls as string[] : undefined });
      getDb().update(keyframeRenders).set({ taskId: started.taskId, model: started.modelId, status: "processing" }).where(eq(keyframeRenders.id, input.requestId)).run();
      await recordAiTask({ projectId, shotId: input.shotId, provider: input.provider, model: started.modelId, mediaType: "image", taskId: started.taskId, mode: `keyframe:${input.requestId}`, prompt: preview.compilation.prompt });
    } catch (error) {
      const rejected = error instanceof ProviderError && [400, 401, 403, 404, 422, 429].includes(error.statusCode ?? 0);
      getDb().update(keyframeRenders).set({ status: rejected ? "failed" : "unknown", error: redacted(error, input.apiKey) }).where(eq(keyframeRenders.id, input.requestId)).run();
      if (rejected) throw new FrameError(`平台拒绝请求，未自动重试 / Provider rejected the request: ${redacted(error, input.apiKey)}`, 400);
      throw new FrameError(`提交状态不确定，已保存 ${input.requestId}；请核对 Fal 任务后恢复，不会自动重提 / Submission uncertain; reconcile the saved task before retrying`, 502);
    }
    return resumeFrame(projectId, input.requestId, input.apiKey);
  });
}
export async function resumeFrame(projectId: string, renderId: string, apiKey: string) {
  return singleFlight(`resume:${projectId}:${renderId}`, () => resumeFrameOnce(projectId, renderId, apiKey));
}
async function resumeFrameOnce(projectId: string, renderId: string, apiKey: string) {
  validId(projectId); validId(renderId);
  const db = getDb();
  const row = db.select().from(keyframeRenders).where(and(eq(keyframeRenders.id, renderId), eq(keyframeRenders.projectId, projectId))).get();
  if (!row) throw new FrameError("任务不存在 / Task not found", 404);
  if (row.assetId) {
    const asset = db.select().from(assets).where(eq(assets.id, row.assetId)).get();
    const path = asset?.filePath && resolveUploadFilePath(asset.filePath);
    if (path && await validateMediaFile(await assertLocalUploadPath(path).catch(() => ""), "image").catch(() => false)) return { asset, renderId };
  }
  if (!row.taskId) throw new FrameError(`尚无确认的云任务ID；先在 Fal 核对 ${renderId}。不会自动重提 / No acknowledged task ID; reconcile in Fal`, 409);
  if (row.status === "failed") throw new FrameError("云端任务已明确失败，可发起新候选 / Provider task failed; start a new candidate");
  const provider = createProvider({ name: row.provider, apiKey, baseUrl: row.request.baseUrl });
  if (!provider.waitForTask) throw new FrameError("平台无法恢复 / Provider cannot resume tasks");
  try {
    let url: string | undefined = row.resultUrl ?? undefined;
    if (!url) {
      const status = await provider.waitForTask(row.taskId, { interval: 3000 });
      if (status.status === "failed" || status.status === "cancelled") throw new ProviderError(status.error || "Task failed", "TASK_FAILED", row.provider);
      url = status.result && "imageUrls" in status.result ? status.result.imageUrls?.[0] : undefined;
      if (!url) throw new Error("结果尚未可读 / Result not available yet");
      db.update(keyframeRenders).set({ resultUrl: url, status: "download_pending", error: null }).where(eq(keyframeRenders.id, renderId)).run();
      await updateAiTaskByProviderTaskId(row.provider, row.taskId, { status: "download_pending", resultUrls: [url] });
    }
    const filePath = await persistAssetSource(projectId, url, row.shotId, "keyframe");
    const asset = db.transaction(tx => {
      tx.insert(assets).values({ id: renderId, projectId, shotId: row.shotId, type: "ai_generated", filePath, provider: row.provider, model: row.model, prompt: row.request.compilation.prompt, selected: false, status: "done" }).onConflictDoUpdate({ target: assets.id, set: { filePath, status: "done" } }).run();
      tx.update(keyframeRenders).set({ assetId: renderId, status: "ready", error: null }).where(eq(keyframeRenders.id, renderId)).run();
      return tx.select().from(assets).where(eq(assets.id, renderId)).get()!;
    });
    await updateAiTaskByProviderTaskId(row.provider, row.taskId, { status: "completed", resultUrls: [asset.filePath!], error: null });
    return { asset, renderId };
  } catch (error) {
    const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
    db.update(keyframeRenders).set({ status: failed ? "failed" : "unknown", error: redacted(error, apiKey) }).where(eq(keyframeRenders.id, renderId)).run();
    throw new FrameError(failed ? "云端生成失败 / Provider generation failed" : `任务已保存，可恢复而不重新扣费：${renderId} / Task saved; resume without another generation`, failed ? 400 : 502);
  }
}
export async function approveFrame(projectId: string, assetId: string, expectedSourceKey: string, expectedRevision: number, pinScene: boolean, acceptRisk: boolean) {
  const view = await frameView(projectId), take = view.takes.find(t => t.id === assetId);
  if (!take) throw new FrameError("候选图不存在 / Candidate not found", 404);
  if (view.sourceKey !== expectedSourceKey || view.revision !== expectedRevision) throw new FrameError("方案已改变，请刷新 / Plan changed; refresh", 409);
  if ((take.review?.verdict === "reject" || (take.sourceKey && take.sourceKey !== view.shotKeys[take.shotId] && !view.workspace.approvals.some(a => a.assetId === take.id && a.sourceKey === view.shotKeys[take.shotId]))) && !acceptRisk) throw new FrameError("此图质检不通过或方案已过期，请明确人工复核 / Explicit human recheck required", 409);
  const path = resolveUploadFilePath(take.url);
  if (!path || !(await validateMediaFile(await assertLocalUploadPath(path), "image"))) throw new FrameError("候选文件无效 / Candidate file is invalid");
  const workspace = structuredClone(view.workspace);
  if (pinScene) {
    const sceneId = workspace.specs.find(s => s.shotId === take.shotId)!.sceneId;
    workspace.references = [...workspace.references.filter(r => !(r.role === "scene" && r.sceneId === sceneId)), { id: `scene-anchor-${frameHash({ sceneId }).slice(0, 32)}`, role: "scene", url: take.url, sceneId, label: `Approved scene anchor / 已确认场景参考 ${take.shotId}` }];
    if (workspace.references.length > 40) throw new FrameError("参考图数量过多 / Too many references");

  }
  workspace.approvals = [...workspace.approvals.filter(a => a.shotId !== take.shotId), { shotId: take.shotId, assetId, sourceKey: frameShotKey(view, workspace, take.shotId) }];
  getDb().transaction(tx => {
    assertUnchanged(view, projectId, true);
    const row = tx.select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, projectId)).get();
    if ((row?.revision ?? 0) !== expectedRevision) throw new FrameError("另一窗口已更新 / Another window updated the workspace", 409);
    tx.insert(keyframeWorkspaces).values({ projectId, revision: expectedRevision + 1, document: workspace }).onConflictDoUpdate({ target: keyframeWorkspaces.projectId, set: { document: workspace, revision: expectedRevision + 1 } }).run();
    tx.update(assets).set({ selected: false }).where(and(eq(assets.projectId, projectId), eq(assets.shotId, take.shotId))).run();
    tx.update(assets).set({ selected: true }).where(eq(assets.id, assetId)).run();
  });
  return frameView(projectId);
}
export async function reviewFrame(projectId: string, renderId: string, config: LLMConfig, locale: "zh" | "en") {
  return singleFlight(`review:${projectId}:${renderId}`, () => reviewFrameOnce(projectId, renderId, config, locale));
}
async function reviewFrameOnce(projectId: string, renderId: string, config: LLMConfig, locale: "zh" | "en") {
  const row = getDb().select().from(keyframeRenders).where(and(eq(keyframeRenders.id, renderId), eq(keyframeRenders.projectId, projectId))).get();
  if (!row?.assetId) throw new FrameError("请先完成候选图 / Finish a candidate first", 409);
  const view = await frameView(projectId), shot = noMissingShot(view, row.shotId);
  if (row.review?.sourceKey === view.shotKeys[row.shotId]) return row.review;
  if (row.sourceKey !== view.shotKeys[row.shotId] && !view.workspace.approvals.some(a => a.assetId === row.assetId && a.sourceKey === view.shotKeys[row.shotId])) throw new FrameError("候选对应旧方案，请人工复核或修正，不用新方案给旧图打分 / Candidate belongs to an older plan", 409);
  const take = view.takes.find(t => t.id === row.assetId)!;
  const currentCompilation = compileFrame({ shot, shots: view.shots, context: view.context, workspace: view.workspace, automaticReferences: await automaticReferences(view, row.shotId) });
  // Never compare a candidate to itself after it has been pinned as the scene sample.
  const refs = currentCompilation.references.filter(r => r.url !== take.url);
  const contract = buildShotQualityContract({ shot: { ...shot, description: currentCompilation.spec.moment || shot.description, prompt: currentCompilation.prompt, textOverlay: undefined }, mediaType: "image", bible: view.context.visualBible, intent: view.context.creativeIntent,
    hasProductReference: refs.some(r => r.role === "product"), hasCharacterReference: refs.some(r => r.role === "character"), hasPreviousReference: false });
  contract.description = currentCompilation.spec.moment || shot.description;
  contract.prompt = currentCompilation.prompt;
  contract.dimensions.find(d => d.id === "action-binding")!.criteria = ["Evaluate this STILL moment, not whether the future action has finished", "Check torso/head orientation, gaze target, anatomical left/right hands, reachable grip, object contact/support, scale and occlusion", currentCompilation.spec.blocking, currentCompilation.spec.hands, currentCompilation.spec.contacts].filter(Boolean);
  contract.dimensions.find(d => d.id === "visual-fidelity")!.criteria = ["Match the approved medium, palette, light and material treatment, not generic photographic beauty", currentCompilation.prompt.split("SHOT PURPOSE")[0]];
  const output = await toRemoteUsableImage(take.url);
  const urls = await Promise.all(refs.map(r => toRemoteUsableImage(r.url)));
  const { evaluateGenerationQuality } = await import("@/lib/generation-quality-evaluator");
  const report = await evaluateGenerationQuality({ contract, config, locale, outputImageDataUrl: output!, referenceImageUrls: urls as string[],
    maxRetries: 0, sampleContext: `Image 1 is the candidate. Subsequent references: ${refs.map((r, i) => `image ${i + 2}: ${r.role} (${r.label})`).join("; ")}. Do not treat a pose/scene/style reference as identity. Anatomy, impossible contact, wrong identity or wrong medium are critical; attractive lighting cannot cancel these. Missing evidence requires review, not confidence.` });
  getDb().update(keyframeRenders).set({ review: { ...report, sourceKey: view.shotKeys[row.shotId] } }).where(eq(keyframeRenders.id, renderId)).run();
  return report;
}

/** Explicit operator reconciliation, never a retry of the generation POST. */
export async function reconcileFrame(projectId: string, renderId: string, input: { apiKey: string; requestId?: string; notAccepted?: boolean; confirmed: boolean }) {
  validId(projectId); validId(renderId);
  const db = getDb(), row = db.select().from(keyframeRenders).where(and(eq(keyframeRenders.id, renderId), eq(keyframeRenders.projectId, projectId))).get();
  if (!row || row.taskId || row.assetId || !["submitting", "unknown"].includes(row.status)) throw new FrameError("此任务不需要人工绑定回执 / This task does not need manual reconciliation", 409);
  if (!input.confirmed || running.has(`${projectId}:${renderId}`) || (row.status === "submitting" && Date.now() - row.createdAt.getTime() < 300_000)) throw new FrameError("先等待提交结束并核对供应商历史，再明确确认 / Wait for submission to finish and explicitly verify provider history", 409);
  if (input.notAccepted && input.requestId) throw new FrameError("请选择一种核对结果 / Choose one reconciliation outcome");
  let taskId: string | undefined;
  if (!input.notAccepted) {
    if (!input.apiKey || !/^[\w-]{1,200}$/.test(input.requestId ?? "")) throw new FrameError("请输入控制台的真实 request_id 和 Key / Enter the actual provider request_id and key");
    const { encodeFalTask } = await import("@/lib/providers/fal-queue");
    taskId = encodeFalTask(row.model, { request_id: input.requestId }, row.request.baseUrl || undefined);
    // GET confirms that this account can access the identified request. The operator is responsible
    // for matching its prompt/model/time to the intent; a 404 alone never authorizes another POST.
    const provider = createProvider({ name: row.provider, apiKey: input.apiKey, baseUrl: row.request.baseUrl });
    await provider.getTaskStatus(taskId);
  }
  db.transaction(tx => {
    const current = tx.select().from(keyframeRenders).where(eq(keyframeRenders.id, renderId)).get();
    if (current?.taskId || current?.assetId || current?.status !== row.status) throw new FrameError("回执已更新，请刷新 / Acknowledgement changed; refresh", 409);
    tx.update(keyframeRenders).set(taskId ? { taskId, status: "processing", error: null } : { status: "failed", error: `Operator verified not accepted at ${new Date().toISOString()}; no automatic resubmission.` }).where(eq(keyframeRenders.id, renderId)).run();
  });
  if (taskId) await recordAiTask({ projectId, shotId: row.shotId, provider: row.provider, model: row.model, mediaType: "image", taskId, mode: `keyframe:${renderId}`, prompt: row.request.compilation.prompt });
  return frameView(projectId);
}
