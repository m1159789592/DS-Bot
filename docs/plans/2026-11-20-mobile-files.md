# Files from the phone

The mobile app could take files from the computer and show them; it could only send
photos. This note covers sending documents as well, on the same composer.

## What a phone sends

A document cannot arrive in one request: one encrypted message carries 4 MB
(`MAX_SECURE_MESSAGE_BYTES` in `link/src/frames.ts`), which is why a download is read
in pieces (`fileChunks`). An upload is the same road backwards. Every piece is its own
command, so a message stays small:

- `stage-file-chunk` carries up to 1.5 MB of raw bytes as base64. The first piece names
  the file and opens an upload; the rest carry its id and say `offset`, so a piece that
  went missing or arrived twice is refused instead of quietly corrupting the file.
- `stage-file-end` joins the pieces, writes the file into the user's downloads folder
  (`src/host/inbox.js`), and hands back the path it landed on.
- `send` puts that path in the message, so the model reads the file with its own tools
  and the user double clicks the same file in the chat.

A file lives in one place: it is not also copied into DSH's attachment store. A picture
from an IM chat is the one exception, because the chat has to draw it; the bytes are
written to the downloads folder beside the attachment.

## Where a file lands

`inboxFolder()` is `%USERPROFILE%\Downloads` (or `XDG_DOWNLOAD_DIR` on Linux), so the
file opens without the Bot being asked for it. `DS_BOT_INBOX` points it elsewhere — the
tests use it so a run never writes into the user's folder.

A name already in the folder is never replaced: the new file becomes `name (2).ext`.
The name is claimed before a byte is written (`open` with `wx`), and a write that fails
partway leaves no half file behind.

A picture that arrives over an IM connection is stored under the time it arrived and the
platform it came from (`weixin-20261120-213045-1a2b3c.jpg`), because the chat app gives
it no name. Writing that copy never fails the message: if the folder is not writable, the
picture still arrives in the chat.

`send` takes `files` beside `images`, and a message may be files alone. A staged id goes
once: sending it again is `bot/stale`, the same as a photo.

## Bounds

- **100 MB per file**, held in the host's memory once when the pieces are joined. The
  phone turns a larger file away before the first piece, where the size is known.
- **1.5 MB per piece** on the host, a little above the phone's 1 MB read.
- **Eight uploads open at once**; a ninth closes the oldest, and an upload older than
  30 minutes is dropped.
- **The name is the phone's, cleaned.** Path separators are dropped, control characters
  are dropped by code point, and the rest is cut at 120 characters.

## The capability

`send-files` joins `send-images` in the hello capabilities. A phone that knows it shows
the clip button; an older host that does not never gets a `stage-file-chunk` call.
Nothing else changes in the handshake.

## On the phone

The composer gets a second attach button beside the photos' "+": it opens the system
document picker and shows a chip with the name and the size. Nothing is read at pick
time; the file is opened and drained a piece at a time when the message goes, so a large
file is never held whole in the phone's memory. The row the phone draws while the
message is in flight lists the names, then the paths the host wrote, until the computer
shows the message back — the chat compares that row with the message the computer kept,
so both sides must carry the same text.

`src/team/send-files.ts` holds the piece loop, the base64 encoder and the size wording,
so the part worth testing needs no Expo; `src/team/stage-file.ts` is the only part that
touches the file system.

## Not done

No resuming an interrupted upload, no sending a file past 100 MB, and no folder picker:
one file at a time, one piece per request.
