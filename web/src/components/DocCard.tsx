import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getArtifact, prefetchDoc } from '../data/gateway'
import type { Doc } from '../data/types'
import { HtmlFrame } from './HtmlFrame'
import { Avatar, Pill } from './ui'
import { daysAgo } from './Gallery'

const FRESH: Record<Doc['freshness'], { label: string; tone: 'gray' | 'warn' | 'green' }> = {
  fresh: { label: 'Fresh', tone: 'gray' },
  stale: { label: 'Stale', tone: 'warn' },
  verified: { label: 'Verified', tone: 'green' },
}

/** A doc as a page you recognise: its opening lines on a sheet, then what it
 *  is, whose it is, and whether it can still be trusted. The preview is the
 *  doc's own text, never a blurb written beside it. */
export function DocCard({ doc: d }: { doc: Doc }) {
  const f = FRESH[d.freshness] ?? FRESH.fresh
  return (
    <Link className="dash-card doc-card" to={d.live ? `/docs/edit/${d.id}` : `/docs/${d.id}`}
      aria-label={`Open doc ${d.title}`}
      // The pointer on its way to a card is a good sign of where it is going:
      // the doc is read now, so the editor opens on it rather than waiting.
      onPointerEnter={() => { if (d.live) prefetchDoc(d.id) }} onFocus={() => { if (d.live) prefetchDoc(d.id) }}>
      <div className={`dash-card-preview doc-card-preview${d.freshness === 'stale' ? ' stale' : ''}`}>
        <div className="dash-card-preview-label">
          <span>{d.pageRef ? 'Full page' : d.live ? 'Editable doc' : 'Doc'}</span>
          <span className={`doc-fresh df-${d.freshness}`}><i />{f.label}</span>
        </div>
        {d.pageRef
          ? <PageThumb id={d.pageRef} title={d.title} />
          : <div className="doc-sheet" aria-hidden="true">
              <b>{d.title}</b>
              <p>{d.excerpt || 'Empty — open it to start writing.'}</p>
            </div>}
      </div>
      <div className="dash-card-content">
        <h2>{d.title}</h2>
        <div className="dash-card-facts">
          <span>{d.space}</span><span>·</span><span>rev {d.rev}</span>
          {d.freshness !== 'fresh' && <Pill tone={f.tone}>{f.label.toLowerCase()}</Pill>}
        </div>
        {d.proposals > 0 && <div><Pill tone="agent">{d.proposals} {d.proposals === 1 ? 'proposal' : 'proposals'} to review</Pill></div>}
        <div className="dash-card-footer">
          <span><Avatar name={d.owner} agent={d.owner === 'Scribe'} />{d.owner}</span>
          <span className="muted">Updated {daysAgo(d.updated)}</span>
        </div>
      </div>
    </Link>
  )
}

/** Fetched once per page per visit: a gallery re-renders on every filter. */
const pages = new Map<string, Promise<string>>()

/** A doc made into a page has no text of its own — its body is the page — so
 *  "Empty — open it to start writing" sat over a doc that showed a whole
 *  landing page when opened. This draws the page itself, small: in the same
 *  sandboxed frame as everywhere else, and inert, so the card is the link. */
function PageThumb({ id, title }: { id: string; title: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!pages.has(id)) pages.set(id, getArtifact(id).then(r => r.artifact.html ?? ''))
    pages.get(id)!.then(h => { if (alive) setHtml(h) }, () => { pages.delete(id); if (alive) setHtml('') })
    return () => { alive = false }
  }, [id])
  return (
    <div className="doc-page-thumb" aria-hidden="true">
      {html ? <div className="doc-page-thumb-inner"><HtmlFrame html={html} height={1000} title={`${title} preview`} /></div>
        : <div className="doc-sheet"><b>{title}</b><p>{html === '' ? 'A full page.' : 'Loading the page…'}</p></div>}
    </div>
  )
}
