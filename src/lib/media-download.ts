/** Bounded, backpressured downloads of expiring generation outputs. Never resubmit inference. */
import { open, mkdir, rename, unlink, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { safeFetch } from '@/lib/ssrf-guard'
import { limitMediaDownload } from '@/lib/media-concurrency'

export const MAX_GENERATED_MEDIA_BYTES = 512 * 1024 * 1024
export interface DownloadOptions {
  maxBytes?: number
  timeoutMs?: number
  kind?: 'image' | 'video' | 'audio'
}
class DownloadError extends Error {
  constructor(message: string, readonly retryable = false) { super(message) }
}

export async function downloadMediaToFile(url: string, destination: string, options: DownloadOptions = {}): Promise<{ bytes: number; mime: string }> {
  return limitMediaDownload(async () => {
    const maxBytes = options.maxBytes ?? MAX_GENERATED_MEDIA_BYTES
    await mkdir(dirname(destination), { recursive: true })
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 180000)
    for (let attempt = 0; ; attempt++) {
      const partial = `${destination}.${randomUUID()}.part`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      let response: Response | undefined
      try {
        deadline.throwIfAborted()
        response = await safeFetch(url, { signal: deadline })
        if (!response.ok) throw new DownloadError(`下载素材失败: HTTP ${response.status}；请重试下载现有任务，不要重新生成`, response.status === 408 || response.status === 429 || response.status >= 500)
        const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase()
        if (mime.includes('html') || mime.includes('json') || (options.kind && mime !== 'application/octet-stream' && !mime.startsWith(options.kind + '/'))) {
          throw new DownloadError('下载响应不是所需媒体类型')
        }
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadError(`素材体积超过 ${maxBytes} 字节上限`)
        if (!response.body) throw new DownloadError('下载响应无内容', true)
        handle = await open(partial, 'wx')
        const reader = response.body.getReader()
        let bytes = 0
        try {
          while (true) {
            deadline.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > maxBytes) throw new DownloadError(`素材体积超过 ${maxBytes} 字节上限`)
            // FileHandle.write may be partial; do not consume the next network chunk until written.
            let offset = 0
            while (offset < value.byteLength) {
              const written = await handle.write(value, offset, value.byteLength - offset)
              if (!written.bytesWritten) throw new DownloadError('媒体写入磁盘失败')
              offset += written.bytesWritten
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        // Fetch transparently decompresses HTTP bodies, so compressed Content-Length is not an output size.
        if (!bytes || (!response.headers.get('content-encoding') && declared > 0 && bytes !== declared)) throw new DownloadError('媒体下载不完整', true)
        await handle.sync()
        await handle.close(); handle = undefined
        await rename(partial, destination)
        return { bytes, mime }
      } catch (error) {
        await handle?.close().catch(() => {})
        await unlink(partial).catch(() => {})
        await response?.body?.cancel().catch(() => {})
        // Disk failures and policy violations are not network jitter.
        const diskError = error && typeof error === 'object' && 'code' in error && ['ENOSPC', 'EACCES', 'EROFS'].includes(String(error.code))
        if (attempt >= 2 || deadline.aborted || diskError || (error instanceof DownloadError && !error.retryable)) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.floor(Math.random() * 150)))
      }
    }
  })
}

/** For small image/audio consumers only. The network path remains bounded and retriable. */
export async function downloadMediaBuffer(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const destination = join(tmpdir(), `clipforge-media-${randomUUID()}`)
  try {
    await downloadMediaToFile(url, destination, { maxBytes: 64 * 1024 * 1024, ...options })
    return await readFile(destination)
  } finally { await unlink(destination).catch(() => {}) }
}
