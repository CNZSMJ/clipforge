/** Stream local assets to fal CDN v3. Signed PUTs never carry the inference API key. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import { getDataDir } from '@/lib/paths'
import { assertPublicUrl, safeFetch } from '@/lib/ssrf-guard'
import { createLimiter, limitMediaUpload } from '@/lib/media-concurrency'
import { ProviderError } from './base'

export const FAL_MULTIPART_THRESHOLD = 90 * 1024 * 1024
export const FAL_UPLOAD_PART_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const CACHE_TTL_MS = 15 * 60 * 1000 // substantially shorter than the requested 24h object lifetime
const cache = new Map<string, { url: string; expiresAt: number }>()
const inflight = new Map<string, Promise<string>>()
const limitFile = createLimiter(4)
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}
export function mediaMimeForPath(path: string): string { return MIME[extname(path).toLowerCase()] || 'application/octet-stream' }

/** Resolve symlinks as well as lexical traversal before reading/uploading any local file. */
export async function assertLocalUploadPath(filePath: string): Promise<string> {
  const [root, actual] = await Promise.all([realpath(join(getDataDir(), 'uploads')), realpath(filePath)])
  if (!actual.startsWith(root + sep)) throw new ProviderError('素材路径超出上传目录', 'INVALID_MEDIA_PATH', 'fal-ai')
  const info = await stat(actual)
  if (!info.isFile()) throw new ProviderError('素材不是普通文件', 'INVALID_MEDIA_PATH', 'fal-ai')
  return actual
}

function validateHttps(raw: unknown): string {
  if (typeof raw !== 'string') throw new ProviderError('fal 上传响应缺少地址', 'UPLOAD_FAILED', 'fal-ai')
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new ProviderError('fal 上传地址不安全', 'UPLOAD_FAILED', 'fal-ai')
  return url.href
}

async function retryStorage<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() } catch (error) {
      const status = error instanceof ProviderError ? error.statusCode : undefined
      if (attempt >= 2 || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) || (status && status !== 408 && status !== 429 && status < 500)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.floor(Math.random() * 150)))
    }
  }
}
async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    // Do not log the signed URL, the credential, or an unbounded upstream body.
    await response.body?.cancel().catch(() => {})
    throw new ProviderError(`fal 媒体上传失败: HTTP ${response.status}`, 'UPLOAD_FAILED', 'fal-ai', response.status)
  }
  return response
}

export async function uploadFalFile(filePath: string, apiKey: string): Promise<string> {
  const actual = await assertLocalUploadPath(filePath)
  const info = await stat(actual)
  if (!info.size || info.size > MAX_UPLOAD_BYTES) throw new ProviderError('参考素材为空或超过 512 MiB 上限', 'INVALID_MEDIA_SIZE', 'fal-ai')
  const fingerprint = `${actual}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const key = createHash('sha256').update(`${apiKey}\0${fingerprint}`).digest('hex')
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const pending = inflight.get(key)
  if (pending) return pending
  const job = limitFile(async () => {
    // Timeout encompasses queueing of multipart chunks, upload retries and finalization.
    const cancelled = new AbortController()
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(5 * 60 * 1000)])
    const mime = mediaMimeForPath(actual)
    const multipart = info.size > FAL_MULTIPART_THRESHOLD
    const initiation = await limitMediaUpload(() => retryStorage(async () => {
      const response = await checked(await fetch(
        `https://rest.alpha.fal.ai/storage/upload/${multipart ? 'initiate-multipart' : 'initiate'}?storage_type=fal-cdn-v3`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json',
            'X-Fal-Object-Lifecycle': JSON.stringify({ expiration_duration_seconds: 86400 }) },
          body: JSON.stringify({ content_type: mime, file_name: basename(actual) }),
        }))
      return await response.json() as { upload_url?: unknown; file_url?: unknown }
    }))
    const uploadUrl = validateHttps(initiation.upload_url)
    const fileUrl = validateHttps(initiation.file_url)
    await assertPublicUrl(fileUrl)
    const uploadPart = (url: string, start: number, end: number, partNumber?: number) => limitMediaUpload(() => retryStorage(async () => {
      signal.throwIfAborted()
      const stream = createReadStream(actual, { start, end })
      try {
        const response = await checked(await safeFetch(url, {
          method: 'PUT', body: stream as unknown as BodyInit, duplex: 'half',
          headers: { 'Content-Type': mime, 'Content-Length': String(end - start + 1) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        } as RequestInit & { duplex: 'half' }, 0))
        if (partNumber === undefined) { await response.body?.cancel().catch(() => {}); return undefined }
        const part = await response.json() as { partNumber?: number; etag?: string }
        if (part.partNumber !== partNumber || typeof part.etag !== 'string' || !part.etag) {
          throw new ProviderError('fal 分片上传回执无效', 'UPLOAD_FAILED', 'fal-ai')
        }
        return { partNumber, etag: part.etag }
      } finally { stream.destroy() }
    }))
    if (multipart) {
      const parsed = new URL(uploadUrl)
      const uploads = Array.from({ length: Math.ceil(info.size / FAL_UPLOAD_PART_BYTES) }, (_, i) => {
        const number = i + 1
        return uploadPart(`${parsed.origin}${parsed.pathname}/${number}${parsed.search}`,
          i * FAL_UPLOAD_PART_BYTES, Math.min((i + 1) * FAL_UPLOAD_PART_BYTES, info.size) - 1, number)
      })
      let parts: Awaited<ReturnType<typeof uploadPart>>[]
      try { parts = await Promise.all(uploads) } catch (error) {
        cancelled.abort()
        await Promise.allSettled(uploads)
        throw error
      }
      // Finalization is not assumed idempotent. On a lost response this upload attempt fails;
      // retrying the user operation may upload again, but cannot submit a duplicate inference.
      const response = await limitMediaUpload(() => safeFetch(`${parsed.origin}${parsed.pathname}/complete${parsed.search}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      }, 0).then(checked))
      await response.body?.cancel().catch(() => {})
    } else await uploadPart(uploadUrl, 0, info.size - 1)
    const after = await stat(actual)
    if (`${actual}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== fingerprint) {
      throw new ProviderError('素材在上传过程中发生变化，请重新选择素材', 'MEDIA_CHANGED', 'fal-ai')
    }
    for (const [id, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(id)
    while (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, { url: fileUrl, expiresAt: Date.now() + CACHE_TTL_MS })
    return fileUrl
  }).finally(() => { inflight.delete(key) })
  inflight.set(key, job)
  return job
}
