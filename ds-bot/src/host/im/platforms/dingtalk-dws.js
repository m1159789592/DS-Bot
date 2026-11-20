// DingTalk through the dws CLI — the owner's own account, not a robot.
//
// Inbound: `dws event consume user_im_message_receive_at
// user_im_message_receive_o2o_all --flatten` prints one JSON object per line on
// stdout and `[event] ready …` on stderr once the personal long connection is
// up. Outbound: `dws chat +messages-send --as user …`, so a reply carries the
// owner's identity exactly like the gateway this replaces.
//
// Because the account is the owner's, every message we send comes back as one of
// their own events. Self-echo has to be filtered or each reply answers itself:
// the owner's name from `dws auth status` plus a short fingerprint of the texts
// we just sent covers both the sender field and a name that does not match.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A plain append-only trace: the host keeps adapter errors for the UI only, and
// "the message never left" has several very different causes upstream of it.
const trace = text => {
  try { appendFileSync(join(tmpdir(), 'dsh-dingtalk-dws.log'), `${new Date().toISOString()} ${text}\n`) } catch {}
}

const EVENTS = ['user_im_message_receive_at', 'user_im_message_receive_o2o_all']
// The group flavour only fires when we are @-mentioned; the direct one is 单聊.
const GROUP_EVENT = 'user_im_message_receive_at'
const TEXT_LIMIT = 3500
const AUTH_TIMEOUT = 30_000
const SEND_TIMEOUT = 60_000
const RESPAWN = [1_000, 3_000, 10_000, 30_000, 60_000]
const ECHO_TTL = 120_000
const ECHO_MAX = 40
const SEEN_MAX = 500

const space = value => String(value ?? '').trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The CLI ships with Hermes on Windows and lives on PATH on the server; an
// explicit path in the connection settings always wins.
const binOf = fields => {
  const given = space(fields?.dwsPath)
  if (given !== '') return given
  const local = space(process.env.LOCALAPPDATA)
  if (local !== '') {
    const candidate = `${local}\\hermes\\bin\\dws.exe`
    if (existsSync(candidate)) return candidate
  }
  if (space(process.env.HOME) !== '') {
    const candidate = `${space(process.env.HOME)}/.local/bin/dws`
    if (existsSync(candidate)) return candidate
  }
  return 'dws'
}

const profileArgs = fields => (space(fields?.profile) === '' ? [] : ['--profile', space(fields.profile)])

// One CLI call, captured. A timeout resolves with code -1 instead of rejecting:
// every caller here reports failure in its own words.
const run = (bin, args, timeout, options = {}) => new Promise((resolve, reject) => {
  let child
  try {
    child = spawn(bin, args, { windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    reject(error)
    return
  }
  let out = ''
  let err = ''
  let settled = false
  const finish = value => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(value)
  }
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM') } catch {}
    finish({ code: -1, out, err: `${err}${err === '' ? '' : '\n'}timed out after ${timeout} ms` })
  }, timeout)
  timer.unref?.()
  child.stdout?.on('data', chunk => { out += chunk })
  child.stderr?.on('data', chunk => { err += chunk })
  child.on('error', error => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    reject(error)
  })
  child.on('close', code => finish({ code, out, err }))
})

const parseJson = text => {
  const body = space(text)
  if (body === '') return undefined
  try { return JSON.parse(body) } catch {}
  // Some subcommands print a log line before the JSON payload.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return undefined }
}

// A send counts as delivered when dws says so; older builds only report
// `"success": true` inside a ledger.
const sendWorked = ({ code, out, err }) => {
  if (code !== 0) return false
  const data = parseJson(out)
  if (data === undefined) return /"ok"\s*:\s*true|"success"\s*:\s*true/.test(out)
  if (data.ok === true || data.success === true) return true
  if (data.result?.ok === true || data.result?.success === true) return true
  const results = data.result?.results ?? data.results
  if (Array.isArray(results) && results.length > 0) return results.every(one => one?.ok !== false && one?.success !== false)
  return false
}

const reasonOf = ({ out, err }, fallback) => {
  const data = parseJson(out)
  const said = data?.error?.message ?? data?.message ?? data?.error
  if (typeof said === 'string' && said !== '') return said
  const tail = space(err) || space(out)
  return tail === '' ? fallback : tail.slice(0, 300)
}

