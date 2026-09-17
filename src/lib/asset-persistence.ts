import { existsSync } from "fs";
import { mkdir, writeFile, rename, unlink } from "fs/promises";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { validateMediaFile, validateOrDelete } from "@/lib/media-validate";
import { getDataDir } from "@/lib/paths";
import { downloadMediaToFile, MAX_GENERATED_MEDIA_BYTES as MAX_DOWNLOAD_BYTES } from "@/lib/media-download";
import { assertLocalUploadPath } from "@/lib/providers/fal-storage";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { sanitizeGenerationControlSummary, type GenerationControlSummary } from "@/lib/video-repair-plan";
import { extractLastFrame, LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/jpeg": "jpg",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-m4v": "m4v",
  };
  const ext = extensions[mime.toLowerCase().split(";")[0]];
  if (!ext) throw new Error("素材返回了不支持的媒体类型");
  return ext;
}

async function assertValidMedia(absPath: string, ext: string): Promise<void> {
  const kind = VIDEO_EXT.test(`file.${ext}`) ? "video" : "image";
  if (!(await validateOrDelete(absPath, kind))) throw new Error("素材文件校验失败（下载内容损坏或非媒体文件），请重试下载已有任务，不要重新生成");
}

/** Persist an expiring provider URL or data URI under the project's uploads directory. */
export async function persistAssetSource(projectId: string, sourceUrl: string, shotId: number, prefix = "asset"): Promise<string> {
  if (!SAFE_ID.test(projectId)) throw new Error("无效的项目ID");
  if (sourceUrl.startsWith("/api/files/")) {
    const local = resolveUploadFilePath(sourceUrl);
    if (!local || !existsSync(local)) throw new Error("本地素材文件不存在");
    const actual = await assertLocalUploadPath(local);
    if (!(await validateMediaFile(actual, VIDEO_EXT.test(sourceUrl) ? "video" : "image"))) throw new Error("本地素材校验失败（原文件未修改）");
    return sourceUrl;
  }

  const directory = join(getDataDir(), "uploads", projectId);
  await mkdir(directory, { recursive: true });
  const safePrefix = prefix.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40) || "asset";
  const stem = `${safePrefix}-${shotId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const temporary = join(directory, `${stem}.download`);
  let mime = "image/jpeg";
  try {
    if (sourceUrl.startsWith("data:")) {
      if (sourceUrl.length > 48 * 1024 * 1024) throw new Error("内联素材超过上限");
      const comma = sourceUrl.indexOf(",");
      if (comma === -1) throw new Error("无法解析 data URI 素材");
      const meta = sourceUrl.slice(5, comma);
      mime = meta.split(";")[0] || "image/png";
      const payload = sourceUrl.slice(comma + 1);
      const bytes = /;base64/i.test(meta) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
      if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("素材体积超过上限");
      await writeFile(temporary, bytes, { flag: "wx" });
    } else if (/^https?:\/\//.test(sourceUrl)) {
      ({ mime } = await downloadMediaToFile(sourceUrl, temporary));
      if (mime === "application/octet-stream") {
        const path = new URL(sourceUrl).pathname;
        mime = /\.webm$/i.test(path) ? "video/webm" : /\.mov$/i.test(path) ? "video/quicktime" : /\.(mp4|m4v)$/i.test(path) ? "video/mp4" : /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : /\.gif$/i.test(path) ? "image/gif" : "image/jpeg";
      }
    } else throw new Error("不支持的素材来源");
    const ext = extensionForMime(mime);
    const fileName = `${stem}.${ext}`;
    const absolutePath = join(directory, fileName);
    // A verified final path is published only after the entire download and probe succeed.
    await assertValidMedia(temporary, ext);
    await rename(temporary, absolutePath);
    return `/api/files/${projectId}/${fileName}`;
  } finally { await unlink(temporary).catch(() => {}); }
}

export interface SaveAssetCandidateInput {
  projectId: string;
  shotId: number;
  filePath: string;
  type?: "ai_generated" | "product_image" | "user_upload" | "stock_footage";
  thumbnailPath?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  generationPlan?: GenerationControlSummary | null;
}

/** Insert a validated take and atomically make it the active composition input. */
export async function saveAssetCandidate(input: SaveAssetCandidateInput) {
  if (!SAFE_ID.test(input.projectId)) throw new Error("无效的项目ID");
  const db = getDb();
  let lastFrameUrl: string | undefined;
  if (VIDEO_EXT.test(input.filePath) && input.filePath.startsWith(`/api/files/${input.projectId}/`)) {
    const absolutePath = resolveUploadFilePath(input.filePath);
    if (!absolutePath || !existsSync(absolutePath)) throw new Error("本地素材文件不存在");
    const frame = await extractLastFrame(absolutePath);
    if (frame) lastFrameUrl = `${input.filePath}${LAST_FRAME_SUFFIX}`;
  }
  const generationPlan = input.generationPlan ? sanitizeGenerationControlSummary(input.generationPlan) : null;
  const rows = db.transaction((transaction) => {
    transaction.update(assets).set({ selected: false }).where(and(eq(assets.projectId, input.projectId), eq(assets.shotId, input.shotId))).run();
    return transaction.insert(assets).values({
      projectId: input.projectId,
      shotId: input.shotId,
      type: input.type ?? "ai_generated",
      filePath: input.filePath,
      ...(input.thumbnailPath?.startsWith("/api/files/") && { thumbnailPath: input.thumbnailPath }),
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      generationPlan,
      selected: true,
      status: "done",
    }).returning().all();
  });
  return { ...rows[0], ...(lastFrameUrl && { lastFrameUrl }) };
}
