/**
 * Being told.
 *
 * A mention or a reply is worth nothing if the person it is for never finds
 * it. What is defended: the bell counts what is unread and says who did what
 * where, a notification takes you to the conversation and marks it read, and
 * reading a thread is what clears it — once per new message, not per poll.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hrefFor, NotificationBell } from '../discussion/Notifications'
import { CommentsButton, Thread } from '../discussion/Thread'
import { forgetMentionables } from '../discussion/mentions'
import { forgetCommentsAsk } from '../discussion/signals'
import type { WireNotification } from '../../data/gateway'

const SCRIBE = { id: 'scribe', name: 'Scribe', kind: 'agent' as const }
const RHEA = { id: 'rhea', name: 'Rhea', kind: 'human' as const }
const note = (over: Partial<WireNotification> & { id: string }): WireNotification => ({
  kind: 'reply', unread: true,
  message: { id: over.id, parent_id: 'm0', author: SCRIBE, body: 'Checked — it says 3.', mentions: [],
             created_at: '2026-09-26T10:00:00Z', edited_at: null, deleted: false,
             you: { may_edit: false, may_delete: false } },
  subject: { id: 'dash-1', type: 'dashboard', key: 'DASH-1', title: 'Two warehouses' },
  ...over,
})

type Call = { op: string; body: Record<string, unknown> }
function stub(notifications: WireNotification[], thread?: unknown) {
  forgetMentionables()
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    const out = op === 'messages.notifications'
      ? { unread: notifications.filter(n => n.unread).length, notifications }
      : op === 'messages.list' ? thread
      : op === 'messages.read' ? { read: [body.subject_id ?? 'all'] }
      : op === 'messages.counts' ? { counts: {} }
      : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
const sent = (calls: Call[], op: string) => calls.filter(c => c.op === op).map(c => c.body)
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); forgetCommentsAsk()
  window.history.replaceState(null, '', '/')
})
const THREAD = { subject: { id: 'dash-1', type: 'dashboard', key: null, title: 'Two warehouses' },
  messages: [{ ...note({ id: 'm1' }).message, parent_id: null }], waiting: {} }

function Where() { const l = useLocation(); return <p data-testid="at">{l.pathname}{l.search}{l.hash}</p> }

describe('the bell', () => {
  it('counts what is unread and says who did what, where', async () => {
    const u = userEvent.setup()
    stub([note({ id: 'n1' }),
          note({ id: 'n2', kind: 'mention', unread: false, message: { ...note({ id: 'n2' }).message, author: RHEA,
            body: '@alex have a look', mentions: [{ id: 'alex', name: 'Alex', kind: 'human' }] },
            subject: { id: 'channel-1', type: 'channel', key: 'CH-1', title: 'refund-incidents' } })])
    render(<MemoryRouter><NotificationBell /></MemoryRouter>)
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' })
    await u.click(bell)
    expect(screen.getByText('replied', { exact: false }).textContent).toMatch(/Scribe replied in Two warehouses/)
    expect(screen.getByText('mentioned you', { exact: false }).textContent).toMatch(/Rhea mentioned you on #refund-incidents/)
    // a mention reads as the name, not the handle
    expect(screen.getByText('@Alex have a look')).toBeTruthy()
  })

  it('takes you to the conversation, open, and marks it read', async () => {
    const u = userEvent.setup()
    const calls = stub([note({ id: 'n1' })], THREAD)
    window.history.replaceState(null, '', '/board')
    render(<BrowserRouter><NotificationBell /><Routes>
      <Route path="/dashboards/:id" element={<><Where /><CommentsButton subjectId="dash-1" title="Two warehouses" /></>} />
      <Route path="*" element={<Where />} />
    </Routes></BrowserRouter>)
    await u.click(await screen.findByRole('button', { name: /Notifications/ }))
    await u.click(screen.getByRole('button', { name: /Scribe replied/ }))
    expect(screen.getByTestId('at').textContent).toBe('/dashboards/dash-1#comments')
    expect(await screen.findByRole('dialog', { name: 'Comments on Two warehouses' })).toBeTruthy()
    await waitFor(() => expect(sent(calls, 'messages.read')[0]).toMatchObject({ subject_id: 'dash-1' }))
  })

  it('opens the comments of the page you are already on', async () => {
    const u = userEvent.setup()
    stub([note({ id: 'n1' })], THREAD)
    window.history.replaceState(null, '', '/dashboards/dash-1')
    render(<BrowserRouter><NotificationBell /><CommentsButton subjectId="dash-1" title="Two warehouses" /></BrowserRouter>)
    await u.click(await screen.findByRole('button', { name: /Notifications/ }))
    expect(screen.queryByRole('dialog', { name: 'Comments on Two warehouses' })).toBeNull()
    await u.click(screen.getByRole('button', { name: /Scribe replied/ }))
    expect(await screen.findByRole('dialog', { name: 'Comments on Two warehouses' })).toBeTruthy()
  })

  it('marks everything read at once', async () => {
    const u = userEvent.setup()
    const calls = stub([note({ id: 'n1' }), note({ id: 'n2' })])
    render(<MemoryRouter><NotificationBell /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }))
    await u.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(sent(calls, 'messages.read')[0]).toMatchObject({ all: true }))
  })

  it('shows nothing, rather than crashing the top bar, when answered in another shape', async () => {
    const u = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ odd: true }) }) as Response))
    render(<MemoryRouter><NotificationBell /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(await screen.findByText(/When someone mentions you/)).toBeTruthy()
  })

  it('says what will appear there when nothing has yet', async () => {
    const u = userEvent.setup()
    stub([])
    render(<MemoryRouter><NotificationBell /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(screen.getByText(/When someone mentions you/)).toBeTruthy()
  })
})

describe('where a notification leads', () => {
  it('opens each kind of conversation where it lives', () => {
    expect(hrefFor({ id: 'd', type: 'dashboard' })).toBe('/dashboards/d#comments')
    expect(hrefFor({ id: 'x', type: 'doc' })).toBe('/docs/edit/x#comments')
    expect(hrefFor({ id: 'e', type: 'experiment' })).toBe('/experiments/e#comments')
    expect(hrefFor({ id: 'g', type: 'design' })).toBe('/designs/g#comments')
    expect(hrefFor({ id: 't', type: 'task' })).toBe('/board?task=t')
    expect(hrefFor({ id: 'c', type: 'channel' })).toBe('/channels/c')
    expect(hrefFor({ id: 'skill-7', type: 'skill' })).toBe('/skills/skill-7#comments')
    expect(hrefFor({ id: 'scribe', type: 'agent' })).toBe('/agents/scribe#comments')
  })

  it('lands on the comments when it links to them', async () => {
    stub([])
    window.location.hash = '#comments'
    render(<CommentsButton subjectId="dash-1" title="Two warehouses" />)
    expect(await screen.findByRole('dialog', { name: 'Comments on Two warehouses' })).toBeTruthy()
  })
})

describe('reading a thread', () => {
  it('marks the conversation read once there is something new to have read', async () => {
    const calls = stub([], THREAD)
    render(<Thread subjectId="dash-1" />)
    await screen.findByText('Checked — it says 3.')
    await waitFor(() => expect(sent(calls, 'messages.read')).toEqual([expect.objectContaining({ subject_id: 'dash-1' })]))
  })
})
