/** Durable fal narration recovery. Identical retries retrieve the existing task, never re-bill it. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "./paths";
import { ProviderError } from "./providers/base";
import { submitFalTask, readFalTask } from "./providers/fal-queue";
import { downloadMediaBuffer } from "./media-download";
import type { TTSConfig } from "./tts";

const pending = new Map<string, Promise<Buffer>>();
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function identity(text: string, config: TTSConfig) {
  return createHash("sha256").update(JSON.stringify([text, config.baseUrl, config.model, config.voice, config.speed, config.emotion, config.apiKey])).digest("hex");
}
function journalPath(text: string, config: TTSConfig) {
  return join(getDataDir(), "cache", "tts", "fal-pending", `${identity(text, config)}.json`);
}
export async function clearCompletedFalSpeech(text: string, config: TTSConfig) {
  await unlink(journalPath(text, config)).catch(() => undefined);
}

export function generateFalSpeech(text: string, config: TTSConfig): Promise<Buffer> {
  if (!text.trim() || Array.from(text).length > 5000) return Promise.reject(new Error("fal Speech-02 文本须为 1–5000 字符，请先拆分长稿"));
  if (config.speed != null && !Number.isFinite(config.speed)) return Promise.reject(new Error("配音速度必须是有限数值"));
  const key = identity(text, config);
  const current = pending.get(key);
  if (current) return current;
  const operation = run(text, config).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function run(text: string, config: TTSConfig): Promise<Buffer> {
  const directory = join(getDataDir(), "cache", "tts", "fal-pending");
  await mkdir(directory, { recursive: true });
  const file = journalPath(text, config);
  const settings = { name: "fal-ai", apiKey: config.apiKey, baseUrl: config.baseUrl || "https://queue.fal.run" };
  let taskId: string | undefined;
  let acquired = false;
  try {
    // Exclusive intent is written BEFORE a billable POST, including across server processes.
    await writeFile(file, JSON.stringify({ state: "submitting", createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
    acquired = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    // Another process can be between intent and acknowledgement; allow it to publish the handle.
    for (let attempt = 0; attempt < 30; attempt++) {
      const record = JSON.parse(await readFile(file, "utf8")) as { taskId?: string };
      if (record.taskId) { taskId = record.taskId; break; }
      if (attempt < 29) await pause(1000);
    }
    if (!taskId) throw new Error("fal 配音提交状态未知，已阻止重复扣费；请核查平台任务及 cache/tts/fal-pending 记录后再操作");
  }
  if (acquired) {
    try {
      taskId = await submitFalTask(settings, config.model || "fal-ai/minimax/speech-02-hd", {
        text, output_format: "url",
        voice_setting: {
          voice_id: config.voice || "Wise_Woman", speed: config.speed == null ? 1 : Math.min(2, Math.max(0.5, config.speed)), vol: 1, pitch: 0,
          ...(["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"].includes(config.emotion || "") && { emotion: config.emotion }),
        },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ taskId, createdAt: Date.now() }), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      // A definite 4xx rejection did not create a job. Ambiguous submissions retain their intent.
      if (!taskId && error instanceof ProviderError && error.statusCode && error.statusCode < 500) await unlink(file).catch(() => undefined);
      if (taskId) throw new Error(`配音任务已提交，但恢复记录写入失败；请保存任务 ID ${taskId}，不要重新提交`);
      throw error;
    }
  }
  if (!taskId) throw new Error("缺少配音任务 ID");
  const deadline = Date.now() + 10 * 60 * 1000;
  let errors = 0;
  while (Date.now() < deadline) {
    try {
      const state = await readFalTask(settings, taskId);
      if (state.status === "failed" || state.status === "cancelled") {
        await unlink(file).catch(() => undefined);
        throw new ProviderError(state.error || "fal 配音失败", "TASK_FAILED", "fal-ai");
      }
      if (state.status === "completed") {
        const audio = state.data?.audio;
        const url = audio && typeof audio === "object" && "url" in audio ? audio.url : undefined;
        if (typeof url !== "string") throw new Error("配音任务完成但没有音频地址");
        // Failure leaves the journal intact so the next compose retrieves this very task.
        return await downloadMediaBuffer(url, { kind: "audio", maxBytes: 64 * 1024 * 1024 });
      }
      errors = 0;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "TASK_FAILED") throw error;
      if (++errors >= 3) throw new Error(`fal 配音查询/下载失败，原任务已保留，重试不会重新生成：${error instanceof Error ? error.message : String(error)}`);
    }
    await pause(1500);
  }
  throw new Error("fal 配音等待超时，任务已保存，下次操作将恢复查询而不是重新生成");
}
