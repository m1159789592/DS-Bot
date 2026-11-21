// The part of reading aloud that needs Expo: keep the audio on the phone and play it.
// The pieces and the name of the file come from read-aloud.ts, which is plain Node.
import { Directory, File, FileMode, Paths } from 'expo-file-system'
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio'
import { collectAudio, audioName, spokenText, type Call, type Voice } from './read-aloud.ts'

let player: AudioPlayer | undefined
let configured = false
// One voice at a time: a reply that arrives while another is being read waits for it to
// end, so two answers never speak at once. `generation` drops what a stop leaves behind.
let tail: Promise<void> = Promise.resolve()
let generation = 0
let settle: (() => void) | undefined

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

async function playOne(call: Call, text: string, voice: Voice): Promise<void> {
  const file = await audioFile(call, text, voice)
  if (!configured) {
    configured = true
    await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' })
  }
  player?.remove()
  const next = createAudioPlayer({ uri: file.uri })
  player = next
  await new Promise<void>((resolve) => {
    const subscription = next.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (status.didJustFinish !== true) return
      settle = undefined
      subscription.remove()
      resolve()
    })
    settle = () => {
      subscription.remove()
      resolve()
    }
    next.play()
  })
  if (player === next) {
    player = undefined
    next.remove()
  }
}

export function speak(call: Call, raw: string, voice: Voice = 'stella'): Promise<void> {
  const text = spokenText(raw)
  if (text === '') return Promise.resolve()
  const mine = generation
  tail = tail
    .then(() => (mine === generation ? playOne(call, text, voice) : undefined))
    // A reply that could not be read does not stop the ones behind it.
    .catch(() => {})
  return tail
}

export function stopReading(): void {
  generation += 1
  const resume = settle
  settle = undefined
  player?.pause()
  player?.remove()
  player = undefined
  resume?.()
}
