import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

/** Self-contained CSS preview. The parent restores the playhead after the
 * new document is ready; the export renderer remains the final check. */
export const PLAYER = `
(() => {
  const root = document.querySelector('[data-composition-id]');
  if (!root) { report('error', { message: 'No composition root found.' }); return; }
  const total = Number(root.getAttribute('data-duration')) || 0;
  if (!Number.isFinite(total) || total <= 0) { report('error', { message: 'Set a positive data-duration on the composition root.' }); return; }
  const clips = [...root.querySelectorAll('[data-start][data-duration]')];
  let t = 0, playing = false, last = 0, raf = 0;
  const tell = () => report('time', { t, total, playing });
  function pause() { playing = false; cancelAnimationFrame(raf); }
  function seek(time) {
    t = Math.max(0, Math.min(total, time));
    // Hold the last visible frame at the end of the scrubber.
    const sample = t === total ? Math.max(0, total - 0.001) : t;
    for (const c of clips) {
      const s = Number(c.getAttribute('data-start')) || 0, d = Number(c.getAttribute('data-duration')) || 0;
      c.style.visibility = sample >= s && sample < s + d && !c.hasAttribute('data-hidden') ? '' : 'hidden';
    }
    // Drive each animation once, using its nearest timed ancestor.
    for (const a of document.getAnimations()) {
      const target = a.effect && a.effect.target;
      const clip = target && target.closest && target.closest('[data-start][data-duration]');
      const start = clip ? Number(clip.getAttribute('data-start')) || 0 : 0;
      a.pause(); a.currentTime = Math.max(0, (sample - start) * 1000);
    }
    tell();
  }
  function frame(now) {
    if (!playing) return;
    seek(t + (now - last) / 1000); last = now;
    if (t >= total) { pause(); tell(); return; }
    raf = requestAnimationFrame(frame);
  }
  addEventListener('message', e => {
    if (e.source !== parent || e.data?.session !== session) return;
    const m = e.data;
    if ((m.hfPreview === 'seek' || m.hfPreview === 'init') && Number.isFinite(m.t)) { pause(); seek(m.t); }
    if (m.hfPreview === 'play' && !playing) {
      if (t >= total) seek(0);
      playing = true; last = performance.now(); tell(); raf = requestAnimationFrame(frame);
    }
    if (m.hfPreview === 'pause') { pause(); tell(); }
  });
  report('ready');
})();`

const POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
let generation = 0

export function previewDocument(html: string, width: number, height: number, session: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'; policy.content = POLICY
  doc.head.prepend(policy)
  const setup = doc.createElement('script')
  setup.textContent = `const session = ${JSON.stringify(session)};
const report = (hfPreview, data = {}) => parent.postMessage({ ...data, hfPreview, session }, '*');
addEventListener('error', e => report('error', { message: e.message || 'Composition script failed.' }));
addEventListener('unhandledrejection', () => report('error', { message: 'Composition script failed asynchronously.' }));`
  policy.after(setup)
  const style = doc.createElement('style')
  style.textContent = `html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}`
  doc.head.append(style)
  const player = doc.createElement('script')
  player.textContent = PLAYER
  doc.body.append(player)
  return '<!doctype html>' + doc.documentElement.outerHTML
}

/** How long the preview may take to answer before it is reported as not
 *  responding. A setting rather than a literal so a test of something else
 *  is not decided by how busy the machine running it is: the editor's tests
 *  answered for the frame after loading the page, and past 8 s of a loaded
 *  run the preview had already given up. */
export const previewTiming = { readyTimeoutMs: 8000 }

