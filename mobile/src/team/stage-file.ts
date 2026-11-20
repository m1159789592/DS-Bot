import { File, FileMode } from 'expo-file-system'
import { stageFile, type PickedFile } from './send-files.ts'

// A picked document as a reader the staging loop drains piece by piece. The handle is
// opened once and closed after the last piece, so a large file never sits in memory.
export async function stageDocument(
  call: (endpoint: string, payload: object) => Promise<unknown>,
  picked: PickedFile,
): Promise<{ id: string, path: string }> {
  const file = new File(picked.uri)
  const size = Number.isFinite(picked.size) && picked.size > 0 ? picked.size : file.size
  const handle = file.open(FileMode.ReadOnly)
  try {
    return await stageFile(call, picked.name, { size, read: length => handle.readBytes(length) })
  } finally { handle.close() }
}

// Every picked document in turn, in the order the composer showed them.
export async function stageDocuments(
  call: (endpoint: string, payload: object) => Promise<unknown>,
  picked: PickedFile[],
): Promise<{ id: string, path: string }[]> {
  const staged: { id: string, path: string }[] = []
  for (const file of picked) staged.push(await stageDocument(call, file))
  return staged
}
