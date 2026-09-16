import { describe, expect, it } from "vitest";
import { buildFalImageRequest, getFalImageSpec, nearestFalImagePreset } from "@/lib/providers/fal-image-params";

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
  referenceImageUrl: "https://cdn.example/product.png",
};

function assertDeclaredOnly(modelId: string, body: Record<string, unknown>) {
  const declared = new Set(DECLARED[modelId]);
  for (const key of Object.keys(body)) {
    expect(declared.has(key), `${modelId} sent undeclared field "${key}"`).toBe(true);
  }
}

describe("fal image request building", () => {
  it("gpt-image-2.5/edit sends the required image_urls and nothing gpt-image does not declare", () => {
    const { body } = buildFalImageRequest({ ...common, modelId: "openai/gpt-image-2.5/sunburst/edit" });
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
    const { body } = buildFalImageRequest({ ...common, modelId: "acme/custom/edit" });
    expect(body.image_urls).toEqual(["https://cdn.example/product.png"]);
    expect(body.image_size).toEqual({ width: 1920, height: 1080 });
  });

  it("maps a requested aspect onto the preset family", () => {
    expect(nearestFalImagePreset(1920, 1080, ["square_hd", "landscape_16_9", "portrait_16_9"])).toBe("landscape_16_9");
    expect(nearestFalImagePreset(1080, 1920, ["square_hd", "landscape_16_9", "portrait_16_9"])).toBe("portrait_16_9");
    expect(nearestFalImagePreset(1024, 1024, ["square_hd", "landscape_16_9"])).toBe("square_hd");
  });
});
