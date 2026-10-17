import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MentionComposer } from '../discussion/MentionComposer'
import { Thread } from '../discussion/Thread'
import { forgetMentionables } from '../discussion/mentions'
import { ChannelView, ChannelsIndex } from '../../views/Channels'
import type { WireMessage, WireThread } from '../../data/gateway'

const channel = { id: 'channel-1', key: 'CH-1', name: 'team', topic: 'Team decisions', messages: 1, last_at: null, last: null }
const msg = (id: string, created_at = '2026-09-28T10:00:00Z'): WireMessage => ({
  id, body: `Message ${id}`, author: { id: 'maya', name: 'Maya', kind: 'human' }, parent_id: null,
  created_at, edited_at: null, deleted: false, mentions: [], you: { may_edit: false, may_delete: false },
})
const thread = (messages: WireMessage[]): WireThread => ({
  subject: { id: 'channel-1', key: 'CH-1', title: 'team', type: 'channel' }, messages, waiting: {},
})
function gateway(extra: (op: string, body: Record<string, unknown>) => unknown = () => ({})) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    const out = op === 'people.list' ? { people: [] } : op === 'agents.list' ? { agents: [] } : await extra(op, body)
    return { ok: true, status: 200, json: async () => structuredClone(out) } as Response
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
beforeEach(() => { forgetMentionables() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('preserves a failed message draft and lets the reader send it again', async () => {
  gateway()
  const send = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(undefined)
  render(<MentionComposer placeholder="Message" onSend={send} />)
  const box = screen.getByRole('combobox') as HTMLTextAreaElement
  await userEvent.type(box, 'Keep this draft{Enter}')
  expect((await screen.findByRole('alert')).textContent).toContain('Your draft is still here')
  expect(box.value).toBe('Keep this draft')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(box.value).toBe(''))
  expect(send).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('does not send during IME composition or twice while a send is pending', async () => {
  gateway()
  let finish!: () => void
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  render(<MentionComposer placeholder="Message" onSend={send} />)
  const box = screen.getByRole('combobox') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'hello' } })
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(box, { key: 'Enter' })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(send).toHaveBeenCalledTimes(1)
  expect(box.readOnly).toBe(true)
  await act(async () => finish())
  expect(box.readOnly).toBe(false)
})

it('keeps channel entries as links and clears an unmatched search', async () => {
  gateway(() => ({ channels: [channel] }))
  render(<MemoryRouter><ChannelsIndex /></MemoryRouter>)
  const link = await screen.findByRole('link', { name: 'Open channel #team' })
  expect(link.closest('[role=listitem]')).toBeTruthy()
  await userEvent.type(screen.getByRole('searchbox'), 'missing')
  expect(screen.getByText('No channel matches')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Show all channels' }))
  expect(screen.getByRole('link', { name: 'Open channel #team' })).toBeTruthy()
})

it('pauses hidden task comments without reading new messages or losing their draft', async () => {
  let tick!: () => void
  let current = [msg('one')]
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const interval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, delay, ...args) => {
    if (delay === 15000) tick = fn as () => void
    return interval(fn, delay, ...args)
  })
  const fetcher = gateway(op => op === 'messages.list' ? thread(current) : {})
  const calls = (op: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(op)).length
  const view = (active: boolean) => <Thread subjectId="task" embedded active={active} />
  const { rerender } = render(view(true))
  await screen.findByText('Message one')
  await userEvent.type(screen.getByRole('combobox'), 'Keep this comment')
  expect(calls('messages.read')).toBe(1)
  rerender(view(false))
  current = [msg('one'), msg('two')]
  await act(async () => tick())
  expect(calls('messages.list')).toBe(1)
  expect(calls('messages.read')).toBe(1)
  rerender(view(true))
  await screen.findByText('Message two')
  expect(calls('messages.read')).toBe(2)
  expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('Keep this comment')
})

it('distinguishes a channel outage from a nonexistent channel and retries', async () => {
  let fail = true
  gateway(op => {
    if (op === 'channels.list' && fail) throw new Error('offline')
    return op === 'channels.list' ? { channels: [channel] } : thread([])
  })
  render(<MemoryRouter initialEntries={['/channels/channel-1']}><Routes>
    <Route path="/channels/:id" element={<ChannelView />} />
  </Routes></MemoryRouter>)
  await screen.findByRole('alert')
  expect(screen.queryByText(/No such channel/)).toBeNull()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('heading', { name: 'team' })
  expect(screen.getByRole('link', { name: '← All channels' })).toBeTruthy()
  await screen.findByText('Nothing said here yet.')
})

