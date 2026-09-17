import { generateTrackedImage } from "@/lib/tracked-image";
import { storyboardGridMode, persistStoryboardGrid } from "@/lib/storyboard-grid-persistence";
import { updateAiTaskByProviderTaskId } from "@/lib/ai-tasks";
import { ProviderError } from "@/lib/providers/base";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { scripts } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createProvider } from "@/lib/providers";
import { toProviderImage } from "@/lib/remote-image";
import { buildStoryboardGridPrompt, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import { apiError, errText } from "@/lib/api-error";

/**
 * POST /api/project/[id]/storyboard-grid — one-image consistency anchoring.
 *
 * Renders ALL shots of a script as a single 3x3 storyboard grid (same person /
 * outfit / room / light jointly conditioned in one generation (still requires visual QC)), then
 * crops each cell into that shot's keyframe asset. The existing per-shot i2v
 * pass ("animate") picks the keyframes up from there. Scripts with more than 9
 * shots are rejected honestly instead of silently truncated.
 *
 * body: { scriptId, provider, model, apiKey, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let recoveryTaskId: string | undefined;
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project id", 400);
    }
    const body = await req.json();
    const { scriptId, provider: providerName, model, apiKey, baseUrl, options, characterSheetUrl, productImageUrl } = body as {
      scriptId?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      /** Presenter's multi-view sheet — locks the person's identity across all nine cells */
      characterSheetUrl?: string;
      /** Product photo — locks the product's appearance across all nine cells */
      productImageUrl?: string;
    };
    if (!scriptId || !providerName || !model) {
      return apiError(req, "缺少 scriptId / provider / model", "Missing scriptId / provider / model", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置生图平台", "Missing API key — configure an image provider in settings first", 400);
    }

    const db = getDb();
    const [script] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const shots = Array.isArray(script.shots) ? script.shots : [];
    if (shots.length < 2) {
      return apiError(req, "分镜太少，九宫格至少需要 2 个分镜", "Too few shots — the grid needs at least 2", 400);
    }
    if (shots.length > GRID_MAX_SHOTS) {
      return apiError(
        req,
        `九宫格最多放 ${GRID_MAX_SHOTS} 个分镜（当前 ${shots.length} 个）——适合短脚本；长脚本请用逐镜生成+链式首尾帧`,
        `The grid holds at most ${GRID_MAX_SHOTS} shots (this script has ${shots.length}) — use per-shot generation with keyframe chaining for longer scripts`,
        400
      );
    }

    // reference images (order matters — the prompt cites them by position):
    // [character sheet?, product photo?]; local files are staged on the provider's CDN first
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const refInputs = [characterSheetUrl, productImageUrl].filter((u): u is string => !!u);
    const referenceImageUrls = (await Promise.all(refInputs.map((u) => toProviderImage(u, provider)))).filter(
      (u): u is string => !!u
    );

    // 1) one generation renders every shot — consistency is physical, not prompted;
    // with references attached the sheet pins the person and the photo pins the product
    const prompt = buildStoryboardGridPrompt(shots, script.characters, {
      characterSheet: !!characterSheetUrl,
      productImage: !!productImageUrl,
    });
    const taskMode = storyboardGridMode(scriptId, shots);
    const result = await generateTrackedImage(provider, {
      ...(options ?? {}),
      modelId: model,
      mode: referenceImageUrls.length > 0 ? "image-to-image" : "text-to-image",
      referenceImageUrl: undefined, referenceImageUrls,
      prompt,
    }, { projectId: id, mode: taskMode, prompt });
    recoveryTaskId = result.taskId;
    const gridUrl = result.imageUrls?.[0];
    if (!gridUrl) throw new Error("生图未返回图片");

    const saved = await persistStoryboardGrid(id, taskMode, gridUrl, providerName, result.modelId, result.taskId);
    await updateAiTaskByProviderTaskId(providerName, result.taskId, { status: "completed", resultUrls: [saved.gridPath, ...saved.cells.map(c => c.filePath)], error: null });
    return NextResponse.json({ ...saved, taskId: result.taskId });
  } catch (error) {
    recoveryTaskId ??= error instanceof ProviderError ? error.taskId : undefined;
    console.error("九宫格分镜生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "九宫格分镜生成失败", "Storyboard grid failed"), ...(recoveryTaskId && { taskId: recoveryTaskId, recoverable: true }) },
      { status: 500 }
    );
  }
}
