// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, open, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createLimiter } from "../media-concurrency";
const mocks = vi.hoisted(() => ({ safeFetch: vi.fn(), assertPublicUrl: vi.fn() }));
vi.mock("../ssrf-guard", () => mocks);
import { uploadFalFile, FAL_MULTIPART_THRESHOLD, FAL_UPLOAD_PART_BYTES } from "../providers/fal-storage";
import { downloadMediaToFile } from "../media-download";
let directory: string;
const originalData = process.env.APP_DATA_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-transfer-"));
  process.env.APP_DATA_DIR = directory;
  await mkdir(join(directory, "uploads"));
  mocks.safeFetch.mockReset(); mocks.assertPublicUrl.mockReset(); mocks.assertPublicUrl.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalData === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = originalData;
  await rm(directory, { recursive: true, force: true });
});
const signed = "https://upload.fal.media/slot?signature=private";
const stored = "https://fal.media/files/complete.png";

describe("Fal streaming CDN uploads", () => {
  it("uses the returned CDN URL only after PUT, streams bytes, and scopes credentials to initiation", async () => {
    const file = join(directory, "uploads", "source.png");
    await writeFile(file, "image-bytes");
    const initiate = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Key A");
      expect(JSON.parse(String(init.body))).toEqual({ content_type: "image/png", file_name: "source.png" });
      return Response.json({ upload_url: signed, file_url: stored });
    });
    vi.stubGlobal("fetch", initiate);
    mocks.safeFetch.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe(signed); expect(init.method).toBe("PUT");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      expect(init.body).toBeInstanceOf(Readable);
      let value = ""; for await (const chunk of init.body as unknown as Readable) value += chunk.toString();
      expect(value).toBe("image-bytes");
      return new Response(null, { status: 200 });
    });
    expect(await uploadFalFile(file, "A")).toBe(stored);
    expect(initiate).toHaveBeenCalledTimes(1);
  });
  it("deduplicates same-file concurrent uploads, but invalidates changes and isolates API keys", async () => {
    const file = join(directory, "uploads", "source.png"); await writeFile(file, "before");
    const initiate = vi.fn(async () => Response.json({ upload_url: signed, file_url: stored })); vi.stubGlobal("fetch", initiate);
    mocks.safeFetch.mockImplementation(async (_url, init) => { for await (const chunk of init.body) { void chunk; /* drain */ } return new Response(null); });
    await Promise.all([uploadFalFile(file, "A"), uploadFalFile(file, "A")]);
    await uploadFalFile(file, "A"); expect(initiate).toHaveBeenCalledTimes(1);
    await uploadFalFile(file, "B"); expect(initiate).toHaveBeenCalledTimes(2);
    await writeFile(file, "after-with-different-length"); await uploadFalFile(file, "A"); expect(initiate).toHaveBeenCalledTimes(3);
  });
  it("rejects missing files, symlink escapes, empty files and >512 MiB before contacting Fal", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const outside = join(directory, "private.txt"); await writeFile(outside, "secret");
    const link = join(directory, "uploads", "link.png"); await symlink(outside, link);
    await expect(uploadFalFile(link, "A")).rejects.toThrow(/目录/);
    const empty = join(directory, "uploads", "empty.mp4"); await writeFile(empty, "");
    await expect(uploadFalFile(empty, "A")).rejects.toThrow(/为空/);
    const huge = await open(empty, "w"); await huge.truncate(513 * 1024 * 1024); await huge.close();
    await expect(uploadFalFile(empty, "A")).rejects.toThrow(/512/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("multipart is bounded at four streams and finalizes ordered receipts without dropping signed query", async () => {
    const file = join(directory, "uploads", "large.mp4"); const handle = await open(file, "w");
    await handle.truncate(FAL_MULTIPART_THRESHOLD + 1); await handle.close();
    const initiate = vi.fn(async (url: string) => {
      expect(url).toContain("initiate-multipart?storage_type=fal-cdn-v3");
      return Response.json({ upload_url: signed, file_url: stored });
    }); vi.stubGlobal("fetch", initiate);
    let active = 0, peak = 0, bytes = 0; const numbers: number[] = [];
    mocks.safeFetch.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toContain("?signature=private"); expect(new Headers(init.headers).has("Authorization")).toBe(false);
      if (init.method === "POST") {
        expect(url).toContain("/slot/complete?");
        expect(active).toBe(0);
        expect(JSON.parse(String(init.body))).toEqual({ parts: Array.from({ length: 10 }, (_, i) => ({ partNumber: i + 1, etag: `etag-${i + 1}` })) });
        return new Response(null);
      }
      const part = Number(new URL(url).pathname.split("/").at(-1)); numbers.push(part); active++; peak = Math.max(peak, active);
      const stream = init.body as unknown as Readable;
      let count = 0; for await (const chunk of stream) count += chunk.length;
      expect(count).toBe(part === 10 ? 1 : FAL_UPLOAD_PART_BYTES); bytes += count;
      await new Promise(r => setTimeout(r, 5)); active--;
      return Response.json({ partNumber: part, etag: `etag-${part}` });
    });
    expect(await uploadFalFile(file, "A")).toBe(stored);
    expect(peak).toBeLessThanOrEqual(4); expect(peak).toBeGreaterThan(1);
    expect(bytes).toBe(FAL_MULTIPART_THRESHOLD + 1); expect(numbers).toHaveLength(10);
  }, 15000);
  it("a permanent failed PUT never returns/caches file_url and does not fall back to Base64", async () => {
    const file = join(directory, "uploads", "failure.png"); await writeFile(file, "image");
    const initiate = vi.fn(async () => Response.json({ upload_url: signed, file_url: stored })); vi.stubGlobal("fetch", initiate);
    mocks.safeFetch.mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(uploadFalFile(file, "A")).rejects.toThrow(/403/);
    mocks.safeFetch.mockImplementation(async (_url, init) => { for await (const chunk of init.body) { void chunk; /* drain */ } return new Response(null); });
    await expect(uploadFalFile(file, "A")).resolves.toBe(stored); expect(initiate).toHaveBeenCalledTimes(2);
  });
});

