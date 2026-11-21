import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixWav, install } from '../src/host/read-aloud.js'

// The shape DeepSeek streams: both lengths are 0xFFFFFFFF and the samples follow.
function streamedWav(samples) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(0xffffffff, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(0xffffffff, 40)
  return Buffer.concat([header, Buffer.alloc(samples * 2, 7)])
}

function runtime({ key = 'test-key', page } = {}) {
  const rt = {
    secretValue: name => (name === 'DEEPSEEK_API_KEY' ? key : undefined),
    ctx: { sessionController: { page: page ?? (async () => ({ records: [] })) } },
  }
  install(rt)
  return rt
}

// The voice service is the only thing a test cannot reach; it is answered from here.
function withVoice(wav, run) {
  const before = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return { ok: true, arrayBuffer: async () => Buffer.from(wav) } }
  return Promise.resolve(run(() => calls)).finally(() => { globalThis.fetch = before })
}

test('the streamed lengths are replaced with the real ones', () => {
  const fixed = fixWav(streamedWav(40))
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8)
  assert.equal(fixed.readUInt32LE(40), fixed.length - 44)
})

test('a short reply arrives in one piece and is cached for the next play', async () => {
  const wav = streamedWav(400)
  await withVoice(wav, async calls => {
    const rt = runtime()
    const first = await rt.readAloud({ text: 'Hello there.', voice: 'stella' })
    assert.equal(first.done, true)
    assert.equal(first.nextOffset, first.size)
    assert.equal(first.mime, 'audio/wav')
    assert.equal(Buffer.from(first.bytes, 'base64').length, wav.length)
    const again = await rt.readAloud({ text: 'Hello there.', voice: 'stella' })
    assert.equal(again.version, first.version)
    assert.equal(calls(), 1)
  })
})

test('a long reply is read in pieces a phone can take', async () => {
  const wav = streamedWav(300 * 1024)
  await withVoice(wav, async () => {
    const rt = runtime()
    const parts = []
    let offset = 0
    for (;;) {
      const part = await rt.readAloud({ text: 'A long reply.', voice: 'stella', offset })
      parts.push(Buffer.from(part.bytes, 'base64').length)
      if (part.done) break
      offset = part.nextOffset
    }
    assert.equal(parts.length, 2)
    assert.equal(parts[0], 512 * 1024)
    assert.equal(parts[0] + parts[1], wav.length)
  })
})

test('markdown is dropped before the voice reads it', async () => {
  await withVoice(streamedWav(40), async () => {
    const rt = runtime()
    const plain = await rt.readAloud({ text: 'Plain sentence.', voice: 'stella' })
    const marked = await rt.readAloud({ text: '## Plain **sentence**.', voice: 'stella' })
    assert.equal(marked.version, plain.version)
  })
})

test('a reply longer than the limit says it was cut', async () => {
  await withVoice(streamedWav(40), async () => {
    const rt = runtime()
    const part = await rt.readAloud({ text: 'word '.repeat(500), voice: 'stella' })
    assert.equal(part.truncated, true)
    assert.equal(part.chars, 2000)
  })
})

test('no key means a refusal that names the secret to add', async () => {
  const rt = runtime({ key: '' })
  await assert.rejects(() => rt.readAloud({ text: 'Hello.', voice: 'stella' }), error => {
    assert.equal(error.code, 'bot/refused')
    assert.match(error.message, /DEEPSEEK_API_KEY/)
    return true
  })
})

test('nothing to say is refused rather than sent', async () => {
  const rt = runtime()
  await assert.rejects(() => rt.readAloud({ text: '**', voice: 'stella' }), error => error.code === 'bot/invalid')
})

// The desktop client asks once per piece with the version it already has, so a long
// reply is not made twice.
test('a second piece of the same reply is not made again', async () => {
  const wav = streamedWav(300 * 1024)
  await withVoice(wav, async calls => {
    const rt = runtime()
    const first = await rt.readAloud({ text: 'A long reply.', voice: 'stella' })
    const second = await rt.readAloud({ version: first.version, offset: first.nextOffset, voice: 'stella' })
    assert.equal(second.version, first.version)
    assert.equal(second.done, true)
    assert.equal(calls(), 1)
  })
})

test('with no text the last reply of the chat is read', async () => {
  const page = async () => ({
    records: [
      { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The older answer.' }] } } } },
      { event: { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'A question.' }] } } } },
      { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The newest answer.' }] } } } },
    ],
  })
  await withVoice(streamedWav(40), async () => {
    const rt = runtime({ page })
    const spoken = await rt.readAloud({ sessionId: 's1', voice: 'stella' })
    assert.equal(spoken.chars, 'The newest answer.'.length)
  })
})

test('a chat with no reply is refused', async () => {
  const rt = runtime()
  await assert.rejects(() => rt.readAloud({ sessionId: 's1', voice: 'stella' }), error => error.code === 'bot/invalid')
})
