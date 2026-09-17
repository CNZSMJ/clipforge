import { assertFrameApproved, approvedFrameMotionDirection, frameView, hasFrameWorkspace, FrameError } from "@/lib/keyframe-store";
import type { VideoOptions } from "@/lib/providers/types";
import { generationOptions, stageReferences } from "@/lib/generation-input";
import { buildFalVideoRequest } from "@/lib/providers/fal-ai";
import { effectiveFalDuration, getFalVideoSpec } from "@/lib/providers/fal-video-params";
import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { toProviderImage } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";

// AI video generation.
//
// Two-phase flow (issue #16): submit the paid task, persist the provider task ID to
// ai_tasks IMMEDIATELY, then poll. A poll timeout/crash no longer loses the task —
// the error response carries the task ID and the row stays recoverable ("unknown"),
// so the client can resume via /api/ai/video/task instead of paying again.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object");
  }
  const { provider: providerName, model, prompt, imageUrl, lastImageUrl, mode, apiKey, baseUrl, options, projectId, shotId, referenceVideoUrls, referenceImageUrls, referenceAudioUrls } = body;
  const controlPlan = sanitizeGenerationControlSummary(body.controlPlan);
  if ((prompt != null && typeof prompt !== "string") || (baseUrl != null && typeof baseUrl !== "string")
    || (projectId != null && (typeof projectId !== "string" || !/^[a-zA-Z0-9-]+$/.test(projectId)))
    || (shotId != null && (!Number.isSafeInteger(shotId) || shotId < 0))) {
    return apiError(req, "无效的提示词或任务上下文", "Invalid prompt or task context");
  }

  if ([providerName, model].some(v => typeof v !== "string" || !v.trim())) {
    return apiError(req, "缺少必要参数", "Missing required parameters");
  }

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  try {
    await assertFrameApproved(projectId, shotId, imageUrl, undefined, mode === "video-to-video" && Array.isArray(referenceImageUrls) ? referenceImageUrls : undefined);
    const reviewedSource = hasFrameWorkspace(projectId) ? frameView(projectId).sourceKey : undefined;
    const approvedDirection = approvedFrameMotionDirection(projectId, shotId);
    const actualPrompt = [prompt || "", approvedDirection].filter(Boolean).join("\n\n");
    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    const opts = generationOptions(options);
    const [firstFrameUrl, lastFrameUrl, refImages, refVideos, refAudios] = await Promise.all([
      toProviderImage(imageUrl, provider), toProviderImage(lastImageUrl, provider),
      stageReferences(referenceImageUrls, 9, "referenceImageUrls", provider),
      stageReferences(referenceVideoUrls, 3, "referenceVideoUrls", provider),
      stageReferences(referenceAudioUrls, 3, "referenceAudioUrls", provider),
    ]);
    const videoOptions: VideoOptions = {
      ...opts,
      modelId: model,
      mode: mode || (imageUrl ? "image-to-video" : "text-to-video"),
      prompt: actualPrompt,
      firstFrameUrl, lastFrameUrl,
      referenceImageUrls: refImages,
      referenceVideoUrls: refVideos,
      referenceAudioUrls: refAudios,
      // The legacy single reference also has to pass staging, not escape through options.
      referenceVideoUrl: opts.referenceVideoUrl == null ? undefined : await toProviderImage(String(opts.referenceVideoUrl), provider),
    };
    await assertFrameApproved(projectId, shotId, imageUrl, undefined, mode === "video-to-video" && Array.isArray(referenceImageUrls) ? referenceImageUrls : undefined);
    if (reviewedSource && reviewedSource !== frameView(projectId).sourceKey) throw new FrameError("画面设定在上传中已改变，请重新确认 / Frame direction changed during upload; review again", 409);
    const resolved = providerName === "fal-ai" ? buildFalVideoRequest(videoOptions) : undefined;
    const resolvedSpec = resolved ? getFalVideoSpec(resolved.modelId) : undefined;
    const actualDuration = resolvedSpec ? effectiveFalDuration(resolvedSpec, videoOptions.duration, videoOptions.fps) : videoOptions.duration;

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      return NextResponse.json({ ...result, prompt: actualPrompt });
    }

    // Phase 1: submit. Mode/model capability is validated inside the provider BEFORE any
    // billable call; base.request() never auto-retries this POST on timeout (money safety).
    const startTime = Date.now();
    const { taskId, modelId } = await provider.submitVideoTask(videoOptions);

    // Persist the paid task before polling starts — this row is the recovery handle.
    const rowId = await recordAiTask({
      projectId,
      shotId,
      provider: providerName,
      model: modelId,
      mediaType: "video",
      mode: videoOptions.mode,
      prompt: videoOptions.prompt,
      taskId,
      ...(controlPlan && { controlPlan }),
    });

    // Phase 2: wait. Transient status-query failures are tolerated inside waitForTask;
    // if it still fails, the task is marked "unknown"/"failed" but never dropped.
    try {
      const finalStatus = await provider.waitForTask(taskId, { interval: 5000 });
      const result = finalStatus.result;
      const videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
      if (!videoUrls || videoUrls.length === 0) {
        await updateAiTask(rowId, { status: "unknown", error: "任务完成但未返回视频地址" });
        return NextResponse.json(
          { error: errText(req, "任务完成但未返回视频地址", "Task completed but returned no video URL"), taskId, modelId, recoverable: true },
          { status: 502 }
        );
      }
      await updateAiTask(rowId, { status: "download_pending", resultUrls: videoUrls, error: null });
      return NextResponse.json({
        taskId,
        prompt: actualPrompt,
        videoUrls,
        modelId,
        duration: actualDuration,
        processingTime: Date.now() - startTime,
        hasAudio: Boolean(resolvedSpec?.nativeAudio || videoOptions.audioEnabled),
      });
    } catch (error) {
      // definitive provider-side failure vs. lost contact (task may still be running & billed)
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: message });
      return NextResponse.json(
        {
          error: failed
            ? message
            : errText(
                req,
                `${message}。任务 ID ${taskId} 已保存，可在素材页恢复查询，请勿重复提交`,
                `${message}. Task ID ${taskId} has been saved and can be recovered from the assets page — do not resubmit`
              ),
          taskId,
        prompt: actualPrompt,
          modelId,
          recoverable: !failed,
        },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    if (error instanceof FrameError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("生视频失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "生视频失败", "Video generation failed") },
      { status: 500 }
    );
  }
}
