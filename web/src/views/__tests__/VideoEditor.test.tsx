import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { previewTiming } from '../../components/VideoPreview'
import { VideoDetail } from '../Videos'

const HTML = '<style>h1{color:red}</style><div data-composition-id="main" data-width="1920" data-height="1080" data-duration="8"><section id="one" data-start="0" data-duration="4"><h1>First</h1><p>First copy</p></section><section id="two" data-start="4" data-duration="4"><h1>Second</h1></section></div>'
const VIDEO = { id: 'video-1', key: 'VID-1', title: 'Launch', brief: 'Original brief', format: 'landscape', state: 'draft', composition: HTML, updated_at: null, render: null }
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response
function gateway(overrides = {}, answers: Record<string, unknown> = {}) {
  let video = { ...VIDEO, ...overrides }
  const calls: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1], body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    if (op in answers) return response(answers[op])
    if (op === 'videos.get') return response({ video })
    if (op === 'videos.tools') return response({ ready: true, ffmpeg: true, renderer: true, formats: ['mp4', 'webm'] })
    if (op === 'videos.save') { video = { ...video, ...body, state: 'draft' }; return response({ state: 'draft' }) }
    if (op === 'videos.render') { video = { ...video, state: 'rendering' }; return response({ state: 'rendering' }) }
    if (op === 'videos.file') return { ok: true, blob: async () => new Blob(['video']) } as Response
    return response({})
  }))
  return calls
}
function mount() {
  return render(<MemoryRouter initialEntries={['/videos/video-1']}><Routes><Route path="/videos/:id" element={<VideoDetail />} /></Routes></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

// These tests answer for the preview frame themselves; how long a busy machine
// takes to get there must not decide them (VideoPreview's own tests cover the
// timeout). A day, not Infinity: setTimeout reads Infinity as 0.
const realReady = previewTiming.readyTimeoutMs
beforeEach(() => { previewTiming.readyTimeoutMs = 24 * 3600_000 })
afterEach(() => { previewTiming.readyTimeoutMs = realReady })

it('uses the platform dropdown for scene context and retains the whole-video choice', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  const context = await screen.findByRole('combobox', { name: 'AI context' })
  expect(context.closest('.share-pick')).not.toBeNull()
  expect((context as HTMLSelectElement).value).toBe('scene')
  await u.click(screen.getByRole('button', { name: 'Preview scene 2: Second' }))
  expect(within(context).getByRole('option', { name: 'Selected scene · 2' })).toBeTruthy()
  await u.selectOptions(context, 'video')
  await u.click(screen.getByRole('button', { name: 'Preview scene 1: First' }))
  expect((context as HTMLSelectElement).value).toBe('video')
})

it('previews AI changes using the current unsaved draft, accepts once, and undoes without saving', async () => {
  const u = userEvent.setup()
  const local = HTML.replace('First copy', 'My own draft')
  const suggested = local.replace('First</h1>', 'Better heading</h1>')
  const calls = gateway({}, { 'videos.assist': { composition: suggested, summary: 'A stronger heading.', model: 'test-model' } })
  mount()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Text 2' }), { target: { value: 'My own draft' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe a video change' }), { target: { value: 'Improve the heading' } })
  await u.click(screen.getByRole('button', { name: 'Preview changes' }))
  await screen.findByText('A stronger heading.')
  expect(calls.find(c => c.op === 'videos.assist')!.body).toMatchObject({ instruction: 'Improve the heading', context: 'Scene 1: First (0s–4s)' })
  expect(String(calls.find(c => c.op === 'videos.assist')!.body.composition)).toContain('My own draft')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('Better heading')
  await u.click(screen.getByRole('button', { name: 'Before' }))
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('First')
  await u.click(screen.getByRole('button', { name: 'After' }))
  await u.click(screen.getByRole('button', { name: 'Accept changes' }))
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('Better heading')
  await u.click(screen.getByRole('button', { name: 'Undo' }))
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('First')
  expect((screen.getByRole('textbox', { name: 'Text 2' }) as HTMLTextAreaElement).value).toBe('My own draft')
  expect(calls.filter(c => ['videos.save', 'videos.render'].includes(c.op))).toHaveLength(0)
})

