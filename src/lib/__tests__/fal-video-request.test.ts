import { describe, expect, it } from "vitest";
import { buildFalVideoRequest } from "@/lib/providers/fal-ai";
import { falFrameSibling, getFalVideoSpec } from "@/lib/providers/fal-video-params";
import { modelSupportsLastFrame } from "@/lib/video-composer/transitions";

const base = { mode: "image-to-video" as const, prompt: "product on a marble counter" };

describe("fal video request building", () => {
  it("Seedance 2.5 i2v: first frame -> image_url, last frame -> end_image_url", () => {
    const { modelId, body } = buildFalVideoRequest({
      ...base,
      modelId: "bytedance/seedance-2.5/image-to-video",
      firstFrameUrl: "https://cdn/first.png",
      lastFrameUrl: "https://cdn/last.png",
      width: 720,
      height: 1280,
      duration: 12,
    });
    expect(modelId).toBe("bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://cdn/first.png");
    expect(body.end_image_url).toBe("https://cdn/last.png");
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBe("auto");
    expect(body.duration).toBe("12");
  });

  it("Kling v3 pro i2v drives from start_image_url, not image_url", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/kling-video/v3/pro/image-to-video",
      firstFrameUrl: "https://cdn/first.png",
      lastFrameUrl: "https://cdn/last.png",
    });
    expect(body.start_image_url).toBe("https://cdn/first.png");
    expect(body.end_image_url).toBe("https://cdn/last.png");
    expect(body.image_url).toBeUndefined();
  });

  it("Seedance 2.5 reference-to-video carries the product reference pack", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "bytedance/seedance-2.5/reference-to-video",
      referenceImageUrls: ["https://cdn/product.png", "https://cdn/model.png"],
      referenceAudioUrls: ["https://cdn/voice.mp3"],
    });
    expect(body.image_urls).toEqual(["https://cdn/product.png", "https://cdn/model.png"]);
    expect(body.audio_urls).toEqual(["https://cdn/voice.mp3"]);
    expect(body.task).toBe("reference");
  });

  it("Vidu reference-to-video uses reference_image_urls", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/vidu/reference-to-video",
      referenceImageUrls: ["https://cdn/product.png"],
    });
    expect(body.reference_image_urls).toEqual(["https://cdn/product.png"]);
    expect(body.image_urls).toBeUndefined();
  });

  it("remaps to the sibling endpoint when a text-to-video id is given a first frame", () => {
    const { modelId, body } = buildFalVideoRequest({
      mode: "text-to-video",
      prompt: "a spinning bottle",
      modelId: "bytedance/seedance-2.5/text-to-video",
      firstFrameUrl: "https://cdn/first.png",
    });
    expect(modelId).toBe("bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://cdn/first.png");
  });

  it("Veo 3 snaps duration to a legal value and writes it as a string", () => {
    const { body } = buildFalVideoRequest({
      mode: "text-to-video",
      prompt: "drone shot over a city",
      modelId: "fal-ai/veo3",
      duration: 7,
      width: 1920,
      height: 1080,
    });
    // Preserve dialogue: choose a legal duration no shorter than the script.
    expect(body.duration).toBe("8s");
    expect(body.resolution).toBe("1080p");
    expect(body.aspect_ratio).toBe("16:9");
  });

  it("never sends a field the endpoint does not declare", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/minimax/hailuo-2.3/pro/image-to-video",
      firstFrameUrl: "https://cdn/first.png",
      width: 720,
      height: 1280,
    });
    expect(body.image_url).toBe("https://cdn/first.png");
    expect(body.end_image_url).toBeUndefined();
    expect(body.resolution).toBeUndefined();
    expect(body.aspect_ratio).toBeUndefined();
  });

  it("falls back to naming conventions for custom endpoints", () => {
    expect(getFalVideoSpec("acme/custom/image-to-video").firstFrame).toBe("image_url");
    expect(getFalVideoSpec("acme/custom/start-end-to-video").lastFrame).toBe("end_image_url");
    expect(falFrameSibling("acme/custom/text-to-video", true)).toBeUndefined();
  });
});

describe("MiniMax Hailuo 3.0 (fal id hailuo-03)", () => {
  it("image-to-video carries first AND last frame, 2K, duration clamped into 5-15s", () => {
    const short = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/minimax/hailuo-03/image-to-video",
      firstFrameUrl: "https://cdn/first.png",
      lastFrameUrl: "https://cdn/last.png",
      duration: 3,
    });
    expect(short.body.image_url).toBe("https://cdn/first.png");
    expect(short.body.end_image_url).toBe("https://cdn/last.png");
    expect(short.body.resolution).toBe("2K");
    expect(short.body.duration).toBe(5);
    // the i2v endpoint declares no aspect_ratio
    expect(short.body.aspect_ratio).toBeUndefined();

    expect(() => buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/minimax/hailuo-03/image-to-video",
      firstFrameUrl: "https://cdn/first.png",
      duration: 40,
    })).toThrow(/最多支持/);
  });

  it("reference-to-video uses the reference_*_urls field names", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/minimax/hailuo-03/reference-to-video",
      referenceImageUrls: ["https://cdn/product.png"],
      referenceVideoUrls: ["https://cdn/clip.mp4"],
      referenceAudioUrls: ["https://cdn/voice.mp3"],
      width: 1080,
      height: 1920,
    });
    expect(body.reference_image_urls).toEqual(["https://cdn/product.png"]);
    expect(body.reference_video_urls).toEqual(["https://cdn/clip.mp4"]);
    expect(body.reference_audio_urls).toEqual(["https://cdn/voice.mp3"]);
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.task).toBeUndefined();
  });

  it("text-to-video keeps aspect_ratio and the 2K const", () => {
    const { body } = buildFalVideoRequest({
      ...base,
      modelId: "fal-ai/minimax/hailuo-03/text-to-video",
      width: 1920,
      height: 1080,
    });
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("2K");
  });
});

describe("no silent frame loss", () => {
  it("throws when a first frame is given to a text-to-video endpoint with no i2v sibling", () => {
    expect(() =>
      buildFalVideoRequest({ ...base, modelId: "fal-ai/veo3", firstFrameUrl: "https://cdn/first.png" })
    ).toThrow(/不接受首帧图/);
  });

  it("chaining is enabled for every fal endpoint that declares an end-frame field", () => {
    expect(modelSupportsLastFrame("fal-ai/minimax/hailuo-03/image-to-video")).toBe(true);
    expect(modelSupportsLastFrame("fal-ai/kling-video/v3/pro/image-to-video")).toBe(true);
    expect(modelSupportsLastFrame("fal-ai/luma-dream-machine/ray-2/image-to-video")).toBe(true);
    expect(modelSupportsLastFrame("fal-ai/wan/v2.2-a14b/image-to-video")).toBe(true);
    expect(modelSupportsLastFrame("bytedance/seedance-2.5/image-to-video")).toBe(true);
    // a text-to-video endpoint has no end frame to pin
    expect(modelSupportsLastFrame("fal-ai/veo3")).toBe(false);
  });
});
