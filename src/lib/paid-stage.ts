/** Browser-side checkpoints for an explicitly confirmed multi-stage paid workflow.
 * A transport failure is not permission to submit again. Keep the intent before POST;
 * known handles use the recovery endpoint, and unknown acknowledgements require reconciliation.
 * This supplements server task journals; it is not a distributed exactly-once guarantee.
 */
type Payload = Record<string, unknown>;
type Checkpoint = {
  version: 1;
  signature: string;
  state: "submitting" | "pending" | "completed";
  taskId?: string;
  result?: Payload;
};
export interface PaidStageOptions {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  key: string;
  /** Describe the confirmed content/model/options, never include API keys. */
  signature: string;
  submit: () => Promise<Response>;
  recover: (taskId: string) => Promise<Response>;
  isComplete: (data: Payload) => boolean;
}
const running = new Map<string, { signature: string; work: Promise<Payload> }>();

export function runPaidStage(options: PaidStageOptions): Promise<Payload> {
  const active = running.get(options.key);
  if (active) {
    return active.signature === options.signature ? active.work : Promise.reject(new Error("付费阶段正在执行，不能切换方案；请先恢复当前任务"));
  }
  const work = run(options).finally(() => running.delete(options.key));
  running.set(options.key, { signature: options.signature, work });
  return work;
}

async function run({ storage, key, signature, submit, recover, isComplete }: PaidStageOptions): Promise<Payload> {
  const raw = storage.getItem(key);
  let previous: Checkpoint | undefined;
  if (raw) {
    try {
      const value = JSON.parse(raw) as Checkpoint;
      if (value.version !== 1 || typeof value.signature !== "string" || !["submitting", "pending", "completed"].includes(value.state) ||
          (value.taskId !== undefined && (typeof value.taskId !== "string" || !value.taskId))) throw new Error("invalid");
      previous = value;
    } catch { throw new Error("付费阶段恢复记录损坏；请先到任务中心核对原任务，已阻止重复提交"); }
    if (previous.signature !== signature) {
      if (previous.state !== "completed") throw new Error("上一次付费任务尚未确认完成；请先到任务中心恢复原任务，再更改方案");
      previous = undefined;
    }
  }
  if (previous && !previous.taskId) {
    if (previous.state === "completed" && previous.result && isComplete(previous.result)) return previous.result;
    throw new Error("付费提交结果未知；请到任务中心或供应商平台核对原任务，已阻止自动重复扣费");
  }
  const checkpoint: Checkpoint = previous ?? { version: 1, signature, state: "submitting" };
  // Fail closed if browser persistence is unavailable, before any paid request is sent.
  storage.setItem(key, JSON.stringify(checkpoint));
  const response = await (checkpoint.taskId ? recover(checkpoint.taskId) : submit());
  const data: unknown = await response.json().catch(() => undefined);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("付费请求没有返回可核对结果；请恢复原任务，不要重新生成");
  const payload = data as Payload;
  if (typeof payload.taskId === "string" && payload.taskId) checkpoint.taskId = payload.taskId;
  const terminal = payload.status === "failed" || payload.status === "cancelled" || payload.recoverable === false;
  // These local-route validation responses happen before a billable submit. Do not infer that
  // arbitrary upstream timeouts/5xx or malformed acknowledgements are safe to resubmit.
  const rejectedBeforeSubmit = !checkpoint.taskId && [400, 401, 403, 404, 422].includes(response.status);
  if (terminal || rejectedBeforeSubmit) {
    storage.removeItem(key);
    throw new Error(typeof payload.error === "string" ? payload.error : "任务已明确失败；请检查原因后再确认新的生成");
  }
  if (response.ok && isComplete(payload)) {
    checkpoint.state = "completed";
    checkpoint.result = payload;
    storage.setItem(key, JSON.stringify(checkpoint));
    return payload;
  }
  checkpoint.state = checkpoint.taskId ? "pending" : "submitting";
  storage.setItem(key, JSON.stringify(checkpoint));
  throw new Error(typeof payload.error === "string" ? payload.error : "任务尚未完成或本地保存未完成；再次确认将恢复原任务，不会重新生成");
}
