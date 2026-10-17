/** The pieces every card gallery shares — Dashboards, Experiments, Docs,
 *  Skills and Agents lay their collections out the same way, so a reader
 *  learns the page once. */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export type GalleryView = 'grid' | 'list'

/** Secondary controls stay available without crowding the primary filters. */
export function GalleryOptions({ label, active = 0, children }: {
  label: string; active?: number; children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const count = active
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  return <div className="dash-extra-filters" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
      }
    }}>
    <button type="button" className="tool dash-filter-trigger" ref={trigger} aria-expanded={open}
      aria-controls={id} onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M2 4h12M2 12h12" /><circle cx="6" cy="4" r="2" fill="var(--panel)" /><circle cx="10" cy="12" r="2" fill="var(--panel)" />
      </svg>
      Filters{count > 0 && <span className="dash-filter-count">{count}<span className="dash-sr-only"> active</span></span>}
    </button>
    {open && <div id={id} className="dash-filter-popover" role="group" aria-label={`Additional ${label} filters`}>
      {children}
    </div>}
  </div>
}

export function GalleryResults({ loading, error, count, total, label, filtered, onReset }: {
  loading: boolean; error?: Error | null; count: number; total: number; label: string
  filtered: boolean; onReset: () => void
}) {
  const visible = loading || filtered || count < total
  return <div className={`dash-gallery-results${!visible ? ' is-quiet' : ''}`}>
    <span role="status">{loading ? `Loading ${label}…` : error ? '' : visible
      ? `${count} of ${total} ${label}` : ''}</span>
    {filtered && <button className="linkbtn" onClick={onReset}>Clear filters</button>}
  </div>
}

export function GalleryError({ label, retry }: { label: string; retry: () => void }) {
  return <div className="dash-load-error" role="alert">
    <span>Could not load {label}. Your content has not been changed.</span>
    <button className="tool" onClick={retry}>Retry</button>
  </div>
}


export function ViewToggle({ view, onChange, label }: {
  view: GalleryView
  onChange: (v: GalleryView) => void
  /** What is being displayed, for the group's accessible name. */
  label: string
}) {
  return (
    <div className="dash-view-toggle" role="group" aria-label={`${label} display`}>
      <button aria-pressed={view === 'grid'} onClick={() => onChange('grid')} aria-label="Grid view">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1.5 1.5h5v5h-5z M9.5 1.5h5v5h-5z M1.5 9.5h5v5h-5z M9.5 9.5h5v5h-5z" /></svg>
      </button>
      <button aria-pressed={view === 'list'} onClick={() => onChange('list')} aria-label="List view">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 3h12 M2 8h12 M2 13h12" /></svg>
      </button>
    </div>
  )
}

/** Card-shaped placeholders while the first page loads, so the grid does not
 *  jump from a line of text to a wall of cards. */
export function CardSkeletons({ n = 6 }: { n?: number }) {
  return (
    <div className="dash-gallery-scroll">
      <div className="dash-collection-shell dash-gallery-grid" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => <div key={i} className="dash-card-skeleton"><div /><span /><span /></div>)}
      </div>
    </div>
  )
}

/** "Updated today", "yesterday", "3d ago" — from a count of days. */
export const daysAgo = (d: number) => (d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`)
