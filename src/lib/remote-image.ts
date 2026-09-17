import { readFile, stat } from 'fs/promises'
import { join, sep } from 'path'
import { getDataDir } from '@/lib/paths'
import { assertLocalUploadPath, mediaMimeForPath } from '@/lib/providers/fal-storage'

export interface LocalMediaUploader {
  uploadLocalMedia?: (filePath: string) => Promise<string>
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Resolve only this app's relative route, or an explicit loopback absolute URL.
 * Decode once; reject encoded separators, traversal, NUL and Windows backslash escapes.
 */
export function resolveUploadFilePath(ref: string): string | null {
  let path = ref
  if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref)
      if (!LOCAL_HOSTS.has(url.hostname) || url.username || url.password) return null
      // Preserve the raw pathname: URL.pathname normalizes ../ before we can reject it.
      path = ref.replace(/^https?:\/\/[^/]+/i, '')
    } catch { return null }
  }
  path = path.split(/[?#]/)[0]
  if (!path.startsWith('/api/files/')) return null
  let relative = path.slice('/api/files/'.length)
  if (/%2f|%5c/i.test(relative)) return null
  try { relative = decodeURIComponent(relative) } catch { return null }
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((s) => s === '.' || s === '..')) return null
  const root = join(getDataDir(), 'uploads')
  const filePath = join(root, relative)
  return filePath.startsWith(root + sep) ? filePath : null
}

/** Staging failure is a PRE-SUBMIT error, never a silent data URI/local-URL fallback. */
export async function toProviderImage(ref: string | undefined, provider: LocalMediaUploader | undefined): Promise<string | undefined> {
  if (!ref) return undefined
  if (typeof ref !== 'string') throw new Error('素材引用必须是字符串')
  const filePath = resolveUploadFilePath(ref)
  if (filePath) {
    if (!provider?.uploadLocalMedia) return toRemoteUsableImage(ref)
    // Uploaders own credential-scoped, fingerprinted caching and single-flight behavior.
    const url = await provider.uploadLocalMedia(filePath)
    if (!/^https?:\/\//i.test(url)) throw new Error('上传完成后未返回有效媒体 URL')
    return url
  }
  if (ref.startsWith('/api/files/') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/i.test(ref)) throw new Error('本地素材路径无效或不可供远程模型访问')
  if (/^https?:\/\//i.test(ref)) {
    const url = new URL(ref)
    if (url.username || url.password) throw new Error('素材 URL 不得携带用户名或密码')
    return ref
  }
  if (ref.startsWith('data:')) {
    // Small explicit inline inputs remain supported by fal; never inline videos or huge photos.
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(ref) || ref.length > 8 * 1024 * 1024) throw new Error('内联素材过大或不是图片，请先上传为本地素材')
    return ref
  }
  throw new Error('素材必须使用 /api/files 路径、公开 URL 或小尺寸图片 data URI')
}

/** Legacy adapters without CDN support still need small inline images. */
export async function toRemoteUsableImage(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined
  const filePath = resolveUploadFilePath(ref)
  if (!filePath) return ref
  const actual = await assertLocalUploadPath(filePath)
  if ((await stat(actual)).size > 8 * 1024 * 1024) throw new Error('内联图片超过上限，请使用支持 CDN 上传的平台')
  const bytes = await readFile(actual)
  if (bytes.length > 8 * 1024 * 1024 || !mediaMimeForPath(actual).startsWith('image/')) throw new Error('内联图片超过上限或媒体类型不受支持')
  return `data:${mediaMimeForPath(actual)};base64,${bytes.toString('base64')}`
}
