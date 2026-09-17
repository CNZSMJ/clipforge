import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { buildFalImageRequest, falImageSibling, getFalImageSpec, nearestFalImagePreset } from "@/lib/providers/fal-image-params";
import { FalAIProvider } from "@/lib/providers/fal-ai";

/**
 * Every property each endpoint's OpenAPI declares, read from
 * https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<model>.
 * The contract under test: we never send a field outside this set.
 */
const DECLARED: Record<string, string[]> = {
  "openai/gpt-image-2.5/sunburst/edit": ["sync_mode", "image_size", "quality", "prompt", "output_format", "background", "image_urls", "mask_url", "output_compression", "num_images"],
  "openai/gpt-image-2.5/sunburst/text-to-image": ["sync_mode", "image_size", "quality", "prompt", "output_format", "background", "output_compression", "num_images"],
  "openai/gpt-image-2/edit": ["sync_mode", "image_size", "quality", "prompt", "output_format", "background", "image_urls", "mask_url", "num_images"],
  "fal-ai/gpt-image-1.5": ["background", "sync_mode", "prompt", "image_size", "quality", "num_images", "output_format"],
  "fal-ai/flux/dev": ["acceleration", "prompt", "enable_safety_checker", "sync_mode", "num_images", "image_size", "num_inference_steps", "guidance_scale", "seed", "output_format"],
  "fal-ai/recraft/v4/pro/text-to-image": ["prompt", "image_size", "colors", "background_color", "enable_safety_checker"],
  "fal-ai/flux-2-pro": ["seed", "prompt", "sync_mode", "output_format", "image_size", "enable_safety_checker", "safety_tolerance"],
};

const common = {
  prompt: "product photo of a tea box on marble",
  width: 1920,
  height: 1080,
  count: 1,
  seed: 42,
  steps: 28,
  guidanceScale: 3.5,
  negativePrompt: "blurry",
};

/** only the /edit endpoints accept a reference, so it is opt-in per test */
const withRef = { referenceImageUrl: "https://cdn.example/product.png" };

function assertDeclaredOnly(modelId: string, body: Record<string, unknown>) {
  const declared = new Set(DECLARED[modelId]);
  for (const key of Object.keys(body)) {
    expect(declared.has(key), `${modelId} sent undeclared field "${key}"`).toBe(true);
  }
}

