/**
 * Videos, as the pages offer them.
 *
 * Defended: a new video is created from a title, a brief and a format; a
 * video's page renders what is saved and says so while it renders; a server
 * that can't render says what is missing instead of offering the button.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VideoDetail, VideosView } from '../Videos'

const VIDEO = { id: 'video-1', key: 'VID-1', title: 'Launch', brief: '20s launch', format: 'landscape',
  state: 'draft', composition: '<div data-composition-id="main"></div>', updated_at: null, render: null }

function gateway(answers: Record<string, unknown>) {
  const calls: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    return { ok: true, status: 200, json: async () => answers[op] ?? {} } as Response
  }))
  return calls
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

const gallery = () => render(<MemoryRouter><Routes><Route path="/" element={<VideosView />} />
  <Route path="/videos/:id" element={<p>the new video</p>} /></Routes></MemoryRouter>)
const openNew = async (u: ReturnType<typeof userEvent.setup>) => {
  await u.click((await screen.findAllByRole('button', { name: '+ New video' }))[0])
  return screen.getByRole('form', { name: 'New video' })
}

const detail = () => render(<MemoryRouter initialEntries={['/videos/video-1']}><Routes>
  <Route path="/videos/:id" element={<VideoDetail />} />
</Routes></MemoryRouter>)

it('creates a video from a title, a brief and a format', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] }, 'videos.propose': { id: 'video-2' } })
  render(<MemoryRouter><Routes><Route path="/" element={<VideosView />} />
    <Route path="/videos/:id" element={<p>the new video</p>} /></Routes></MemoryRouter>)
  await u.click((await screen.findAllByRole('button', { name: '+ New video' }))[0])
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Q4 launch')
  await u.type(screen.getByRole('textbox', { name: /^Brief/ }), '25 seconds, calm')
  await u.click(screen.getByRole('radio', { name: /Portrait/ }))
  await u.click(screen.getByRole('button', { name: 'Create video' }))
  expect(await screen.findByText('the new video')).toBeTruthy()
  expect(calls.find(c => c.op === 'videos.propose')!.body).toMatchObject({ title: 'Q4 launch', brief: '25 seconds, calm', format: 'portrait' })
})

it('renders what is saved, and says so while it renders', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.get': { video: VIDEO }, 'videos.tools': { renderer: true, ffmpeg: true, ready: true, formats: ['mp4', 'webm'] },
                          'videos.render': { video_id: 'video-1', state: 'rendering' } })
  detail()
  await u.click(await screen.findByRole('button', { name: 'Render MP4' }))
  expect(calls.find(c => c.op === 'videos.render')!.body).toMatchObject({ video_id: 'video-1', format: 'mp4' })
})

it('says what is missing when the server cannot render', async () => {
  gateway({ 'videos.get': { video: VIDEO }, 'videos.tools': { renderer: true, ffmpeg: false, ready: false, formats: [] } })
  detail()
  expect(await screen.findByText(/can’t render yet: ffmpeg not/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Render MP4' }) as HTMLButtonElement).disabled).toBe(true)
})

it('filters videos by brief, ID, status, and format, and can clear an empty result', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [VIDEO,
    { ...VIDEO, id: 'video-2', key: 'VID-2', title: 'Mobile tour', brief: 'Onboarding for customers', format: 'portrait', state: 'ready' },
    { ...VIDEO, id: 'video-3', key: 'VID-3', title: 'Feed promo', format: 'square', state: 'failed' },
  ] } })
  gallery()
  await screen.findByRole('link', { name: 'Open video: Launch' })
  await u.type(screen.getByRole('searchbox', { name: 'Search videos' }), ' onboarding ')
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Open video: Mobile tour' }).getAttribute('href')).toBe('/videos/video-2')
  await u.selectOptions(screen.getByRole('combobox', { name: 'Video status' }), 'draft')
  expect(screen.getByText('No matching videos')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Show all videos' }))
  expect(screen.getAllByRole('link')).toHaveLength(3)
  await u.selectOptions(screen.getByRole('combobox', { name: 'Video format' }), 'square')
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Open video: Feed promo' })).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Clear filters' }))
  await u.type(screen.getByRole('searchbox'), 'vid-1')
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(calls.filter(c => c.op === 'videos.list')).toHaveLength(1)
})

it('shows real state and rounds duration without showing 0:60', async () => {
  gateway({ 'videos.list': { videos: [{ ...VIDEO, state: 'ready', visibility: 'private', render: { seconds: 59.8 } }] } })
  gallery()
  const card = await screen.findByRole('link', { name: 'Open video: Launch' })
  expect(within(card).getByText('Ready')).toBeTruthy()
  expect(within(card).getByText('1:00')).toBeTruthy()
  expect(within(card).getByText('Private')).toBeTruthy()
  expect(within(card).getByText('Video ready')).toBeTruthy()
  expect(within(card).queryByRole('img')).toBeNull()
})

it('recovers from gallery errors without a stale alert or loading message', async () => {
  const u = userEvent.setup()
  gateway({ 'videos.list': { videos: [VIDEO] } })
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline'))
  gallery()
  expect((await screen.findByRole('alert')).textContent).toContain('Offline')
  expect(screen.queryByText('Loading videos…')).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('link', { name: 'Open video: Launch' })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retains an unsubmitted brief and format when cancelling and reopening the inline creator', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] } })
  gallery()
  await openNew(u)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'My draft')
  await u.type(screen.getByRole('textbox', { name: /^Brief/ }), 'Keep these ideas')
  await u.click(screen.getByRole('radio', { name: /Square/ }))
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('form', { name: 'New video' })).toBeNull()
  await openNew(u)
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('My draft')
  expect((screen.getByRole('textbox', { name: /^Brief/ }) as HTMLTextAreaElement).value).toBe('Keep these ideas')
  expect((screen.getByRole('radio', { name: /Square/ }) as HTMLInputElement).checked).toBe(true)
  expect(calls.filter(c => c.op === 'videos.propose')).toHaveLength(0)
})

it('fills an editable example without overwriting a written brief or creating a video', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] } })
  gallery()
  await openNew(u)
  await u.click(screen.getByRole('button', { name: 'Product launch' }))
  const brief = screen.getByRole('textbox', { name: /^Brief/ }) as HTMLTextAreaElement
  expect(brief.value).toContain('25-second product launch')
  expect((screen.getByRole('button', { name: 'Explainer' }) as HTMLButtonElement).disabled).toBe(true)
  await u.type(brief, ' Use our brand colors.')
  expect(brief.value).toContain('Use our brand colors.')
  await u.clear(brief)
  await u.click(screen.getByRole('button', { name: 'Explainer' }))
  expect(brief.value).toContain('45-second explainer')
  expect(calls.filter(c => c.op === 'videos.propose')).toHaveLength(0)
})

it('keeps creation in the page without an overlay or focus trap, and restores focus after Cancel', async () => {
  // jsdom does not expose CSS.escape; the only identifier used here is "format".
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  const u = userEvent.setup()
  gateway({ 'videos.list': { videos: [] } })
  const { container } = render(<MemoryRouter><Link to="/docs">Docs</Link><VideosView /><button>After collection</button></MemoryRouter>)
  const trigger = (await screen.findAllByRole('button', { name: '+ New video' }))[0]
  await u.click(trigger)
  const form = screen.getByRole('form', { name: 'New video' })
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }))
  expect(container.contains(form)).toBe(true)
  expect(form.closest('.dash-gallery-scroll')).toBeTruthy()
  expect(container.querySelectorAll('.dash-gallery-scroll')).toHaveLength(1)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.share-overlay')).toBeNull()
  expect(container.inert).toBeFalsy()
  expect(container.hasAttribute('aria-hidden')).toBe(false)
  expect(screen.getByRole('link', { name: 'Docs' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: /Videos/ })).toBeTruthy()
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Focus test')
  screen.getByRole('button', { name: 'Create video' }).focus()
  await u.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After collection' }))
  await u.tab({ shift: true })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create video' }))
  screen.getByRole('radio', { name: /Landscape/ }).focus()
  await u.keyboard('{ArrowRight}')
  expect((screen.getByRole('radio', { name: /Portrait/ }) as HTMLInputElement).checked).toBe(true)
  await u.keyboard('{Escape}')
  expect(screen.getByRole('form', { name: 'New video' })).toBe(form)
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.activeElement).toBe(screen.getAllByRole('button', { name: '+ New video' })[0])
})

it('does not submit a blank title and allows creating without an optional brief', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] }, 'videos.propose': { id: 'video-2' } })
  gallery()
  const form = await openNew(u)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), '   ')
  fireEvent.submit(form)
  expect(calls.filter(c => c.op === 'videos.propose')).toHaveLength(0)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Launch   ')
  await u.click(screen.getByRole('button', { name: 'Create video' }))
  await screen.findByText('the new video')
  expect(calls.find(c => c.op === 'videos.propose')!.body).toMatchObject({ title: 'Launch', brief: '', format: 'landscape' })
  expect(calls.some(c => c.op === 'videos.render')).toBe(false)
})

it('prevents duplicate submissions and dismissal while creation is pending, then retains errors for retry', async () => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] }, 'videos.propose': { id: 'video-2' } })
  gallery()
  const form = await openNew(u)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Pending launch')
  let reject!: (reason: Error) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((_, fail) => { reject = fail }))
  const before = vi.mocked(fetch).mock.calls.length
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(vi.mocked(fetch).mock.calls.length).toBe(before + 1)
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(form, { key: 'Escape' })
  fireEvent.click(form.parentElement!)
  expect(screen.getByRole('form', { name: 'New video' })).toBe(form)
  await act(async () => { reject(new Error('Connection interrupted')) })
  expect((await screen.findByRole('alert')).textContent).toContain('Your brief is still here')
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Pending launch')
  await u.click(screen.getByRole('button', { name: 'Create video' }))
  await screen.findByText('the new video')
  expect(calls.find(c => c.op === 'videos.propose')!.body.title).toBe('Pending launch')
})

it('replaces gallery tools while creating and returns to the same filters on Cancel', async () => {
  const u = userEvent.setup()
  gateway({ 'videos.list': { videos: [VIDEO, { ...VIDEO, id: 'video-2', title: 'Tour', format: 'portrait' }] } })
  gallery()
  await screen.findByRole('searchbox', { name: 'Search videos' })
  await u.type(screen.getByRole('searchbox'), 'Tour')
  await u.selectOptions(screen.getByRole('combobox', { name: 'Video format' }), 'portrait')
  await openNew(u)
  expect(screen.queryByRole('list', { name: 'Videos' })).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: '+ New video' })).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Tour')
  expect((screen.getByRole('combobox', { name: 'Video format' }) as HTMLSelectElement).value).toBe('portrait')
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Open video: Tour' })).toBeTruthy()
})

it.each(['Control', 'Meta'])('supports %s+Enter creation without consuming a normal brief newline', async modifier => {
  const u = userEvent.setup()
  const calls = gateway({ 'videos.list': { videos: [] }, 'videos.propose': { id: 'video-2' } })
  gallery()
  await openNew(u)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Keyboard launch')
  await u.type(screen.getByRole('textbox', { name: /^Brief/ }), 'First scene{Enter}Second scene')
  expect(calls.filter(c => c.op === 'videos.propose')).toHaveLength(0)
  await u.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
  await screen.findByText('the new video')
  expect(calls.find(c => c.op === 'videos.propose')!.body).toMatchObject({ title: 'Keyboard launch', brief: 'First scene\nSecond scene' })
})

it('does not redirect from another collection when a pending creation finishes', async () => {
  const u = userEvent.setup()
  gateway({ 'videos.list': { videos: [] } })
  render(<MemoryRouter><Link to="/docs">Docs</Link><Routes>
    <Route path="/" element={<VideosView />} />
    <Route path="/docs" element={<h1>Documents</h1>} />
    <Route path="/videos/:id" element={<p>the new video</p>} />
  </Routes></MemoryRouter>)
  await openNew(u)
  await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Background launch')
  let resolve!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
  await u.click(screen.getByRole('button', { name: 'Create video' }))
  await u.click(screen.getByRole('link', { name: 'Docs' }))
  await act(async () => { resolve({ ok: true, json: async () => ({ id: 'video-2' }) } as Response) })
  expect(screen.getByRole('heading', { name: 'Documents' })).toBeTruthy()
  expect(screen.queryByText('the new video')).toBeNull()
})

it('refreshes a rendering video and stops polling after it is ready', async () => {
  vi.useFakeTimers()
  const answers = { 'videos.list': { videos: [{ ...VIDEO, state: 'rendering' }] } }
  const calls = gateway(answers)
  gallery()
  await act(async () => {})
  expect(screen.getByText('Rendering your video')).toBeTruthy()
  answers['videos.list'] = { videos: [{ ...VIDEO, state: 'ready' }] }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByText('Video ready')).toBeTruthy()
  expect(calls.filter(c => c.op === 'videos.list')).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(calls.filter(c => c.op === 'videos.list')).toHaveLength(2)
})

it('gives a new draft actions to review its brief or paste a composition', async () => {
  const u = userEvent.setup()
  gateway({ 'videos.get': { video: { ...VIDEO, composition: '' } }, 'videos.tools': { ready: true } })
  detail()
  await u.click(await screen.findByRole('button', { name: 'Review brief' }))
  expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('20s launch')
  await u.click(screen.getByRole('button', { name: 'Paste composition' }))
  expect(screen.getByRole('textbox', { name: 'Composition HTML' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Render MP4' }) as HTMLButtonElement).disabled).toBe(true)
})

it('fetches real poster images and releases their object URLs when leaving the gallery', async () => {
  const create = vi.fn(() => 'blob:real-poster'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  gateway({ 'videos.list': { videos: [{ ...VIDEO, state: 'ready', render: { poster: true, finished_at: '2026-10-04T00:00:00Z' } }] } })
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith('videos.file')
    ? { ok: true, blob: async () => new Blob(['poster'], { type: 'image/png' }) } as Response : original(url, init))
  const view = gallery()
  await waitFor(() => expect(view.container.querySelector('.vcard-thumb img')?.getAttribute('src')).toBe('blob:real-poster'))
  expect(create).toHaveBeenCalledOnce()
  view.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:real-poster')
})

describe('a written draft', () => {
  it('says what it holds rather than "Your next story starts here"', async () => {
    const { draftSummary } = await import('../Videos')
    const html = '<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="18">'
      + '<section data-start="0" data-duration="6"><h1>Ask from your order page</h1></section>'
      + '<section data-start="6" data-duration="6"><h1>Most refunds are instant</h1></section>'
      + '<section data-start="12" data-duration="6"><h1>Money back in 5–10 days</h1></section></div>'
    expect(draftSummary(html)).toEqual({ scenes: 3, seconds: 18, first: 'Ask from your order page' })
    expect(draftSummary('')).toBeNull()
  })
})
