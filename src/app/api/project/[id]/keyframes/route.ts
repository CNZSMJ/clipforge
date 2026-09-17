import { NextRequest, NextResponse } from "next/server";
import { FrameError, frameView, saveFrameWorkspace, frameConfig, planFrames, previewFrame, generateFrame, resumeFrame, approveFrame, reviewFrame, reconcileFrame } from "@/lib/keyframe-service";
import { pickLocale } from "@/lib/api-error";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  return response({ error: error instanceof FrameError ? error.message : "操作未完成；已受理的生图请恢复，不要重复提交。 / Operation failed; resume an acknowledged generation instead of resubmitting." }, error instanceof FrameError ? error.status : 500);
}
async function bodyOf(req: NextRequest): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > 300_000) throw new FrameError("请求过大 / Request too large", 413);
  const raw = await req.text();
  if (raw.length > 300_000) throw new FrameError("请求过大 / Request too large", 413);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new FrameError("无效JSON / Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FrameError("请求必须是对象 / Expected an object");
  return value as Record<string, unknown>;
}
function string(body: Record<string, unknown>, key: string, required = true, max = 2000): string {
  const v = body[key];
  if (v == null && !required) return "";
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) throw new FrameError(`无效参数 / Invalid field: ${key}`);
  return v.trim();
}
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { return response(await frameView((await params).id)); } catch (e) { return failure(e); }
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, b = await bodyOf(req);
    if (!Number.isSafeInteger(b.revision) || Number(b.revision) < 0) throw new FrameError("缺少有效版本 / Missing valid revision");
    const sourceKey = string(b, "sourceKey");
    if (b.action === "approve") return response(await approveFrame(id, string(b, "assetId"), sourceKey, Number(b.revision), b.pinScene === true, b.acceptRisk === true));
    if (b.action !== "save") throw new FrameError("未知操作 / Unknown action");
    return response(await saveFrameWorkspace(id, b.workspace, Number(b.revision), sourceKey));
  } catch (e) { return failure(e); }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, b = await bodyOf(req), action = string(b, "action");
    if (["plan", "generate", "check"].includes(action) && b.confirmPaid !== true) throw new FrameError("此操作可能收费，请显式确认 / Explicit charge confirmation required");
    if (action === "plan") return response(await planFrames(id, frameConfig(b.llmConfig), string(b, "sourceKey")));
    if (action === "check") return response(await reviewFrame(id, string(b, "renderId"), frameConfig(b.llmConfig), pickLocale(req)));
    if (action === "reconcile") return response(await reconcileFrame(id, string(b, "renderId"), { apiKey: string(b, "apiKey", false), requestId: string(b, "requestId", false) || undefined, notAccepted: b.notAccepted === true, confirmed: b.confirmReconciled === true }));
    if (action === "resume") return response(await resumeFrame(id, string(b, "renderId"), string(b, "apiKey")));
    if (!["preview", "generate"].includes(action)) throw new FrameError("未知操作 / Unknown action");
    if (!Number.isSafeInteger(b.shotId)) throw new FrameError("无效镜号 / Invalid shot ID");
    const input = { shotId: Number(b.shotId), provider: string(b, "provider"), model: string(b, "model"), baseUrl: string(b, "baseUrl", false),
      options: b.options, correction: string(b, "correction", false, 1200), editAssetId: string(b, "editAssetId", false) || undefined };
    if (action === "preview") return response(await previewFrame(id, input));
    return response(await generateFrame(id, { ...input, apiKey: string(b, "apiKey"), requestId: string(b, "requestId"), expectedPlanKey: string(b, "expectedPlanKey"), confirmPaid: true, allowSynthetic: b.allowSynthetic === true }));
  } catch (e) { return failure(e); }
}
