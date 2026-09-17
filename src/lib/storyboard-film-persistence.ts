import { createHash } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDataDir } from "./paths";
import { getDb } from "./db";
import { compositions } from "./db/schema";
import { probeMedia } from "./media-probe";
import { downloadMediaToFile } from "./media-download";

/** A cloud result becomes an exportable composition only after a complete, probed local copy.
 * A stable task-derived filename makes interrupted finalization/recovery idempotent.
 */
export async function persistGeneratedFilm(projectId: string, videoUrl: string | undefined, model: string, taskId?: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !videoUrl) throw new Error("无效的项目或成片地址");
  const outputDir = join(getDataDir(), "output", projectId);
  await mkdir(outputDir, { recursive: true });
  const key = createHash("sha256").update(taskId || videoUrl).digest("hex").slice(0, 32);
  const fileName = `film_${key}.mp4`;
  const outputPath = join(outputDir, fileName);
  const db = getDb();
  const where = and(eq(compositions.projectId, projectId), eq(compositions.outputPath, outputPath));
  const existing = db.select().from(compositions).where(where).get();
  if (existing) {
    try {
      const probe = await probeMedia(outputPath);
      if (probe.duration > 0 && probe.width > 0 && probe.height > 0 && probe.hasAudio) {
        return { url: `/api/output/${projectId}/${fileName}`, compositionId: existing.id, fileName };
      }
    } catch { /* recover a missing/damaged local result from this same paid task */ }
  }
  const temporary = `${outputPath}.${crypto.randomUUID()}.download`;
  try {
    await downloadMediaToFile(videoUrl, temporary, { kind: "video" });
    const probe = await probeMedia(temporary);
    if (!(probe.duration > 0 && probe.width > 0 && probe.height > 0)) throw new Error("成片媒体校验失败；请重试下载，不要重新生成");
    if (probe.formatName && !probe.formatName.split(",").some(format => ["mov", "mp4"].includes(format))) throw new Error("整片不是 MP4 容器；已保留原任务，请下载后转封装，不会重新生成");
    if (!probe.hasAudio) throw new Error("整片未包含必需的对白音轨；结果已保留，请检查该任务，不要自动重复付费");
    await rename(temporary, outputPath);
    const ratio = probe.width / probe.height;
    const aspectRatio = (["9:16", "16:9", "1:1"] as const).reduce((best, value) => {
      const numeric = (s: string) => { const [w, h] = s.split(":").map(Number); return w / h; };
      return Math.abs(Math.log(numeric(value) / ratio)) < Math.abs(Math.log(numeric(best) / ratio)) ? value : best;
    });
    const comp = db.transaction(tx => {
      const found = tx.select().from(compositions).where(where).get();
      if (found) return found;
      return tx.insert(compositions).values({
        projectId, outputPath, resolution: Math.min(probe.width, probe.height) >= 1080 ? "1080p" : "720p",
        aspectRatio, duration: Math.round(probe.duration * 1000), aigcBadge: false,
        label: `整片 · ${model.split("/").slice(-2).join("/")}`.slice(0, 60), status: "done",
      }).returning().get();
    });
    return { url: `/api/output/${projectId}/${fileName}`, compositionId: comp.id, fileName };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
