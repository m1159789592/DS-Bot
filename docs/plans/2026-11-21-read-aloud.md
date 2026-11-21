# Reading replies aloud

The phone app could only read replies with the eyes. The desktop app has a read-aloud
control; the phone gets one too, plus the behaviour other assistants have: the newest
finished reply is spoken by itself. This note covers where the voice comes from, how the
audio gets to the phone, and what the phone draws.

## Where the voice comes from

DeepSeek's TTS endpoint (`POST https://api.deepseek.com/v1/tools/tts`, `voice_id` `stella`
or `tide`, `format` `wav`) is called by the **host**, never by the phone: the key stays on
the computer, and the phone only ever sees audio bytes. The key is a DS Bot secret named
`DEEPSEEK_API_KEY` (`src/host/secrets.js`), added once in Settings → Secrets. The plugin
reads no DSH credential file — a secret the user put in DS Bot is the only source.

Missing key fails with a message that names that secret, so the phone can tell the user
what to add; it never guesses at another key.

## How the audio travels

One encrypted message carries 4 MB, and a long reply's WAV is larger than that, so the
audio rides the same road a downloaded file takes: endpoint `read-aloud`, chunks of
512 KB, each answered as `{ bytes, nextOffset, done, version }`. `fileChunks` in
`src/shared/file-chunks.js` takes the endpoint name as a third argument, so the phone
reads both with one loop.

The phone sends the text with every piece. It is at most 2000 characters, so repeating it
costs little and the host needs no per-client state to survive a reconnect. The host
recognises a repeat by `version` (a hash of text and voice) and answers from memory
instead of paying for the same sentence twice.

## The WAV header DeepSeek streams

The streamed WAV writes `0xFFFFFFFF` into the RIFF size and the `data` chunk size. Android
refuses such a file, so the host fills both in with the real lengths before the first
chunk goes out (`fixWav`). A player that reads the file to its end does not care, but one
that trusts the header does: the file is 0 bytes long as far as it can tell.

## Bounds

- **2000 characters spoken.** The API allows 10 000; a longer reply is read up to the
  2000th character and the phone says so instead of hiding it.
- **Three replies kept in memory**, by hash. A replay of the newest reply costs nothing.
- **512 KB per chunk**, the same size a file download uses.
- **Markdown is removed before it is read**: code blocks, links, emphasis, bullets. The
  voice should say what the sentence says, not the punctuation that draws it.

## The capability

`read-aloud` joins the hello capabilities. A phone that knows it draws the speaker; an
older host never gets the call and the phone hides the control.

## On the phone

`src/team/read-aloud.ts` holds the piece loop, the cache directory and one player, so only
that file touches Expo audio. `expo-audio` is the one new native module (playback only:
the microphone permission is off in `app.json`).

- **Long press a reply → Read aloud.** The sheet that already offers Copy and Select text
  gets the third row; talking again stops the voice that is running.
- **Auto read.** When a reply finishes and the chat is the one on screen, it is spoken
  once. The item key remembers what was already read, so a poll that returns the same
  items does not speak twice, and a reply the phone missed while away is not read in a
  burst on return.
- **Settings → Reading.** On or off, and which voice (`stella` or `tide`). Kept in the
  phone's preferences beside the other ones.

## Not done

No streaming playback: the whole reply is fetched before the first sound, which a long
reply makes a two second wait. No sentence highlighting, no speed control, no reading of
the Bot's own tool steps, and nothing is spoken while the app is in the background beyond
what the player keeps running.
