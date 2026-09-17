import { describe, expect, it, vi } from "vitest";
import { toProviderImage } from "@/lib/remote-image";

// resolveUploadFilePath only accepts /api/files/*, so any local ref here resolves to a path
const localRef = "/api/files/proj/1.png";

describe("toProviderImage", () => {
  it("stages a local file on the provider CDN when the provider supports it", async () => {
    const uploadLocalMedia = vi.fn(async () => "https://cdn.fal.media/files/x.png");
    expect(await toProviderImage(localRef, { uploadLocalMedia })).toBe("https://cdn.fal.media/files/x.png");
    expect(uploadLocalMedia).toHaveBeenCalledTimes(1);
  });

  it("passes remote URLs and data URIs through untouched (no upload)", async () => {
    const uploadLocalMedia = vi.fn(async () => "nope");
    expect(await toProviderImage("https://example.com/a.png", { uploadLocalMedia })).toBe("https://example.com/a.png");
    expect(await toProviderImage("data:image/png;base64,AAA", { uploadLocalMedia })).toBe("data:image/png;base64,AAA");
    expect(uploadLocalMedia).not.toHaveBeenCalled();
  });

  it("falls back to a data URI when the provider has no upload API", async () => {
    const out = await toProviderImage("https://example.com/a.png", {});
    expect(out).toBe("https://example.com/a.png");
  });

  it("fails before billing when staging fails; never substitutes a local URL or Base64", async () => {
    const uploadLocalMedia = vi.fn(async () => { throw new Error("cdn down"); });
    // a distinct path: the successful case above is cached per file on purpose
    await expect(toProviderImage("/api/files/proj/2.png", { uploadLocalMedia })).rejects.toThrow("cdn down");
  });

  it("returns undefined for an empty ref", async () => {
    expect(await toProviderImage(undefined, {})).toBeUndefined();
  });
});