it('preserves reading position, groups days, and offers new messages without marking unseen ones read', async () => {
  let tick!: () => void
  const interval = globalThis.setInterval
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, delay, ...args) => {
    if (delay === 15000) tick = fn as () => void
    return interval(fn, delay, ...args)
  })
  let messages = [msg('one')]
  const fetcher = gateway(op => op === 'messages.list' ? thread(messages) : {})
  const { container } = render(<Thread subjectId="channel-1" variant="channel" />)
  await screen.findByText('Message one')
  const scroller = container.querySelector('.thread-scroll') as HTMLDivElement
  Object.defineProperties(scroller, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400 } })
  scroller.scrollTop = 100
  fireEvent.scroll(scroller)
  const reads = () => fetcher.mock.calls.filter(([url]) => String(url).includes('messages.read')).length
  const initialReads = reads()
  messages = [...messages, msg('two', '2026-09-29T10:00:00Z')]
  await act(async () => tick())
  await screen.findByText('Message two')
  expect(scroller.scrollTop).toBe(100)
  expect(container.querySelectorAll('.thread-day')).toHaveLength(2)
  expect(reads()).toBe(initialReads)
  await userEvent.click(screen.getByRole('button', { name: /Jump to latest/ }))
  expect(scroller.scrollTop).toBe(2000)
  expect(reads()).toBe(initialReads + 1)
})

it('keeps existing messages visible when refreshing fails', async () => {
  let tick!: () => void
  const interval = globalThis.setInterval
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, delay, ...args) => {
    if (delay === 15000) tick = fn as () => void
    return interval(fn, delay, ...args)
  })
  let fail = false
  gateway(op => {
    if (op === 'messages.list' && fail) throw new Error('offline')
    return op === 'messages.list' ? thread([msg('one')]) : {}
  })
  render(<Thread subjectId="channel-1" />)
  await screen.findByText('Message one')
  fail = true
  await act(async () => tick())
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Could not refresh messages')
  expect(screen.getByText('Message one')).toBeTruthy()
  fail = false
  await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('opens channel replies in their own panel and restores focus on close', async () => {
  gateway(op => op === 'messages.list' ? thread([msg('one'), { ...msg('reply'), parent_id: 'one' }]) : {})
  const { container } = render(<Thread subjectId="channel-1" variant="channel" />)
  const trigger = await screen.findByRole('button', { name: 'View 1 reply to Maya' })
  expect(screen.queryByText('Message reply')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(trigger)
  const panel = screen.getByRole('complementary', { name: 'Thread with Maya' })
  expect(within(panel).getByText('Message one')).toBeTruthy()
  expect(within(panel).getByText('Message reply')).toBeTruthy()
  expect(container.querySelector('.thread-main')?.textContent).not.toContain('Message reply')
  expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
  expect(document.activeElement).toBe(within(panel).getByRole('combobox'))
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('complementary')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('keeps separate thread drafts when switching or closing, without losing the channel draft', async () => {
  gateway(op => op === 'messages.list' ? thread([msg('one'), msg('two')]) : {})
  render(<Thread subjectId="channel-1" variant="channel" />)
  await screen.findByText('Message one')
  const channelBox = screen.getByRole('combobox') as HTMLTextAreaElement
  await userEvent.type(channelBox, 'Channel draft')
  const triggers = screen.getAllByRole('button', { name: 'Reply in thread' })
  await userEvent.click(triggers[0])
  await userEvent.type(screen.getByRole('combobox', { name: 'Reply to Maya' }), 'First thread draft')
  await userEvent.click(triggers[1])
  const second = screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement
  expect(second.value).toBe('')
  await userEvent.type(second, 'Second thread draft')
  await userEvent.click(screen.getByRole('button', { name: 'Close thread' }))
  await userEvent.click(triggers[0])
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('First thread draft')
  expect(channelBox.value).toBe('Channel draft')
  await userEvent.click(triggers[1])
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('Second thread draft')
})

it('sends a channel reply to the right parent, clears its draft and leaves the thread open', async () => {
  let messages = [msg('one')]
  const fetcher = gateway((op, body) => {
    if (op === 'messages.list') return thread(messages)
    if (op === 'messages.post') {
      const reply = { ...msg('sent'), body: String(body.body), parent_id: String(body.parent_id) }
      messages = [...messages, reply]
      return { message: reply, asked: [], not_asked: [] }
    }
    return {}
  })
  render(<Thread subjectId="channel-1" variant="channel" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Reply in thread' }))
  const box = screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement
  await userEvent.type(box, 'A useful follow-up{Enter}')
  const panel = screen.getByRole('complementary')
  expect(await within(panel).findByText('A useful follow-up')).toBeTruthy()
  await waitFor(() => expect(box.value).toBe(''))
  const sent = fetcher.mock.calls.find(([url]) => String(url).includes('messages.post'))
  expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ subject_id: 'channel-1', parent_id: 'one', body: 'A useful follow-up' })
  await userEvent.click(screen.getByRole('button', { name: 'Close thread' }))
  await userEvent.click(screen.getByRole('button', { name: 'View 1 reply to Maya' }))
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('')
})

it('retains a failed reply draft even after closing the panel', async () => {
  gateway(op => {
    if (op === 'messages.post') throw new Error('Offline')
    return op === 'messages.list' ? thread([msg('one')]) : {}
  })
  render(<Thread subjectId="channel-1" variant="channel" />)
  const trigger = await screen.findByRole('button', { name: 'Reply in thread' })
  await userEvent.click(trigger)
  await userEvent.type(screen.getByRole('combobox', { name: 'Reply to Maya' }), 'Keep this reply{Enter}')
  expect((await screen.findByRole('alert')).textContent).toContain('Your draft is still here')
  await userEvent.click(screen.getByRole('button', { name: 'Close thread' }))
  await userEvent.click(trigger)
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('Keep this reply')
})

it('prevents a duplicate reply when the thread is reopened during an in-flight send', async () => {
  let finish!: (value: unknown) => void
  const fetcher = gateway(op => op === 'messages.post' ? new Promise(resolve => { finish = resolve })
    : op === 'messages.list' ? thread([msg('one')]) : {})
  render(<Thread subjectId="channel-1" variant="channel" />)
  const trigger = await screen.findByRole('button', { name: 'Reply in thread' })
  await userEvent.click(trigger)
  await userEvent.type(screen.getByRole('combobox', { name: 'Reply to Maya' }), 'Only once{Enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Close thread' }))
  await userEvent.click(trigger)
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('messages.post'))).toHaveLength(1)
  await act(async () => finish({ message: msg('sent'), asked: [], not_asked: [] }))
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).disabled).toBe(false))
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('')
})

