/**
 * A thread reads only what changed and folds it in, rather than reading the
 * whole conversation on every poll.
 */
import { describe, expect, it } from 'vitest'
import { mergeThread } from '../discussion/Thread'
import type { WireMessage, WireThread } from '../../data/gateway'

const who = { id: 'maya', name: 'Maya', kind: 'human' } as WireMessage['author']
const msg = (id: string, at: string, over: Partial<WireMessage> = {}): WireMessage => ({
  id, parent_id: null, author: who, body: id, mentions: [], created_at: at, edited_at: null,
  deleted: false, you: { may_edit: true, may_delete: true }, ...over,
})
const thread = (messages: WireMessage[], now = '2026-10-14T10:00:00Z'): WireThread =>
  ({ subject: { id: 'doc-1', type: 'doc', key: null, title: 'D' }, messages, waiting: {}, now })

describe('folding in what changed', () => {
  it('replaces an edited message, adds a new one, and keeps reading order', () => {
    const had = thread([msg('a', '2026-10-14T09:00:00Z'), msg('b', '2026-10-14T09:01:00Z')])
    const changed = thread([msg('c', '2026-10-14T10:01:00Z'), msg('a', '2026-10-14T09:00:00Z', { body: 'a, edited' })],
      '2026-10-14T10:02:00Z')
    const t = mergeThread(had, { ...changed, since: had.now })
    expect(t.messages.map(m => m.body)).toEqual(['a, edited', 'b', 'c'])
    expect(t.now).toBe('2026-10-14T10:02:00Z')
  })

  it('takes away a deleted message, unless replies still hang from it', () => {
    const had = thread([msg('a', '2026-10-14T09:00:00Z'), msg('b', '2026-10-14T09:01:00Z'),
      msg('r', '2026-10-14T09:02:00Z', { parent_id: 'b' })])
    const changed = thread([msg('a', '2026-10-14T09:00:00Z', { deleted: true, body: null }),
      msg('b', '2026-10-14T09:01:00Z', { deleted: true, body: null })])
    const t = mergeThread(had, changed)
    expect(t.messages.map(m => m.id)).toEqual(['b', 'r'])
    expect(t.messages[0].deleted).toBe(true)
  })
})