describe("fal image request building", () => {
  it("gpt-image-2.5/edit sends the required image_urls and nothing gpt-image does not declare", () => {
    const { body } = buildFalImageRequest({ ...common, ...withRef, modelId: "openai/gpt-image-2.5/sunburst/edit" });
    expect(body.image_urls).toEqual(["https://cdn.example/product.png"]);
    expect(body.image_size).toEqual({ width: 1920, height: 1088 }); // snapped to a multiple of 16
    expect(body.num_images).toBe(1);
    expect(body.seed).toBeUndefined();
    expect(body.negative_prompt).toBeUndefined();
    expect(body.num_inference_steps).toBeUndefined();
    expect(body.guidance_scale).toBeUndefined();
    assertDeclaredOnly("openai/gpt-image-2.5/sunburst/edit", body);
  });

  it("gpt-image-2.5 text-to-image never carries a reference field", () => {
    const { body } = buildFalImageRequest({ ...common, modelId: "openai/gpt-image-2.5/sunburst/text-to-image" });
    expect(body.image_urls).toBeUndefined();
    expect(body.image_url).toBeUndefined();
    assertDeclaredOnly("openai/gpt-image-2.5/sunburst/text-to-image", body);
  });

  it("gpt-image-1.5 gets one of its three literal size strings", () => {
    const landscape = buildFalImageRequest({ ...common, modelId: "fal-ai/gpt-image-1.5" }).body;
    expect(["1024x1024", "1536x1024", "1024x1536"]).toContain(landscape.image_size);
    expect(landscape.image_size).toBe("1536x1024");
    const portrait = buildFalImageRequest({ ...common, width: 1080, height: 1920, modelId: "fal-ai/gpt-image-1.5" }).body;
    expect(portrait.image_size).toBe("1024x1536");
    assertDeclaredOnly("fal-ai/gpt-image-1.5", landscape);
  });

  it("flux/dev gets seed + steps + guidance_scale, but not negative_prompt (it declares none)", () => {
    const { body } = buildFalImageRequest({ ...common, modelId: "fal-ai/flux/dev" });
    expect(body.seed).toBe(42);
    expect(body.num_inference_steps).toBe(28);
    expect(body.guidance_scale).toBe(3.5);
    expect(body.num_images).toBe(1);
    expect(body.negative_prompt).toBeUndefined();
    assertDeclaredOnly("fal-ai/flux/dev", body);
  });

  it("recraft only gets what it declares — no seed, no num_images", () => {
    const { body } = buildFalImageRequest({ ...common, modelId: "fal-ai/recraft/v4/pro/text-to-image" });
    expect(body.seed).toBeUndefined();
    expect(body.num_images).toBeUndefined();
    expect(body.image_size).toEqual({ width: 1920, height: 1080 });
    assertDeclaredOnly("fal-ai/recraft/v4/pro/text-to-image", body);
  });

  it("flux-2-pro clamps to its published constraints (multiple of 16, 256..2560, max area)", () => {
    const { body } = buildFalImageRequest({ ...common, width: 6000, height: 6000, modelId: "fal-ai/flux-2-pro" });
    const size = body.image_size as { width: number; height: number };
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width).toBeLessThanOrEqual(2560);
    expect(size.height).toBeLessThanOrEqual(2560);
    expect(size.width * size.height).toBeLessThanOrEqual(4194304);
    assertDeclaredOnly("fal-ai/flux-2-pro", body);
  });

  it("falls back to preset snapping and an /edit reference field for custom endpoints", () => {
    expect(getFalImageSpec("acme/custom/edit").referenceField).toBe("image_urls");
    const { body } = buildFalImageRequest({ ...common, ...withRef, modelId: "acme/custom/edit" });
    expect(body.image_urls).toEqual(["https://cdn.example/product.png"]);
    expect(body.image_size).toEqual({ width: 1920, height: 1080 });
  });

  it("routes to the EDIT sibling when a reference is supplied to a text-to-image endpoint", () => {
    const { modelId, body } = buildFalImageRequest({ ...common, ...withRef, modelId: "openai/gpt-image-2.5/sunburst/text-to-image" });
    expect(modelId).toBe("openai/gpt-image-2.5/sunburst/edit");
    expect(body.image_urls).toEqual(["https://cdn.example/product.png"]);
  });

  it("routes a reference-less shot to the TEXT-TO-IMAGE sibling instead of submitting an /edit call", () => {
    // This is the real storyboard case: a B-roll shot has no product photo, and an /edit endpoint
    // answers 422 "missing image_urls" while still reporting the request as COMPLETED.
    const { modelId, body } = buildFalImageRequest({ ...common, modelId: "openai/gpt-image-2.5/sunburst/edit" });
    expect(modelId).toBe("openai/gpt-image-2.5/sunburst/text-to-image");
    expect(body.image_urls).toBeUndefined();
    expect(body.prompt).toBe(common.prompt);
  });

  it("routes the pairs whose ids do not follow the /text-to-image convention", () => {
    expect(buildFalImageRequest({ ...common, modelId: "openai/gpt-image-2/edit" }).modelId).toBe("openai/gpt-image-2");
    expect(buildFalImageRequest({ ...common, ...withRef, modelId: "openai/gpt-image-2" }).modelId).toBe("openai/gpt-image-2/edit");
    expect(buildFalImageRequest({ ...common, modelId: "fal-ai/bytedance/seedream/v5/lite/edit" }).modelId).toBe(
      "fal-ai/bytedance/seedream/v5/lite/text-to-image"
    );
  });

  it("fails before submitting when an /edit endpoint has no sibling and no reference", () => {
    expect(() =>
      buildFalImageRequest({ ...common, modelId: "acme/custom/edit" })
    ).toThrow(/必须提供参考图/);
    // with a reference the custom /edit endpoint is fine
    expect(buildFalImageRequest({ ...common, ...withRef, modelId: "acme/custom/edit" }).body.image_urls).toEqual([
      "https://cdn.example/product.png",
    ]);
  });

  it("the custom-endpoint inference marks /edit routes as requiring a reference", () => {
    expect(getFalImageSpec("acme/custom/edit").requiresReference).toBe(true);
  });
  it("maps a requested aspect onto the preset family", () => {
    expect(nearestFalImagePreset(1920, 1080, ["square_hd", "landscape_16_9", "portrait_16_9"])).toBe("landscape_16_9");
    expect(nearestFalImagePreset(1080, 1920, ["square_hd", "landscape_16_9", "portrait_16_9"])).toBe("portrait_16_9");
    expect(nearestFalImagePreset(1024, 1024, ["square_hd", "landscape_16_9"])).toBe("square_hd");
  });
});

