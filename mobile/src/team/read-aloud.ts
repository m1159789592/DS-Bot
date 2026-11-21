// Reading a reply out loud (docs/plans/2026-11-21-read-aloud.md). The voice is made on
// the computer and arrives in the same pieces a downloaded file does; this file joins
// them and names the cached result, so it needs no Expo and can be tested in Node.
import { fileChunks } from '../../../ds-bot/src/shared/file-chunks.js'

export type Call = (endpoint: string, payload: object) => Promise<any>
export type Voice = 'stella' | 'tide'

// A short stable hash, only used to name a cache file: two replies that differ must land
// on different names, and the same reply must land on the same one.
function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(16).padStart(8, '0')
}

export function audioName(text: string, voice: Voice): string {
  return `${fingerprint(text)}-${text.length}-${voice}.wav`
}

export function spokenText(raw: string): string {
  return String(raw).replace(/\s+/g, ' ').trim()
}

export async function collectAudio(call: Call, text: string, voice: Voice): Promise<{ data: Uint8Array; truncated: boolean }> {
  const pieces: Uint8Array[] = []
  let total = 0
  let truncated = false
  for await (const part of fileChunks(call, { text, voice }, 'read-aloud')) {
    if (part.truncated === true) truncated = true
    pieces.push(part.data)
    total += part.data.length
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const piece of pieces) { data.set(piece, offset); offset += piece.length }
  return { data, truncated }
}
