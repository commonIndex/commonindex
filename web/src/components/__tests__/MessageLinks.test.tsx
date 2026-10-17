import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageBody, Thread } from '../discussion/Thread'
import { MentionComposer } from '../discussion/MentionComposer'
import { LinkPreviewProvider, MessageLinkPreviews } from '../discussion/LinkPreviews'
import { messageLinks, previewLinks } from '../discussion/messageLinks'
import { forgetMentionables } from '../discussion/mentions'
import { DocumentBackdrop } from '../discussion/DocumentBackdrop'
import type { ItemPreview, ItemReference, WireMessage } from '../../data/gateway'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); forgetMentionables() })
const available = (item: ItemReference): ItemPreview => ({ ...item, available: true,
  title: `Title ${item.id}`, summary: 'A short summary', key: 'D-1', status: 'draft', detail: '3 panels' })
function stub(resolve: (items: ItemReference[]) => Promise<ItemPreview[]> | ItemPreview[] = items => items.map(available)) {
  const preview = vi.fn(resolve)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const data = String(url).endsWith('items.previews') ? { items: await preview(body.items) }
      : { people: [], agents: [] }
    return { ok: true, status: 200, json: async () => data }
  }))
  return preview
}

it('recognizes all item routes, doc edit links, and deep links without trusting foreign origins', () => {
  const pairs = [['docs/d', 'doc'], ['docs/edit/d', 'doc'], ['dashboards/d', 'dashboard'], ['experiments/e', 'experiment'],
    ['designs/d', 'design'], ['videos/v', 'video'], ['artifacts/a', 'artifact'], ['channels/c', 'channel'],
    ['agents/a', 'agent'], ['skills/s', 'skill'], ['board?task=t', 'task'], ['code?file=f&lines=1-3', 'code_file']]
  for (const [path, type] of pairs) {
    expect(previewLinks(`${window.location.origin}/${path}#comments`)[0]?.item?.type).toBe(type)
  }
  expect(previewLinks('https://elsewhere.test/docs/d /dashboards/new /experiments/plan /experiments/analysis //evil.test/docs/d /docs/a%2Fb /docs/%ZZ')).toEqual([])
  expect(previewLinks('https://user:secret@localhost/docs/d javascript:/docs/d /api/v1/docs.get')).toEqual([])
  expect(previewLinks(`http://localhost:9876/docs/d`)).toEqual([])
})

it('handles punctuation, markdown links, whitespace, deduplication and a three-card limit', () => {
  const text = `See [the doc](/docs/edit/d1), then (/dashboards/d2#comments).\n/experiments/e! /docs/d1 /videos/v /designs/z`
  const links = messageLinks(text)
  expect(links[0]).toMatchObject({ label: 'the doc', href: '/docs/edit/d1', item: { id: 'd1', type: 'doc' } })
  expect(links[1].href).toBe('/dashboards/d2#comments')
  expect(links[2].href).toBe('/experiments/e')
  expect(previewLinks(text).map(l => l.item!.id)).toEqual(['d1', 'd2', 'e'])
  expect(messageLinks('https://example.test/a_(b).')[0].href).toBe('https://example.test/a_(b)')
})

it('keeps mentions and literal HTML safe while making links clickable', async () => {
  const preview = stub()
  const { container } = render(<MessageBody text={'@maya see [runbook](/docs/d). <img src=x onerror=alert(1)> https://example.test/@maya'}
    mentions={[{ id: 'maya', name: 'Maya', kind: 'human' }]} />)
  expect(container.querySelectorAll('.mention')).toHaveLength(1)
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByRole('link', { name: 'runbook' }).getAttribute('href')).toBe('/docs/d')
  expect(screen.getByRole('link', { name: 'https://example.test/@maya' }).getAttribute('rel')).toBe('noopener noreferrer')
  await screen.findByRole('link', { name: 'Open document: Title d (new tab)' })
  expect(preview).toHaveBeenCalledWith([{ id: 'd', type: 'doc' }])
})

