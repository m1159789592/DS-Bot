// Files the team receives — a document from the phone, a picture from a chat app — land
// in the user's Downloads folder, where they open with a double click. The Session keeps
// the path, not a copy: one file, one place on the disk.
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

// One file name, not a listing's line: enough for a long drawing name, short enough that
// the folder stays readable on every file system.
const NAME_MAX = 120

// Where received files go. `DS_BOT_INBOX` points the tests (and a user who keeps another
// folder) somewhere else; otherwise it is the folder Windows, macOS and most desktop
// Linux setups call Downloads.
export function inboxFolder() {
  const chosen = process.env.DS_BOT_INBOX
  if (typeof chosen === 'string' && chosen.trim() !== '') return chosen.trim()
  const dirs = process.env.XDG_DOWNLOAD_DIR
  if (typeof dirs === 'string' && dirs.trim() !== '') return dirs.trim()
  return join(homedir(), 'Downloads')
}

// The name the phone or chat app gave, made safe to store: no path, no control
// characters, and never empty.
export function inboxName(value, fallback = 'file') {
  const cleaned = Array.from(String(value ?? ''), ch => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? '' : ch)).join('')
  const name = cleaned.split(/[\\/]/).pop().trim()
  if (name === '' || name === '.' || name === '..') return fallback
  return name.slice(0, NAME_MAX)
}

const taken = error => error?.code === 'EEXIST'

// Writes one file into the folder and returns it. A name already there is never
// replaced: the new file becomes "name (2).ext", the way a second download reads.
export async function saveToInbox({ data, name, folder = inboxFolder() }) {
  await mkdir(folder, { recursive: true })
  const wanted = inboxName(name)
  const ext = extname(wanted)
  const stem = ext === '' ? wanted : wanted.slice(0, -ext.length)
  let handle
  let target
  for (let copy = 1; handle === undefined; copy += 1) {
    const candidate = copy === 1 ? wanted : `${stem} (${copy})${ext}`
    target = join(folder, candidate)
    try {
      // 'wx' claims the name before any byte is written, so two files that arrive
      // together cannot end up sharing one.
      handle = await open(target, 'wx')
    } catch (error) {
      if (!taken(error)) throw error
    }
  }
  try {
    await handle.writeFile(data)
    await handle.sync()
    return { path: target, name: basename(target), bytes: data.length }
  } catch (error) {
    // A half-written file is worse than none: it would open as if it were whole.
    await rm(target, { force: true })
    throw error
  } finally {
    await handle.close()
  }
}

// The extension a picture arrived with, from its media type.
const PICTURE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }

// The name a chat app's picture is stored under: the time it arrived and the platform it
// came in over, because the app itself names nothing.
export function receivedPictureName(platform, mediaType, at = new Date()) {
  const two = number => String(number).padStart(2, '0')
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  const ext = PICTURE_EXT[mediaType] ?? 'jpg'
  return `${platform}-${stamp}-${randomUUID().slice(0, 6)}.${ext}`
}
