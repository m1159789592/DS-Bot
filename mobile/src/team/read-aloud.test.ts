import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audioName, collectAudio, spokenText } from './read-aloud.ts'

// The host answers `read-aloud` exactly as it answers a file: base64 pieces.
function host(pieces: string[][], extra: object = {}) {
  const asked: { endpoint: string; payload: any }[] = []
  const starts: number[] = []
  let seen = 0
  for (const piece of pieces) { starts.push(seen); seen += piece.join('').length }
  const call = async (endpoint: string, payload: any) => {
    asked.push({ endpoint, payload })
    const index = Math.max(0, starts.indexOf(payload.offset))
    const joined = (pieces[index] ?? []).join('')
    return { bytes: Buffer.from(joined).toString('base64'), nextOffset: payload.offset + joined.length, done: index === pieces.length - 1, version: 'v1', ...extra }
  }
  return { call, asked }
}

test('the same reply and voice name the same file', () => {
  assert.equal(audioName('Hello.', 'stella'), audioName('Hello.', 'stella'))
})

test('a different reply or voice names another file', () => {
  assert.notEqual(audioName('Hello.', 'stella'), audioName('Hello!', 'stella'))
  assert.notEqual(audioName('Hello.', 'stella'), audioName('Hello.', 'tide'))
  assert.match(audioName('Hello.', 'tide'), /\.wav$/)
})

test('the pieces are joined in order', async () => {
  const { call } = host([['abc'], ['de'], ['f']])
  const { data, truncated } = await collectAudio(call as any, 'Hello.', 'stella')
  assert.equal(Buffer.from(data).toString(), 'abcdef')
  assert.equal(truncated, false)
})

test('the text and voice travel with every piece', async () => {
  const { call, asked } = host([['abc'], ['de']])
  await collectAudio(call as any, 'Hello.', 'tide')
  assert.equal(asked.length, 2)
  for (const { endpoint, payload } of asked) {
    assert.equal(endpoint, 'read-aloud')
    assert.equal(payload.text, 'Hello.')
    assert.equal(payload.voice, 'tide')
  }
  assert.deepEqual(asked.map(entry => entry.payload.offset), [0, 3])
})

test('a cut reply is reported', async () => {
  const { call } = host([['abc']], { truncated: true })
  assert.equal((await collectAudio(call as any, 'Hello.', 'stella')).truncated, true)
})

test('spacing is squeezed before the text is compared', () => {
  assert.equal(spokenText('  a\n\n b  '), 'a b')
})