it('discards a suggestion without changing the local draft and supports keyboard requests', async () => {
  const u = userEvent.setup()
  gateway({}, { 'videos.assist': { composition: HTML.replace('First copy', 'AI copy'), summary: 'New copy.', model: 'test-model' } })
  mount()
  const prompt = await screen.findByRole('textbox', { name: 'Describe a video change' })
  fireEvent.change(prompt, { target: { value: 'Improve copy' } })
  fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })
  await u.click(await screen.findByRole('button', { name: 'Discard suggestion' }))
  expect((screen.getByRole('textbox', { name: 'Text 2' }) as HTMLTextAreaElement).value).toBe('First copy')
  expect(screen.getByText('All changes saved')).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Describe a video change' }) as HTMLTextAreaElement).value).toBe('Improve copy')
})

it('keeps the request and draft after a failed model call so it can be retried', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  const prompt = await screen.findByRole('textbox', { name: 'Describe a video change' })
  fireEvent.change(prompt, { target: { value: 'Make it clearer' } })
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Model is not configured'))
  await u.click(screen.getByRole('button', { name: 'Preview changes' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Model is not configured')
  expect((prompt as HTMLTextAreaElement).value).toBe('Make it clearer')
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('First')
  expect((screen.getByRole('button', { name: 'Preview changes' }) as HTMLButtonElement).disabled).toBe(false)
})

it('answers questions without creating an edit or a save', async () => {
  const u = userEvent.setup(), calls = gateway({}, { 'videos.assist': { composition: HTML, summary: 'Try a shorter title.', model: 'test-model' } })
  mount()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Describe a video change' }), { target: { value: 'What would you improve?' } })
  await u.click(screen.getByRole('button', { name: 'Preview changes' }))
  await screen.findByText('Try a shorter title.')
  expect(screen.queryByRole('button', { name: 'Accept changes' })).toBeNull()
  expect(calls.filter(c => c.op === 'videos.save')).toHaveLength(0)
})

it('queues an agent request with scene context and does not claim to run an agent', async () => {
  const u = userEvent.setup(), calls = gateway({}, { 'agents.list': { agents: [{ id: 'scribe', display: 'Scribe' }] },
    'agents.ask': { seq: 9, repeat: false, note: 'queued' } })
  mount()
  await u.selectOptions(await screen.findByRole('combobox', { name: 'AI editing method' }), 'agent')
  await screen.findByRole('option', { name: 'Scribe' })
  await u.selectOptions(screen.getByRole('combobox', { name: 'Agent to ask' }), 'scribe')
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe a video change' }), { target: { value: 'Make the title bigger' } })
  await u.click(screen.getByRole('button', { name: 'Send request' }))
  await screen.findByText(/Request queued for Scribe/)
  expect(calls.find(c => c.op === 'agents.ask')!.body).toMatchObject({ agent_id: 'scribe', object_id: 'video-1' })
  expect(calls.find(c => c.op === 'agents.ask')!.body.note).toContain('Scene 1: First')
  expect(calls.filter(c => ['videos.assist', 'videos.save', 'videos.render'].includes(c.op))).toHaveLength(0)
})

it('requires saving local changes before handing the video to an external agent', async () => {
  const u = userEvent.setup()
  gateway({}, { 'agents.list': { agents: [{ id: 'scribe', display: 'Scribe' }] } }); mount()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Heading 1' }), { target: { value: 'Local change' } })
  await u.selectOptions(screen.getByRole('combobox', { name: 'AI editing method' }), 'agent')
  await screen.findByRole('option', { name: 'Scribe' })
  await u.selectOptions(screen.getByRole('combobox', { name: 'Agent to ask' }), 'scribe')
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe a video change' }), { target: { value: 'Update it' } })
  expect((screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Save or discard your edits before asking an agent/)).toBeTruthy()
})

it('shows model setup guidance and still offers the agent path when no LLM is configured', async () => {
  const u = userEvent.setup()
  gateway({}, { 'videos.tools': { ready: true, ffmpeg: true, renderer: true, formats: ['mp4'], ai_configured: false },
    'agents.list': { agents: [] } })
  mount()
  await screen.findByText(/No LLM is configured on this server/)
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe a video change' }), { target: { value: 'Improve this scene' } })
  expect((screen.getByRole('button', { name: 'Preview changes' }) as HTMLButtonElement).disabled).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Ask an agent instead' }))
  await screen.findByRole('link', { name: 'Set up an agent →' })
  expect((screen.getByRole('textbox', { name: 'Describe a video change' }) as HTMLTextAreaElement).value).toBe('Improve this scene')
})

it('locks editing during generation and prevents duplicate requests', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  const prompt = await screen.findByRole('textbox', { name: 'Describe a video change' })
  fireEvent.change(prompt, { target: { value: 'Improve this scene' } })
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await u.click(screen.getByRole('button', { name: 'Preview changes' }))
  expect((prompt as HTMLTextAreaElement).disabled).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Heading 1' }).closest('fieldset')!.disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Preview scene 2: Second' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('videos.assist'))).toHaveLength(1)
  await act(async () => finish(response({ composition: HTML.replace('First copy', 'Better copy'), summary: 'Updated copy.', model: 'test-model' })))
  await u.click(screen.getByRole('button', { name: 'Discard suggestion' }))
  expect(screen.getByRole('textbox', { name: 'Heading 1' }).closest('fieldset')!.disabled).toBe(false)
})