it('still lets people read replies to a deleted channel message', async () => {
  gateway(op => op === 'messages.list'
    ? thread([{ ...msg('one'), body: null, deleted: true }, { ...msg('reply'), parent_id: 'one' }]) : {})
  render(<Thread subjectId="channel-1" variant="channel" />)
  await userEvent.click(await screen.findByRole('button', { name: 'View 1 reply to Maya' }))
  const panel = screen.getByRole('complementary')
  expect(within(panel).getByText('Message reply')).toBeTruthy()
  expect(within(panel).getByText(/conversation is read-only/)).toBeTruthy()
  expect(within(panel).queryByRole('combobox')).toBeNull()
})

it('clears the thread selection and its drafts on a different channel', async () => {
  gateway(op => op === 'messages.list' ? thread([msg('one')]) : {})
  const { rerender } = render(<Thread subjectId="channel-1" variant="channel" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Reply in thread' }))
  await userEvent.type(screen.getByRole('combobox', { name: 'Reply to Maya' }), 'Private to this channel')
  rerender(<Thread subjectId="channel-2" variant="channel" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Reply in thread' }))
  expect((screen.getByRole('combobox', { name: 'Reply to Maya' }) as HTMLTextAreaElement).value).toBe('')
})

it('inserts a mention at the current selection without overwriting the rest of the message', async () => {
  gateway()
  const send = vi.fn()
  render(<MentionComposer placeholder="Message" onSend={send} />)
  const box = screen.getByRole('combobox') as HTMLTextAreaElement
  await userEvent.type(box, 'Hello someone, can you check?')
  box.setSelectionRange(6, 13)
  await userEvent.click(screen.getByRole('button', { name: 'Mention a person or agent' }))
  expect(box.value).toBe('Hello @, can you check?')
  expect(box.selectionStart).toBe(7)
  expect(document.activeElement).toBe(box)
  expect(send).not.toHaveBeenCalled()
})
