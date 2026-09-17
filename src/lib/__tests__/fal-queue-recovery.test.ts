// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFalTask, decodeFalTask, readFalTask, submitFalTask, trustedFalQueueUrl } from "../providers/fal-queue";
import { FalAIProvider } from "../providers/fal-ai";
const config = { name: "fal-ai", apiKey: "account-A", baseUrl: "https://queue.fal.run" };
const model = "fal-ai/flux/schnell";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable authoritative Fal queue URLs", () => {
  it("retains official URLs in the saved handle and uses them in a fresh provider", async () => {
    const taskId = encodeFalTask(model, { request_id: "job", status_url: "https://queue.fal.run/custom/status/job", response_url: "https://queue.fal.run/custom/result/job" });
    expect(decodeFalTask(taskId)).toMatchObject({ modelId: model, requestId: "job", statusUrl: "https://queue.fal.run/custom/status/job", responseUrl: "https://queue.fal.run/custom/result/job" });
    const fetcher = vi.fn(async (url: string) => url.includes("/status/") ? Response.json({ status: "COMPLETED" }) : Response.json({ images: [{ url: "https://fal.media/result.png" }] }));
    vi.stubGlobal("fetch", fetcher);
    const state = await new FalAIProvider(config).getTaskStatus(taskId);
    expect(state.result).toMatchObject({ imageUrls: ["https://fal.media/result.png"] });
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["https://queue.fal.run/custom/status/job", "https://queue.fal.run/custom/result/job"]);
  });
  it("keeps legacy task IDs readable at owner/app, not at the variant endpoint", () => {
    expect(decodeFalTask(`${model}::old`).statusUrl).toBe("https://queue.fal.run/fal-ai/flux/requests/old/status");
    expect(decodeFalTask("workflows/team/name/variant::old").responseUrl).toBe("https://queue.fal.run/workflows/team/name/requests/old");
  });
  it("prefers a refreshed result URL from status over the saved pointer", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/status") ? Response.json({ status: "COMPLETED", response_url: "https://queue.fal.run/refreshed/job" }) : Response.json({ video: { url: "https://fal.media/v.mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    await readFalTask(config, `${model}::refresh`);
    expect(fetcher.mock.calls[1][0]).toBe("https://queue.fal.run/refreshed/job");
  });
  it("never sends the API key to untrusted returned URLs or cross-origin redirects", async () => {
    expect(() => trustedFalQueueUrl("https://attacker.invalid/result")).toThrow(/不可信/);
    const harmless = encodeFalTask(model, { request_id: "job", status_url: "https://attacker.invalid/status" });
    expect(decodeFalTask(harmless).statusUrl).toContain("queue.fal.run/fal-ai/flux/requests/job/status");
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Key account-A");
      return Response.json({ status: "COMPLETED", response_url: "https://attacker.invalid/result" });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(readFalTask(config, `${model}::malicious`)).rejects.toThrow(/不可信/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["CANCELLED", "CANCELED"])("treats %s as terminal, not a polling loop", async state => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: state })));
    expect((await readFalTask(config, `${model}::cancel`)).status).toBe("cancelled");
  });
  it("recognizes COMPLETED with a stored rejection without attempting to download media", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "COMPLETED", error: "content rejected" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await readFalTask(config, `${model}::rejected`)).toMatchObject({ status: "failed", error: "content rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("surfaces stored 422 validation while keeping transient result errors recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/status") ? Response.json({ status: "COMPLETED" }) : Response.json({ detail: "missing image_url" }, { status: 422 })));
    expect(await readFalTask(config, `${model}::invalid`)).toMatchObject({ status: "failed", error: expect.stringContaining("image_url") });
  });
  it.each([429, 500, 503])("never retries an inference POST returning HTTP %i", async code => {
    const fetcher = vi.fn(async () => Response.json({ detail: "failure" }, { status: code }));
    vi.stubGlobal("fetch", fetcher);
    await expect(submitFalTask(config, model, { prompt: "x" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a lost submission acknowledgement does not trigger a second charge", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("connection reset"); });
    vi.stubGlobal("fetch", fetcher);
    await expect(submitFalTask(config, model, { prompt: "x" })).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries only transient GET failures with a fixed limit", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json({}, { status: 429 })).mockResolvedValueOnce(Response.json({ status: "IN_PROGRESS" }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readFalTask(config, `${model}::retry`)).status).toBe("processing");
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) expect(init.method).toBe("GET");
  });
  it("coalesces concurrent reads but never across credentials", async () => {
    const fetcher = vi.fn(async () => { await new Promise(r => setTimeout(r, 10)); return Response.json({ status: "IN_QUEUE" }); });
    vi.stubGlobal("fetch", fetcher);
    await Promise.all([readFalTask(config, `${model}::parallel`), readFalTask(config, `${model}::parallel`), readFalTask({ ...config, apiKey: "account-B" }, `${model}::parallel`)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed handles and missing acknowledgement IDs", () => {
    expect(() => decodeFalTask("model::../bad")).toThrow();
    expect(() => encodeFalTask(model, {})).toThrow(/request_id/);
    expect(() => decodeFalTask(`${model}::job::bm90LWpzb24`)).toThrow(/元数据/);
  });
});
