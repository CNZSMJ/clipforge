// @vitest-environment node
import { describe, expect, it } from "vitest";
import contracts from "./fixtures/fal-input-contracts.json";
import { buildFalImageRequest, FAL_IMAGE_SPECS } from "../providers/fal-image-params";
import { buildFalVideoRequest } from "../providers/fal-ai";
import { FAL_VIDEO_SPECS } from "../providers/fal-video-params";
import { modelSupportsLastFrame } from "../video-composer/transitions";

type Schema = { type?: string; const?: unknown; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; minimum?: number; maximum?: number; multipleOf?: number; minItems?: number; maxItems?: number };
// Assert the input-shape constraints used by these published schemas, without taking a
// runtime dependency on a validator or making a live paid call in CI.
function errors(schema: Schema, value: unknown, path = "$", strictKeys = false): string[] {
  const out: string[] = [];
  const choices = schema.anyOf || schema.oneOf;
  if (choices && !choices.some(s => errors(s, value, path).length === 0)) out.push(`${path}: no matching union variant`);
  if ("const" in schema && value !== schema.const) out.push(`${path}: wrong const`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: not in enum`);
  if (schema.type) {
    const valid = schema.type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : schema.type === "array" ? Array.isArray(value)
      : schema.type === "null" ? value === null
      : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === schema.type;
    if (!valid) return [...out, `${path}: expected ${schema.type}, got ${JSON.stringify(value)}`];
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) out.push(`${path}: below minimum`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${path}: above maximum`);
    if (schema.multipleOf != null && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8) out.push(`${path}: wrong multiple`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${path}: too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${path}: too many items`);
    if (schema.items) value.forEach((v, i) => out.push(...errors(schema.items!, v, `${path}[${i}]`)));
  } else if (value && typeof value === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required || []) if (!(name in record)) out.push(`${path}.${name}: required`);
    for (const [name, v] of Object.entries(record)) {
      if (schema.properties[name]) out.push(...errors(schema.properties[name], v, `${path}.${name}`));
      else if (strictKeys) out.push(`${path}.${name}: undeclared field`);
    }
  }
  return out;
}
const snapshots: Record<string, Schema> = contracts;
const image = "https://fal.media/files/anchor.png";
const video = "https://fal.media/files/reference.mp4";
const audio = "https://fal.media/files/voice.mp3";

describe("Fal public OpenAPI contract snapshots (2026-09-17)", () => {
  for (const [modelId, spec] of Object.entries(FAL_VIDEO_SPECS)) {
    for (const dimensions of [[720, 1280], [1920, 1080], [1024, 1024]]) {
      it(`${modelId} ${dimensions.join("x")} matches its actual endpoint`, () => {
        const requested = spec.fixedDuration ?? spec.durations?.[0] ?? spec.durationRange?.[0] ?? 5;
        const { modelId: resolved, body } = buildFalVideoRequest({
          modelId, mode: "image-to-video", prompt: "Keep the selected person, package and action.",
          width: dimensions[0], height: dimensions[1], duration: requested, seed: 42,
          firstFrameUrl: spec.firstFrame ? image : undefined,
          lastFrameUrl: spec.lastFrame ? image : undefined,
          referenceImageUrls: spec.referenceImages ? [image] : undefined,
          referenceVideoUrls: spec.referenceVideos ? [video] : undefined,
          referenceAudioUrls: spec.referenceAudio ? [audio] : undefined,
          audioEnabled: !!(spec.audio || spec.nativeAudio), voiceover: "Hello.",
        });
        expect(snapshots[resolved], `missing contract for ${resolved}`).toBeDefined();
        expect(errors(snapshots[resolved], body, resolved, true)).toEqual([]);
      });
    }
  }
  for (const [modelId, spec] of Object.entries(FAL_IMAGE_SPECS)) {
    if (!snapshots[modelId]) continue; // separately tested, additional verified sibling endpoints
    it(`${modelId} image options match declared fields and types`, () => {
      const { modelId: resolved, body } = buildFalImageRequest({ modelId, prompt: "Keep the approved product.", width: 1080, height: 1920, count: 1, seed: 4, steps: 30, guidanceScale: 3.5, referenceImageUrls: spec.referenceField ? [image] : undefined });
      expect(errors(snapshots[resolved], body, resolved, true)).toEqual([]);
    });
  }
});

describe("conditioning and billable argument invariants", () => {
  it("does not advertise hard end frames on text or unordered-reference endpoints", () => {
    expect(modelSupportsLastFrame("bytedance/seedance-2.5/text-to-video")).toBe(false);
    expect(modelSupportsLastFrame("bytedance/seedance-2.5/reference-to-video")).toBe(false);
    expect(modelSupportsLastFrame("bytedance/seedance-2.5/image-to-video")).toBe(true);
  });
  it("rejects unsupported hard last frame and oversized reference packs before submit", () => {
    expect(() => buildFalVideoRequest({ modelId: "fal-ai/minimax/hailuo-2.3/pro/image-to-video", mode: "image-to-video", prompt: "x", firstFrameUrl: image, lastFrameUrl: image })).toThrow(/尾帧/);
    expect(() => buildFalVideoRequest({ modelId: "bytedance/seedance-2.5/reference-to-video", mode: "video-to-video", prompt: "x", referenceImageUrls: Array(10).fill(image) })).toThrow(/上限/);
  });
  it("options.extra cannot replace staged references, prompt, duration or enable nonrecoverable sync mode", () => {
    const body = buildFalImageRequest({ modelId: "openai/gpt-image-2/edit", prompt: "approved", referenceImageUrls: [image], extra: { image_urls: ["/api/files/old.png"], prompt: "other", num_images: 10, sync_mode: true, max_images: 6 } }).body;
    expect(body).toMatchObject({ prompt: "approved", image_urls: [image], num_images: 1 });
    expect(body.sync_mode).toBeUndefined(); expect(body.max_images).toBeUndefined();
    const v = buildFalVideoRequest({ modelId: "bytedance/seedance-2.5/image-to-video", mode: "image-to-video", prompt: "approved", firstFrameUrl: image, duration: 8, extra: { image_url: "/api/files/old.png", duration: "30", prompt: "other" } }).body;
    expect(v).toMatchObject({ image_url: image, prompt: "approved", duration: "8" });
  });
  it("respects per-endpoint image counts and clips only configurable sampler steps", () => {
    expect(buildFalImageRequest({ modelId: "openai/gpt-image-2.5/flare/text-to-image", prompt: "x", count: 10 }).body.num_images).toBe(10);
    expect(() => buildFalImageRequest({ modelId: "fal-ai/recraft/v4/pro/text-to-image", prompt: "x", count: 2 })).toThrow(/1/);
    expect(buildFalImageRequest({ modelId: "fal-ai/flux/schnell", prompt: "x", steps: 30 }).body.num_inference_steps).toBe(12);
  });
  it("never rounds dialogue down or silently clamps an overlong shot", () => {
    expect(buildFalVideoRequest({ modelId: "fal-ai/veo3", mode: "text-to-video", prompt: "x", duration: 7 }).body.duration).toBe("8s");
    expect(() => buildFalVideoRequest({ modelId: "fal-ai/veo3", mode: "text-to-video", prompt: "x", duration: 9 })).toThrow(/最多/);
    expect(buildFalVideoRequest({ modelId: "fal-ai/wan/v2.2-a14b/image-to-video", mode: "image-to-video", prompt: "x", firstFrameUrl: image, duration: 5, fps: 16 }).body.num_frames).toBe(81);
  });
});
