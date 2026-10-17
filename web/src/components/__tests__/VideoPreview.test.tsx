import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PLAYER, previewDocument, VideoPreview, type PreviewHandle } from '../VideoPreview'

const HTML = '<div data-composition-id="main" data-duration="8"><section data-start="0" data-duration="4"><h1>First</h1></section><section data-start="4" data-duration="4"><h1>Second</h1></section></div>'
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

function frame() {
  const iframe = screen.getByTitle('Live preview') as HTMLIFrameElement
  const session = iframe.srcdoc.match(/const session = "([^"]+)"/)![1]
  const post = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { ...data, session } })))
  const send = vi.spyOn(iframe.contentWindow!, 'postMessage')
  return { iframe, post, send, session }
}

it('queues seeks until the frame is ready and retains time through HTML edits', () => {
  const ref = createRef<PreviewHandle>()
  const view = render(<VideoPreview ref={ref} html={HTML} width={1920} height={1080} initialTime={1.6} />)
  const first = frame()
  act(() => ref.current!.seek(5.6))
  expect(first.send).not.toHaveBeenCalled()
  first.post({ hfPreview: 'ready' })
  expect(first.send).toHaveBeenLastCalledWith({ hfPreview: 'init', t: 5.6, session: first.session }, '*')
  first.post({ hfPreview: 'time', t: 5.6, total: 8, playing: false })
  expect((screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement).disabled).toBe(false)
  view.rerender(<VideoPreview ref={ref} html={HTML.replace('Second', 'Updated')} width={1920} height={1080} />)
  const next = frame()
  next.post({ hfPreview: 'ready' })
  expect(next.send).toHaveBeenLastCalledWith({ hfPreview: 'init', t: 5.6, session: next.session }, '*')
  fireEvent.load(next.iframe)
  expect(next.send).toHaveBeenLastCalledWith({ hfPreview: 'init', t: 5.6, session: next.session }, '*')
})

it('surfaces runtime errors, ignores stale or invalid messages, and can reload', () => {
  render(<VideoPreview html={HTML} width={1920} height={1080} />)
  const current = frame()
  current.post({ hfPreview: 'time', t: NaN, total: 8, playing: false })
  expect(screen.getByText('Loading preview…')).toBeTruthy()
  current.post({ hfPreview: 'error', message: 'Broken script' })
  expect(screen.getByRole('alert').textContent).toContain('Broken script')
  current.post({ hfPreview: 'time', t: 1, total: 8, playing: false })
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }))
  expect(frame().session).not.toBe(current.session)
  current.post({ hfPreview: 'time', t: 1, total: 8, playing: false })
  expect(screen.getByText('Loading preview…')).toBeTruthy()
})

it('shows a recoverable error if a preview never responds', () => {
  vi.useFakeTimers()
  render(<VideoPreview html={HTML} width={1920} height={1080} />)
  act(() => vi.advanceTimersByTime(8000))
  expect(screen.getByRole('alert').textContent).toContain('Preview did not respond')
})

it('ignores queued playback ticks until a selected-scene seek is acknowledged', () => {
  const ref = createRef<PreviewHandle>(), onTime = vi.fn()
  const view = render(<VideoPreview ref={ref} html={HTML} width={1920} height={1080} onTime={onTime} />)
  const current = frame()
  current.post({ hfPreview: 'time', t: 0, total: 8, playing: false })
  act(() => ref.current!.seek(5.6))
  current.post({ hfPreview: 'time', t: 2, total: 8, playing: true })
  expect(onTime).not.toHaveBeenCalledWith(2, 8)
  view.rerender(<VideoPreview ref={ref} html={HTML.replace('Second', 'Changed')} width={1920} height={1080} onTime={onTime} />)
  const next = frame()
  next.post({ hfPreview: 'ready' })
  expect(next.send).toHaveBeenLastCalledWith(expect.objectContaining({ hfPreview: 'init', t: 5.6 }), '*')
  next.post({ hfPreview: 'time', t: 5.6, total: 8, playing: false })
  expect(onTime).toHaveBeenLastCalledWith(5.6, 8)
  next.post({ hfPreview: 'time', t: 6, total: 8, playing: true })
  expect(onTime).toHaveBeenLastCalledWith(6, 8)
})

it('preserves full-document head styles with the sandbox policy before authored scripts', () => {
  const html = previewDocument('<!doctype html><html><head><style>h1{color:red}</style><script>example()</script></head><body>' + HTML + '</body></html>', 1920, 1080, 'test')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.querySelectorAll('html')).toHaveLength(1)
  expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  expect(doc.head.textContent).toContain('h1{color:red}')
  expect(doc.body.querySelectorAll('[data-composition-id]')).toHaveLength(1)
})

/** The player is exercised with a fake clock/animations, never a browser. */
function runtime() {
  const doc = new DOMParser().parseFromString(HTML, 'text/html')
  const animation = { effect: { target: doc.querySelectorAll('h1')[1] }, pause: vi.fn(), currentTime: 0 }
  Object.assign(doc, { getAnimations: () => [animation] })
  let receive!: (event: { source: object; data: object }) => void
  const parent = {}, report = vi.fn(), request = vi.fn(() => 1), cancel = vi.fn()
  // Only our fixed player source executes, not any authored HTML or script.
  new Function('document', 'parent', 'session', 'report', 'addEventListener', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', PLAYER)(
    doc, parent, 'test', report, (_: string, fn: typeof receive) => { receive = fn }, request, cancel, { now: () => 0 })
  const send = (data: object) => receive({ source: parent, data: { session: 'test', ...data } })
  return { doc, send, report, request, cancel, animation }
}

it('holds the last visible frame at the end and seeks animations once', () => {
  const p = runtime()
  p.send({ hfPreview: 'seek', t: 8 })
  const clips = p.doc.querySelectorAll<HTMLElement>('section')
  expect(clips[0].style.visibility).toBe('hidden')
  expect(clips[1].style.visibility).toBe('')
  expect(p.animation.currentTime).toBeCloseTo(3999)
  expect(p.animation.pause).toHaveBeenCalledOnce()
  expect(p.report).toHaveBeenLastCalledWith('time', { t: 8, total: 8, playing: false })
  p.send({ hfPreview: 'seek', t: 4 })
  expect(clips[0].style.visibility).toBe('hidden')
  expect(clips[1].style.visibility).toBe('')
})

it('does not start two playback loops and cancels the loop on seek', () => {
  const p = runtime()
  p.send({ hfPreview: 'play' }); p.send({ hfPreview: 'play' })
  expect(p.request).toHaveBeenCalledOnce()
  p.send({ hfPreview: 'seek', t: 2 })
  expect(p.cancel).toHaveBeenCalledWith(1)
  p.send({ hfPreview: 'play' })
  expect(p.request).toHaveBeenCalledTimes(2)
})
