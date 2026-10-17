import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DesignTokens, WireDesign } from '../data/gateway'
import { DesignScreenView, onSystem, palette } from './DesignCanvas'
import { isDesignSystem } from './DesignTemplatePicker'
import { Pill } from './ui'

export type DesignCollection = 'designs' | 'starters' | 'systems'
export type DesignSort = 'updated' | 'name'

/** Honour explicit metadata, with compatibility for the original catalogue. */
export function designCollection(design: WireDesign): DesignCollection {
  if (isDesignSystem(design)) return 'systems'
  if (design.template_kind === 'layout' || /^Starter\s*[·:—-]/i.test(design.title)) return 'starters'
  return 'designs'
}

export function updatedTime(design: WireDesign): number | null {
  const value = design.updated_at ? Date.parse(design.updated_at) : NaN
  return Number.isFinite(value) ? value : null
}

export function sortDesigns(designs: WireDesign[], sort: DesignSort): WireDesign[] {
  const byName = (a: WireDesign, b: WireDesign) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  return [...designs].sort((a, b) => {
    if (sort === 'name') return byName(a, b)
    const at = updatedTime(a), bt = updatedTime(b)
    if (at === null && bt !== null) return 1
    if (bt === null && at !== null) return -1
    return (bt ?? 0) - (at ?? 0) || byName(a, b)
  })
}

function relativeTime(at: number) {
  const elapsed = Math.max(0, Date.now() - at) / 1000
  if (elapsed < 60) return 'just now'
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`
  return `${Math.floor(elapsed / 86400)}d ago`
}

/** One non-interactive preview, one descriptive link. No focusable demo inputs. */
export function DesignGalleryCard({ design, tokens, builtOn }: {
  design: WireDesign
  tokens?: DesignTokens
  builtOn?: string
}) {
  const preview = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(230)
  useEffect(() => {
    const node = preview.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(1, entry.contentRect.width - 24))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const kind = designCollection(design)
  const system = kind === 'systems'
  const colours = Object.entries(tokens ?? {}).filter(([path, token]) =>
    (token.$type === 'color' || path.startsWith('color.')) && typeof token.$value === 'string')
  const p = palette(tokens)
  const tokenCount = Object.keys(tokens ?? {}).length
  const { on, total, unverified, ownColour } = onSystem(design, tokens ?? {})
  const first = design.spec?.screens?.[0]
  const screens = design.screen_count ?? design.spec?.screens?.length ?? 0
  const updated = updatedTime(design)
  const state = design.state ?? 'draft'
  const tone = state === 'approved' ? 'green' : state === 'review' ? 'warn' : state === 'superseded' ? 'red' : 'gray'

  return <Link to={`/designs/${encodeURIComponent(design.id)}`} className="dcard" aria-label={`Open ${design.title}`}>
    <div className={`dcard-preview${system ? ' dcard-system-preview' : ''}`} ref={preview} aria-hidden="true" inert>
      {system ? <div className="dcard-palette">
        {tokenCount > 0 ? <>
          <div className="dcard-type-sample" style={{ background: p.bg, color: p.text, fontFamily: p.font }}>
            <span>Aa</span><span style={{ color: p.accent }}>Aa</span>
            <small>Shared colours &amp; type</small>
          </div>
          {colours.length > 0 && <div className="dcard-swatches">
            {colours.slice(0, 6).map(([path, token]) => <span key={path} style={{ background: String(token.$value) }} />)}
          </div>}
        </> : <span className="hint">No tokens defined yet</span>}
      </div> : first ? <DesignScreenView screen={first} tokens={tokens ?? {}}
          surface={design.surface} width={width} maxHeight={220} />
        : <span className="hint">No screens yet</span>}
    </div>
    <div className="dcard-meta">
      <b>{design.title}</b>
      <div className="sub dcard-facts">
        <span>{system ? 'Design system' : design.surface[0].toUpperCase() + design.surface.slice(1)}</span>
        <Pill tone={tone}>{state}</Pill>
        <span>{system ? `${tokenCount} token${tokenCount === 1 ? '' : 's'}` : `${screens} screen${screens === 1 ? '' : 's'}`}</span>
      </div>
      {system ? <p className="sub dcard-description">{design.description || 'Reusable colours and typography for your designs.'}</p>
        : <div className="sub dcard-citations" title="Checks whether element citations resolve in the palette; not a visual compliance check.">
          {/* The canvas calls these off-system; the card said "citations
              verified", so the same fact had two names depending on where you
              stood. */}
          {total === 0 ? 'No token references' : <span style={{ color: on === total ? 'var(--green)' : 'var(--warn)' }}>
            {on === total ? 'On system' : `${total - on} of ${total} off-system`}
          </span>}
          {unverified > 0 && <span> · {unverified} unresolved</span>}
          {ownColour > 0 && <span> · {ownColour} custom colour{ownColour === 1 ? '' : 's'}</span>}
        </div>}
      {!system && builtOn && <div className="sub dcard-from" title={`Built on ${builtOn}`}>Built on {builtOn}</div>}
      <div className="dcard-updated">
        {updated === null ? 'Update time unavailable' : <time dateTime={design.updated_at} title={new Date(updated).toLocaleString()}>
          Updated {relativeTime(updated)}
        </time>}
      </div>
    </div>
  </Link>
}