it('batches and deduplicates across messages and reply context, including StrictMode', async () => {
  const preview = stub()
  render(<StrictMode><LinkPreviewProvider>
    <MessageBody text="/docs/d /dashboards/a" mentions={[]} />
    <MessageBody text="/docs/edit/d" mentions={[]} />
  </LinkPreviewProvider></StrictMode>)
  await waitFor(() => expect(screen.getAllByText('Title d')).toHaveLength(2))
  expect(preview).toHaveBeenCalledTimes(1)
  expect(preview.mock.calls[0][0]).toHaveLength(2)
})

it('shows actual document blocks behind the card, never injected HTML or an active embedded page', async () => {
  stub(items => items.map(item => ({ ...available(item), document: { blocks: [
    { kind: 'heading', text: 'Launch checklist' }, { kind: 'paragraph', text: 'Pilot begins on Monday.' },
    { kind: 'list', ordered: false, items: ['Invite Maya', 'Review the runbook'] },
    { kind: 'table', rows: [['Owner', 'Status'], ['Maya', 'Ready']] },
    { kind: 'quote', text: '<script>unsafe()</script>' },
  ] } })))
  const { container } = render(<MessageBody text="/docs/d" mentions={[]} />)
  await screen.findByText('Launch checklist')
  const background = container.querySelector('.message-doc-backdrop')!
  expect(background.getAttribute('aria-hidden')).toBe('true')
  expect(background.querySelector('p')?.textContent).toBe('Pilot begins on Monday.')
  expect(background.querySelectorAll('li')).toHaveLength(2)
  expect(background.querySelectorAll('td')).toHaveLength(4)
  expect(background.querySelector('blockquote')?.textContent).toBe('<script>unsafe()</script>')
  expect(container.querySelector('iframe, script')).toBeNull()
  expect(screen.getByRole('link', { name: 'Open document: Title d (new tab)' })).toBeTruthy()
})

it('removes document body content as soon as a permission refresh denies the doc', async () => {
  let allowed = true
  stub(items => items.map(item => ({ ...available(item), available: allowed,
    document: { blocks: [{ kind: 'paragraph', text: 'Visible only with access' }] } })))
  const view = (n: number) => <LinkPreviewProvider refreshKey={n}><MessageBody text="/docs/d" mentions={[]} /></LinkPreviewProvider>
  const { rerender } = render(view(1))
  await screen.findByText('Visible only with access')
  allowed = false; rerender(view(2))
  await screen.findByText('Preview unavailable')
  expect(screen.queryByText('Visible only with access')).toBeNull()
})

it('loads a saved embedded page with authenticated image requests and releases its URL on version changes', async () => {
  const create = vi.fn().mockReturnValueOnce('blob:preview-one').mockReturnValueOnce('blob:preview-two')
  const revoke = vi.fn()
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = create; static revokeObjectURL = revoke })
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) }))
  vi.stubGlobal('fetch', fetcher)
  const view = (version: string) => <DocumentBackdrop blocks={[{ kind: 'snapshot', artifact_id: 'page', version }]} />
  const { container, rerender, unmount } = render(view('v1'))
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-one'))
  const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]
  expect(url).toMatch(/\/api\/v1\/artifacts.snapshot$/)
  expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ artifact_id: 'page' }) })
  expect(init.signal).toBeInstanceOf(AbortSignal)
  rerender(view('v2'))
  expect(container.querySelector('img')).toBeNull()
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-two'))
  expect(revoke).toHaveBeenCalledWith('blob:preview-one')
  expect(container.querySelector('iframe')).toBeNull()
  unmount()
  expect(revoke).toHaveBeenCalledWith('blob:preview-two')
})

it.each([404, 200])('does not embed HTML or bypass unavailable saved images (status %s)', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status === 200, status,
    blob: async () => new Blob(['<script>unsafe()</script>'], { type: 'text/html' }) })))
  const { container } = render(<DocumentBackdrop blocks={[{ kind: 'snapshot', artifact_id: 'denied', version: 'v1' }]} />)
  await screen.findByText('Embedded preview unavailable')
  expect(container.querySelector('img, iframe, script')).toBeNull()
})