it('retains title and brief across tabs and saves all edits through the header', async () => {
  const u = userEvent.setup(), calls = gateway()
  mount()
  await u.click(await screen.findByRole('button', { name: 'Details' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'New launch' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Keep this brief' } })
  await u.click(screen.getByRole('button', { name: 'Code' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Composition HTML' }), { target: { value: HTML.replace('First copy', 'Updated copy') } })
  await u.click(screen.getByRole('button', { name: 'Details' }))
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('New launch')
  expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('Keep this brief')
  expect(screen.getByText('Unsaved changes')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('All changes saved')
  expect(calls.find(c => c.op === 'videos.save')!.body).toMatchObject({ title: 'New launch', brief: 'Keep this brief', composition: HTML.replace('First copy', 'Updated copy') })
})

it('allows restoring a cleared heading, undoing a scene deletion, and redoing it', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  const heading = await screen.findByRole('textbox', { name: 'Heading 1' })
  fireEvent.change(heading, { target: { value: '' } })
  expect(screen.getByRole('textbox', { name: 'Heading 1' })).toBe(heading)
  fireEvent.change(heading, { target: { value: 'Restored' } })
  await u.click(screen.getByRole('button', { name: 'Delete scene' }))
  expect(within(screen.getByRole('list', { name: 'Scene list' })).getAllByRole('button')).toHaveLength(1)
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('Second')
  await u.click(screen.getByRole('button', { name: 'Undo' }))
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('Restored')
  await u.click(screen.getByRole('button', { name: 'Redo' }))
  expect(within(screen.getByRole('list', { name: 'Scene list' })).getAllByRole('button')).toHaveLength(1)
  expect((screen.getByRole('button', { name: 'Delete scene' }) as HTMLButtonElement).disabled).toBe(true)
})

it('preserves spaces and newlines while typing scene text', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  const heading = await screen.findByRole('textbox', { name: 'Heading 1' })
  await u.clear(heading)
  await u.type(heading, 'Two words {Enter}Next line ')
  expect((heading as HTMLTextAreaElement).value).toBe('Two words \nNext line ')
})

it('keeps metadata in undo history and clears redo after a different edit', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  await u.click(await screen.findByRole('button', { name: 'Details' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Changed' } })
  await u.click(screen.getByRole('button', { name: 'Undo' }))
  expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Launch')
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Other edit' } })
  expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true)
})

it('saves a new video brief without submitting an invalid empty composition', async () => {
  const u = userEvent.setup(), calls = gateway({ composition: '' })
  mount()
  await u.click(await screen.findByRole('button', { name: 'Details' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'An updated brief' } })
  await u.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('All changes saved')
  const body = calls.find(c => c.op === 'videos.save')!.body
  expect(body.brief).toBe('An updated brief')
  expect(body).not.toHaveProperty('composition')
})

it('keeps unsaved work after a save fails and retries with keyboard Save', async () => {
  const u = userEvent.setup(), calls = gateway()
  mount()
  const heading = await screen.findByRole('textbox', { name: 'Heading 1' })
  fireEvent.change(heading, { target: { value: 'Keep this edit' } })
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline'))
  await u.click(screen.getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Offline')
  expect((heading as HTMLTextAreaElement).value).toBe('Keep this edit')
  expect(screen.getByText('Unsaved changes')).toBeTruthy()
  fireEvent.keyDown(heading, { key: 's', ctrlKey: true })
  await screen.findByText('All changes saved')
  expect(calls.filter(c => c.op === 'videos.save')).toHaveLength(1)
})

it('saves metadata before rendering and disables save and editing throughout rendering', async () => {
  const u = userEvent.setup(), calls = gateway()
  mount()
  await u.click(await screen.findByRole('button', { name: 'Details' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'New brief' } })
  await u.click(screen.getByRole('button', { name: 'Render MP4' }))
  await screen.findByRole('button', { name: 'Rendering…' })
  expect(calls.filter(c => ['videos.save', 'videos.render'].includes(c.op)).map(c => c.op)).toEqual(['videos.save', 'videos.render'])
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Brief' }).closest('fieldset')!.disabled).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Code' }))
  expect((screen.getByRole('textbox', { name: 'Composition HTML' }) as HTMLTextAreaElement).disabled).toBe(true)
})

it('prevents duplicate saves while the first request is pending', async () => {
  gateway(); mount()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Heading 1' }), { target: { value: 'Once' } })
  let done!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
  const count = vi.mocked(fetch).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Heading 1' }), { key: 's', metaKey: true })
  expect(vi.mocked(fetch).mock.calls.length).toBe(count + 1)
  await act(async () => { done(response({ state: 'draft' })) })
  expect(screen.getByText('All changes saved')).toBeTruthy()
})

it('mounts the live preview at the chosen scene when switching from a rendered file', async () => {
  const u = userEvent.setup()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:video'; static revokeObjectURL = vi.fn() })
  gateway({ state: 'ready', render: { format: 'mp4', finished_at: '2026-10-04T00:00:00Z' } })
  const view = mount()
  await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy())
  expect(screen.queryByTitle('Live preview')).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Preview scene 2: Second' }))
  const iframe = screen.getByTitle('Live preview') as HTMLIFrameElement
  const send = vi.spyOn(iframe.contentWindow!, 'postMessage')
  fireEvent.load(iframe)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ hfPreview: 'init', t: 5.6 }), '*')
  expect((screen.getByRole('textbox', { name: 'Heading 1' }) as HTMLTextAreaElement).value).toBe('Second')
})

