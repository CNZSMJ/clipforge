import { describe, it, expect } from "vitest";
import {
  getVideoParamSpec,
  pickEnumDuration,
  pickRatio,
  pickResolution,
  VIDEO_PARAM_SPECS,
} from "@/lib/providers/video-params";
import type { VideoOptions } from "@/lib/providers/types";

/**
 * Per-model video request contracts (v0.8.76). Video vendors disagree on field names
 * and enums; every expectation here mirrors the model's published input schema
 * (vendor schema dumps, fetched 2026-08). A wrong body either
 * rejects pre-billing (lucky) or bills a mis-parameterized video (issue #18's video
 * twin) — these tests pin the mapping.
 */

const i2vBase: VideoOptions = {
  modelId: "",
  mode: "image-to-video",
  prompt: "宣传片",
  firstFrameUrl: "https://example.com/first.png",
  width: 1080,
  height: 1920,
  duration: 3,
};

describe("取值选择器", () => {
  it("pickEnumDuration：就近取整档，平手取更短（更省）", () => {
    expect(pickEnumDuration([4, 5, 6, 7, 8], 3)).toBe(4);
    expect(pickEnumDuration([6, 10], 7)).toBe(6);
    expect(pickEnumDuration([6, 10], 8)).toBe(6); // tie -> shorter
    expect(pickEnumDuration([8, 4, 6], 5)).toBe(4); // tie -> shorter, order-insensitive
    expect(pickEnumDuration([-1, 4, 5], 2)).toBe(4); // -1 auto sentinel filtered out
  });

  it("pickResolution：4k-esr 这类带后缀的 k 简写能被解析（旧实现整档丢弃）", () => {
    expect(pickResolution(["1080p", "4k-esr"], 2160, 3840)).toBe("4k-esr");
    expect(pickResolution(["2K", "4k-esr"], 1440, 2560)).toBe("2K");
  });

  it("pickResolution：覆盖请求短边的最小档；无档可覆盖取最大档；同档裸名优先", () => {
    expect(pickResolution(["768P", "2K"], 1080, 1920)).toBe("2K");
    expect(pickResolution(["768P", "2K"], 720, 1280)).toBe("768P");
    expect(pickResolution(["720p", "1080p", "4k"], 1080, 1920)).toBe("1080p");
    expect(pickResolution(["480p", "720p", "720p-SR", "1080p-SR", "1440p-SR"], 1080, 1920)).toBe("1080p-SR");
    expect(pickResolution(["720P", "1080P"], 1440, 2560)).toBe("1080P"); // nothing covers 1440 -> largest
    expect(pickResolution(["720p-SR", "720p"], 720, 1280)).toBe("720p"); // plain over suffixed
    // issue #28: the curated Seedance 2.5 enum omitted native 1080p, so a 1080p request landed
    // on 1080p-sr — a separately priced upscale product, ~5x the native per-second rate.
    expect(
      pickResolution(["480p", "720p", "720p-sr", "1080p", "1080p-sr", "1080p-esr", "1440p-sr", "4k-esr"], 1080, 1920)
    ).toBe("1080p");
  });

  it("pickRatio：数值比例就近；仅 adaptive 时返回 adaptive；已知尺寸时数值优先于 adaptive", () => {
    expect(pickRatio(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], 1080, 1920)).toBe("9:16");
    expect(pickRatio(["adaptive"], 1080, 1920)).toBe("adaptive");
    expect(pickRatio(["adaptive", "16:9", "9:16"], 1080, 1920)).toBe("9:16");
    expect(pickRatio(["16:9", "9:16"], 1920, 1080)).toBe("16:9");
  });
});
