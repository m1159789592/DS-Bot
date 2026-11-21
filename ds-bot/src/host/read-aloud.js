// Reading a reply out loud for the phone (docs/plans/2026-11-21-read-aloud.md).
// The voice is DeepSeek's TTS endpoint, called from here so the key never leaves the
// computer; the audio comes back in the same chunks a file download uses, because one
// encrypted message carries 4 MB and a long reply is larger than that.
import { createHash } from 'node:crypto'
import { HANDOFF_ACK, HISTORY_TIMEOUT_MS } from './constants.js'
import { textOf } from './text.js'

const TTS_URL = 'https://api.deepseek.com/v1/tools/tts'
// The key is a secret the user added to DS Bot. DSH's own credential store is not read.
const KEY_SECRET = 'DEEPSEEK_API_KEY'
const CHUNK_BYTES = 512 * 1024
const MAX_CHARS = 2000
// How many spoken replies stay in memory, by text and voice, so a replay is free.
const KEPT = 3
const TIMEOUT_MS = 60_000
const VOICES = ['stella', 'tide']

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

// The voice should say the sentence, not the punctuation that draws it.
function speechText(raw) {
  return String(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The streamed WAV writes 0xFFFFFFFF into both lengths; a player that trusts the header
// reads a zero length file and refuses it.
export function fixWav(buffer) {
  if (buffer.length < 44) return buffer
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return buffer
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      buffer.writeUInt32LE(Math.max(0, buffer.length - offset - 8), offset + 4)
      buffer.writeUInt32LE(buffer.length - 8, 4)
      return buffer
    }
    if (size === 0xffffffff) break
    offset += 8 + size + (size % 2)
  }
  return buffer
}

export function install(rt) {
  const { ctx } = rt
  // Newest first: a Map keeps insertion order, so the first key is the oldest.
  const spoken = new Map()

  // The reply a chat would read: the last message its Bot wrote there. A fresh part opens
  // with a fixed note that is not the Bot speaking, so that one is skipped.
  async function lastReply(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const page = await ctx.sessionController.page(
      { address: { kind: 'session', sessionId }, maxMessages: 80 },
      AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    )
    for (let index = page.records.length - 1; index >= 0; index -= 1) {
      const event = page.records[index]?.event
      if (event?.type !== 'assistant/message') continue
      const text = textOf(event.data?.message?.content)
      if (text !== '' && text !== HANDOFF_ACK) return text
    }
    return ''
  }

  async function synthesize(text, voice, key) {
    let upstream
    try {
      upstream = await fetch(TTS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voice, format: 'wav' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (failure) {
      throw refused(`The voice service is unreachable: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      throw refused(`The voice service answered ${upstream.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`)
    }
    return fixWav(Buffer.from(await upstream.arrayBuffer()))
  }

  // One reply at a time, in pieces: the phone asks again with the offset it reached,
  // and the desktop client asks with the version it already has.
  async function readAloud(body) {
    const voice = VOICES.includes(body?.voice) ? body.voice : VOICES[0]
    const offset = body?.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid audio offset'), { code: 'bot/invalid' })

    let version = typeof body?.version === 'string' ? body.version : undefined
    let made = version === undefined ? undefined : spoken.get(version)
    if (made === undefined) {
      const raw = speechText(body?.text ?? await lastReply(body?.sessionId))
      const full = Array.from(raw)
      const text = full.slice(0, MAX_CHARS).join('')
      if (text === '') throw Object.assign(new Error('Nothing to read'), { code: 'bot/invalid' })
      version = createHash('sha256').update(voice).update('\u0000').update(text).digest('hex').slice(0, 24)
      made = spoken.get(version)
      if (made === undefined) {
        const key = rt.secretValue?.(KEY_SECRET) ?? process.env[KEY_SECRET]
        if (typeof key !== 'string' || key === '') {
          throw refused(`Add a secret named ${KEY_SECRET} in Settings → Secrets to read replies aloud`)
        }
        made = { audio: await synthesize(text, voice, key), chars: text.length, truncated: full.length > MAX_CHARS }
        spoken.set(version, made)
        while (spoken.size > KEPT) spoken.delete(spoken.keys().next().value)
      }
    } else {
      // Reinsert so the reply that is being replayed is the last to go.
      spoken.delete(version)
      spoken.set(version, made)
    }

    const audio = made.audio
    if (offset > audio.length) throw Object.assign(new Error('This audio is no longer available'), { code: 'bot/stale' })
    const slice = audio.subarray(offset, offset + CHUNK_BYTES)
    const nextOffset = offset + slice.length
    return {
      voice,
      mime: 'audio/wav',
      version,
      size: audio.length,
      bytes: slice.toString('base64'),
      nextOffset,
      done: nextOffset >= audio.length,
      chars: made.chars,
      truncated: made.truncated,
    }
  }

  Object.assign(rt, { readAloud })
}
