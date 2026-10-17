import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** The frame's policy: its own inline style and script, data: images and
 *  fonts, and nothing else — no request leaves it. The gateway's snapshot
 *  page (commonindex/gateway/artifacts.py, POLICY) uses the same one. */
export const FRAME_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"

/** Runs inside the frame and says how tall the page is, whenever that
 *  changes. A number is all it sends; the app checks where it came from. */
const SIZER = `<script>(()=>{let last=0;const tell=()=>{const h=Math.ceil(document.documentElement.getBoundingClientRect().height);`
  + `if(h!==last){last=h;parent.postMessage({htmlFrame:'size',h},'*')}};new ResizeObserver(tell).observe(document.documentElement);`
  + `addEventListener('load',tell);tell()})()</script>`

/** Runs inside the frame and says, at most a few times a second, that the
 *  reader moved, touched, scrolled or typed — which the app can't see on its
 *  own over a frame. Nothing about what or where. */
const ACTIVITY = `<script>(()=>{let t=0;const tell=()=>{const n=Date.now();if(n-t>300){t=n;parent.postMessage({htmlFrame:'activity'},'*')}};`
  + `for(const e of ['mousemove','pointerdown','touchstart','wheel','keydown'])addEventListener(e,tell,{passive:true,capture:true})})()</script>`

export function framePage(html: string, sizer = false, activity = false): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + "<style>html,body{margin:0;background:#fff;color:#1b1a16;"
    + "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}</style>"
    + `</head><body>${html}${sizer ? SIZER : ''}${activity ? ACTIVITY : ''}</body></html>`
}

const MIN = 60
const MAX = 1600

/** HTML that runs, where it cannot reach anything: sandboxed without
 *  same-origin, so it has no cookies, no storage and no way into the app,
 *  and under a policy with no network. Scripts run; that is the point.
 *
 *  With `fit`, it grows or shrinks to its content — told by the page itself,
 *  since a cross-origin frame can't be measured from outside — up to
 *  `height`, which is also what it shows until the page has said. */
export function HtmlFrame({ html, height, title, fit = false, onActivity }: {
  /** A number of pixels, or a CSS length — '100%' to fill a full-screen sheet. */
  html: string; height: number | string; title: string; fit?: boolean
  /** Told when the reader moves, touches, scrolls or types over the frame. */
  onActivity?: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const watching = !!onActivity
  const doc = useMemo(() => framePage(html, fit, watching), [html, fit, watching])
  const [measured, setMeasured] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const active = useRef(onActivity)
  useEffect(() => { active.current = onActivity }, [onActivity])

  useEffect(() => {
    if (!fit && !watching) return
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own page: a number, or a nudge.
      if (e.source !== frame.current?.contentWindow) return
      if (e.data?.htmlFrame === 'activity') { active.current?.(); return }
      if (!fit || e.data?.htmlFrame !== 'size') return
      const h = Number(e.data.h)
      if (Number.isFinite(h)) setMeasured(Math.max(MIN, Math.min(MAX, Math.round(h))))
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [fit, watching])

  const shown = fit && measured != null && typeof height === 'number' ? Math.min(measured, Math.max(height, MIN)) : height
  return <iframe ref={frame} className={`html-frame${loaded ? ' is-loaded' : ''}`} title={title}
    sandbox="allow-scripts" srcDoc={doc} onLoad={() => setLoaded(true)}
    style={{ height: shown }} referrerPolicy="no-referrer" />
}

/** An artifact at the size of the window, the way a page is seen: a fixed
 *  header stays put and 100vh means the window, which a frame that grows to
 *  its content can't give. Escape, Close or a click outside closes it. */
export function HtmlFullscreen({ html, title, onClose }: { html: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="html-fullscreen" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="html-fullscreen-sheet">
        <header><span className="html-fullscreen-title">{title}</span>
          <button type="button" className="btn" onClick={onClose} autoFocus>Close</button></header>
        <HtmlFrame html={html} height="100%" title={title} />
      </div>
    </div>, document.body)
}

/** A whole HTML document — `<!doctype html>` or `<html>` first — rather than
 *  a piece of a page. It is shown as a page: in a window, at desktop size. */
export function isPage(html: string): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(html)
}

/** The size a page is laid out at, as on a laptop; shown scaled to fit. */
export const PAGE_W = 1280
export const PAGE_H = 800

/** A page, as a browser shows one: laid out at desktop size in a window of
 *  that size — so a fixed header stays put, 100vh is the window and the page
 *  scrolls inside — and scaled down to the width it is given. */
export function HtmlPage({ html, title }: { html: string; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.min(1, el.clientWidth / PAGE_W) || 0.5)
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const doc = useMemo(() => framePage(html), [html])
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="html-page">
      <div className="html-page-bar" aria-hidden="true">
        <span className="dots"><i /><i /><i /></span>
        <span className="addr">{title}</span>
      </div>
      <div className="html-page-view" ref={box} style={{ height: Math.round(PAGE_H * scale) }}>
        <iframe className={`html-frame${loaded ? ' is-loaded' : ''}`} title={title} sandbox="allow-scripts" srcDoc={doc}
          referrerPolicy="no-referrer" onLoad={() => setLoaded(true)}
          style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})` }} />
      </div>
    </div>
  )
}
