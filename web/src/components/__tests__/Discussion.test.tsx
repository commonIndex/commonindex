/**
 * Comments and channels, against the gateway's messages.
 *
 * What is defended: a mention is picked from the people and agents in the
 * space and lands where the caret was — typing on straight after picking must
 * not scramble the message, which it did when the caret moved a frame late —
 * a resolved mention reads as the person it names, a mentioned agent reads as
 * asked and waiting until it answers, and replies go to the message they
 * answer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommentsButton, MessageBody, Thread } from '../discussion/Thread'
import { forgetMentionables } from '../discussion/mentions'
import { ChannelsIndex } from '../../views/Channels'
import type { WireMessage, WireThread } from '../../data/gateway'

const MAYA = { id: 'maya', name: 'Maya', kind: 'human' as const }
const SCRIBE = { id: 'scribe', name: 'Scribe', kind: 'agent' as const }
const YOU = { may_edit: false, may_delete: false }

const msg = (over: Partial<WireMessage> & { id: string }): WireMessage => ({
  parent_id: null, author: MAYA, body: 'hello', mentions: [], created_at: '2026-09-26T10:00:00Z',
  edited_at: null, deleted: false, you: YOU, ...over,
})

type Call = { op: string; body: Record<string, unknown> }

function stub(thread: Partial<WireThread> = {}, extra: Record<string, unknown> = {}) {
  forgetMentionables()
  const calls: Call[] = []
  const t: WireThread = { subject: { id: 'dash-1', type: 'dashboard', key: 'DASH-1', title: 'Refunds' },
                          messages: [], waiting: {}, ...thread }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    const out = op === 'messages.list' ? t
      : op === 'people.list' ? { people: [{ id: 'maya', display: 'Maya', agents_owned: 0 }] }
      : op === 'agents.list' ? { agents: [{ id: 'scribe', display: 'Scribe', may: ['propose'] },
                                          { id: 'nosy', display: 'Nosy', may: [] }] }
      : op === 'messages.post' ? { message: msg({ id: 'm-new', body: body.body }), asked: [], not_asked: [] }
      : op === 'messages.counts' ? { counts: { 'dash-1': 3 } }
      : extra[op] ?? {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
const sent = (calls: Call[], op: string) => calls.filter(c => c.op === op).map(c => c.body)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the composer', () => {
  it('offers people and agents for @, and lands the caret after the one picked', async () => {
    const u = userEvent.setup()
    const calls = stub()
    render(<Thread subjectId="dash-1" />)
    const box = await screen.findByRole('combobox', { name: /Add a comment/ })
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false))
    await u.type(box, 'Spend jumped @scr')
    const pick = await screen.findByRole('listbox', { name: 'Mention someone' })
    expect(within(pick).getByText('Scribe')).toBeTruthy()
    await u.keyboard('{Enter}')
    // Straight on, as a person types — the rest must follow the mention.
    await u.type(box, 'can you check?')
    expect((box as HTMLTextAreaElement).value).toBe('Spend jumped @scribe can you check?')
    await u.keyboard('{Enter}')
    await waitFor(() => expect(sent(calls, 'messages.post')).toHaveLength(1))
    expect(sent(calls, 'messages.post')[0]).toMatchObject({
      subject_id: 'dash-1', body: 'Spend jumped @scribe can you check?' })
  })

  it('marks an agent that holds nothing here, rather than hiding it', async () => {
    const u = userEvent.setup()
    stub()
    render(<Thread subjectId="dash-1" />)
    const box = await screen.findByRole('combobox', { name: /Add a comment/ })
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false))
    await u.type(box, '@no')
    expect(await screen.findByText('agent · no grant here')).toBeTruthy()
  })

  it('opens mentions from the toolbar and closes the picker before closing a channel thread', async () => {
    const u = userEvent.setup()
    stub({ messages: [msg({ id: 'm1', body: 'A channel question' })] })
    render(<Thread subjectId="channel-1" variant="channel" />)
    await u.click(await screen.findByRole('button', { name: 'Reply in thread' }))
    const panel = screen.getByRole('complementary')
    await u.click(within(panel).getByRole('button', { name: 'Mention a person or agent' }))
    expect(await within(panel).findByRole('listbox')).toBeTruthy()
    const box = within(panel).getByRole('combobox') as HTMLTextAreaElement
    expect(box.value).toBe('@')
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('complementary')).toBe(panel)
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('complementary')).toBeNull()
  })
})

describe('a thread', () => {
  it('shows a resolved mention as the one it names, and an unresolved one as text', () => {
    render(<MessageBody text="ask @maya and @nobody" mentions={[MAYA]} />)
    expect(screen.getByText('@Maya').className).toMatch(/mention/)
    expect(screen.getByText(/and @nobody/)).toBeTruthy()
  })

  it('says an agent was asked and is waiting, until it answers', async () => {
    stub({ messages: [msg({ id: 'm1', body: '@scribe check this', mentions: [SCRIBE] })],
           waiting: { m1: [SCRIBE] } })
    render(<Thread subjectId="dash-1" />)
    expect(await screen.findByText(/Asked Scribe — waiting for a reply/)).toBeTruthy()
    expect(screen.getByText('@Scribe').className).toMatch(/agent/)
  })

  it('files a reply under the message it answers', async () => {
    const u = userEvent.setup()
    const calls = stub({ messages: [
      msg({ id: 'm1', body: 'first' }),
      msg({ id: 'm2', parent_id: 'm1', author: SCRIBE, body: 'an answer' }),
    ] })
    render(<Thread subjectId="dash-1" />)
    expect(await screen.findByText('an answer')).toBeTruthy()
    expect(screen.getByText('an answer').closest('.treplies')).not.toBeNull()
    await u.click(screen.getByRole('button', { name: 'Reply · 1 reply' }))
    const box = screen.getByRole('combobox', { name: 'Reply to Maya' })
    await u.type(box, 'thanks{Enter}')
    await waitFor(() => expect(sent(calls, 'messages.post')[0]).toMatchObject({ parent_id: 'm1', body: 'thanks' }))
  })

  it('shows the latest five replies, and the earlier ones on Show more', async () => {
    const u = userEvent.setup()
    stub({ messages: [
      msg({ id: 'm1', body: 'the question' }),
      ...Array.from({ length: 7 }, (_, i) => msg({ id: `r${i + 1}`, parent_id: 'm1', body: `reply ${i + 1}` })),
    ] })
    render(<Thread subjectId="dash-1" />)
    expect(await screen.findByText('reply 7')).toBeTruthy()
    expect(screen.getByText('reply 3')).toBeTruthy()
    expect(screen.queryByText('reply 2')).toBeNull()
    // Reply counts the whole thread, not what is showing.
    expect(screen.getByRole('button', { name: 'Reply · 7 replies' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Show more · 2 earlier replies' }))
    expect(screen.getByText('reply 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
  })

  it('folds nothing at five replies or fewer', async () => {
    stub({ messages: [
      msg({ id: 'm1', body: 'the question' }),
      ...Array.from({ length: 5 }, (_, i) => msg({ id: `r${i + 1}`, parent_id: 'm1', body: `reply ${i + 1}` })),
    ] })
    render(<Thread subjectId="dash-1" />)
    expect(await screen.findByText('reply 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
  })

  it('keeps a deleted message only as the marker its replies hang from', async () => {
    stub({ messages: [
      msg({ id: 'm1', body: null, deleted: true }),
      msg({ id: 'm2', parent_id: 'm1', body: 'still here' }),
    ] })
    render(<Thread subjectId="dash-1" />)
    expect(await screen.findByText('This message was deleted.')).toBeTruthy()
    expect(screen.getByText('still here')).toBeTruthy()
  })
})

describe('the comments button', () => {
  it('shows the count before the thread is opened, and opens it beside the page', async () => {
    const u = userEvent.setup()
    stub({ messages: [msg({ id: 'm1', body: 'hi' })] })
    render(<CommentsButton subjectId="dash-1" title="Refunds" />)
    const button = await screen.findByRole('button', { name: /Comments/ })
    // Read as "Comments 3", not "Comments3".
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comments 3' })).toBe(button))
    await u.click(button)
    expect(screen.getByRole('dialog', { name: 'Comments on Refunds' })).toBeTruthy()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says what a skill is, since the gateway has no skill to look up', async () => {
    const u = userEvent.setup()
    const calls = stub()
    const about = { type: 'skill' as const, title: 'doc-drift-sync', key: 'SK-109' }
    render(<CommentsButton subjectId="skill-109" title="doc-drift-sync" about={about} />)
    await u.click(await screen.findByRole('button', { name: /Comments/ }))
    await u.type(await screen.findByRole('combobox', { name: /Add a comment/ }), 'still used?{Enter}')
    const named = { subject_id: 'skill-109', subject: about }
    await waitFor(() => expect(sent(calls, 'messages.post')[0]).toMatchObject({ ...named, body: 'still used?' }))
    expect(sent(calls, 'messages.list')[0]).toMatchObject(named)
  })

  it('names nothing for an object, which the gateway looks up', async () => {
    const calls = stub()
    render(<Thread subjectId="dash-1" />)
    await waitFor(() => expect(sent(calls, 'messages.list')).toHaveLength(1))
    expect(sent(calls, 'messages.list')[0]).toEqual({ subject_id: 'dash-1' })
  })
})

describe('channels', () => {
  it('names a new channel like a handle and opens it', async () => {
    const u = userEvent.setup()
    const calls = stub({}, {
      'channels.list': { channels: [] },
      'channels.propose': { channel: { id: 'channel-abc', key: 'CH-1', name: 'refund-incidents', topic: null,
                                       messages: 0, last_at: null, last: null }, created: true },
    })
    render(<MemoryRouter><ChannelsIndex /></MemoryRouter>)
    expect(await screen.findByText('No channels yet')).toBeTruthy()
    await u.click(screen.getAllByRole('button', { name: '+ New channel' })[0])
    await u.type(screen.getByPlaceholderText('refund-incidents'), 'Refund Incidents')
    expect((screen.getByPlaceholderText('refund-incidents') as HTMLInputElement).value).toBe('refund-incidents')
    await u.click(screen.getByRole('button', { name: 'Create channel' }))
    await waitFor(() => expect(sent(calls, 'channels.propose')[0]).toMatchObject({ name: 'refund-incidents' }))
  })
})
