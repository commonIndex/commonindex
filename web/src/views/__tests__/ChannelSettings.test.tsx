/**
 * A channel's settings, from its page.
 *
 * Defended: the header offers Share (who can see it) and Settings (its name,
 * topic, and archiving); a rename is sent as a rename; an archived channel is
 * read, not written in; a new channel can start private.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelsIndex, ChannelView } from '../Channels'

const CHANNEL = { id: 'channel-1', key: 'CH-1', name: 'test', topic: 'test', visibility: 'workspace', archived: false,
  messages: 0, last_at: null, last: null }

function gateway(channel: object = CHANNEL) {
  const calls: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    const out = op === 'channels.list' ? { channels: [channel] }
      : op === 'channels.update' ? { channel: { ...channel, ...body } }
      : op === 'channels.archive' ? { channel: { ...channel, archived: body.archived } }
      : op === 'channels.propose' ? { channel: { ...CHANNEL, id: 'channel-2', name: body.name }, created: true }
      : op === 'messages.list' ? { subject: { id: 'channel-1' }, messages: [], waiting: {} }
      : op === 'items.access' ? { id: 'channel-1', visibility: 'workspace', general: 'role', you: 'manage', people: [] }
      : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const view = () => render(<MemoryRouter initialEntries={['/channels/channel-1']}><Routes>
  <Route path="/channels/:id" element={<ChannelView />} />
</Routes></MemoryRouter>)

describe('channel settings', () => {
  it('renames a channel and changes its topic', async () => {
    const u = userEvent.setup()
    const calls = gateway()
    view()
    expect(await screen.findByRole('button', { name: /Share/ })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Settings for #test' })
    const name = within(dialog).getAllByRole('textbox')[0]
    await u.clear(name); await u.type(name, 'Launch Team')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(calls.find(c => c.op === 'channels.update')!.body).toMatchObject({ channel_id: 'channel-1', name: 'launch-team' })
    expect(await screen.findByRole('heading', { name: 'launch-team' })).toBeTruthy()
  })

  it('archives a channel, and then it is read, not written in', async () => {
    const u = userEvent.setup()
    const calls = gateway()
    view()
    await u.click(await screen.findByRole('button', { name: 'Settings' }))
    await u.click(screen.getByRole('button', { name: 'Archive' }))
    expect(calls.find(c => c.op === 'channels.archive')!.body).toMatchObject({ channel_id: 'channel-1', archived: true })
    expect(await screen.findByText(/This channel is archived/)).toBeTruthy()
    expect(screen.getByText(/unarchive it in Settings to post again/)).toBeTruthy()
  })

  it('starts a channel private when asked', async () => {
    const u = userEvent.setup()
    const calls = gateway()
    render(<MemoryRouter><ChannelsIndex /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: '+ New channel' }))
    await u.type(screen.getByPlaceholderText('refund-incidents'), 'leadership')
    await u.click(screen.getByRole('checkbox', { name: /Private/ }))
    await u.click(screen.getByRole('button', { name: 'Create channel' }))
    expect(calls.find(c => c.op === 'channels.propose')!.body).toMatchObject({ name: 'leadership', private: true })
  })
})
