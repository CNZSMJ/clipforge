/** Server-side read model and approval gate, deliberately independent of inference clients. */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, characters, keyframeRenders, keyframeWorkspaces, projects, scripts } from "@/lib/db/schema";
import { defaultFrameWorkspace, sanitizeFrameWorkspace, type FrameContext } from "@/lib/keyframe-direction";
import type { FrameWorkspaceView } from "@/lib/keyframe-types";
const SAFE_ID = /^[a-zA-Z0-9-]{1,100}$/;
/** Canonical object order keeps persisted/sanitized data fingerprints stable; array order is semantic. */
export const frameHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v, (_key, value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
})).digest("hex");
const IMAGE = /\.(png|jpe?g|webp)$/i;
export class FrameError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function validId(id: string) { if (!SAFE_ID.test(id)) throw new FrameError("无效的ID / Invalid ID"); }
export function noMissingShot(view: FrameWorkspaceView, shotId: number) {
  const shot = view.shots.find(s => s.shotId === shotId);
  if (!shot) throw new FrameError("分镜已改变，请刷新 / Shot changed; refresh", 409);
  return shot;
}
export function frameView(projectId: string): FrameWorkspaceView {
  validId(projectId);
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new FrameError("项目不存在 / Project not found", 404);
  const scriptRows = db.select().from(scripts).where(eq(scripts.projectId, projectId)).orderBy(desc(scripts.createdAt)).all();
  const script = scriptRows.find(s => s.selected) ?? scriptRows[0];
  if (!script?.shots?.length) throw new FrameError("请先选择一个分镜脚本 / Select a storyboard first", 409);
  if (script.shots.length > 60) throw new FrameError("画面工作台每次最多处理60镜 / The keyframe workspace supports up to 60 shots");
  const row = db.select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, projectId)).get();
  const context: FrameContext = {
    contentType: project.contentType, videoMode: project.videoMode, styleType: project.contentType === "topic" ? script.narrationStyle ?? script.styleType : script.styleType,
    productName: project.productName, productDescription: project.productDescription, productAnalysis: project.productAnalysis,
    productImages: project.productImages, characterId: project.characterId, creativeIntent: project.creativeIntent,
    visualBible: project.visualBible, characters: script.characters,
  };
  const workspace = sanitizeFrameWorkspace(row?.document ?? defaultFrameWorkspace(script.shots, context), script.shots, context);
  const visibleIdentities = [...new Set(workspace.specs.flatMap(s => s.characterIds))]
    .filter(id => !workspace.references.some(r => r.role === "character" && r.characterId === id));
  // Include the actual reusable library references in revision fingerprints, not just their IDs.
  if (visibleIdentities.length) {
    const cast = db.select().from(characters).where(inArray(characters.id, visibleIdentities)).all();
    context.identityReferences = Object.fromEntries(cast.filter(c => c.referenceImages?.[0]).map(c => [c.id,
      { name: c.name, url: c.referenceImages![0], ...(c.appearance && { appearance: c.appearance }) }]));
  }
  const sourceKey = frameSourceKey({ scriptId: script.id, shots: script.shots, context }, workspace);
  const shotKeys = Object.fromEntries(script.shots.map(shot => [shot.shotId, frameShotKey({ scriptId: script.id, shots: script.shots!, context }, workspace, shot.shotId)]));
  const renderRows = db.select().from(keyframeRenders).where(eq(keyframeRenders.projectId, projectId)).orderBy(desc(keyframeRenders.createdAt)).all();
  const assetRows = db.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.status, "done"))).orderBy(desc(assets.createdAt)).all();
  return {
    revision: row?.revision ?? 0, sourceKey, shotKeys, workspace, context, shots: script.shots, scriptId: script.id,
    takes: assetRows.filter(a => a.filePath && IMAGE.test(a.filePath)).map(a => {
      const render = renderRows.find(r => r.assetId === a.id);
      return { id: a.id, shotId: a.shotId, url: a.filePath!, selected: a.selected, status: a.status,
        ...(render && { sourceKey: render.sourceKey, renderId: render.id, review: render.review?.sourceKey === shotKeys[a.shotId] ? render.review : null }) };
    }),
    pending: renderRows.filter(r => ["submitting", "processing", "download_pending", "unknown"].includes(r.status)).map(({ id, shotId, status, taskId, provider, model, error }) => ({ id, shotId, status, taskId, provider, model, error })),
  };
}
export function frameSourceKey(view: Pick<FrameWorkspaceView, "scriptId" | "shots" | "context">, workspace: FrameWorkspaceView["workspace"]): string {
  return frameHash({ scriptId: view.scriptId, shots: view.shots, context: view.context, direction: { ...workspace, approvals: undefined } });
}
export function assertUnchanged(view: FrameWorkspaceView, projectId: string, revision = false) {
  const current = frameView(projectId);
  if (current.sourceKey !== view.sourceKey || (revision && current.revision !== view.revision)) throw new FrameError("脚本或设定在操作中已改变，请刷新 / Storyboard or direction changed during the operation; refresh", 409);
}
export function hasFrameWorkspace(projectId?: string) {
  return !!projectId && !!getDb().select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, projectId)).get();
}
/** A saved workspace enables the review gate. Existing unrelated projects retain compatibility. */
export async function assertFrameApproved(projectId: string | undefined, shotId?: number, firstFrame?: string, allFrames?: { scriptId: string; urls: string[] }, referenceFrames?: string[]) {
  if (!projectId || !getDb().select().from(keyframeWorkspaces).where(eq(keyframeWorkspaces.projectId, projectId)).get()) return;
  const view = await frameView(projectId);
  if (allFrames && allFrames.scriptId !== view.scriptId) throw new FrameError("只能生成当前已确认脚本 / Only the reviewed storyboard may be rendered", 409);
  const shots = shotId == null ? view.shots : [noMissingShot(view, shotId)];
  for (const shot of shots) {
    const approval = view.workspace.approvals.find(a => a.shotId === shot.shotId && a.sourceKey === view.shotKeys[shot.shotId]);
    const take = approval && view.takes.find(t => t.id === approval.assetId);
    // Original product photos/stock are not AI keyframes unless replaced with an AI candidate.
    const hasAi = view.takes.some(t => t.shotId === shot.shotId && t.renderId);
    if (shot.visualSource !== "ai_generate" && !hasAi) continue;
    if (!take || (shotId != null && (firstFrame ? firstFrame !== take.url : !referenceFrames?.includes(take.url))) || (allFrames && !allFrames.urls.includes(take.url))) throw new FrameError(`镜头 ${shot.shotId} 的关键帧尚未确认或已变更，请先在画面工作台确认 / Approve the current keyframe for shot ${shot.shotId} before buying video`, 409);
  }
}

