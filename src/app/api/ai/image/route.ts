import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { toProviderImage } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";

// AI image generation
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { provider: providerName, model, prompt, imageUrl, imageUrls, mode, apiKey, baseUrl, options } = body;

  if (!providerName || !model || !prompt) {
    return apiError(req, "缺少必要参数", "Missing required parameters");
  }

  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    // For image-to-image mode, convert local reference images to data URIs.
    // imageUrls (plural) feeds multi-reference edits (e.g. character sheet + product photo);
    // the array order is preserved so prompts can cite references by position.
    // Stage local files on the provider's CDN (fal) rather than inlining base64 — fal's docs call
    // data URIs the fallback that "inflates the request size significantly".
    const referenceImageUrl = await toProviderImage(imageUrl, provider);
    const referenceImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
      ? (await Promise.all((imageUrls as string[]).map((u) => toProviderImage(u, provider)))).filter((u): u is string => !!u)
      : undefined;

    const result = await provider.generateImage({
      modelId: model,
      mode: mode || "text-to-image",
      prompt,
      referenceImageUrl,
      ...(referenceImageUrls?.length && { referenceImageUrls }),
      ...options,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("生图失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "生图失败", "Image generation failed") },
      { status: 500 }
    );
  }
}
