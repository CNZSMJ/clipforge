import { access } from "node:fs/promises";
import { join, basename } from "node:path";
import { getDataDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { getDb } from "@/lib/db";
import { compositions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { persistStoryboardGrid } from "@/lib/storyboard-grid-persistence";
import { persistAssetSource } from "@/lib/asset-persistence";
import { persistGeneratedFilm } from "@/lib/storyboard-film-persistence";
import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { apiError, errText } from "@/lib/api-error";
import { findAiTask, updateAiTaskByProviderTaskId, type AiTaskStatus } from "@/lib/ai-tasks";
import type { TaskStatusEnum } from "@/lib/providers/types";

// Query / resume a previously submitted video task by its provider task ID (issue #16).
// POST because the request carries the API key — keys must never appear in URLs.
// body: { provider, apiKey, baseUrl?, taskId, wait? }
//   wait=false (default): single status check
//   wait=true: block until the task reaches a terminal state (resume flow)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object", 400);
  }
  const { provider: providerName, apiKey, baseUrl, taskId, wait } = body;

  if (!providerName || !taskId) {
    return apiError(req, "缺少必要参数（provider / taskId）", "Missing required parameters (provider / taskId)");
  }
  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  // map the provider's task status to the persisted ai_tasks status
  const toRowStatus = (s: TaskStatusEnum): AiTaskStatus =>
    s === "completed" ? "download_pending" : s === "failed" || s === "cancelled" ? "failed" : "processing";

  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    try {
      const row = await findAiTask(providerName, taskId);
      if (row?.mode?.startsWith("keyframe:") && row.projectId) {
        const { resumeFrame } = await import("@/lib/keyframe-service");
        const saved = await resumeFrame(row.projectId, row.mode.slice("keyframe:".length), apiKey);
        return NextResponse.json({ taskId, status: "completed", persisted: true, imageUrls: [saved.asset?.filePath], keyframeReviewRequired: true }, { headers: { "Cache-Control": "no-store" } });
      }
      if (row?.status === "completed" && row.resultUrls?.length) {
        const urls = row.resultUrls;
        const localPaths = urls.map(url => {
          if (url.startsWith("/api/files/")) return resolveUploadFilePath(url);
          if (row.projectId && /^[a-zA-Z0-9-]+$/.test(row.projectId) && url.startsWith(`/api/output/${row.projectId}/`) && !url.slice(`/api/output/${row.projectId}/`.length).includes("/")) {
            return join(getDataDir(), "output", row.projectId, basename(url));
          }
          return null;
        });
        const available = localPaths.every(Boolean) && (await Promise.all(localPaths.map(path => access(path!).then(() => true, () => false)))).every(Boolean);
        if (available) {
          const composition = row.mode === "storyboard-film" && row.projectId
            ? getDb().select().from(compositions).where(and(eq(compositions.projectId, row.projectId), eq(compositions.outputPath, localPaths[0]!))).get() : undefined;
          return NextResponse.json({ taskId, status: "completed", persisted: true,
            ...(row.mediaType === "image" ? { imageUrls: urls } : { videoUrls: urls }),
            ...(composition && { compositionId: composition.id }),
            ...(row.mode?.startsWith("storyboard-grid:") && { grid: { gridPath: urls[0], cells: [] } }),
            ...(row.mode === "character-sheet" && { sheetUrl: urls[0] }),
          });
        }
      }
      const status = wait && provider.waitForTask
        ? await provider.waitForTask(taskId, { interval: 5000 })
        : await provider.getTaskStatus(taskId);

      const result = status.result;
      let videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
      let imageUrls = result && "imageUrls" in result ? result.imageUrls : undefined;
      if (status.status === "completed" && !videoUrls?.length && !imageUrls?.length) {
        throw new Error("任务完成但没有媒体结果；已保留恢复入口，不会重新付费提交");
      }
      let compositionId: string | undefined;
      let grid: Awaited<ReturnType<typeof persistStoryboardGrid>> | undefined;
      let sheetUrl: string | undefined;
      if (status.status === "completed" && imageUrls?.[0] && row?.mode?.startsWith("storyboard-grid:") && row.projectId) {
        grid = await persistStoryboardGrid(row.projectId, row.mode, imageUrls[0], providerName, row.model, taskId);
        imageUrls = [grid.gridPath, ...grid.cells.map(c => c.filePath)];
      }
      if (status.status === "completed" && imageUrls?.[0] && row?.mode?.startsWith("character-sheet")) {
        sheetUrl = await persistAssetSource("characters", imageUrls[0], -1, "sheet");
        if (!/\.(png|jpe?g|webp|gif)$/i.test(sheetUrl)) throw new Error("定妆结果不是图片");
        imageUrls = [sheetUrl];
      }
      if (status.status === "completed" && videoUrls?.[0] && row?.mode === "storyboard-film" && row.projectId) {
        const saved = await persistGeneratedFilm(row.projectId, videoUrls[0], row.model, taskId);
        videoUrls = [saved.url];
        compositionId = saved.compositionId;
      }

      await updateAiTaskByProviderTaskId(providerName, taskId, {
        status: compositionId || grid || sheetUrl ? "completed" : toRowStatus(status.status),
        ...((videoUrls || imageUrls) && { resultUrls: videoUrls || imageUrls }),
        error: status.error ?? null,
      });

      return NextResponse.json({
        taskId,
        status: status.status,
        videoUrls, imageUrls, compositionId, ...(grid && { grid }), ...(sheetUrl && { sheetUrl }),
        error: status.error,
      });
    } catch (error) {
      // definitive failure vs. lost contact — a paid task must never be downgraded to
      // "failed" just because we couldn't reach the status endpoint
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTaskByProviderTaskId(providerName, taskId, {
        status: failed ? "failed" : "unknown",
        error: message,
      });
      return NextResponse.json(
        { error: message, taskId, recoverable: !failed },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "查询任务失败", "Task query failed") },
      { status: 500 }
    );
  }
}
