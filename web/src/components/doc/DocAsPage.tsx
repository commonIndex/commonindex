import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getArtifact, type DocNode, type WireArtifact } from '../../data/gateway'
import { HtmlFrame, isPage } from '../HtmlFrame'

/** The artifact a doc IS, when it is one: a body holding a single embed and
 *  nothing else but empty lines. Anything more and it is a doc that embeds. */
export function pageRef(body: DocNode | null | undefined): string | null {
  const blocks = (body?.content ?? []).filter(n => !(n.type === 'paragraph' && !(n.content ?? []).length))
  if (blocks.length !== 1 || blocks[0].type !== 'embed') return null
  const ref = (blocks[0].attrs as { ref?: unknown } | undefined)?.ref
  return typeof ref === 'string' && ref ? ref : null
}

/** Whether a doc is a page: `pending` while its one artifact loads — so the
 *  doc is not drawn and then replaced — then the page, or null for a doc
 *  (not one, or not one this reader may see: they get the doc instead). */
export function useDocPage(body: DocNode | null | undefined): { page: WireArtifact | null; pending: boolean } {
  const ref = pageRef(body)
  // Keyed by the body, not the id: asking again with a new body (View as
  // page, after editing) fetches the artifact as it is now.
  const [found, setFound] = useState<{ body: DocNode; page: WireArtifact | null } | null>(null)
  useEffect(() => {
    if (!ref || !body) return
    let alive = true
    getArtifact(ref)
      .then(r => { if (alive) setFound({ body, page: isPage(r.artifact.html ?? '') ? r.artifact : null }) })
      .catch(() => { if (alive) setFound({ body, page: null }) })
    return () => { alive = false }
  }, [ref, body])
  if (!ref || !body) return { page: null, pending: false }
  if (found?.body !== body) return { page: null, pending: true }
  return { page: found.page, pending: false }
}

/** How long the controls stay after the reader last moved, in ms. */
const SHOW_FOR = 2500

/** The page in the doc: the doc's whole area under its header, at real size,
 *  scrolling inside like a website. Blank until the page has loaded. */
export function DocPageBody({ page }: { page: WireArtifact | null }) {
  return (
    <div className="doc-page-html">
      {page && <HtmlFrame html={page.html ?? ''} height="100%" title={page.title} />}
    </div>
  )
}

/** The page expanded: the whole screen, nothing of the app around it, the way
 *  it would look on its own. One small control comes back out — it shows when
 *  the reader moves or touches and fades when they stop, and stays while it
 *  has keyboard focus — and so does Escape. */
export function PageExpanded({ page, onClose }: { page: WireArtifact; onClose: () => void }) {
  const [shown, setShown] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const nudge = useCallback(() => {
    setShown(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown(false), SHOW_FOR)
  }, [])
  useEffect(() => {
    nudge()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    addEventListener('pointermove', nudge)
    addEventListener('keydown', onKey, true)
    return () => { removeEventListener('pointermove', nudge); removeEventListener('keydown', onKey, true); clearTimeout(timer.current) }
  }, [nudge, onClose])
  useEffect(() => {
    const was = document.title
    document.title = page.title
    return () => { document.title = was }
  }, [page])

  return createPortal(
    <div className="doc-as-page" role="dialog" aria-modal="true" aria-label={page.title}>
      <HtmlFrame html={page.html ?? ''} height="100%" title={page.title} onActivity={nudge} />
      <nav className={`doc-as-page-ctl${shown ? ' is-shown' : ''}`} aria-label="Page">
        <button type="button" onClick={onClose} aria-label="Exit full screen" title="Exit full screen (Esc)">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5M10 13.5V10h3.5" /></svg>
        </button>
      </nav>
    </div>, document.body)
}
