// A document the phone sends, in pieces: one encrypted message carries a few MB, so
// the file is read a slice at a time and the host puts it back together.
export interface PickedFile { name: string; uri: string; size: number }

// Bytes the phone hands to one request. Base64 makes it about a third larger, which
// still leaves the message well inside what the link carries.
export const UPLOAD_CHUNK_BYTES = 1024 * 1024

// The host holds the whole file in memory once, so it stops at this; the phone turns a
// larger file away first, where the size is already known.
export const FILE_MAX_BYTES = 100 * 1024 * 1024

export interface ChunkReader {
  size: number
  // The next `length` bytes, from wherever the previous read stopped.
  read(length: number): Promise<Uint8Array>
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Base64 of raw bytes. React Native has no Buffer, and `btoa` cannot take a whole
// megabyte at once, so the encoder is here and stays a plain function.
export function base64Of(bytes: Uint8Array): string {
  let out = ''
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  const rest = bytes.length - index
  if (rest === 1) {
    const n = bytes[index] << 16
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}==`
  } else if (rest === 2) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8)
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`
  }
  return out
}

// Reads a file to its end and hands the host the id of the staged copy, and the path it
// was written to on the computer. Each piece says where it belongs, so the host refuses
// one that went missing on the way.
export async function stageFile(
  call: (endpoint: string, payload: object) => Promise<unknown>,
  name: string,
  reader: ChunkReader,
): Promise<{ id: string, path: string }> {
  let sent = 0
  let id: string | undefined
  while (sent < reader.size) {
    const bytes = await reader.read(Math.min(UPLOAD_CHUNK_BYTES, reader.size - sent))
    if (bytes.length === 0) throw new Error('The file ended before it said it would')
    const part = await call('stage-file-chunk', {
      ...(id === undefined ? { name } : { id }),
      offset: sent,
      data: base64Of(bytes),
    }) as { id: string, nextOffset: number }
    id = part.id
    sent += bytes.length
  }
  if (id === undefined) throw new Error('This file is empty')
  const staged = await call('stage-file-end', { id }) as { id: string, path?: string }
  return { id: String(staged.id), path: typeof staged.path === 'string' ? staged.path : '' }
}

// "12.4 MB", for the chip under the box and nothing else.
export function fileSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