it('shows an initial loading failure honestly and allows retry', async () => {
  const u = userEvent.setup()
  gateway()
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Network unavailable'))
  mount()
  expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable')
  expect(screen.queryByText('No such video.')).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('textbox', { name: 'Heading 1' })
})

it('starts a live draft at a meaningful point in its first scene', async () => {
  gateway(); mount()
  const iframe = await screen.findByTitle('Live preview') as HTMLIFrameElement
  const send = vi.spyOn(iframe.contentWindow!, 'postMessage')
  fireEvent.load(iframe)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ hfPreview: 'init', t: 1.6 }), '*')
})

it('returns to the edited scene after playback advances, then keeps it through HTML reload', async () => {
  // The test answers for the frame's player, which in a browser only answers
  // after the frame has loaded. jsdom fires that load asynchronously; on a busy
  // run it landed after these messages, re-armed the pending seek, and the
  // playback tick was discarded — "Preview: scene 2" never appeared.
  // A listener on each frame as it is inserted, which is always before its load.
  let loads = 0
  const watch = new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(n => {
    const frames = n instanceof HTMLIFrameElement ? [n] : n instanceof Element ? [...n.querySelectorAll('iframe')] : []
    frames.forEach(f => f.addEventListener('load', () => { loads += 1 }))
  })))
  watch.observe(document.body, { childList: true, subtree: true })
  gateway(); mount()
  const heading = await screen.findByRole('textbox', { name: 'Heading 1' })
  await waitFor(() => expect(loads).toBeGreaterThan(0))
  watch.disconnect()
  const iframe = screen.getByTitle('Live preview') as HTMLIFrameElement
  const session = iframe.srcdoc.match(/const session = "([^"]+)"/)![1]
  const post = (t: number, playing = false) => act(() => window.dispatchEvent(new MessageEvent('message', {
    source: iframe.contentWindow, data: { session, hfPreview: 'time', t, total: 8, playing },
  })))
  post(1.6); post(6, true)
  expect(screen.getByText('Preview: scene 2')).toBeTruthy()
  const send = vi.spyOn(iframe.contentWindow!, 'postMessage')
  fireEvent.focus(heading)
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ hfPreview: 'seek', t: 1.6 }), '*')
  fireEvent.change(heading, { target: { value: 'Editing the first scene' } })
  const updated = screen.getByTitle('Live preview') as HTMLIFrameElement
  const initialize = vi.spyOn(updated.contentWindow!, 'postMessage')
  fireEvent.load(updated)
  expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ hfPreview: 'init', t: 1.6 }), '*')
  expect(screen.getByText('Editing scene 1 of 2')).toBeTruthy()
})