it('batches at most 24 references and does not fetch external links', async () => {
  const preview = stub()
  render(<LinkPreviewProvider>{Array.from({ length: 26 }, (_, i) => <MessageLinkPreviews key={i} text={`/docs/d${i}`} />)}
    <MessageLinkPreviews text="https://example.test/docs/private" /></LinkPreviewProvider>)
  await screen.findByText('Title d25')
  expect(preview.mock.calls.map(([items]) => items.length)).toEqual([24, 2])
})

it('rechecks permission on refresh and removes previously visible metadata on denial', async () => {
  let allowed = true
  const preview = stub(items => items.map(i => allowed ? available(i) : { ...i, available: false }))
  const view = (key: number) => <LinkPreviewProvider refreshKey={key}><MessageBody text="/docs/d" mentions={[]} /></LinkPreviewProvider>
  const { rerender } = render(view(1))
  await screen.findByText('Title d')
  allowed = false; rerender(view(2))
  await screen.findByText('Preview unavailable')
  expect(screen.queryByText('Title d')).toBeNull()
  expect(screen.queryByText('A short summary')).toBeNull()
  expect(preview).toHaveBeenCalledTimes(2)
})

it('offers a retry for an outage, distinct from an inaccessible item', async () => {
  let failed = true
  stub(items => { if (failed) throw new Error('offline'); return items.map(available) })
  render(<MessageBody text="/docs/d" mentions={[]} />)
  await screen.findByText('Preview could not load')
  failed = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
  await screen.findByText('Title d')
  expect(screen.queryByRole('button', { name: 'Retry preview' })).toBeNull()
})

it('discards obsolete responses after a message link is edited', async () => {
  let finish!: (items: ItemPreview[]) => void
  stub(items => items[0].id === 'old' ? new Promise(resolve => { finish = resolve }) : items.map(available))
  const { rerender } = render(<MessageBody text="/docs/old" mentions={[]} />)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  rerender(<MessageBody text="/docs/new-doc" mentions={[]} />)
  await screen.findByText('Title new-doc')
  await act(async () => finish([available({ id: 'old', type: 'doc' })]))
  expect(screen.queryByText('Title old')).toBeNull()
})

it('shows draft previews without altering or sending the original message', async () => {
  stub()
  const send = vi.fn().mockResolvedValue(undefined)
  render(<MentionComposer placeholder="Message channel" onSend={send} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Look at /docs/d' } })
  await screen.findByText('Title d')
  expect(send).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(send).toHaveBeenCalledWith('Look at /docs/d')
  expect(screen.queryByText('Title d')).toBeNull()
})

it('groups consecutive same-author channel messages, but not across authors, days or long gaps', async () => {
  const message = (id: string, time: string, author = 'maya'): WireMessage => ({
    id, created_at: time, body: `Message ${id}`, author: { id: author, name: author, kind: 'human' },
    deleted: false, edited_at: null, parent_id: null, mentions: [], you: { may_edit: false, may_delete: false },
  })
  const messages = [message('a', '2026-10-06T10:00:00'), message('b', '2026-10-06T10:02:00'),
    message('c', '2026-10-06T10:03:00', 'alex'), message('d', '2026-10-06T12:00:00'), message('e', '2026-10-07T12:00:00')]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => String(url).endsWith('messages.list')
    ? { subject: { id: 'channel', title: 'team', type: 'channel' }, messages, waiting: {} } : { people: [], agents: [] } })))
  const { container } = render(<Thread subjectId="channel" variant="channel" />)
  await screen.findByText('Message b')
  expect(container.querySelectorAll('.continuation')).toHaveLength(1)
  expect(container.querySelector('.continuation')?.getAttribute('data-message')).toBe('b')
  expect(container.querySelectorAll('.thread-day')).toHaveLength(2)
})
