// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { runPaidStage, type PaidStageOptions } from "../paid-stage";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
const response = (data: unknown, status = 200) => Response.json(data, { status });
function stage(): PaidStageOptions {
  return { storage: storage(), key: crypto.randomUUID(), signature: "confirmed-content-model-options",
    submit: vi.fn(async () => response({ taskId: "model::original", gridPath: "/api/files/p/grid.png" })),
    recover: vi.fn(async () => response({ taskId: "model::original", status: "completed", grid: {} })),
    isComplete: (data) => typeof data.gridPath === "string" || (data.status === "completed" && Boolean(data.grid)),
  };
}
describe("paid pipeline stage checkpoints", () => {
  it("records the intent BEFORE submitting a paid request", async () => {
    const input = stage();
    input.submit = vi.fn(async () => {
      expect(JSON.parse(input.storage.getItem(input.key)!)).toMatchObject({ state: "submitting", signature: input.signature });
      return response({ taskId: "model::original", gridPath: "/api/files/p/grid.png" });
    });
    await runPaidStage(input);
    expect(JSON.parse(input.storage.getItem(input.key)!)).toMatchObject({ state: "completed", taskId: "model::original" });
  });
  it("a downstream failure does not re-bill the successfully completed grid", async () => {
    const input = stage();
    await runPaidStage(input);
    await runPaidStage(input);
    expect(input.submit).toHaveBeenCalledTimes(1);
    expect(input.recover).toHaveBeenCalledExactlyOnceWith("model::original");
  });
  it("a failed download is retried against the same handle", async () => {
    const input = stage();
    input.submit = vi.fn(async () => response({ taskId: "model::original", recoverable: true, error: "CDN unavailable" }, 504));
    await expect(runPaidStage(input)).rejects.toThrow("CDN unavailable");
    await runPaidStage(input);
    expect(input.submit).toHaveBeenCalledTimes(1);
    expect(input.recover).toHaveBeenCalledExactlyOnceWith("model::original");
  });
  it("retains the handle across repeated failed recovery attempts", async () => {
    const input = stage(); await runPaidStage(input);
    input.recover = vi.fn(async () => response({ error: "temporary network failure" }, 504));
    await expect(runPaidStage(input)).rejects.toThrow("temporary network failure");
    await expect(runPaidStage(input)).rejects.toThrow("temporary network failure");
    expect(input.submit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(input.storage.getItem(input.key)!)).toMatchObject({ taskId: "model::original", state: "pending" });
  });
  it("lost acknowledgements fail closed instead of resubmitting", async () => {
    const input = stage(); input.submit = vi.fn(async () => { throw new Error("network lost"); });
    await expect(runPaidStage(input)).rejects.toThrow("network lost");
    await expect(runPaidStage(input)).rejects.toThrow("结果未知");
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
  it("a malformed success response remains ambiguous, not safe to re-bill", async () => {
    const input = stage(); input.submit = vi.fn(async () => new Response("<html>bad gateway</html>"));
    await expect(runPaidStage(input)).rejects.toThrow("没有返回");
    await expect(runPaidStage(input)).rejects.toThrow("结果未知");
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
  it("quota/storage failure blocks submission before money moves", async () => {
    const input = stage(); input.storage.setItem = () => { throw new Error("storage full"); };
    await expect(runPaidStage(input)).rejects.toThrow("storage full");
    expect(input.submit).not.toHaveBeenCalled();
  });
  it("cannot replace an unfinished task by changing the model or content", async () => {
    const input = stage(); input.submit = vi.fn(async () => response({ taskId: "model::original", error: "waiting", recoverable: true }, 504));
    await expect(runPaidStage(input)).rejects.toThrow();
    await expect(runPaidStage({ ...input, signature: "new-model" })).rejects.toThrow("先到任务中心恢复");
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
  it("allows explicitly reconfirmed changed content after the old stage completed", async () => {
    const input = stage(); await runPaidStage(input);
    await runPaidStage({ ...input, signature: "new-confirmed-content" });
    expect(input.submit).toHaveBeenCalledTimes(2);
  });
  it("a definitive terminal failure requires a new confirmation, never auto-resubmits", async () => {
    const input = stage(); await runPaidStage(input);
    input.recover = vi.fn(async () => response({ status: "failed", error: "moderation rejected" }));
    await expect(runPaidStage(input)).rejects.toThrow("moderation rejected");
    expect(input.storage.getItem(input.key)).toBeNull();
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
  it("a local pre-submit validation rejection can be corrected and reconfirmed", async () => {
    const input = stage(); input.submit = vi.fn(async () => response({ error: "invalid input" }, 400));
    await expect(runPaidStage(input)).rejects.toThrow("invalid input");
    expect(input.storage.getItem(input.key)).toBeNull();
  });
  it("corrupt records fail closed instead of erasing recovery evidence", async () => {
    const input = stage(); input.storage.setItem(input.key, "not json");
    await expect(runPaidStage(input)).rejects.toThrow("记录损坏");
    expect(input.submit).not.toHaveBeenCalled();
  });
  it("deduplicates same-page concurrent confirmations", async () => {
    const input = stage(); await Promise.all([runPaidStage(input), runPaidStage(input)]);
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
  it("rejects a different simultaneous plan", async () => {
    const input = stage(); const first = runPaidStage(input);
    await expect(runPaidStage({ ...input, signature: "changed" })).rejects.toThrow("正在执行");
    await first;
    expect(input.submit).toHaveBeenCalledTimes(1);
  });
});
