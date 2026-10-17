import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { forgetLiveDocs, listDocs, type DocFilter } from '../data/api'
import { createDoc, GatewayError } from '../data/gateway'
import { useToast } from '../components/Shell'
import { usePagedList, useDebounced } from '../hooks'
import { VirtualList } from '../components/VirtualList'
import { Pill, Stat, statusTone } from '../components/ui'
import { CardSkeletons, GalleryOptions, GalleryResults, GalleryError, ViewToggle, type GalleryView } from '../components/Gallery'
import { DocCard } from '../components/DocCard'
import type { Doc } from '../data/types'

const FILTERS: { id: DocFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stale', label: 'Stale' },
  { id: 'proposals', label: 'With proposals' },
  { id: 'verified', label: 'Verified' },
]

export function DocsView() {
  // The editor is the next thing almost every visit here opens, and its code
  // is the largest on the site: fetched while the list sits idle, so opening a
  // doc does not wait for it.
  useEffect(() => {
    const load = () => { void import('./DocEdit') }
    const idle = (window as { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback
    const t = idle ? idle(load) : window.setTimeout(load, 800)
    return () => { if (!idle) window.clearTimeout(t) }
  }, [])
  const [filter, setFilter] = useState<DocFilter>('all')
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [view, setView] = useState<GalleryView>('grid')
  const navigate = useNavigate()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const reset = () => { setQ(''); setFilter('all') }

  async function newDoc() {
    setCreating(true)
    try {
      const { id } = await createDoc('Untitled')
      forgetLiveDocs()
      navigate(`/docs/edit/${id}`)
    } catch (e) {
      toast(e instanceof GatewayError ? e.message : 'The gateway could not be reached, so the doc was not created.')
      setCreating(false)
    }
  }

  const fetcher = useCallback(
    (cursor?: number) => listDocs({ cursor, filter, q: dq }),
    [filter, dq],
  )
  const { items, total, loading, error, loadMore, hasMore, retry } = usePagedList(`${filter}:${dq}`, fetcher)
  const open = (d: Doc) => navigate(d.live ? `/docs/edit/${d.id}` : `/docs/${d.id}`)

  return (
    <div className="collection dashboard-collection workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Docs <span className="total">{loading ? 'Loading…' : error ? 'Unavailable' : `${total} in this view`}</span></h1>
          <p className="coll-sub">Specs, runbooks and notes, written and edited here — with comments, history, and @ai to draft.</p>
        </div>
        <button className="btn action" onClick={newDoc} disabled={creating}>{creating ? 'Creating…' : '+ New doc'}</button>
      </header>
      <div className="dash-collection-shell">
        <div className="coll-tools dash-gallery-tools">
          <div className="dash-gallery-filters" role="group" aria-label="Filter docs">
            {FILTERS.map(f => <button key={f.id} className={`chip${filter === f.id ? ' on' : ''}`}
              aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
          <input type="search" className="dash-search" aria-label="Search docs"
            placeholder="Search by title, space, owner or what it says…" value={q} onChange={e => setQ(e.target.value)} />
          <ViewToggle view={view} onChange={setView} label="Doc" />
        </div>
        <GalleryResults loading={loading} error={error} count={items.length} total={total} label="docs"
          filtered={!!q || filter !== 'all'} onReset={reset} />
        {error && <GalleryError label="docs" retry={retry} />}
      </div>

      {loading ? <CardSkeletons /> : error && !items.length ? null : !items.length ? (
        <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-empty">
          <h2>{q || filter !== 'all' ? 'No docs match' : 'No docs yet'}</h2>
          <p>{q || filter !== 'all' ? 'Try a different search, or clear the filters.' : 'Write the first one. Anyone here can comment on it, and @ai drafts with you.'}</p>
          {q || filter !== 'all'
            ? <button className="tool" onClick={reset}>Show all docs</button>
            : <button className="btn primary" onClick={newDoc} disabled={creating}>New doc</button>}
        </div></div>
      ) : view === 'grid' ? (
        <div className="dash-gallery-scroll">
          <div className="dash-collection-shell dash-gallery-grid" role="list" aria-label="Docs">
            {/* Keyed by source as well: a doc written here and a sample doc can
                share an id, and React would silently drop one of the two cards. */}
            {items.map(d => <div role="listitem" key={`${d.live ? 'live' : 'sample'}:${d.id}`}><DocCard doc={d} /></div>)}
          </div>
          {hasMore && !error && <div className="dash-gallery-more"><button className="tool" onClick={loadMore}>Load more docs</button></div>}
        </div>
      ) : (
        <VirtualList<Doc>
          items={items}
          rowHeight={62}
          loading={loading}
          error={error}
          hasMore={hasMore}
          onEndReached={loadMore}
          listClass="list-doc"
          emptyText="No docs match — try clearing the filter."
          onRowClick={open}
          byAgent={d => d.owner === 'Scribe' || d.proposals > 0}
          render={d => (
            <>
              <span className="cell stack">
                <span className="title">{d.title}<span className="sub"> · {d.space} · {d.owner}</span></span>
                <span className="prev">{d.pageRef ? 'A full page — open it to see or edit it.' : d.excerpt || (d.live ? 'Empty — open it to start writing.' : '')}</span>
              </span>
              <span className="cell sig">
                {d.live && <Pill tone="blue">editable</Pill>}
                {d.proposals > 0 && <Pill tone="agent">{d.proposals} proposal</Pill>}
              </span>
              <span className="cell">
                {d.freshness === 'stale'
                  ? <Pill tone="warn">stale</Pill>
                  : <Stat tone={statusTone(d.freshness)}>{d.freshness}</Stat>}
              </span>
              <span className="cell r meta upd">{d.updated}d ago</span>
            </>
          )}
        />
      )}
    </div>
  )
}
