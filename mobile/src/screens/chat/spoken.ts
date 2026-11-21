// Which reply the phone says out loud (docs/plans/2026-11-21-read-aloud.md). A chat
// opens with a baseline: only a reply newer than everything already in it is spoken, so
// opening a chat — or coming back to one — never reads its history out loud.
export interface SpokenItem {
  kind?: string
  seq?: number
  text?: string
}

export function highestSeq(items: SpokenItem[]): number {
  let highest = 0
  for (const item of items) if (typeof item.seq === 'number' && item.seq > highest) highest = item.seq
  return highest
}

// The newest Bot reply that carries a sequence number, since the baseline is a sequence.
export function newestReply(items: SpokenItem[]): { seq: number; text: string } | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind !== 'bot' && item?.kind !== 'post') continue
    if (typeof item.seq !== 'number') continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    return { seq: item.seq, text: item.text }
  }
  return undefined
}