// DingTalk folds a single newline away in group messages, so paragraphs keep a
// blank line between them; chunks break on a line boundary where one is close.
const chunkText = (text, limit) => {
  const whole = String(text ?? '')
  if (whole.length <= limit) return [whole]
  const chunks = []
  let rest = whole
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const cut = at > limit * 0.5 ? at : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

// `@通知 查一下磁盘` — the mention is part of the text on the way in and means
// nothing to the Bot.
const stripMentions = content => String(content ?? '')
  .replace(/^(?:\s*@[^\s@]+)+\s*/u, '')
  .replace(/\s+/g, m => (m.includes('\n') ? m : ' '))
  .trim()

const participants = fields => space(fields?.allow)
  .split(/[,，;；\s]+/)
  .map(one => one.trim())
  .filter(one => one !== '')

const allowed = (fields, id, name) => {
  const list = participants(fields)
  if (list.length === 0) return true
  return list.includes(id) || list.includes(name)
}

const STRIP_HINT = /\n?注意[：:]\s*如需下载[\s\S]*$/

// An image/file message arrives as `[图片消息](mediaId=…)` plus a download hint
// instead of words; the placeholder is the only thing that names the resource.
const mediaHintOf = value => {
  const match = /\[[^\]]*消息\]\(\s*(?:mediaId|fileId)=([^)]+?)\s*\)/.exec(String(value ?? ''))
  return match === null ? undefined : match[1].trim()
}

const sniffImage = bytes => {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ext: '.png', mime: 'image/png' }
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { ext: '.gif', mime: 'image/gif' }
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { ext: '.webp', mime: 'image/webp' }
  return undefined
}

const eventFields = ev => {
  // Without --flatten the business fields sit under `data`; accept both so a
  // future CLI change cannot silently drop every message.
  if (ev?.data !== null && typeof ev?.data === 'object') {
    const merged = { ...ev.data }
    for (const key of ['type', 'event_type', 'event_id']) if (key in ev && !(key in merged)) merged[key] = ev[key]
    return merged
  }
  return ev ?? {}
}

// ---- inbound media ---------------------------------------------------------
// An image or a file arrives as a resource id inside the message payload; the
// bytes come from `dws chat +messages-resource-download`. The exact key names
// differ between payload versions, so any mediaId/fileId found anywhere in the
// object counts, and its siblings are read for a name and a content type.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
}

const scanResources = (value, out = [], depth = 0) => {
  if (value === null || typeof value !== 'object' || depth > 6 || out.length >= 6) return out
  if (Array.isArray(value)) {
    for (const one of value) scanResources(one, out, depth + 1)
    return out
  }
  const mediaId = space(value.mediaId ?? value.media_id ?? value.openMediaId ?? value.downloadCode ?? '')
  const fileId = space(value.fileId ?? value.file_id ?? '')
  if (mediaId !== '' || fileId !== '') {
    out.push({
      id: mediaId !== '' ? mediaId : fileId,
      kind: mediaId !== '' ? 'mediaId' : 'fileId',
      name: space(value.fileName ?? value.file_name ?? value.name ?? ''),
      mime: space(value.contentType ?? value.content_type ?? value.mimeType ?? value.mime_type ?? ''),
    })
    return out
  }
  for (const one of Object.values(value)) scanResources(one, out, depth + 1)
  return out
}

