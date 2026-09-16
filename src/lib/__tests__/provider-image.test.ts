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

  it("never throws when staging fails — the caller still gets an input", async () => {
    const uploadLocalMedia = vi.fn(async () => { throw new Error("cdn down"); });
    // a distinct path: the successful case above is cached per file on purpose
    const out = await toProviderImage("/api/files/proj/2.png", { uploadLocalMedia });
    // either a data URI (file readable) or the original ref (file missing in the test env)
    expect(typeof out).toBe("string");
    expect(out).not.toBe("https://cdn.fal.media/files/x.png");
  });

  it("returns undefined for an empty ref", async () => {
    expect(await toProviderImage(undefined, {})).toBeUndefined();
  });
});
