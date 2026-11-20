import assert from 'node:assert/strict'
import test from 'node:test'
import { base64Of, fileSizeText, stageFile, UPLOAD_CHUNK_BYTES } from './send-files.ts'

const asReader = (bytes: Uint8Array) => {
  let at = 0
  return {
    size: bytes.length,
    read: async (length: number) => {
      const part = bytes.subarray(at, Math.min(at + length, bytes.length))
      at += part.length
      return part
    },
  }
}

test('base64Of matches what Buffer writes, for every remainder', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'hello from the phone']) {
    assert.equal(base64Of(new TextEncoder().encode(text)), Buffer.from(text).toString('base64'))
  }
  const wide = new Uint8Array(3001).map((_, index) => index % 251)
  assert.equal(base64Of(wide), Buffer.from(wide).toString('base64'))
})

test('stageFile sends a file piece by piece, each piece saying where it belongs', async () => {
  const size = UPLOAD_CHUNK_BYTES * 2 + 700
  const bytes = new Uint8Array(size).map((_, index) => index % 253)
  const calls: { endpoint: string; payload: Record<string, unknown> }[] = []
  const call = async (endpoint: string, payload: object) => {
    const fields = payload as { offset?: number, data?: string }
    calls.push({ endpoint, payload: fields })
    if (endpoint === 'stage-file-chunk') {
      return { id: 'upload-1', nextOffset: Number(fields.offset) + Buffer.from(String(fields.data), 'base64').length }
    }
    return { id: 'file-1', name: 'plan.zip', bytes: size, path: 'C:\\Users\\me\\Downloads\\plan.zip' }
  }
  const staged = await stageFile(call, 'plan.zip', asReader(bytes))
  // The host says where the file landed, so the message can name that path.
  assert.deepEqual(staged, { id: 'file-1', path: 'C:\\Users\\me\\Downloads\\plan.zip' })
  const chunks = calls.filter(entry => entry.endpoint === 'stage-file-chunk')
  assert.equal(chunks.length, 3)
  // The first piece names the file; the rest carry the upload id.
  assert.equal(chunks[0].payload.name, 'plan.zip')
  assert.equal(chunks[0].payload.id, undefined)
  assert.equal(chunks[1].payload.id, 'upload-1')
  assert.deepEqual(chunks.map(entry => entry.payload.offset), [0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2])
  // Every byte arrives, in order.
  const sent = Buffer.concat(chunks.map(entry => Buffer.from(String(entry.payload.data), 'base64')))
  assert.equal(sent.length, size)
  assert.deepEqual(new Uint8Array(sent), bytes)
  assert.deepEqual(calls.map(entry => entry.endpoint), ['stage-file-chunk', 'stage-file-chunk', 'stage-file-chunk', 'stage-file-end'])
})

test('stageFile refuses an empty file instead of opening an upload for it', async () => {
  let called = 0
  await assert.rejects(
    stageFile(async () => { called += 1; return {} }, 'empty.txt', asReader(new Uint8Array(0))),
    /empty/,
  )
  assert.equal(called, 0)
})

test('fileSizeText reads bytes, kilobytes and megabytes', () => {
  assert.equal(fileSizeText(0), '0 B')
  assert.equal(fileSizeText(999), '999 B')
  assert.equal(fileSizeText(2048), '2 KB')
  assert.equal(fileSizeText(12.4 * 1024 * 1024), '12.4 MB')
  assert.equal(fileSizeText(Number.NaN), '')
})
