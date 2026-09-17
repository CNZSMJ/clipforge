/** fal queue transport. A saved task handle is sufficient to resume in a new process.
 * No inference POST is retried: losing a response does not mean it was not billed.
 */
import { createHash } from 'node:crypto'
import { ProviderError } from './base'
import type { ProviderConfig } from './types'

export type FalPayload = Record<string, unknown>
export interface FalTaskHandle {
  modelId: string
  requestId: string
  statusUrl: string
  responseUrl: string
}
const DEFAULT_BASE = 'https://queue.fal.run'
const inflightReads = new Map<string, Promise<FalPayload>>()
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function falQueueAppPath(modelId: string): string {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(modelId) || modelId.split('/').some((s) => s === '.' || s === '..')) {
    throw new ProviderError('无效的 fal 模型 ID', 'INVALID_MODEL', 'fal-ai')
  }
  const segments = modelId.split('/')
  return segments.slice(0, segments[0] === 'workflows' || segments[0] === 'comfy' ? 3 : 2).join('/')
}

/** Credentials may only go to the explicitly configured gateway or fal's queue, never a CDN. */
export function trustedFalQueueUrl(raw: string, baseUrl = DEFAULT_BASE): string {
  const base = new URL(baseUrl)
  const url = new URL(raw, `${baseUrl.replace(/\/$/, '')}/`)
  if (url.username || url.password || url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.origin !== base.origin && url.origin !== DEFAULT_BASE)) {
    throw new ProviderError('fal 返回了不可信的队列地址，已阻止发送 API Key', 'UNTRUSTED_QUEUE_URL', 'fal-ai')
  }
  return url.href
}

export function encodeFalTask(modelId: string, payload: FalPayload, baseUrl = DEFAULT_BASE): string {
  falQueueAppPath(modelId)
  const requestId = payload.request_id
  if (typeof requestId !== 'string' || !/^[\w-]+$/.test(requestId)) {
    throw new ProviderError('fal 未返回有效 request_id；提交状态未知，请先核查平台任务，勿重复付费提交', 'SUBMISSION_UNKNOWN', 'fal-ai')
  }
  const urls: Record<string, string> = {}
  // Ignore malformed optional pointers rather than losing an already-created paid task.
  // They will be derived safely below; an untrusted URL can never receive credentials.
  for (const key of ['status_url', 'response_url'] as const) {
    if (typeof payload[key] === 'string') {
      try { urls[key] = trustedFalQueueUrl(payload[key], baseUrl) } catch { /* use safe app URL */ }
    }
  }
  const suffix = Object.keys(urls).length ? `::${Buffer.from(JSON.stringify(urls)).toString('base64url')}` : ''
  return `${modelId}::${requestId}${suffix}`
}

export function decodeFalTask(taskId: string, baseUrl = DEFAULT_BASE): FalTaskHandle {
  if (typeof taskId !== 'string' || taskId.length > 16000) throw new ProviderError('无效的任务 ID', 'INVALID_TASK_ID', 'fal-ai')
  const [modelId, requestId, encoded, ...rest] = taskId.split('::')
  if (!requestId || !/^[\w-]+$/.test(requestId) || rest.length) throw new ProviderError('无效的任务 ID', 'INVALID_TASK_ID', 'fal-ai')
  const root = `${baseUrl.replace(/\/$/, '')}/${falQueueAppPath(modelId)}/requests/${requestId}`
  let urls: Record<string, unknown> = {}
  if (encoded) {
    try {
      urls = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      if (!urls || typeof urls !== 'object' || Array.isArray(urls)) throw new Error('object required')
    } catch { throw new ProviderError('任务地址元数据损坏', 'INVALID_TASK_ID', 'fal-ai') }
  }
  return {
    modelId, requestId,
    statusUrl: trustedFalQueueUrl(typeof urls.status_url === 'string' ? urls.status_url : `${root}/status`, baseUrl),
    responseUrl: trustedFalQueueUrl(typeof urls.response_url === 'string' ? urls.response_url : root, baseUrl),
  }
}

export function falErrorMessage(payload: FalPayload): string | undefined {
  const value = payload.error ?? payload.detail
  if (value == null || value === '') return undefined
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 2000)
}