/** Scene-local changes invalidate only dependent frames; project style changes invalidate all. */
export function frameShotKey(view: Pick<FrameWorkspaceView, "scriptId" | "shots" | "context">, w: FrameWorkspaceView["workspace"], shotId: number): string {
  const shot = view.shots.find(s => s.shotId === shotId), spec = w.specs.find(s => s.shotId === shotId);
  const index = view.shots.findIndex(s => s.shotId === shotId);
  const previous = index > 0 ? w.specs.find(s => s.shotId === view.shots[index - 1].shotId && s.sceneId === spec?.sceneId) : undefined;
  const references = w.references.filter(r => (r.shotId == null || r.shotId === shotId) && (!r.sceneId || r.sceneId === spec?.sceneId)
    && (r.role !== "product" || spec?.productVisible) && (r.role !== "character" || spec?.characterIds.includes(r.characterId ?? "")));
  const context = { ...view.context, ...(view.context.identityReferences && { identityReferences:
    Object.fromEntries(Object.entries(view.context.identityReferences).filter(([id]) => spec?.characterIds.includes(id))) }) };
  return frameHash({ scriptId: view.scriptId, context, shot, spec, previousState: previous?.state,
    style: w.style, scene: w.scenes.find(s => s.id === spec?.sceneId), references });
}

/** Read the approved visual treatment without importing image-specific reference indexes into video. */
export function approvedFrameMotionDirection(projectId?: string, shotId?: number): string {
  if (!hasFrameWorkspace(projectId)) return "";
  const view = frameView(projectId!);
  const specs = shotId == null ? view.workspace.specs : view.workspace.specs.filter(s => s.shotId === shotId);
  return `APPROVED KEYFRAME AUTHORITY: preserve the supplied keyframes' medium, identities, wardrobe, world-space scene topology, material rendering and lighting. This overrides legacy generic look/openers. Animate forward from the supplied INITIAL state; do not recreate the still image or repeat completed actions. Physical contact, balance and gaze track the actual task. Do not turn an offscreen narrator into a visible person.\n${JSON.stringify({ style: view.workspace.style, shots: specs.map(s => ({ shotId: s.shotId, scene: view.workspace.scenes.find(x => x.id === s.sceneId), initialMoment: s.moment, initialState: s.state, initialBlocking: s.blocking, initialContacts: s.contacts })) })}`;
}

/** Protect the local compose path as well as paid image-to-video generation. */
export async function assertSelectedFramesApproved(projectId: string) {
  if (!hasFrameWorkspace(projectId)) return;
  await assertFrameApproved(projectId);
  const view = frameView(projectId), selected = getDb().select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.selected, true))).all();
  for (const shot of view.shots) {
    const approval = view.workspace.approvals.find(a => a.shotId === shot.shotId && a.sourceKey === view.shotKeys[shot.shotId]);
    if (!approval) continue;
    const approved = view.takes.find(t => t.id === approval.assetId), active = selected.find(a => a.shotId === shot.shotId);
    if (!active || (active.id !== approval.assetId && active.thumbnailPath !== approved?.url)) throw new FrameError(`镜头 ${shot.shotId} 当前素材不是已确认画面或其派生视频 / Selected shot ${shot.shotId} does not use its approved frame`, 409);
  }
}
