import { describe, expect, it } from "vitest";
import { falQueueAppPath } from "@/lib/providers/fal-ai";

describe("falQueueAppPath", () => {
  // Verified live 2026-09-16 with a real key: the full endpoint path answers 405, owner/app 404
  // (route exists, unknown request id) — so polling must use owner/app.
  it("keeps owner/app and drops the variant path", () => {
    expect(falQueueAppPath("fal-ai/flux/schnell")).toBe("fal-ai/flux");
    expect(falQueueAppPath("openai/gpt-image-2/image-to-image")).toBe("openai/gpt-image-2");
    expect(falQueueAppPath("bytedance/seedance-2.5/image-to-video")).toBe("bytedance/seedance-2.5");
    expect(falQueueAppPath("fal-ai/kling-video/v3/pro/image-to-video")).toBe("fal-ai/kling-video");
    expect(falQueueAppPath("fal-ai/vidu/start-end-to-video")).toBe("fal-ai/vidu");
  });

  it("leaves a two-segment id untouched", () => {
    expect(falQueueAppPath("fal-ai/veo3")).toBe("fal-ai/veo3");
  });
});
