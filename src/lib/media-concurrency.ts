/** Process-wide backpressure: reference packs from concurrent shots share a finite I/O budget. */
export function createLimiter(concurrency: number, maxQueued = 256) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('Invalid media concurrency limit')
  let active = 0
  const waiting: Array<() => void> = []
  return async function limit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (waiting.length >= maxQueued) throw new Error('媒体传输队列已满，请重试传输；不要重复提交生成任务')
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else active++
    try { return await work() } finally {
      const next = waiting.shift()
      if (next) next() // transfer the occupied slot to the oldest waiter
      else active--
    }
  }
}
export const limitMediaUpload = createLimiter(4)
export const limitMediaDownload = createLimiter(4)
