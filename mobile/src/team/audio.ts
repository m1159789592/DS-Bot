// The part of reading aloud that needs Expo: keep the audio on the phone and play it.
// The pieces and the name of the file come from read-aloud.ts, which is plain Node.
import { Directory, File, FileMode, Paths } from 'expo-file-system'
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import { collectAudio, audioName, spokenText, type Call, type Voice } from './read-aloud.ts'

let player: AudioPlayer | undefined
let configured = false

function folder(): Directory {
  const dir = new Directory(Paths.cache, 'read-aloud')
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

async function audioFile(call: Call, text: string, voice: Voice): Promise<File> {
  const dir = folder()
  const cached = new File(dir, audioName(text, voice))
  if (cached.exists && (cached.size ?? 0) > 44) return cached
  const { data } = await collectAudio(call, text, voice)
  const file = new File(dir, audioName(text, voice))
  if (file.exists) file.delete()
  file.create()
  const handle = file.open(FileMode.Truncate)
  try {
    await handle.writeBytes(data)
  } finally {
    handle.close()
  }
  return file
}

export async function speak(call: Call, raw: string, voice: Voice = 'stella'): Promise<void> {
  const text = spokenText(raw)
  if (text === '') return
  const file = await audioFile(call, text, voice)
  if (!configured) {
    configured = true
    await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' })
  }
  player?.remove()
  const next = createAudioPlayer({ uri: file.uri })
  player = next
  next.play()
}

export function stopReading(): void {
  player?.pause()
  player?.remove()
  player = undefined
}
