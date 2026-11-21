import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highestSeq, newestReply } from './spoken.ts'

const bot = (seq: number, text = 'An answer.') => ({ kind: 'bot', seq, text })
const user = (seq: number) => ({ kind: 'user', seq, text: 'A question.' })

test('the newest Bot reply wins, whatever comes after it', () => {
  const items = [bot(1, 'Old.'), user(2), bot(3, 'New.'), { kind: 'event', seq: 4 }]
  assert.deepEqual(newestReply(items), { seq: 3, text: 'New.' })
})

test('posts in a group are replies too', () => {
  assert.deepEqual(newestReply([{ kind: 'post', seq: 7, text: 'Reported.' }]), { seq: 7, text: 'Reported.' })
})

test('a reply without a sequence cannot be compared, so it is not read', () => {
  assert.equal(newestReply([{ kind: 'bot', text: 'No seq.' }]), undefined)
})

test('an empty reply is skipped for the one before it', () => {
  assert.deepEqual(newestReply([bot(2, '   '), bot(1, 'Real.')]), { seq: 1, text: 'Real.' })
})

test('the baseline is the highest sequence in the chat', () => {
  assert.equal(highestSeq([bot(1), user(9), { kind: 'event' }]), 9)
  assert.equal(highestSeq([]), 0)
})

// The rule the screen follows: open with the baseline, then speak only what is newer.
test('history is not read, a reply that arrives afterwards is', () => {
  const history = [user(4), bot(5, 'Already there.')]
  const baseline = highestSeq(history)
  const opened = newestReply(history)
  assert.equal(opened === undefined || opened.seq <= baseline, true)

  const afterReply = [...history, user(6), bot(7, 'Fresh.')]
  const fresh = newestReply(afterReply)
  assert.equal(fresh !== undefined && fresh.seq > baseline, true)
  assert.equal(fresh?.text, 'Fresh.')
})
