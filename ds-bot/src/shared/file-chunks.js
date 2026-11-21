// A bounded response fits the encrypted link; consumers write each chunk before asking for more.
/**
 * @param {(endpoint: string, payload: object) => Promise<any>} call
 * @param {object} target
 * @param {string} [endpoint] another endpoint answering in the same chunks, such as `read-aloud`
 * @param {{ lookahead?: number, onProgress?: (done: number, size?: number) => void }} [options]
 */
export async function* fileChunks(call, target, endpoint = 'file-download', options = {}) {
  const lookahead = Math.max(1, Number(options.lookahead) || 1)
  const report = options.onProgress
  const ask = (offset, version) => call(endpoint, { ...target, offset, ...(version === undefined ? {} : { version }) })
  const decode = part => Uint8Array.from(atob(part.bytes), char => char.charCodeAt(0))
  const stale = () => new Error('This file is no longer available')

  const first = await ask(0)
  const head = decode(first)
  // Older hosts return one whole file without chunk metadata.
  if (first.nextOffset === undefined) {
    report?.(head.length, head.length)
    yield { ...first, data: head }
    return
  }
  if (first.nextOffset !== head.length || (first.done !== true && head.length === 0)) throw stale()
  const version = first.version
  const step = head.length
  const size = Number.isFinite(first.size) ? first.size : undefined
  report?.(first.nextOffset, size)
  yield { ...first, data: head }
  if (first.done === true) return

  const take = (part, offset) => {
    const bytes = decode(part)
    if (part.version !== version) throw stale()
    if (part.nextOffset !== offset + bytes.length || (part.done !== true && bytes.length === 0)) throw stale()
    return { ...part, data: bytes }
  }

  // Without a size the next offset is the only thing that says where to ask.
  if (size === undefined || step === 0) {
    let offset = first.nextOffset
    for (;;) {
      const part = take(await ask(offset, version), offset)
      report?.(part.nextOffset)
      yield part
      if (part.done === true) return
      offset = part.nextOffset
    }
  }

  // Asking one piece at a time waits a whole round trip for every piece. The size and
  // the version are known now, so a few pieces travel at once and keep their order.
  const queue = []
  for (let at = first.nextOffset; at < size; at += step) queue.push(at)
  const running = new Map()
  const fill = () => {
    while (running.size < lookahead && queue.length > 0) {
      const at = queue.shift()
      running.set(at, ask(at, version))
    }
  }
  fill()
  let offset = first.nextOffset
  for (;;) {
    const waiting = running.get(offset)
    if (waiting === undefined) throw stale()
    const part = take(await waiting, offset)
    running.delete(offset)
    fill()
    report?.(part.nextOffset, size)
    yield part
    if (part.done === true) return
    offset = part.nextOffset
  }
}