export default {
  id: 'dingtalk-dws',

  async check(fields) {
    const bin = binOf(fields)
    const answer = await run(bin, ['auth', 'status', ...profileArgs(fields)], AUTH_TIMEOUT).catch(error => {
      throw new Error(`dws 无法执行（${bin}）：${error?.message ?? error}`)
    })
    const data = parseJson(answer.out)
    if (data === undefined) throw new Error(`dws auth status 没有返回 JSON：${reasonOf(answer, '空响应')}`)
    if (data.authenticated !== true) throw new Error('dws 未登录，先在电脑上运行 dws auth login')
    if (data.token_valid === false && data.refresh_token_valid === true) {
      // Still usable: dws refreshes on the next call.
    }
    return { account: { id: String(data.user_id ?? ''), name: String(data.user_name ?? '') } }
  },

  connect(fields, env, handlers) {
    const bin = binOf(fields)
    const args = ['event', 'consume', ...EVENTS, '--flatten', ...profileArgs(fields)]
    const log = env?.log
    let stopped = false
    let child
    let attempt = 0
    let ready = false
    let buffer = ''
    let selfName = ''
    const selfId = space(fields?.selfId)
    const seen = new Set()
    const echoes = []
    // Direct chats are addressed by the sender's open id; the conversation id
    // seen on the way in is the fallback when that address is refused.
    const directChats = new Map()

    const remember = (key, text) => {
      echoes.push({ key, text: space(text), at: Date.now() })
      while (echoes.length > ECHO_MAX) echoes.shift()
    }
    // Listing the account holder in `allow` is the explicit "and my own
    // messages too" opt-in for driving the Bot from the owner's account.
    const allowSelf = () => selfName !== '' && participants(fields).includes(selfName)

    // Fetch the actual image/file bytes for one message. A payload sometimes
    // carries the resource id directly; when it does not, one `messages-mget`
    // call returns the message record to scan instead.
    const mediaRoot = join(tmpdir(), 'dsh-dingtalk-media')
    const fetchMedia = async (messageId, chatKey, merged, lookup, hintId) => {
      let resources = scanResources(merged)
      // The placeholder `[图片消息](mediaId=…)` is the usual carrier; it names
      // the resource without a lookup round trip.
      if (resources.length === 0 && hintId !== undefined && hintId !== '') {
        resources = [{ id: hintId, kind: 'mediaId', name: '', mime: '' }]
      }
      if (resources.length === 0 && lookup && messageId !== '') {
        const detail = await run(bin, ['chat', '+messages-mget', '--msg-ids', messageId], SEND_TIMEOUT)
        const data = parseJson(detail.out)
        if (data !== undefined) resources = scanResources(data)
        else trace(`media lookup failed code=${detail.code} err=${space(detail.err).slice(0, 200)}`)
      }
      const images = []
      const files = []
      for (const [index, resource] of resources.entries()) {
        try {
          mkdirSync(mediaRoot, { recursive: true })
          const base = (resource.name !== '' ? resource.name : `${resource.kind}-${index}`).replace(/[^\w.\-]+/g, '_')
          const output = `./${Date.now()}_${index}_${base}`
          const args = ['chat', '+messages-resource-download', '--resource-id', resource.id, '--output', output]
          if (resource.kind === 'mediaId') args.push('--message-id', messageId, '--open-conversation-id', chatKey)
          const answer = await run(bin, args, SEND_TIMEOUT, { cwd: mediaRoot })
          if (answer.code !== 0) {
            trace(`media download failed kind=${resource.kind} code=${answer.code} err=${space(answer.err).slice(0, 200)}`)
            continue
          }
          const path = join(mediaRoot, output.replace(/^\.\//, ''))
          if (!existsSync(path)) {
            trace(`media download reported success but file missing: ${path}`)
            continue
          }
          const bytes = readFileSync(path)
          const sniffed = sniffImage(bytes)
          const ext = sniffed?.ext ?? (String(resource.name || path).toLowerCase().match(IMAGE_EXT) ?? [''])[0]
          const mime = sniffed?.mime ?? (resource.mime !== '' ? resource.mime : (MIME[ext] ?? ''))
          if (mime.startsWith('image/') || ext !== '') {
            images.push({ mediaType: mime === '' ? 'image/jpeg' : mime, data: bytes.toString('base64') })
          } else {
            files.push({ name: resource.name !== '' ? resource.name : base, data: bytes })
          }
          trace(`media ok kind=${resource.kind} bytes=${bytes.length} ext=${ext} mime=${mime}`)
        } catch (error) {
          trace(`media error kind=${resource.kind}: ${error?.message ?? error}`)
        }
      }
      return { images, files }
    }
    const isEcho = (key, text) => {
      const now = Date.now()
      const body = space(text)
      for (const entry of echoes) {
        if (now - entry.at > ECHO_TTL) continue
        if (entry.key !== key) continue
        if (entry.text === body) return true
        // The platform may re-wrap or trim our text; a long shared prefix is
        // enough to call it our own message.
        if (body.length > 40 && (entry.text.startsWith(body.slice(0, 40)) || body.startsWith(entry.text.slice(0, 40)))) return true
      }
      return false
    }

    const deliver = async ev => {
      const merged = eventFields(ev)
      const messageId = space(merged.message_id ?? merged.messageId ?? merged.event_id ?? '')
      if (messageId !== '') {
        if (seen.has(messageId)) return
        seen.add(messageId)
        if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
      }
      const senderId = space(merged.sender_open_dingtalk_id ?? merged.senderId ?? merged.sender_open_id ?? '')
      const sender = space(merged.sender ?? merged.sender_name ?? merged.senderName ?? '')
      if (senderId === '' && sender === '') return
      // The account is the owner's: their own messages are what they send to
      // colleagues, not commands. Colleagues list themselves in `allow`; the
      // owner can do the same to command the Bot from their own account.
      if (selfId !== '' && senderId === selfId) return
      if (selfName !== '' && sender === selfName && !allowSelf()) return
      const type = space(merged.type ?? merged.event_type ?? '')
      const conversation = space(merged.conversation_id ?? merged.open_conversation_id ?? merged.conversationId ?? '')
      // Only the @-mention event is a group chat. A 单聊 also carries a
      // conversation id, and treating that as a group made every direct chat
      // look like a group that needed its own binding.
      const group = type === GROUP_EVENT
      const raw = merged.content ?? merged.text ?? merged.msgContent ?? ''
      const rawText = typeof raw === 'string' ? raw : ''
      const mediaHint = mediaHintOf(rawText)
      // A media message carries `[图片消息](mediaId=…)` and a download hint
      // instead of words, so it has nothing to say to the Bot.
      const text = mediaHint !== undefined ? '' : stripMentions(rawText)
      const key = group ? conversation : (senderId !== '' ? senderId : conversation)
      if (!group && conversation !== '' && key !== '') directChats.set(key, conversation)
      trace(`event type=${type} sender=${sender} senderId=${senderId} key=${key} text=${String(text).slice(0, 60)}`)
      if (key === '') return
      if (isEcho(key, text)) {
        trace('event dropped: echo of our own reply')
        return
      }
      if (!allowed(fields, senderId, sender)) {
        log?.info?.(`ds-bot im: dingtalk-dws dropped ${sender || senderId} (not in allow list)`)
        trace('event dropped: not in allow list')
        return
      }
      trace(`deliver -> kind=${group ? 'group' : 'direct'}`)
      // Images and files carry a resource id instead of text; the bytes have to
      // be fetched before the message is worth delivering.
      let images = []
      let files = []
      if (messageId !== '') {
        const empty = String(text).trim() === ''
        if (empty || mediaHint !== undefined || scanResources(merged).length > 0) {
          const media = await fetchMedia(messageId, key, merged, empty, mediaHint).catch(error => {
            trace(`media fetch failed: ${error?.message ?? error}`)
            return { images: [], files: [] }
          })
          images = media.images
          files = media.files
        }
      }
      if (String(text).trim() === '' && images.length === 0 && files.length === 0) {
        trace('event dropped: no text and no media could be fetched')
        return
      }
      await handlers.onMessage({
        chat: { key, kind: group ? 'group' : 'direct', title: space(merged.conversation_title ?? merged.group_name ?? merged.conversationTitle ?? '') },
        sender: { id: senderId !== '' ? senderId : sender, name: sender !== '' ? sender : senderId },
        text,
        images,
        files,
        mentioned: group,
        messageId,
      })
    }

    const consumeLines = text => {
      buffer += text
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '' || !line.startsWith('{')) continue
        const parsed = parseJson(line)
        if (parsed === undefined) continue
        // A build that does not print `[event] ready` is still online once it
        // delivers a real event.
        if (!ready) {
          ready = true
          attempt = 0
          handlers.onStatus({ state: 'ready' })
        }
        void deliver(parsed).catch(error => log?.warn?.('ds-bot im: dingtalk-dws message failed: %s', error?.message ?? error))
      }
    }

    const start = () => {
      if (stopped) return
      ready = false
      handlers.onStatus({ state: 'connecting' })
      trace(`consume start bin=${bin} args=${args.join(' ')}`)
      try {
        child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        trace(`consume spawn failed: ${error?.message ?? error}`)
        handlers.onStatus({ state: 'error', error: `dws 无法启动：${error?.message ?? error}` })
        return
      }
      child.stdout?.on('data', chunk => consumeLines(String(chunk)))
      child.stderr?.on('data', chunk => {
        const text = String(chunk)
        log?.info?.(`ds-bot im: dingtalk-dws ${text.trim().slice(0, 300)}`)
        trace(`consume stderr: ${text.trim().slice(0, 200)}`)
        // The CLI documents `[event] ready` as the point where the personal
        // long connection is up and stdout will carry events.
        if (!ready && /\[event\]\s*ready/.test(text)) {
          ready = true
          attempt = 0
          handlers.onStatus({ state: 'ready' })
          trace('consume ready')
        }
      })
      child.on('error', error => {
        trace(`consume error: ${error?.message ?? error}`)
        handlers.onStatus({ state: 'error', error: `dws 无法启动：${error?.message ?? error}` })
      })
      child.on('close', code => {
        if (stopped) return
        const wait = RESPAWN[Math.min(attempt, RESPAWN.length - 1)]
        attempt += 1
        trace(`consume closed code=${code} respawn in ${wait}ms`)
        handlers.onStatus({ state: 'connecting', error: `dws 事件流已断开（退出码 ${code}），${Math.round(wait / 1000)} 秒后重连` })
        void sleep(wait).then(() => start())
      })
    }

    const send = async (chat, job) => {
      const text = String(job?.text ?? '')
      const key = space(chat?.key)
      if (key === '') throw new Error('钉钉会话缺失，无法回复')
      if (space(text) === '') return { messageId: '' }
      const group = chat?.kind === 'group'
      const chunks = chunkText(text, TEXT_LIMIT)
      let messageId = ''
      trace(`send start kind=${String(chat?.kind)} key=${key} len=${text.length} chunks=${chunks.length}`)
      for (const piece of chunks) {
        const body = group ? piece.replace(/\n(?!\n)/g, '\n\n') : piece
        const call = target => run(bin, ['chat', '+messages-send', '--as', 'user',
          ...target, '--text', body, '--yes', ...profileArgs(fields)], SEND_TIMEOUT)
          .catch(error => ({ code: -1, out: '', err: String(error?.message ?? error) }))
        let answer = await call(group ? ['--chat-id', key] : ['--open-dingtalk-id', key])
        // A direct chat addressed by open id can be refused; the conversation id
        // seen on the way in is a working address for the same chat.
        const fallback = group ? '' : (directChats.get(key) ?? '')
        if (!sendWorked(answer) && fallback !== '') {
          trace(`send retry with conversation id for ${key}`)
          answer = await call(['--chat-id', fallback])
        }
        trace(`send result code=${answer.code} worked=${sendWorked(answer)} out=${space(answer.out).slice(0, 300)} err=${space(answer.err).slice(0, 300)}`)
        if (!sendWorked(answer)) throw new Error(`钉钉发送失败：${reasonOf(answer, '未知原因')}`)
        // Our own message will come back as an event; mark it before it lands.
        remember(key, piece)
        const data = parseJson(answer.out)
        messageId = space(data?.result?.message_id ?? data?.message_id ?? data?.result?.open_message_id ?? messageId)
      }
      trace(`send done messageId=${messageId}`)
      return { messageId }
    }

    const stop = async () => {
      stopped = true
      if (child === undefined) return
      // The CLI asks to be shut down with SIGTERM or a closed stdin, never -9.
      try { child.stdin?.end() } catch {}
      try { child.kill('SIGTERM') } catch {}
      const dying = child
      child = undefined
      await Promise.race([new Promise(resolve => dying.once('close', resolve)), sleep(3000)])
    }

    // Must return a promise: the host chains `.catch` on it while a turn runs,
    // and a bare undefined crashes the host process there.
    const typing = async () => {}
    // Knowing the account holder's name is what separates "a colleague asked"
    // from "the owner typed to a colleague"; it is worth one CLI call, and a
    // failure only leaves the self-filter off.
    void run(bin, ['auth', 'status', ...profileArgs(fields)], AUTH_TIMEOUT)
      .then(answer => { selfName = space(parseJson(answer.out)?.user_name) })
      .catch(() => {})
    start()
    return { send, stop, typing }
  },
}
