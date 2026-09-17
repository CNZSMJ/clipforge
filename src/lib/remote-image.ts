import { readFile } from "fs/promises";
import { join, sep } from "path";
import { getDataDir } from "@/lib/paths";

/** Provider capability needed to stage a local file on its own CDN. */
export interface LocalMediaUploader {
  uploadLocalMedia?: (filePath: string) => Promise<string>;
}

/** local file path → already-uploaded CDN URL, so one product image is staged once per process. */
const uploadedUrlCache = new Map<string, string>();

/**
 * Resolve a local `/api/files/{relative-path}` reference to a safe absolute path inside the uploads directory.
 *
 * Security note: `m[1]` comes from the request body and is attacker-controlled. A value containing `../` could
 * let join escape the uploads directory, reading arbitrary files (which toRemoteUsableImage would then base64-encode
 * and leak to a remote provider configured by the attacker).
 * join already normalises `..`; we then verify the result still lives inside uploads — any escape returns null (rejected).
 *
 * Pure function, easy to unit-test (no disk access). Returns a safe absolute path, or null (non-/api/files path or path traversal).
 */
export function resolveUploadFilePath(ref: string): string | null {
  const m = ref.match(/\/api\/files\/(.+)/);
  if (!m) return null;
  const uploadsRoot = join(getDataDir(), "uploads");
  const filePath = join(uploadsRoot, m[1]);
  if (filePath !== uploadsRoot && !filePath.startsWith(uploadsRoot + sep)) return null; // path traversal detected, reject
  return filePath;
}

/**
 * Turn a local `/api/files/...` reference into something the provider can actually fetch.
 *
 * fal's docs are explicit that file inputs are URLs and that data URIs "inflate the request size
 * significantly ... not recommended for files larger than a few KB" — passing product photos as
 * base64 is also what kept blowing past request-body limits. Providers that expose
 * `uploadLocalMedia` (fal CDN, Atlas) therefore get a real URL; the rest keep the data URI they
 * require.
 */
export async function toProviderImage(
  ref: string | undefined,
  provider: LocalMediaUploader | undefined
): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
  const filePath = resolveUploadFilePath(ref);
  if (!filePath) return ref;
  if (!provider?.uploadLocalMedia) return toRemoteUsableImage(ref);
  const cached = uploadedUrlCache.get(filePath);
  if (cached) return cached;
  try {
    const url = await provider.uploadLocalMedia(filePath);
    uploadedUrlCache.set(filePath, url);
    return url;
  } catch {
    // staging is an optimisation, never a hard requirement — fall back to the inline form
    return toRemoteUsableImage(ref);
  }
}

/**
 * Convert a local `/api/files` path to a base64 data URI (remote providers cannot access localhost and require a data URI or public URL).
 * http(s) URLs and data URIs are passed through unchanged; non-local paths or path-traversal attempts return ref as-is (no disk read).
 */
export async function toRemoteUsableImage(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
  const filePath = resolveUploadFilePath(ref);
  if (!filePath) return ref; // not an /api/files path or path traversal — skip disk read, return as-is
  try {
    const buf = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return ref;
  }
}