describe("bounded atomic downloads", () => {
  it("streams chunks to disk without using response.arrayBuffer and publishes only after completion", async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3, 4])); c.close(); } }), { headers: { "content-type": "video/mp4", "content-length": "4" } });
    const buffer = vi.spyOn(response, "arrayBuffer"); mocks.safeFetch.mockResolvedValue(response);
    const destination = join(directory, "result.mp4");
    expect(await downloadMediaToFile(stored, destination, { kind: "video" })).toEqual({ bytes: 4, mime: "video/mp4" });
    expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3, 4])); expect(buffer).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter(p => p.endsWith(".part"))).toEqual([]);
  });
  it("retries transient CDN failures without touching a generation endpoint", async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(new Response("valid", { headers: { "content-type": "image/png" } }));
    const destination = join(directory, "retry.png"); await downloadMediaToFile(stored, destination, { kind: "image" });
    expect(await readFile(destination, "utf8")).toBe("valid"); expect(mocks.safeFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of mocks.safeFetch.mock.calls) { expect(url).toBe(stored); expect(init.method).toBeUndefined(); }
  });
  it.each(["text/html", "application/json", "audio/mpeg"])("rejects %s instead of storing it as video", async mime => {
    mocks.safeFetch.mockResolvedValue(new Response("bad", { headers: { "content-type": mime } }));
    const file = join(directory, "existing.mp4"); await writeFile(file, "original");
    await expect(downloadMediaToFile(stored, file, { kind: "video" })).rejects.toThrow(/媒体类型/);
    expect(await readFile(file, "utf8")).toBe("original"); expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
    expect((await readdir(directory)).filter(p => p.endsWith(".part"))).toEqual([]);
  });
  it("enforces a streaming size cap even without Content-Length", async () => {
    mocks.safeFetch.mockResolvedValue(new Response(new Uint8Array(1025), { headers: { "content-type": "video/mp4" } }));
    await expect(downloadMediaToFile(stored, join(directory, "large.mp4"), { maxBytes: 1024 })).rejects.toThrow(/上限/);
    expect((await readdir(directory)).filter(p => p.endsWith(".part"))).toEqual([]);
  });
  it("never publishes an incomplete body and preserves an existing file through all retries", async () => {
    mocks.safeFetch.mockImplementation(async () => new Response("short", { headers: { "content-type": "video/mp4", "content-length": "10" } }));
    const file = join(directory, "existing.mp4"); await writeFile(file, "original");
    await expect(downloadMediaToFile(stored, file)).rejects.toThrow(/不完整/);
    expect(await readFile(file, "utf8")).toBe("original"); expect(mocks.safeFetch).toHaveBeenCalledTimes(3);
  });
});

describe("shared I/O backpressure", () => {
  it("limits active work, bounds the waiting queue and releases slots after failures", async () => {
    const limit = createLimiter(1, 1);
    let release!: () => void; const first = limit(() => new Promise<void>(r => { release = r; }));
    const second = limit(async () => 2);
    await expect(limit(async () => 3)).rejects.toThrow(/队列已满/);
    release(); await first; expect(await second).toBe(2);
    await expect(limit(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await limit(async () => 4)).toBe(4);
  });
});