it('keeps the preview aligned with the restored scene on undo and redo', async () => {
  const u = userEvent.setup()
  gateway(); mount()
  await u.click(await screen.findByRole('button', { name: 'Move later' }))
  expect(screen.getByText('Editing scene 2 of 2')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Undo' }))
  const iframe = screen.getByTitle('Live preview') as HTMLIFrameElement
  const send = vi.spyOn(iframe.contentWindow!, 'postMessage')
  fireEvent.load(iframe)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ hfPreview: 'init', t: 1.6 }), '*')
  await u.click(screen.getByRole('button', { name: 'Redo' }))
  const redone = screen.getByTitle('Live preview') as HTMLIFrameElement
  const seek = vi.spyOn(redone.contentWindow!, 'postMessage')
  fireEvent.load(redone)
  expect(seek).toHaveBeenCalledWith(expect.objectContaining({ hfPreview: 'init', t: 5.6 }), '*')
})

it('retries a failed rendered-file request without losing the editor', async () => {
  const u = userEvent.setup()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:retried'; static revokeObjectURL = vi.fn() })
  gateway({ state: 'ready', render: { format: 'mp4', finished_at: '2026-10-04T00:00:00Z' } })
  const original = vi.mocked(fetch).getMockImplementation()!
  let failed = false
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('videos.file') && !failed) { failed = true; throw new Error('Download interrupted') }
    return original(url, init)
  })
  const view = mount()
  expect((await screen.findByRole('alert')).textContent).toContain('Download interrupted')
  await u.click(screen.getByRole('button', { name: 'Retry file' }))
  await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('blob:retried'))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the editor mounted after a render polling failure', async () => {
  vi.useFakeTimers()
  gateway({ state: 'rendering' }); mount()
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Temporary outage'))
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('alert').textContent).toContain('Could not refresh render status')
  expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('Original brief')
})

it('isolates route changes from late requests for the previous video', async () => {
  const u = userEvent.setup()
  gateway()
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<MemoryRouter initialEntries={['/videos/video-1']}><Link to="/videos/video-2">Next video</Link><Routes><Route path="/videos/:id" element={<VideoDetail />} /></Routes></MemoryRouter>)
  await u.click(screen.getByRole('link', { name: 'Next video' }))
  await screen.findByRole('heading', { name: 'Launch' })
  await act(async () => { finish(response({ video: { ...VIDEO, title: 'Stale result' } })) })
  expect(screen.queryByRole('heading', { name: 'Stale result' })).toBeNull()
})
