import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getUploadsDir } from "./paths";
import { getDb } from "./db";
import { scripts, assets, type Shot } from "./db/schema";
import { persistAssetSource } from "./asset-persistence";
import { resolveUploadFilePath } from "./remote-image";
import { probeMedia } from "./media-probe";
import { computeGridCells } from "./storyboard-grid";
import { ffmpegBin } from "./ffmpeg-path";

const execute = promisify(execFile);
export function storyboardGridMode(scriptId: string, shots: Shot[]) {
  return `storyboard-grid:${scriptId}:${createHash("sha256").update(JSON.stringify(shots)).digest("hex")}`;
}

/** Crop every cell successfully before atomically replacing the active storyboard.
 * A failed cell must never leave half the project on a different face/outfit/grid revision.
 */
export async function persistStoryboardGrid(projectId: string, mode: string, sourceUrl: string, provider: string, model: string, taskId: string) {
  if (!/^[\w-]+$/.test(projectId) || !mode.startsWith("storyboard-grid:")) throw new Error("无效的九宫格任务上下文");
  const scriptId = mode.split(":")[1];
  const db = getDb();
  const script = db.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId))).get();
  if (!script || !Array.isArray(script.shots) || storyboardGridMode(scriptId, script.shots) !== mode) {
    throw new Error("脚本已修改，不能将旧九宫格覆盖到新分镜；请先恢复生成时的脚本版本");
  }
  const gridPath = await persistAssetSource(projectId, sourceUrl, -1, "storyboard-grid");
  const physical = resolveUploadFilePath(gridPath);
  if (!physical || !/\.(png|jpe?g|webp|gif)$/i.test(physical)) throw new Error("九宫格结果不是图片");
  const probe = await probeMedia(physical);
  if (probe.width < 3 || probe.height < 3) throw new Error("九宫格图片尺寸无效");
  const cells = computeGridCells(probe.width, probe.height);
  const dir = join(getUploadsDir(), projectId);
  await mkdir(dir, { recursive: true });
  const prefix = createHash("sha256").update(taskId).digest("hex").slice(0, 24);
  const prepared: { shotId: number; filePath: string; description: string; index: number }[] = [];
  for (let i = 0; i < script.shots.length; i++) {
    const shot = script.shots[i]; const cell = cells[i];
    if (!cell) throw new Error("九宫格分镜数量超过可用格数");
    const fileName = `grid-${prefix}-${shot.shotId}.png`;
    const output = join(dir, fileName); const temporary = `${output}.${randomUUID()}.png`;
    try {
      await execute(ffmpegBin(), ["-y", "-i", physical, "-vf", `crop=${cell.w}:${cell.h}:${cell.x}:${cell.y}`, "-frames:v", "1", temporary], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      const cropped = await probeMedia(temporary);
      if (!cropped.width || !cropped.height) throw new Error("九宫格裁切输出无效");
      await rename(temporary, output);
      prepared.push({ shotId: shot.shotId, filePath: `/api/files/${projectId}/${fileName}`, description: shot.description || "", index: i });
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  db.transaction(tx => {
    // Recheck under the same DB transaction; the script could change while FFmpeg was running.
    const current = tx.select().from(scripts).where(eq(scripts.id, scriptId)).get();
    if (!current || !current.shots || storyboardGridMode(scriptId, current.shots) !== mode) throw new Error("裁切期间脚本已修改，未覆盖任何当前分镜");
    for (const item of prepared) {
      const where = and(eq(assets.projectId, projectId), eq(assets.shotId, item.shotId));
      const existing = tx.select().from(assets).where(and(where, eq(assets.filePath, item.filePath))).get();
      tx.update(assets).set({ selected: false }).where(where).run();
      if (existing) tx.update(assets).set({ selected: true }).where(eq(assets.id, existing.id)).run();
      else tx.insert(assets).values({ projectId, shotId: item.shotId, type: "ai_generated", filePath: item.filePath,
        provider, model, prompt: `[storyboard-grid 第${item.index + 1}格] ${item.description}`.trim(), selected: true, status: "done" }).run();
    }
  });
  return { gridPath, cells: prepared.map(({ shotId, filePath }) => ({ shotId, filePath })), count: prepared.length };
}
