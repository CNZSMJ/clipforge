import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { toProviderImage } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { generationOptions, stageReferences } from "@/lib/generation-input";
import { generateTrackedImage } from "@/lib/tracked-image";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object");
  }
  const { provider: providerName, model, prompt, imageUrl, imageUrls, mode, apiKey, baseUrl, options, projectId, shotId } = body;
  if ((baseUrl != null && typeof baseUrl !== "string")
    || (projectId != null && (typeof projectId !== "string" || !/^[a-zA-Z0-9-]+$/.test(projectId)))
    || (shotId != null && (!Number.isSafeInteger(shotId) || shotId < 0))) {
    return apiError(req, "无效的任务上下文", "Invalid task context");
  }
  if ([providerName, model, prompt, apiKey].some(v => typeof v !== "string" || !v.trim())) {
    return apiError(req, "缺少有效的平台、模型、提示词或 API Key", "Valid provider, model, prompt and API key are required");
  }
  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });
    const opts = generationOptions(options);
    const [referenceImageUrl, referenceImageUrls] = await Promise.all([
      toProviderImage(imageUrl, provider), stageReferences(imageUrls, 16, "imageUrls", provider),
    ]);
    // Staged URLs and approved identity fields are authoritative, including undefined:
    // options cannot smuggle a local file, override the model, or drop a reference pack.
    const result = await generateTrackedImage(provider, {
      ...opts, modelId: model, mode: mode || "text-to-image", prompt,
      referenceImageUrl, referenceImageUrls,
    }, { projectId, shotId, mode: mode || "text-to-image", prompt });
    return NextResponse.json(result);
  } catch (error) {
    const taskId = error instanceof ProviderError ? error.taskId : undefined;
    return NextResponse.json({
      error: error instanceof Error ? error.message : errText(req, "生图失败", "Image generation failed"),
      ...(taskId && { taskId, recoverable: !(error instanceof ProviderError && error.code === "TASK_FAILED") }),
    }, { status: taskId ? 504 : 400 });
  }
}
