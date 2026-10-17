import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// Renders only the visible slice of an arbitrarily long list.
// 500 rows or 50,000 — the DOM holds ~25 either way.
export function VirtualList<T>({
  items, rowHeight, render, onEndReached, hasMore, loading, error, emptyText, onRowClick,
  listClass = '', byAgent, columns,
}: {
  items: T[]
  rowHeight: number
  render: (item: T) => React.ReactNode
  onEndReached: () => void
  hasMore: boolean
  loading: boolean
  /** Why the list is empty, when it is empty because something failed. An
   *  unreported rejection left every collection in the product spinning
   *  forever with no message and no way to retry. */
  error?: Error | null
  emptyText: string
  onRowClick?: (item: T) => void
  /** Sets the row's column grid — see .list-* in styles.css. */
  listClass?: string
  /** Marks the provenance node violet: an agent's work is the latest thing here. */
  byAgent?: (item: T) => boolean
  /** What each column is, one label per cell in `render`.
   *
   *  These lists had none. A row ends in unlabelled numbers — `89%`, `+33.2%`,
   *  `−10.9%` — and a reader has to infer what each is from the values, which
   *  works until two columns are both percentages. Empty strings for the
   *  columns that need no label; the header shares the row's grid template, so
   *  it cannot drift out of alignment with what it names. */
  columns?: (string | { label: string; className?: string })[]
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  })
  const vItems = virtualizer.getVirtualItems()

  useEffect(() => {
    const last = vItems[vItems.length - 1]
    if (last && hasMore && last.index >= items.length - 15) onEndReached()
  }, [vItems, items.length, hasMore, onEndReached])

  if (error && items.length === 0) {
    // "Nothing here" and "we could not ask" look identical, and only one of
    // them is worth waiting for.
    return (
      <div className={`vlist ${listClass}`}>
        <div className="empty">
          <b>Could not load this list.</b> {error.message}
        </div>
      </div>
    )
  }
  if (!loading && items.length === 0) {
    return <div className={`vlist ${listClass}`}><div className="empty">{emptyText}</div></div>
  }

  return (
    <div className={`vlist-wrap ${listClass}`}>
      {columns && (
        <div className="vrow vhead" role="row" aria-hidden="true">
          {/* The class mirrors the row's, so a header over a right-aligned
              number is right-aligned too — otherwise `accepted` and `updated`
              both start at their track's left edge and run into each other. */}
          {columns.map((c, i) => {
            const { label, className } = typeof c === 'string' ? { label: c, className: '' } : c
            return <span key={i} className={`cell ${className ?? ''}`}>{label}</span>
          })}
        </div>
      )}
      <div className={`vlist ${listClass}`} ref={parentRef} data-testid="vlist">
        <div className="vlist-inner" style={{ height: virtualizer.getTotalSize() }}>
        {vItems.map(vi => (
          <div
            key={vi.key}
            data-row
            className={`vrow${byAgent?.(items[vi.index]) ? ' by-agent' : ''}`}
            style={{ top: vi.start, height: vi.size }}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={onRowClick ? () => onRowClick(items[vi.index]) : undefined}
            onKeyDown={onRowClick ? e => { if (e.key === 'Enter') onRowClick(items[vi.index]) } : undefined}
          >
            {render(items[vi.index])}
          </div>
        ))}
        </div>
        {hasMore && <div className="load-note">loading more as you scroll…</div>}
      </div>
    </div>
  )
}
