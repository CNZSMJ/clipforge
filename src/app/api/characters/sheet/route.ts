import { generateTrackedImage } from "@/lib/tracked-image";
import { persistAssetSource } from "@/lib/asset-persistence";
import { findAiTask, updateAiTaskByProviderTaskId } from "@/lib/ai-tasks";
import { ProviderError } from "@/lib/providers/base";
import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { buildCharacterSheetPrompt } from "@/lib/character-sheet";
import { apiError, errText } from "@/lib/api-error";

/**
 * POST /api/characters/sheet — generate a presenter's 2x2 multi-view reference
 * sheet (front / side / back / close-up in ONE generation, so it's physically
 * the same person). The client stores the returned path on the character; the
 * storyboard grid and film passes then attach it as a reference image to keep
 * the presenter's identity locked across shots and videos.
 *
 * body: { appearance, name?, provider, model, apiKey, baseUrl?, options? }
 */
export async function POST(req: NextRequest) {
  let recoveryTaskId: string | undefined;
  try {
    const body = await req.json();
    const { appearance, name, provider: providerName, model, apiKey, baseUrl, options, taskId } = body as {
      appearance?: string;
      name?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      taskId?: string;
    };
    if (!appearance?.trim()) {
      return apiError(req, "缺少外观描述——先给主播写一段外观", "Missing appearance — describe the presenter first", 400);
    }
    if (!providerName || !model) {
      return apiError(req, "缺少 provider / model", "Missing provider / model", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置生图平台", "Missing API key — configure an image provider in settings first", 400);
    }

    const prompt = buildCharacterSheetPrompt(appearance.trim(), name);
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const previous = taskId ? await findAiTask(providerName, taskId) : undefined;
    if (taskId && (previous?.mode !== "character-sheet" || previous.prompt !== prompt)) throw new Error("定妆图任务不存在或不匹配当前外观描述");
    recoveryTaskId = taskId;
    let result: { taskId: string; imageUrls: string[] };
    if (taskId) {
      if (previous?.status === "completed" && previous.resultUrls?.[0]?.startsWith("/api/files/")) {
        const url = await persistAssetSource("characters", previous.resultUrls[0], -1, "sheet");
        return NextResponse.json({ url, prompt, taskId });
      }
      const recovered = provider.waitForTask
        ? await provider.waitForTask(taskId, { interval: 3000 })
        : await provider.getTaskStatus(taskId);
      if (recovered.status === "failed" || recovered.status === "cancelled") throw new ProviderError(recovered.error || "定妆任务失败", "TASK_FAILED", providerName);
      if (recovered.status !== "completed" || !recovered.result || !("imageUrls" in recovered.result) || !recovered.result.imageUrls.length) throw new Error("原定妆任务尚无可下载图片；已保留任务 ID，不会重新付费提交");
      result = { taskId, imageUrls: recovered.result.imageUrls };
    } else result = await generateTrackedImage(provider, {
      ...(options ?? {}),
      modelId: model,
      mode: "text-to-image",
      prompt, referenceImageUrl: undefined, referenceImageUrls: undefined,
    }, { mode: "character-sheet", prompt });
    recoveryTaskId = result.taskId;
    const sourceUrl = result.imageUrls?.[0];
    if (!sourceUrl) throw new Error("生图未返回图片");

    const url = await persistAssetSource("characters", sourceUrl, -1, "sheet");
    if (!/\.(png|jpe?g|webp|gif)$/i.test(url)) throw new Error("定妆结果不是图片");
    await updateAiTaskByProviderTaskId(providerName, result.taskId, { status: "completed", resultUrls: [url], error: null });
    return NextResponse.json({ url, prompt, taskId: result.taskId });
  } catch (error) {
    recoveryTaskId ??= error instanceof ProviderError ? error.taskId : undefined;
    console.error("多视图定妆生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "多视图定妆生成失败", "Character sheet generation failed"), ...(recoveryTaskId && { taskId: recoveryTaskId, recoverable: !(error instanceof ProviderError && error.code === "TASK_FAILED") }) },
      { status: 500 }
    );
  }
}
