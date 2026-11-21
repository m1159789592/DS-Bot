import { Directory, File, FileMode, Paths } from 'expo-file-system'
import { fileChunks } from '../../../ds-bot/src/shared/file-chunks.js'

// A file is taken a few pieces at a time: the pieces arrive while the one before them is
// still being written, so a save does not wait a round trip for every piece.
export async function downloadFile(
  call: (endpoint: string, payload: object) => Promise<unknown>,
  target: object,
  onProgress?: (done: number, size?: number) => void,
) {
  const dir = new Directory(Paths.cache, 'downloads', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  dir.create({ intermediates: true })
  let file: File | undefined
  let handle: ReturnType<File['open']> | undefined
  let saved: { uri: string; name: string; mime: string } | undefined
  try {
    for await (const part of fileChunks(call, target, 'file-download', { lookahead: 4, onProgress })) {
      if (file === undefined) {
        const name = String(part.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_')
        file = new File(dir, name === '.' || name === '..' ? 'file' : name)
        file.create()
        handle = file.open(FileMode.Truncate)
        saved = { uri: file.uri, name: file.name, mime: part.mime || 'application/octet-stream' }
      }
      await handle!.writeBytes(part.data)
    }
    return saved!
  } catch (error) {
    handle?.close()
    handle = undefined
    dir.delete()
    throw error
  } finally { handle?.close() }
}