describe("platform-rejected submissions", () => {
  it("surfaces fal's stored 422 instead of a vague result error", async () => {
    const provider = new FalAIProvider({ name: "fal-ai", apiKey: "k", baseUrl: "https://example.com" });
    vi.spyOn(provider as unknown as { request: (path: string) => Promise<unknown> }, "request").mockImplementation(
      async (path: string) =>
        path.endsWith("/status")
          ? { status: "COMPLETED", request_id: "r1" }
          : { detail: [{ type: "missing", loc: ["body", "image_urls"], msg: "Field required" }] }
    );
    await expect(
      provider.getTaskStatus("openai/gpt-image-2.5/sunburst/edit::r1")
    ).rejects.toThrow(/平台拒绝了这次请求/);
  });

  it("falImageSibling only rewrites known pairs", () => {
    expect(falImageSibling("openai/gpt-image-2.5/flare/edit", false)).toBe("openai/gpt-image-2.5/flare/text-to-image");
    expect(falImageSibling("openai/gpt-image-2.5/flare/edit", true)).toBeUndefined();
    expect(falImageSibling("fal-ai/veo3", true)).toBeUndefined();
  });
});

describe("generateImage submits to the RESOLVED endpoint", () => {
  // Regression: the builder reroutes edit <-> text-to-image, and the body it produced only matches
  // that sibling. Submitting the original id with the sibling's body produced fal's
  // "422 missing image_urls" (task id showed /edit, body carried no image_urls).
  it("posts to the text-to-image sibling and keeps its task id when there is no reference", async () => {
    const provider = new FalAIProvider({ name: "fal-ai", apiKey: "k", baseUrl: "https://example.com" });
    const paths: string[] = [];
    vi.spyOn(provider as unknown as { request: (p: string, i?: { method?: string }) => Promise<unknown> }, "request")
      .mockImplementation(async (path: string, init?: { method?: string }) => {
        paths.push(path);
        if (init?.method === "POST") return { request_id: "r1" };
        if (path.endsWith("/status")) return { status: "COMPLETED", request_id: "r1" };
        return { images: [{ url: "https://cdn.example/out.png" }] };
      });
    const result = await provider.generateImage({
      modelId: "openai/gpt-image-2.5/sunburst/edit",
      mode: "text-to-image",
      prompt: "a dusty tea set",
      width: 1024,
      height: 1024,
    });
    expect(paths[0]).toBe("/openai/gpt-image-2.5/sunburst/text-to-image");
    expect(paths.some((p) => p.startsWith("/openai/gpt-image-2.5/sunburst/text-to-image::"))).toBe(false);
    expect("imageUrls" in result && result.imageUrls[0]).toBe("https://cdn.example/out.png");
  });

  it("posts to the edit sibling when a reference is supplied", async () => {
    const provider = new FalAIProvider({ name: "fal-ai", apiKey: "k", baseUrl: "https://example.com" });
    let submitted: { path: string; body?: Record<string, unknown> } | undefined;
    vi.spyOn(provider as unknown as { request: (p: string, i?: { method?: string; body?: Record<string, unknown> }) => Promise<unknown> }, "request")
      .mockImplementation(async (path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
        if (init?.method === "POST") {
          submitted = { path, body: init.body };
          return { request_id: "r2" };
        }
        if (path.endsWith("/status")) return { status: "COMPLETED", request_id: "r2" };
        return { images: [{ url: "https://cdn.example/out2.png" }] };
      });
    await provider.generateImage({
      modelId: "openai/gpt-image-2.5/sunburst/text-to-image",
      mode: "image-to-image",
      prompt: "keep the product",
      width: 1024,
      height: 1024,
      referenceImageUrl: "https://cdn.example/product.png",
    });
    expect(submitted?.path).toBe("/openai/gpt-image-2.5/sunburst/edit");
    expect(submitted?.body?.image_urls).toEqual(["https://cdn.example/product.png"]);
  });
});
