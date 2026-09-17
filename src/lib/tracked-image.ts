import { recordAiTask, updateAiTask, type RecordAiTaskInput } from "./ai-tasks";
import { ProviderError } from "./providers/base";
import type { AIProvider, ImageOptions, ImageResult } from "./providers/types";

/** Retain paid image handles just like video handles; a poll/download retry is not a new edit. */
export async function generateTrackedImage(
  provider: AIProvider,
  options: ImageOptions,
  context: Omit<RecordAiTaskInput, "taskId" | "model" | "mediaType" | "provider"> = {},
): Promise<ImageResult> {
  if (!provider.submitImageTask || !provider.waitForTask) return provider.generateImage(options);
  const started = Date.now();
  const { taskId, modelId } = await provider.submitImageTask(options);
  const rowId = await recordAiTask({ ...context, provider: provider.name, taskId, model: modelId, mediaType: "image" });
  try {
    const status = await provider.waitForTask(taskId, { interval: 3000 });
    const imageUrls = status.result && "imageUrls" in status.result ? status.result.imageUrls : undefined;
    if (!imageUrls?.length) throw new Error("图片任务未返回图片地址；请恢复此任务，不要重新生成");
    await updateAiTask(rowId, { status: "download_pending", resultUrls: imageUrls, error: null });
    return { taskId, modelId, imageUrls, duration: Date.now() - started };
  } catch (cause) {
    const failed = cause instanceof ProviderError && cause.code === "TASK_FAILED";
    const error = cause instanceof ProviderError ? cause : new ProviderError(
      cause instanceof Error ? cause.message : String(cause), "TASK_RECOVERABLE", provider.name,
    );
    error.taskId = taskId;
    await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: error.message });
    throw error;
  }
}