async function requestJson(url: string, config: ProviderConfig, body?: FalPayload): Promise<FalPayload> {
  const method = body === undefined ? 'GET' : 'POST'
  const target = trustedFalQueueUrl(url, config.baseUrl || DEFAULT_BASE)
  const attempts = method === 'GET' ? 3 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    let retryAfter = 0
    try {
      const response = await fetch(target, {
        method, redirect: 'error',
        headers: { ...config.headers, 'Content-Type': 'application/json', Authorization: `Key ${config.apiKey}` },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(config.timeout ?? 30000),
      })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 2000)
        retryAfter = Math.min(10000, Math.max(0, Number(response.headers.get('retry-after')) * 1000 || 0))
        throw new ProviderError(`fal ${method} 请求失败: ${response.status} ${text}`, 'API_ERROR', 'fal-ai', response.status)
      }
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('fal 返回非对象响应', 'INVALID_RESPONSE', 'fal-ai')
      return value as FalPayload
    } catch (error) {
      const retryable = !(error instanceof ProviderError) || !error.statusCode || error.statusCode === 429 || error.statusCode >= 500
      if (method === 'POST') {
        if (error instanceof ProviderError && error.statusCode && error.statusCode < 500) throw error
        throw new ProviderError('fal 提交响应丢失或超时，任务可能已计费；不会自动重复提交，请核查平台任务', 'SUBMISSION_UNKNOWN', 'fal-ai')
      }
      if (!retryable || attempt === attempts - 1) throw error
      await sleep(retryAfter || 300 * 2 ** attempt + Math.floor(Math.random() * 150))
    }
  }
  throw new ProviderError('fal 请求未完成', 'NETWORK_ERROR', 'fal-ai')
}

export async function submitFalTask(config: ProviderConfig, modelId: string, body: FalPayload): Promise<string> {
  falQueueAppPath(modelId)
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/$/, '')
  return encodeFalTask(modelId, await requestJson(`${base}/${modelId}`, config, body), base)
}

/** Coalesce simultaneous UI/server reads, scoped by gateway and credentials (never across accounts). */
function getJson(url: string, config: ProviderConfig): Promise<FalPayload> {
  const key = createHash('sha256').update(JSON.stringify([url, config.apiKey, config.headers])).digest('hex')
  const pending = inflightReads.get(key)
  if (pending) return pending
  const promise = requestJson(url, config).finally(() => { inflightReads.delete(key) })
  inflightReads.set(key, promise)
  return promise
}

export async function readFalTask(config: ProviderConfig, taskId: string): Promise<{
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  modelId: string
  progress?: number
  error?: string
  data?: FalPayload
}> {
  const handle = decodeFalTask(taskId, config.baseUrl || DEFAULT_BASE)
  const status = await getJson(handle.statusUrl, config)
  const state = String(status.status || '').toUpperCase()
  const error = falErrorMessage(status)
  const base = { modelId: handle.modelId, ...(typeof status.progress === 'number' && { progress: status.progress }) }
  if (['CANCELLED', 'CANCELED'].includes(state)) return { ...base, status: 'cancelled', error: error || '任务已取消' }
  if (['FAILED', 'ERROR'].includes(state) || (state === 'COMPLETED' && error)) return { ...base, status: 'failed', error: error || 'fal 任务失败' }
  if (state === 'IN_QUEUE') return { ...base, status: 'pending' }
  if (state === 'IN_PROGRESS') return { ...base, status: 'processing' }
  if (state !== 'COMPLETED') throw new ProviderError(`未知 fal 任务状态: ${state}`, 'STATUS_UNKNOWN', 'fal-ai')
  // The current status response may refresh the pointer. Never try guessed endpoints before it.
  const resultUrl = typeof status.response_url === 'string'
    ? trustedFalQueueUrl(status.response_url, config.baseUrl || DEFAULT_BASE) : handle.responseUrl
  try {
    const data = await getJson(resultUrl, config)
    const resultError = falErrorMessage(data)
    return resultError ? { ...base, status: 'failed', error: resultError } : { ...base, status: 'completed', data }
  } catch (error) {
    // Validation/rejection is terminal. Authentication/expiry/transport errors stay recoverable:
    // a retry must retrieve this task, never create another paid generation.
    if (error instanceof ProviderError && [400, 422].includes(error.statusCode ?? 0)) {
      return { ...base, status: 'failed', error: error.message }
    }
    if (error instanceof ProviderError) error.taskId = taskId
    throw error
  }
}