export interface PreviewHandle { seek: (t: number) => void }
export const VideoPreview = forwardRef<PreviewHandle, {
  html: string; width: number; height: number; initialTime?: number
  onTime?: (t: number, total: number) => void
}>(function VideoPreview({ html, width, height, initialTime = 0, onTime }, ref) {
  const frame = useRef<HTMLIFrameElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const keep = useRef(initialTime)
  const requested = useRef<number | null>(initialTime)
  const ready = useRef(false)
  const [scale, setScale] = useState(0.25)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState({ t: initialTime, total: 0, playing: false })
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const told = useRef(onTime)
  useEffect(() => { told.current = onTime }, [onTime])
  const content = useMemo(() => {
    const session = `preview-${++generation}`
    return { session, doc: previewDocument(html, width, height, session) }
  }, [html, width, height, retry])
  const send = useCallback((m: object) => frame.current?.contentWindow?.postMessage({ ...m, session: content.session }, '*'), [content.session])
  const seek = useCallback((t: number) => {
    if (!Number.isFinite(t)) return
    keep.current = t
    requested.current = t
    if (ready.current) send({ hfPreview: 'seek', t })
  }, [send])
  useImperativeHandle(ref, () => ({ seek }), [seek])
  useEffect(() => {
    ready.current = false; setStatus('loading'); setError('')
    setState(s => ({ ...s, playing: false }))
    let failed = false
    const timeout = window.setTimeout(() => {
      failed = true; setStatus('error'); setError('Preview did not respond. Reload it or review the composition code.')
    }, previewTiming.readyTimeoutMs)
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.session !== content.session) return
      const m = e.data
      if (m.hfPreview === 'error') {
        failed = true; ready.current = false; clearTimeout(timeout)
        setStatus('error'); setError(typeof m.message === 'string' ? m.message : 'Preview failed.'); return
      }
      if (failed) return
      if (m.hfPreview === 'ready') { send({ hfPreview: 'init', t: keep.current }); return }
      if (m.hfPreview !== 'time' || !Number.isFinite(m.t) || !Number.isFinite(m.total) || m.total <= 0 || m.t < 0 || m.t > m.total) return
      // A playback tick already in flight must not replace a scene seek.
      // Wait for the paused seek acknowledgment before accepting ticks again.
      if (requested.current !== null && (m.playing || Math.abs(m.t - Math.max(0, Math.min(m.total, requested.current))) > 0.001)) return
      requested.current = null
      ready.current = true; clearTimeout(timeout); setStatus('ready')
      keep.current = m.t
      setState({ t: m.t, total: m.total, playing: m.playing === true })
      told.current?.(m.t, m.total)
    }
    addEventListener('message', onMessage)
    return () => { clearTimeout(timeout); removeEventListener('message', onMessage); ready.current = false }
  }, [content.session, send])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const { width: w, height: h } = el.getBoundingClientRect()
      if (w > 0 && h > 0) setScale(Math.min(w / width, h / height))
    }
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    return () => watch.disconnect()
  }, [width, height])

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return (
    <div className="vp">
      <div className="vp-fit" ref={box}>
        <div className="vp-stage" style={{ width: width * scale, height: height * scale }}>
          <iframe key={content.session} ref={frame} title="Live preview" sandbox="allow-scripts" srcDoc={content.doc}
            onLoad={() => { requested.current = keep.current; send({ hfPreview: 'init', t: keep.current }) }}
            style={{ width, height, transform: `scale(${scale})` }} />
        </div>
        {status !== 'ready' && <div className="vp-status" role={status === 'error' ? 'alert' : 'status'}>
          <b>{status === 'loading' ? 'Loading preview…' : 'Preview needs attention'}</b>
          {status === 'error' && <><span>{error}</span><button className="btn" onClick={() => setRetry(n => n + 1)}>Reload preview</button></>}
        </div>}
      </div>
      <div className="vp-controls">
        <button type="button" className="vp-play" aria-label={state.playing ? 'Pause' : 'Play'} disabled={status !== 'ready'}
          onClick={() => send({ hfPreview: state.playing ? 'pause' : 'play' })}>
          {state.playing ? <span aria-hidden="true">Ⅱ</span> : <span aria-hidden="true">▶</span>}
        </button>
        <span className="vp-time">{fmt(state.t)} / {fmt(state.total)}</span>
        <input type="range" className="vp-scrub" aria-label="Scrub" min={0} max={state.total || 1} step={0.01}
          disabled={status !== 'ready'} value={state.t} onChange={e => seek(Number(e.target.value))} />
      </div>
    </div>
  )
})
