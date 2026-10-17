import { DetailHead } from '../components/DetailHead'
import { ShareButton } from '../components/ShareButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { forgetLiveDashboards, getDashboard, getPanels, listDashboards, type DashFilter, type DashOwnership } from '../data/api'
import {
  addPanel, deleteDashboard, listMetrics, previewSql, ratifyMetric, removePanel,
  renameDashboard, renderLive, saveVirtualDataset, toPanel,
  type SqlPreview, type WireDash, type WireMetric, type WirePanel, reorderPanels,
  resizePanels, setDefaultFilters,
  OP_LABEL, RANGES as WIRE_RANGES, opsFor, columnValues, type ColumnValues,
  listConnections, introspect, type WireConnection, type WireDataset,
  type FilterColumn, type FilterOp, type WireFilter,
} from '../data/gateway'
import { useDebounced, usePagedList } from '../hooks'
import { DashboardFilters } from '../components/DashboardFilters'
import { DashboardAIEdit } from '../components/DashboardAIEdit'
import { VirtualList } from '../components/VirtualList'
import { DashboardCard } from '../components/DashboardCard'
import { PanelChart } from '../components/PanelChart'
import { SERIES, fmtStat, signed } from '../components/chartkit'
import { MARKS } from '../components/marks'
import { SqlEditor, type SqlError } from '../components/SqlEditor'
import { AGGS, aggById } from '../data/aggs'
import { GatewayError } from '../data/gateway'
import { Avatar, Oid, Pill, Freshness } from '../components/ui'
import { useToast } from '../components/Shell'
import { CommentsButton } from '../components/discussion/Thread'
import { MakeTaskDialog, TasksButton } from '../components/TaskLinks'
import { ProjectsButton } from '../components/ProjectChips'
import type { Dashboard, Panel } from '../data/types'
import { HORIZON } from '../data/seed'
import { dashboardCsv, download, exportName, sqlPanelCsv } from '../data/csv'
import { isRange, parseView, previousSpan, rangeDays, rangeLabel, spanOf, spanWords, TO_DATE, writeView } from '../data/viewstate'

const FILTERS: { id: DashFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'certified', label: 'Certified' },
  { id: 'attention', label: 'Needs attention' },
]

/** The list row's own preview — 28 days of the headline metric, no axes. */
function RowSpark({ points, up }: { points: number[]; up: boolean }) {
  const lo = Math.min(...points)
  const span = Math.max(Math.max(...points) - lo, 1e-9)
  const d = points
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * 56 + 1).toFixed(1)} ${(17 - ((v - lo) / span) * 14).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="row-spark" viewBox="0 0 58 20" width={58} height={20} aria-hidden="true">
      <path d={d} fill="none" stroke={up ? SERIES[0] : 'var(--border2)'} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function DashboardsView() {
  const [filter, setFilter] = useState<DashFilter>('all')
  const [ownership, setOwnership] = useState<DashOwnership>('all')
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim())
  const navigate = useNavigate()
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [retry, setRetry] = useState(0)
  const [paging, setPaging] = useState(false)
  const request = useRef(0)
  const filtered = !!q || filter !== 'all' || ownership !== 'all'
  const reset = () => { setQ(''); setFilter('all'); setOwnership('all') }

  const fetcher = useCallback(
    async (cursor?: number) => {
      const current = ++request.current
      setPaging(!!cursor)
      try { return await listDashboards({ cursor, filter, q: dq, ...(ownership !== 'all' ? { ownership } : {}) }) }
      finally { if (request.current === current) setPaging(false) }
    },
    [filter, ownership, dq],
  )
  const { items, total, loading, error, loadMore, hasMore } = usePagedList(`${filter}:${ownership}:${dq}:${retry}`, fetcher)
  const resultNote = loading ? 'Loading dashboards…' : error
    ? (items.length ? 'Showing previously loaded results' : 'Dashboards unavailable')
    : filtered ? `${total} matching dashboard${total === 1 ? '' : 's'}${hasMore ? ` · ${items.length} shown` : ''}`
    : hasMore ? `${items.length} of ${total} dashboards` : ''

  return (
    <div className="collection dashboard-collection dashboard-gallery">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Dashboards <span className="total">{loading ? 'Loading…' : error ? 'Refresh needed' : total}</span></h1>
          <p className="coll-sub">Explore shared metrics, monitor performance, and see where decisions need attention.</p>
        </div>
        <button className="btn action" onClick={() => navigate('/dashboards/new')}>+ New dashboard</button>
      </header>
      <div className="dash-collection-shell">
        <div className="coll-tools dash-gallery-tools">
          <div className="dash-gallery-filters" role="group" aria-label="Filter dashboards">
            {FILTERS.map(f => <button key={f.id} className={`chip${filter === f.id ? ' on' : ''}`}
              aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
          <input type="search" className="dash-search" aria-label="Search dashboards"
            placeholder="Search dashboards, sources, or metrics…" value={q} onChange={e => setQ(e.target.value)} />
          <DashboardFilters ownership={ownership} onChange={setOwnership} />
          <div className="dash-view-toggle" role="group" aria-label="Dashboard display">
            <button aria-pressed={view === 'grid'} onClick={() => setView('grid')} aria-label="Grid view">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1.5 1.5h5v5h-5z M9.5 1.5h5v5h-5z M1.5 9.5h5v5h-5z M9.5 9.5h5v5h-5z" /></svg>
            </button>
            <button aria-pressed={view === 'list'} onClick={() => setView('list')} aria-label="List view">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 3h12 M2 8h12 M2 13h12" /></svg>
            </button>
          </div>
        </div>
        <div className={`dash-gallery-results${!resultNote ? ' is-quiet' : ''}`}>
          <span role="status">{resultNote}</span>
          {ownership !== 'all' && <span className="dash-active-filter">{ownership === 'mine' ? 'Mine' : 'Agent-touched'}</span>}
          {filtered && <button className="linkbtn" onClick={reset}>Clear filters</button>}
        </div>
        {!loading && error && <div className="dash-load-error" role="alert"><span><b>Could not load dashboards.</b> {error.message}</span>
          <button className="tool" onClick={() => { forgetLiveDashboards(); setRetry(value => value + 1) }}>Try again</button>
        </div>}
      </div>
      {loading ? <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="dash-card-skeleton"><div /><span /><span /></div>)}
      </div></div> : !items.length ? <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-empty">
        {!error && <><h2>{filtered ? 'No matching dashboards' : 'Your first dashboard starts with a question'}</h2>
          <p>{filtered ? 'Try a different search or clear your filters.' : 'Connect a data source, choose your metrics, and build a shared view.'}</p>
          {filtered ? <button className="tool" onClick={reset}>Show all dashboards</button>
            : <button className="btn action" onClick={() => navigate('/dashboards/new')}>Create a dashboard</button>}</>}
      </div></div> : view === 'grid' ? <div className="dash-gallery-scroll">
        <div className="dash-collection-shell dash-gallery-grid" role="list" aria-label="Dashboards">
          {items.map(dashboard => <div role="listitem" key={dashboard.id}><DashboardCard dashboard={dashboard} /></div>)}
        </div>
        {hasMore && !error && <div className="dash-gallery-more"><button className="tool" disabled={paging}
          onClick={loadMore}>{paging ? 'Loading more…' : 'Load more dashboards'}</button></div>}
      </div> : (
      <VirtualList<Dashboard>
        items={items}
        rowHeight={62}
        loading={loading}
        error={error}
        hasMore={hasMore}
        onEndReached={() => { if (!error) loadMore() }}
        listClass="list-dash"
        columns={['', 'dashboard', '', '',
                  { label: 'now', className: 'r' },
                  { label: 'change', className: 'r' }, 'owner']}
        emptyText="No dashboards match this view."
        onRowClick={d => navigate(`/dashboards/${d.id}`)}
        byAgent={d => d.agentOwner || d.proposals > 0}
        render={d => {
          const good = d.headline.better === 'up' ? d.headline.delta > 0 : d.headline.delta < 0
          return (
            <>
              <span className="cell"><Oid id={d.key} /></span>
              <span className="cell stack">
                <span className="title">{d.title}<span className="sub"> · {d.space}</span></span>
                {/* the bindings, not a blurb — what the panels below actually cite */}
                <span className="prev">{d.panelCount} panel{d.panelCount === 1 ? '' : 's'} · {d.metricReferences?.map(m => m.label).join(', ') || d.metrics.map(m => m.replaceAll('_', ' ')).join(', ') || 'No metric definitions cited'}</span>
              </span>
              <span className="cell sig">
                {d.live && <Pill tone="blue">warehouse</Pill>}
                {d.proposals > 0 && <Pill tone="agent">{d.proposals} proposal</Pill>}
                {/* The words the detail page uses. A panel carrying its own
                    query cites no metric, so calling it an "unratified metric"
                    names something that does not exist. */}
                {!d.certified && (
                  <Pill tone="warn">{
                    (d.queries ?? 0) > 0 && d.queries === d.uncertified
                      ? `${d.queries} custom quer${d.queries === 1 ? 'y' : 'ies'}`
                      : `${d.uncertified || 1} uncertified`
                  }</Pill>
                )}
              </span>
              {/* A live row has no headline and no sparkline without running its
                  query, and the cells are fixed-width — the label that used to
                  sit here clipped to "queried o". Leaving them empty is the
                  honest answer: the row says the dashboard is warehouse-backed,
                  and the number is on the other side of a click. */}
              <span className="cell spark">{d.live ? null : <RowSpark points={d.spark} up={good} />}</span>
              <span className="cell r num">{d.live ? '' : fmtStat(d.headline.value, d.headline.unit)}</span>
              <span className={`cell r num ${good ? 'up' : 'down'}`}>{d.live ? '' : signed(d.headline.delta)}</span>
              <span className="cell who"><span className="nm">{d.owner}</span><Avatar name={d.owner} agent={d.agentOwner} /></span>
            </>
          )
        }}
      />)}
    </div>
  )
}

// Days, parsed from the server's own list. A hand-kept copy here showed the
// reader options the server 422s on the moment either side moved.
const RANGES = WIRE_RANGES.map(r => Number(r.replace('d', '')))



/** Add a panel to a dashboard that already exists.
 *
 *  The first control is the one that matters: **cite an existing definition**,
 *  or write a new one. Without the first option every panel anywhere writes a
 *  new metric, and at N dashboards the registry holds N rows that all say
 *  COUNT(*) — the drift a metric registry exists to prevent, produced by the
 *  authoring tool itself. So citing is the default, and defining is the
 *  deliberate second choice. */
function AddPanel({ dashboardId, datasetId, connectionId, onAdded, onCancel }: {
  dashboardId: string
  /** Which warehouse a SQL panel would query. */
  connectionId: string
  /** Scopes which definitions may be cited. A metric's expression names one
   *  dataset's columns, so citing across datasets compiles to a query about
   *  columns that are not there. Offering such a metric is worse than offering
   *  no reuse at all — it fails after the panel is saved. */
  datasetId: string | null
  onAdded: (msg: string) => void
  onCancel: () => void
}) {
  // Which table this panel reads. Defaults to the dashboard's, and did not
  // used to be a choice at all — so `panels.add` has accepted `dataset_id` and
  // `connection_id` since per-panel connections were added, and the only way
  // to use either was the API. A dashboard built through the product could
  // only ever read one table.
  const [connId, setConnId] = useState(connectionId)
  const [dsId, setDsId] = useState<string>(datasetId ?? '')
  const [conns, setConns] = useState<WireConnection[] | null>(null)
  const [tables, setTables] = useState<WireDataset[] | null>(null)
  const elsewhere = connId !== connectionId || dsId !== (datasetId ?? '')

  useEffect(() => { listConnections().then(r => setConns(r.connections)).catch(() => setConns([])) }, [])
  useEffect(() => {
    let stale = false
    setTables(null)
    introspect(connId)
      .then(r => { if (!stale) setTables(r.datasets) })
      .catch(() => { if (!stale) setTables([]) })
    return () => { stale = true }
  }, [connId])

  const [metrics, setMetrics] = useState<WireMetric[] | null>(null)
  // Three ways to answer "what should this panel show", in the order that keeps
  // the registry honest: cite something that exists, define a new measure over
  // the dashboard's data, or bring different data entirely.
  const [mode, setMode] = useState<'cite' | 'define' | 'sql'>('cite')
  const [metricId, setMetricId] = useState('')
  const [title, setTitle] = useState('')
  const [mark, setMark] = useState<string>('line')
  const [grain, setGrain] = useState('day')
  const [agg, setAgg] = useState('count')
  const [column, setColumn] = useState('')
  const [denominator, setDenominator] = useState('')
  const [dimension, setDimension] = useState('')
  const [sort, setSort] = useState('bucket')
  const [limit, setLimit] = useState(0)
  const [matchValue, setMatchValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // the SQL mode
  const [sql, setSql] = useState('')
  const [sqlOut, setSqlOut] = useState<SqlPreview | null>(null)
  const [dsName, setDsName] = useState('')
  const [running, setRunning] = useState(false)
  // What SQL mode produces. `measure` saves the query as a dataset and defines
  // a measure over it — reusable, citable, certified. `rows` hangs the query on
  // the panel and prints what it returns. The second is genuinely useful and
  // genuinely uncertified, so it is a deliberate choice rather than a default.
  const [sqlAs, setSqlAs] = useState<'measure' | 'rows'>('measure')
  const inlineSql = mode === 'sql' && sqlAs === 'rows'

  useEffect(() => {
    listMetrics(dsId || undefined).then(r => {
      setMetrics(r.metrics)
      setMetricId(r.metrics[0]?.id ?? '')
      // Nothing to cite yet is a real state, and the form should not open on a
      // choice the workspace cannot make.
      if (!r.metrics.length) setMode('define')
    }).catch(() => { setMetrics([]); setMode('define') })
  }, [dsId])

  const chosen = metrics?.find(m => m.id === metricId)
  const chosenAgg = aggById(agg)
  const chosenDataset = (tables ?? []).find(t => t.id === dsId) ?? null
  const needsColumn = chosenAgg?.column

  const [sqlErr, setSqlErr] = useState<SqlError | null>(null)
  const runSql = async () => {
    setRunning(true); setErr(null); setSqlErr(null)
    try {
      setSqlOut(await previewSql(connId, sql))
    } catch (e) {
      setSqlOut(null)
      // A parse error knows its line and column. Routed to the editor, which
      // can point at it, rather than to the generic notice at the bottom of
      // the form.
      if (e instanceof GatewayError && e.code === 'bad_sql') {
        setSqlErr({ message: e.message, at: e.at })
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    } finally { setRunning(false) }
  }

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      // In SQL mode the query is saved as a dataset first, then the panel names
      // it. Two steps rather than one, because a saved query is a thing in its
      // own right that other panels can reuse — inlining it on the panel would
      // be the adhoc-metric mistake at the dataset level.
      // An inline panel saves nothing and defines nothing: the query goes on
      // the panel, and the dashboard reports itself uncertified because of it.
      if (inlineSql) {
        const r = await addPanel(dashboardId, {
          title: title.trim() || dsName.trim() || 'Query',
          mark: 'sql' as never, grain: 'none', agg: 'last', sql,
          ...(connId !== connectionId ? { connection_id: connId } : {}),
        })
        onAdded(`Panel added — it cites no definition, so ${''
          }this dashboard now reports itself uncertified`)
        void r
        return
      }
      let dataset_id: string | undefined
      if (mode === 'sql') {
        const ds = await saveVirtualDataset(
          connId, dsName.trim() || title.trim() || 'Saved query', sql,
          sqlOut?.times[0] ?? null)
        dataset_id = ds.dataset_id
      }
      const r = await addPanel(dashboardId, {
        title: title.trim() || chosen?.label || 'New panel',
        mark: mark as never, grain, agg,
        ...(dimension ? { dimension } : {}),
        ...(limit ? { limit, sort } : sort !== 'bucket' ? { sort } : {}),
        // The chosen table, unless SQL mode just saved one. `connection_id` is
        // sent only when it differs, so a single-warehouse dashboard stays
        // free of per-panel bookkeeping and null keeps meaning "the
        // dashboard's".
        dataset_id: dataset_id ?? (dsId || undefined),
        ...(connId !== connectionId ? { connection_id: connId } : {}),
        ...(mode === 'cite' ? { metric_id: metricId } : {
          column: column || undefined,
          denominator: denominator || undefined,
          value: matchValue || undefined,
        }),
      })
      onAdded(r.cited_existing
        ? `Panel added, citing ${r.metric_id.split('.').pop()} — no new definition`
        : `Panel added and ${r.metric_id.split('.').pop()} defined`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="card addpanel">
      {/* Which table this panel reads, before anything about what it shows.
          The dashboard's own is the default and stays the common case; the
          point is that it is a DEFAULT rather than the only option. A
          dashboard is a page of questions about a subject, and the answers do
          not all live in one table — the render has run one query per panel
          since per-panel connections were added, so nothing downstream ever
          required them to. */}
      <div className="ap-source">
        <span className="eyebrow">Reads</span>
        <select aria-label="Connection" value={connId}
          onChange={e => { setConnId(e.target.value); setDsId('') }}>
          {(conns ?? []).map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select aria-label="Table" value={dsId} onChange={e => setDsId(e.target.value)}>
          <option value="">{tables === null ? 'reading…' : 'choose a table…'}</option>
          {(tables ?? []).map(t => (
            <option key={t.id} value={t.id}>{t.id}{t.is_virtual ? ' (saved query)' : ''}</option>
          ))}
        </select>
        {elsewhere && (
          // Worth saying, because it is the thing that will surprise somebody
          // later: a dashboard filter reaches a panel only if THIS table has
          // the column, and the panel says so on its own face when it does not.
          <span className="p-filter-note">
            not the dashboard's own table — a filter on the bar reaches this
            panel only if {dsId || 'it'} has the column
          </span>
        )}
      </div>

      <div className="seg ap-mode">
        <button className={mode === 'cite' ? 'on' : ''} disabled={!metrics?.length}
          onClick={() => setMode('cite')}>Cite a definition</button>
        <button className={mode === 'define' ? 'on' : ''}
          onClick={() => setMode('define')}>New measure</button>
        <button className={mode === 'sql' ? 'on' : ''}
          onClick={() => setMode('sql')}>Write SQL</button>
      </div>

      {mode === 'sql' && (
        <>
          <SqlEditor label={`Query ${(conns ?? []).find(c => c.id === connId)?.name ?? connId}`}
            value={sql} onChange={setSql}
            onRun={runSql} running={running} error={sqlErr}
            placeholder={'select agent_id, started_at, cost_usd\n  from runs\n where status = \'done\''} />
          <div className="sql-act">
            <button className="btn action" disabled={running || !sql.trim()} onClick={runSql}>
              {running ? 'Running…' : 'Run'}
            </button>
          </div>
          <div className="seg ap-sqlas">
            <button className={sqlAs === 'measure' ? 'on' : ''}
              onClick={() => setSqlAs('measure')}>Measure it</button>
            <button className={sqlAs === 'rows' ? 'on' : ''}
              onClick={() => setSqlAs('rows')}>Just show the rows</button>
          </div>
          {sqlOut && (
            <>
              <div className="sql-res">
                <table className="sql-tbl">
                  <thead><tr>{sqlOut.columns.map(c => (
                    <th key={c.name}>{c.name}<i className={`ck ck-${c.kind}`}>{c.kind}</i></th>))}</tr></thead>
                  <tbody>{sqlOut.rows.slice(0, 6).map((r, i) => (
                    <tr key={i}>{r.map((v, k) => (
                      <td key={k} className={v === null ? 'nul' : ''}>{v === null ? 'null' : String(v)}</td>
                    ))}</tr>))}</tbody>
                </table>
              </div>
              <div className="sql-foot">
                {sqlOut.row_count} rows{sqlOut.truncated && ' (capped)'}
                {sqlOut.times.length === 0 && ' · no temporal column, so this panel cannot use a time axis'}
              </div>
            </>
          )}
        </>
      )}

      <div className="fld-row">
        {mode === 'cite' ? (
          <label className="fld grow"><span>Definition</span>
            <select value={metricId} onChange={e => setMetricId(e.target.value)}>
              {(metrics ?? []).map(m => (
                <option key={m.id} value={m.id}>{m.label} — {m.expr}</option>
              ))}
            </select></label>
        ) : inlineSql ? null : (
          <>
            {mode === 'sql' && (
              <label className="fld grow"><span>Save the query as</span>
                <input value={dsName} onChange={e => setDsName(e.target.value)}
                  placeholder="Cost by agent" /></label>
            )}
            <label className="fld grow"><span>Measure</span>
              <select value={agg} onChange={e => setAgg(e.target.value)}>
                {AGGS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select></label>
            {needsColumn && (
              <label className="fld grow"><span>Column</span>
                {/* In SQL mode the columns are known — they are what the query
                    just returned — so this is a choice rather than a guess. */}
                {mode === 'sql' && sqlOut
                  ? <select value={column} onChange={e => setColumn(e.target.value)}>
                      <option value="">choose…</option>
                      {sqlOut.columns.filter(c => c.kind === 'number')
                        .map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  : <input value={column} onChange={e => setColumn(e.target.value)} placeholder="cost_usd" />}
              </label>
            )}
            {/* `ratio` and `share` are the two that make a RATE expressible,
                and the reason they exist is that "refund rate" is the example
                this product uses to explain itself. Neither authoring surface
                offered them, so the headline example could not be built. */}
            {chosenAgg?.denominator && (
              <label className="fld grow"><span>Divided by</span>
                {mode === 'sql' && sqlOut
                  ? <select value={denominator} onChange={e => setDenominator(e.target.value)}>
                      <option value="">choose…</option>
                      {sqlOut.columns.filter(c => c.kind === 'number')
                        .map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  : <input value={denominator} onChange={e => setDenominator(e.target.value)}
                      placeholder="orders" />}
              </label>
            )}
            {chosenAgg?.value && (
              <label className="fld grow"><span>Equal to</span>
                <input value={matchValue} onChange={e => setMatchValue(e.target.value)}
                  placeholder="refunded" /></label>
            )}
          </>
        )}
        {/* Split by, order, and how many. `panels.add` has taken `dimension`,
            `sort` and `limit` since the first migration — a top-N bar chart is
            `sort: value_desc` with a limit, and the compiler has always known
            how to build one. Neither form offered any of the three, so every
            panel built through the product was every row, in bucket order,
            ungrouped. */}
        {!inlineSql && chosenDataset && chosenDataset.slices.length > 0 && (
          <label className="fld grow"><span>Split by</span>
            <select value={dimension} onChange={e => setDimension(e.target.value)}>
              <option value="">nothing — one line</option>
              {chosenDataset.slices.map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
        )}
        {!inlineSql && <>
          <label className="fld"><span>Order</span>
            <select value={sort} onChange={e => setSort(e.target.value)}>
              {/* Chronological is meaningless once a limit is set on a time
                  axis: it takes the OLDEST n buckets, which is never what
                  anybody means by "top 10". The server refuses that
                  combination; disabling it here is how you find out before
                  pressing Add rather than after. */}
              <option value="bucket" disabled={!!limit && grain !== 'none'}>
                oldest first{limit && grain !== 'none' ? ' — needs a ranking' : ''}
              </option>
              <option value="value_desc">largest first</option>
              <option value="value_asc">smallest first</option>
            </select></label>
          <label className="fld"><span>How many</span>
            <input type="number" min={0} max={5000} value={limit || ''}
              placeholder="all" onChange={e => {
                const n = Number(e.target.value) || 0
                setLimit(n)
                // Setting a limit on a time axis without a ranking is the
                // refusal above; pick one rather than let it be sent.
                if (n && sort === 'bucket' && grain !== 'none') setSort('value_desc')
              }} /></label>
        </>}
        {!inlineSql && <>
          <label className="fld"><span>Chart</span>
            <select value={mark} onChange={e => setMark(e.target.value)}>
              {MARKS.map(m => (
                <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>))}
            </select></label>
          <label className="fld"><span>Bucket</span>
            <select value={grain} onChange={e => setGrain(e.target.value)}>
              <option value="day">by day</option><option value="week">by week</option>
              <option value="month">by month</option><option value="none">no time axis</option>
            </select></label>
        </>}
        <label className="fld grow"><span>Panel title</span>
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder={chosen?.label ?? 'New panel'} /></label>
      </div>

      {mode === 'cite' && chosen && (
        <div className="ap-note">
          Citing <span className="mono">{chosen.id}</span> — <span className="mono">{chosen.expr}</span>,
          {' '}{chosen.status}. This panel will show the same number as every other panel citing it,
          and will follow it if the definition changes.
        </div>
      )}
      {inlineSql && (
        <div className="ap-note warn">
          Nothing here cites a definition, so nobody has agreed this number means what
          you think it means — and this dashboard will report itself <b>uncertified</b>
          {' '}for as long as the panel is on it. That is the trade: an arbitrary query
          in exchange for a claim the workspace cannot stand behind. Measure it instead
          if other panels should be able to reuse this.
        </div>
      )}
      {chosenAgg?.hint && mode !== 'cite' && (
        <div className="ap-note">{chosenAgg.hint}</div>
      )}
      {mode === 'define' && (
        <div className="ap-note warn">
          A new definition. If one of the above already means this, cite it instead — two
          definitions of one number is the thing this registry exists to prevent.
        </div>
      )}
      {err && <div className="notice" style={{ margin: '10px 0 0' }}>{err}</div>}

      <div className="wiz-act">
        <button className="btn action"
          disabled={busy || (mode === 'cite' && !metricId) || (mode === 'sql' && !sqlOut)
            || (mode !== 'cite' && !!chosenAgg?.denominator && !denominator.trim())
            || (mode !== 'cite' && !!chosenAgg?.value && !matchValue.trim())}
          title={inlineSql ? 'Adds an uncertified panel' : undefined}
          onClick={submit}>
          {busy ? 'Adding…' : 'Add panel'}
        </button>
        <button className="chip" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** A panel that cannot draw yet, drawn anyway.
 *
 *  It occupies the same footprint as a rendered panel and carries the same
 *  header, so the dashboard reads as a dashboard with one panel switched off —
 *  not as a dashboard that failed to load. */
function PendingPanel({ p, span, busy, onRatify, onMakeTask }: {
  p: WirePanel; span: number; busy: boolean; onRatify: () => void
  /** A panel that could not run is work for somebody: make it a task, here. */
  onMakeTask?: () => void
}) {
  const proposed = p.status === 'proposed'
  return (
    <div className="panel panel-pending" style={{ '--span': span } as React.CSSProperties}>
      <div className="p-binding">
        <i className="dot dot-warn" />
        <span className="mono">{p.panel.metric_id?.split('.').pop() ?? 'no definition'}</span>
        {proposed ? ' · proposed' : ' · unresolved'}
      </div>
      <div className="p-title">{p.panel.title}</div>
      <div className="p-none">
        {proposed
          ? <>Nobody has ratified this definition yet, and only ratified definitions run —
              which is what stops two dashboards quietly disagreeing about the same number.</>
          : p.error}
      </div>
      {proposed && (
        <button className="btn action pend-btn" disabled={busy} onClick={onRatify}>
          {busy ? 'Ratifying…' : 'Ratify this definition'}
        </button>
      )}
      {!proposed && onMakeTask && (
        <button type="button" className="btn pend-btn" onClick={onMakeTask}>Make a task to fix it</button>
      )}
    </div>
  )
}

export function DashboardDetail() {
  const { id } = useParams()
  const [dash, setDash] = useState<Dashboard | null | undefined>(undefined)
  const [panels, setPanels] = useState<Panel[] | null>(null)
  // The range and the filters live in the URL, so a dashboard someone is
  // looking at is a dashboard they can send. Read once for the initial state
  // and written on every change below — a link that does not carry the slice
  // means two readers on one number with no way to tell they disagree.
  const [search, setSearch] = useSearchParams()
  const opened = useRef(parseView(search, '30d')).current
  // A preset, a calendar period to date, or a span of dates — the server
  // resolves all three; `days` is only its length, for words and the probe.
  const [range, setRangeKey] = useState(opened.range)
  const days = rangeDays(range)
  /** Each panel also read over the window just before, to compare with. */
  const [compare, setCompare] = useState(!!opened.compare)
  const [loadingWindow, setLoadingWindow] = useState(false)
  const toast = useToast()
  /** The failed panel a task is being made for, while its dialog is open. */
  const [fixing, setFixing] = useState<WirePanel | null>(null)

  const [live, setLive] = useState<WireDash | null>(null)
  const [liveErr, setLiveErr] =
    useState<{ code: string; message: string; field?: string } | null>(null)
  const [ratifying, setRatifying] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // When the warehouse was last asked. Null for a seeded dashboard, which
  // is generated in the browser and has no reading to be stale.
  const [readAt, setReadAt] = useState<number | null>(null)
  // Reordering by hand, in edit mode only. Dragging while reading would be a
  // trap: the panels are also the read surface, and a stray drag on a chart
  // would silently rewrite the dashboard for everyone.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  // Which panel is being resized. The card is `draggable`, and a pointer drag
  // on the edge otherwise starts an HTML5 drag as well — so the panel both
  // resized and tried to reorder itself, which is most of what "buggy" looked
  // like.
  const [sizingId, setSizingId] = useState<string | null>(null)
  // The filter bar. A READING choice, like the range beside it — slicing to one
  // region does not change what a metric means, so it does not touch
  // certification. It does change what the numbers say, which is why it
  // re-queries and why every panel reports what it could apply.
  const [filters, setFilters] = useState<WireFilter[]>(opened.filters)
  const navigate = useNavigate()

  const cameFrom = useRef(id)
  useEffect(() => {
    setPanels(null); setLive(null); setLiveErr(null)
    // Filters name COLUMNS, and the next dashboard is on a different dataset.
    // Carried over, they arrive as a bar full of columns nothing has, and the
    // page opens saying "3 panels are not filtered" about a filter the reader
    // never set here. The range is deliberately kept — a window is a preference
    // that means the same thing everywhere, and a column name is not.
    //
    // On a NAVIGATION, not on mount. This effect runs once when the page opens
    // too, and clearing there threw away the filters the link had just been
    // read for — so a shared link opened on the unfiltered default, which is
    // the exact failure putting them in the URL was meant to fix.
    if (cameFrom.current !== id) {
      cameFrom.current = id
      setFilters([])
    }
    // `.catch`, because `getDashboard` can now reject.
    //
    // It could not before: `liveRows` swallowed every failure into `[]`, which
    // is the bug that was fixed two commits ago — a transient 401 cached "there
    // are no warehouse dashboards" for the life of the tab. Making it rethrow
    // was right and left this caller holding an unhandled rejection, so `dash`
    // stayed `undefined` and the page said "Loading…" forever.
    //
    // Which is precisely the failure the audit found in `usePagedList`,
    // recreated one function over by the fix for a different one.
    getDashboard(id ?? '')
      .then(d => setDash(d ?? null))
      .catch(e => {
        setDash(null)
        setLiveErr(e instanceof GatewayError
          ? { code: e.code, message: e.message, field: e.field }
          : { code: 'offline', message: e instanceof Error ? e.message : String(e) })
      })
  }, [id])

  // Two sources, one screen. A seeded dashboard shapes its panels in the
  // browser; a live one is a query, so the range control is not a slice of
  // something already fetched — it re-runs every panel against the warehouse.
  // That is why this effect depends on `days` and the seeded path does not.
  const isLive = dash?.live === true
  /** The grid is 12 columns. A dashboard with one chart on it should not leave
   *  six of them empty — the seeded dashboards always have nine panels, so this
   *  only became visible once dashboards could be built one panel at a time. */
  //  stat   3 of 12 — a single figure needs no more
  //  1 chart 12    — nothing to sit beside it
  //  2 charts 6    — a pair reads as a comparison
  //  3+      6     — two per row, so each keeps half the width rather than a
  //                  third; a third-width time series is a sparkline with axes
  /** What somebody DECIDED, or what the heuristic guesses when nobody has.
   *
   *  A stored span outranks the guess for the same reason a registered dataset
   *  outranks introspection: the guess describes the page as it is today, and
   *  a person saying "this heatmap is the point" is a fact about the page that
   *  should survive adding a panel next to it. */
  const widthOf = (p: WirePanel, charts: number) =>
    p.panel.span ?? spanFor(p.panel.mark, charts)

  const spanFor = (mark: string, charts: number) =>
    // A table is read down a column of rows, so it wants height rather than
    // width — half a row, like a chart, not the full twelve.
    mark === 'stat' ? 3 : mark === 'table' ? 6 : charts <= 1 ? 12 : 6
  // `replace`, not push: a reader adjusting a filter three times should not
  // have to press Back three times to leave the page.
  useEffect(() => {
    setSearch(prev => writeView(prev, { range, filters, compare }), { replace: true })
  }, [range, filters, compare, setSearch])

  // Coming from a live dashboard on a window this one cannot answer, the
  // buttons would show nothing selected while the chart drew whatever it had.
  useEffect(() => {
    // A seeded dashboard holds HORIZON days and no calendar: presets only.
    if (dash && !isLive && (days > HORIZON || !/^\d+d$/.test(range))) setRangeKey(`${HORIZON}d`)
  }, [dash, isLive, days, range])

  useEffect(() => {
    if (dash === undefined || dash === null) return
    if (!isLive) { getPanels(dash.id).then(setPanels); return }
    let stale = false
    setLoadingWindow(true)
    renderLive(dash.id, range, filters, compare)
      .then(w => {
        if (stale) return
        setLive(w)
        setLiveErr(null)
        setReadAt(Date.now())
        // A fresh read supersedes any local arrangement: the server's
        // order is now authoritative and the override would fight it.
        setOrder(null)
        const charts = w.panels.filter(p => !p.error && p.panel.mark !== 'stat').length
        setPanels(w.panels.filter(p => !p.error).map(p => toPanel(p, widthOf(p, charts))))
      })
      .catch(e => {
        if (stale) return
        // A GatewayError knows what went wrong and which field it was about.
        // Anything else really is the network.
        setLiveErr(e instanceof GatewayError
          ? { code: e.code, message: e.message, field: e.field }
          : { code: 'offline', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => { if (!stale) setLoadingWindow(false) })
    return () => { stale = true }
  }, [dash, isLive, range, compare, reloadKey, filters])

  // A window with nothing in it is often a window after the data stopped —
  // yesterday's export, a table that ended last month. The panels said "no rows
  // in the last 30 days" and left the reader to guess a longer range. When some
  // are empty, the year is read once to find where each panel's data ends, and
  // the page offers the shortest range that reaches it for the empty ones —
  // the empty ones only: a panel with data from today says nothing about one
  // whose table stopped in August.
  const emptyIds = live ? live.panels.filter(p => !p.error && !p.rows
    && !(p.series ?? []).some(s => s.points.some(([, v]) => v !== null && v !== undefined)))
    .map(p => p.panel.id) : []
  const empties = emptyIds.length
  const probeKey = dash ? `${dash.id}:${JSON.stringify(filters)}` : ''
  const [newest, setNewest] = useState<{ key: string; by: Record<string, string> } | null>(null)
  useEffect(() => {
    if (!isLive || !dash || !empties || days >= RANGES[RANGES.length - 1] || newest?.key === probeKey) return
    let stale = false
    renderLive(dash.id, `${RANGES[RANGES.length - 1]}d`, filters)
      .then(w => {
        if (stale) return
        const by: Record<string, string> = {}
        for (const p of w.panels) for (const s of p.series ?? []) {
          for (const [d, v] of s.points) {
            if (v !== null && v !== undefined && (!by[p.panel.id] || d > by[p.panel.id])) by[p.panel.id] = d
          }
        }
        setNewest({ key: probeKey, by })
      })
      .catch(() => {})   // an offer that cannot be made is not an error to show
    return () => { stale = true }
  }, [isLive, dash, empties, days, filters, probeKey, newest?.key])
  const reach = (() => {
    if (!empties || !newest || newest.key !== probeKey) return null
    // Where each empty panel's data ends; the range has to reach the earliest
    // of those for every one of them to have something to show.
    const ends = emptyIds.map(id => newest.by[id]).filter((d): d is string => !!d)
    if (!ends.length) return null
    const at = ends.reduce((a, b) => (a < b ? a : b))
    const ago = Math.ceil((Date.now() - Date.parse(at)) / 86_400_000) + 1
    if (ago <= days) return null
    const range = RANGES.find(r => r >= ago)
    return range ? { range, at, count: ends.length } : null
  })()

  /** One long-format file for the dashboard, plus one per query panel.
   *
   *  Query panels get their own file rather than four blank columns in the
   *  shared one: an arbitrary SELECT has no metric, no unit and no date axis.
   */
  const exportCsv = () => {
    if (!panels?.length || !dash || loadingWindow || (isLive && (!live || liveErr))) return
    const ctx = {
      dashboard: { id: dash.id, title: dash.title },
      days, certified,
      // The server's echo, not local state. These rows came out of the last
      // render, so the filters that produced them are the ones that render
      // reported — local state may already have moved on, and a file labelled
      // with a slice it was not taken under is worse than one with no label.
      filters: live?.filters ?? filters,
      partial: live?.filters_partial ?? [],
    }
    const shared = panels.filter(p => p.kind !== 'sql')
    if (shared.length) {
      download(exportName(dash.title, ctx), dashboardCsv(shared, ctx))
    }
    for (const p of panels.filter(p => p.kind === 'sql')) {
      download(exportName(dash.title, ctx, p.title), sqlPanelCsv(p, ctx))
    }
    toast(`Downloaded — the file names the window, the filters and ${
      certified ? 'the ratified definitions behind it' : 'which numbers nobody has ratified'}`)
  }

  const ratifyAll = async (metricIds: string[]) => {
    setRatifying(metricIds[0])
    try {
      // Sequential, not concurrent: each ratification deprecates whatever held
      // the badge before it, and two of those racing on one metric is exactly
      // what the partial unique index would reject.
      for (const m of metricIds) await ratifyMetric(m)
      forgetLiveDashboards()
      toast(metricIds.length === 1
        ? `${metricIds[0].split('.').pop()} ratified — every panel citing it re-renders`
        : `${metricIds.length} definitions ratified`)
      const w = await renderLive(dash!.id, range, filters, compare)
      setLive(w)
      setReadAt(Date.now())
      // A fresh read supersedes any local arrangement: the server's
      // order is now authoritative and the override would fight it.
      setOrder(null)
      const charts = w.panels.filter(p => !p.error && p.panel.mark !== 'stat').length
      setPanels(w.panels.filter(p => !p.error).map(p => toPanel(p, widthOf(p, charts))))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'ratification failed')
    } finally { setRatifying(null) }
  }
  const ratify = (metricId: string) => ratifyAll([metricId])

  // Every edit re-reads the dashboard rather than patching local state. The
  // server decides ids, positions and whether a definition arrives ratified, so
  // guessing at the result here is how the screen and the database drift.
  const reload = () => { forgetLiveDashboards(); setReloadKey(k => k + 1) }

  const doRename = async () => {
    const t = (renaming ?? '').trim()
    if (!t || !dash || t === dash.title) { setRenaming(null); return }
    try {
      await renameDashboard(dash.id, t)
      setRenaming(null); setDash(current => current ? { ...current, title: t } : current)
      forgetLiveDashboards(); toast(`Renamed to ${t}`)
    }
    catch (e) { toast(e instanceof Error ? e.message : 'rename failed') }
  }

  const doDelete = async () => {
    if (!dash) return
    try {
      const r = await deleteDashboard(dash.id)
      // The definitions outlive the page: a metric can be cited elsewhere, and
      // removing one is its own decision.
      toast(`Deleted — ${r.panels_removed} panels removed, their definitions kept`)
      forgetLiveDashboards()
      navigate('/dashboards')
    } catch (e) { toast(e instanceof Error ? e.message : 'delete failed') }
  }

  /** Make the current slice the one this dashboard opens on.
   *
   *  Edit mode only, because it changes what everyone else sees. The
   *  difference between "I sliced this to EMEA" and "this dashboard is about
   *  EMEA" is who it is true for, and every reader re-typing the second one is
   *  how two people end up looking at different numbers under one title.
   */
  const saveDefaultFilters = useCallback(async () => {
    if (!dash) return
    try {
      await setDefaultFilters(dash.id, filters)
      setLive(l => (l ? { ...l, default_filters: filters } : l))
      toast(filters.length
        ? `Saved — this dashboard now opens on ${filters.map(f => f.dimension).join(', ')}`
        : 'Saved — this dashboard now opens unfiltered')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the default')
    }
  }, [dash, filters, toast])

  /** Set one panel's width, locally first so the grid moves under the pointer,
   *  then persisted. A resize that waits for a round trip feels broken. */
  const saveSize = useCallback(async (
    spans: Record<string, number>, heights: Record<string, number> = {},
    cols: Record<string, number | null> = {},
  ) => {
    try {
      await resizePanels(dash!.id, spans, heights, cols)
      forgetLiveDashboards()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not save the size')
      // The local change already moved the grid, so a failed write leaves the
      // screen showing a layout the server does not have. Re-reading is the
      // only honest end to that.
      reload()
    }
  }, [dash, toast, reload])

  const setSpan = useCallback((panelId: string, span: number) => {
    // Widened past the edge from where it was placed, it moves left to fit
    // rather than spilling into a column the grid does not have.
    const placed = panels?.find(p => p.id === panelId)?.col
    const col = placed && placed + span > 13 ? 13 - span : undefined
    setPanels(ps => ps?.map(p => (p.id === panelId ? { ...p, span, ...(col ? { col } : {}) } : p)) ?? ps)
    void saveSize({ [panelId]: span }, {}, col ? { [panelId]: col } : {})
  }, [saveSize, panels])

  /** Where a panel starts across the twelve columns — free placement: it sits
   *  there in its row, so a gap is wherever the author left one. Null puts it
   *  back to following the panel before it. */
  const setCol = useCallback((panelId: string, col: number | null) => {
    setPanels(ps => ps?.map(p => (p.id === panelId ? { ...p, col: col ?? undefined } : p)) ?? ps)
    void saveSize({}, {}, { [panelId]: col })
  }, [saveSize])

  /** The column a panel is drawn at now, for one that has not been placed:
   *  the first nudge starts from where it is, not from column 1. */
  const drawnCol = (el: Element | null): number => {
    const tile = el?.closest('.pv') as HTMLElement | null
    const grid = tile?.closest('.panel-grid') as HTMLElement | null
    if (!tile || !grid) return 1
    const g = grid.getBoundingClientRect(), t = tile.getBoundingClientRect()
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0
    const colW = (g.width + gap) / 12
    return Math.min(12, Math.max(1, Math.round((t.left - g.left) / colW) + 1))
  }

  const setHeight = useCallback((panelId: string, height: number) => {
    setPanels(ps => ps?.map(p => (p.id === panelId ? { ...p, height } : p)) ?? ps)
    void saveSize({}, { [panelId]: height })
  }, [saveSize])

  /** Drag the right edge. The grid is twelve columns, so the pointer snaps to
   *  column boundaries rather than to pixels — anything else stores a width
   *  the grid will not draw. */
  const beginResize = useCallback((e: React.PointerEvent, panel: Panel,
                                   axis: 'x' | 'y' | 'xy' = 'x') => {
    e.preventDefault()
    e.stopPropagation()
    const grid = (e.currentTarget as HTMLElement).closest('.panel-grid')
    if (!grid) return
    // Snapped by comparing against the width each span actually RENDERS at,
    // read off `gridTemplateColumns`, rather than dividing the grid by twelve.
    //
    // Both agree today — I checked, expecting the 14px gaps to have skewed the
    // division, and they do not: the gap term cancels to under a tenth of a
    // column at every span. So this is not a bug fix. It is the version that
    // stays correct if the gap, the track sizing or the column count ever
    // changes, which the arithmetic identity it relies on would not.
    const style = getComputedStyle(grid)
    const tracks = style.gridTemplateColumns.split(' ').map(parseFloat)
    const gap = parseFloat(style.columnGap) || 0
    const resolved = tracks.length === 12 && !tracks.some(Number.isNaN)
    // Not every environment resolves `grid-template-columns` to pixels — jsdom
    // hands back the authored `repeat(12, minmax(0, 1fr))`. Falling back to an
    // even twelfth is right to within a tenth of a column here, and is what
    // this did before; REFUSING would have been a handle that silently does
    // nothing, which is worse than a handle that is a hair imprecise.
    const width = grid.getBoundingClientRect().width
    const widthOfSpan = resolved
      ? (n: number) => tracks.slice(0, n).reduce((a, w) => a + w, 0) + gap * (n - 1)
      : (n: number) => (width / 12) * n

    const startY = e.clientY
    const startH = panel.height ?? 264
    setSizingId(panel.id)
    // Measured ONCE, before the first move. Re-reading it each frame reads a
    // box that the previous frame's resize already moved, so the panel chases
    // the pointer and jumps between two widths.
    const left = (e.currentTarget as HTMLElement).closest('.pv')!.getBoundingClientRect().left
    let latest = panel.span
    let latestH = startH

    const move = (ev: PointerEvent) => {
      if (axis !== 'y') {
        const want = ev.clientX - left
        // The span whose rendered width is nearest the pointer.
        let next = 3
        let best = Infinity
        for (let n = 3; n <= 12; n++) {
          const d = Math.abs(widthOfSpan(n) - want)
          if (d < best) { best = d; next = n }
        }
        if (next !== latest) {
          latest = next
          setPanels(ps => ps?.map(p => (p.id === panel.id ? { ...p, span: next } : p)) ?? ps)
        }
      }
      if (axis !== 'x') {
        // Height is free rather than snapped: there is no grid to align to
        // vertically — the rows size themselves to what is in them — so
        // snapping would be inventing a lattice that does not exist. Rounded
        // to 10px so the stored number is a round one.
        const next = Math.min(900, Math.max(160,
          Math.round((startH + (ev.clientY - startY)) / 10) * 10))
        if (next !== latestH) {
          latestH = next
          setPanels(ps => ps?.map(p => (p.id === panel.id ? { ...p, height: next } : p)) ?? ps)
        }
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSizingId(null)
      // Written once, on release. Persisting every column crossed would be a
      // dozen writes for one intent.
      const spans = latest !== panel.span ? { [panel.id]: latest } : {}
      const heights = latestH !== (panel.height ?? null) ? { [panel.id]: latestH } : {}
      if (Object.keys(spans).length || Object.keys(heights).length) {
        void saveSize(spans, heights)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setSpan])

  /** Move the dragged panel to where it was dropped, then persist the whole
   *  order. Applied locally first: a drag that waits for a round trip before
   *  anything moves feels broken, and this is trivially reversible. */
  const dropOn = async (targetId: string) => {
    const from = dragId
    setDragId(null); setOverId(null)
    if (!from || from === targetId || !dash) return

    const ids = arranged.map(p => p.id)
    const next = ids.filter(id => id !== from)
    // Dropped on a panel further along, it goes AFTER it. Always inserting
    // before the target put a panel dropped on its right-hand neighbour back
    // where it was, so a panel could be moved left and never right.
    const later = ids.indexOf(from) < ids.indexOf(targetId)
    next.splice(next.indexOf(targetId) + (later ? 1 : 0), 0, from)
    await saveOrder(next)
  }

  /** One place earlier or later: the keyboard's way, and the mouse's when a
   *  drag across a wide grid is more than the move needs. */
  const nudge = async (id: string, step: -1 | 1) => {
    const ids = arranged.map(p => p.id)
    const i = ids.indexOf(id), j = i + step
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    ;[next[i], next[j]] = [next[j], next[i]]
    await saveOrder(next)
  }

  const saveOrder = async (next: string[]) => {
    if (!dash) return
    const before = order
    setOrder(next)
    try {
      await reorderPanels(dash.id, next)
      forgetLiveDashboards()
      toast('Panel order saved')
    } catch (e) {
      // Put it back rather than leave the screen disagreeing with the server.
      setOrder(before)
      toast(e instanceof Error ? e.message : 'could not save the new order')
    }
  }

  const doRemovePanel = async (panelId: string) => {
    try {
      // A panel that carried its own query had no definition to keep, and
      // saying one was kept names a metric that never existed.
      const r = await removePanel(panelId)
      toast(r.metric_kept
        ? 'Panel removed — its definition is kept'
        : 'Panel removed — it carried its own query, so nothing else changes')
      reload()
    }
    catch (e) { toast(e instanceof Error ? e.message : 'could not remove') }
  }

  // A range change re-scopes every panel below it. The frame is held at reduced
  // opacity while it lands — no skeleton, no layout jump, no flash.
  const setRange = (n: number | string) => {
    const next = typeof n === 'number' ? `${n}d` : n
    if (next === range) return
    setRangeKey(next)
    // A live dashboard re-queries and clears this itself when the rows land.
    if (!dash?.live) {
      setLoadingWindow(true)
      setTimeout(() => setLoadingWindow(false), 160)
    }
  }

  if (dash === undefined) return <div className="detail"><div className="empty">Loading…</div></div>
  if (dash === null) {
    // "Not found" and "we could not ask" are different answers, and only one
    // of them means the dashboard is gone. Saying the first when the gateway
    // is down sends somebody looking for a dashboard that is fine.
    return (
      <div className="detail"><div className="empty">
        {liveErr
          ? <><b>Could not load this dashboard.</b> {liveErr.message}</>
          : <>Dashboard not found.</>}
        {' '}<Link to="/dashboards">Back to the collection.</Link>
      </div></div>
    )
  }

  // A seeded dashboard is generated in the browser and holds exactly HORIZON
  // days. Offering 180d or 365d there draws all 90 of them under a label that
  // says a year — the chart is not wrong, the axis is, and nothing says which.
  // A live dashboard is a query and can be asked for any window.
  const offered = isLive ? RANGES : RANGES.filter(n => n <= HORIZON)

  const kpis = panels?.filter(p => p.kind === 'stat') ?? []
  const rest = panels?.filter(p => p.kind !== 'stat') ?? []

  // The order shown: a local override while dragging, the server's otherwise.
  // Keeping the two separate is what lets a drop apply instantly and still fall
  // back to the stored order if the write fails.
  const shown = [...kpis, ...rest]
  const arranged = order
    ? order.map(id => shown.find(p => p.id === id)).filter((p): p is Panel => !!p)
    : shown

  // A live dashboard's failing panels never become Panels at all — an
  // unratified binding comes back as an error, so the pending list is read off
  // the wire rather than off the rendered chart.
  const failed = live?.panels.filter(p => p.error) ?? []
  // A panel waiting on a human and a panel that could not run are different
  // problems with different fixes, and this called both "pending". A dropped
  // table, a statement timeout or a revoked grant got the banner "this panel
  // is waiting on you — ratify it", and the button then ratified a definition
  // that was already ratified, or `null`.
  const proposals = failed.filter(p => p.status === 'proposed' && p.panel.metric_id)
  const broken = failed.filter(p => !proposals.includes(p))
  // The server draws the same line and is the one that knows which exception
  // it caught. Where it has spoken, believe it.
  const brokenIds = new Set(live?.failed ?? [])

  // What the SERVER counted, not a second count computed from the errors. A
  // panel carrying its own query is uncertified and does NOT error, so
  // counting errors said "1 unratified metric" on a dashboard with two
  // uncertified panels and no errors at all — and hid the explanation, which
  // is gated on the same number.
  const uncertified = isLive
    ? (live?.unratified ?? []).filter(id => !brokenIds.has(id))
    : (panels?.filter(p => !p.ratified) ?? [])
  const certified = isLive ? (live?.certified ?? false) : dash.certified
  // A panel citing nothing is not "an unratified metric" — there is no metric.
  const sqlPanels = live?.panels.filter(p => p.sql).length ?? 0
  const n = uncertified.length || 1
  const uncertifiedLabel = sqlPanels === n
    ? `${n} panel${n > 1 ? 's' : ''} carry their own query`
    : `${n} uncertified panel${n > 1 ? 's' : ''}`

  return (
    <div className={`detail dashboard-detail${editing ? ' is-editing' : ''}`}>
      {(() => { const n = panels === null ? dash.panelCount : panels.length + failed.length
        return <DetailHead back={{ to: '/dashboards', label: 'Dashboards' }} keyId={dash.key}
        title={editing && isLive
          ? <input className="title-edit" aria-label="Dashboard title" value={renaming ?? dash.title}
              onChange={e => setRenaming(e.target.value)} onBlur={doRename}
              onKeyDown={e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(null) }} />
          : dash.title}
        dot={isLive && !live ? 'gray' : certified ? 'green' : 'warn'}
        status={[
          isLive && !live ? <span>{liveErr ? 'Status unavailable' : 'Checking definitions…'}</span>
            : certified ? <span className="good">Certified</span> : <span className="warn">{uncertifiedLabel}</span>,
          <span>{n} {n === 1 ? 'panel' : 'panels'}</span>,
          <span>{isLive ? 'Warehouse dashboard' : 'Sample dashboard'} · {dash.space}</span>,
          <span>Owned by {dash.owner}{dash.agentOwner ? ' · agent' : ''}</span>,
          dash.proposals > 0 && <span className="agent">{dash.proposals} panel proposal</span>,
          editing && <Pill tone="blue">Editing layout</Pill>,
        ]}
        actions={<>
          {(panels?.length ?? 0) > 0 && <button className="tool" onClick={exportCsv}
            disabled={loadingWindow || (isLive && !!liveErr)}
            title="Every panel's numbers, with the definitions and window behind them">Download CSV</button>}
          {isLive && <ProjectsButton about={{ id: dash.id, type: 'dashboard' }} />}
          {isLive && <TasksButton about={{ id: dash.id, type: 'dashboard', title: dash.title, key: dash.key }} />}
          {isLive && <ShareButton id={dash.id} title={dash.title} />}
          {isLive && <CommentsButton subjectId={dash.id} title={dash.title} />}
          {isLive && editing && <button className="btn" onClick={() => setAdding(value => !value)}>
            {adding ? 'Cancel' : '+ Add panel'}</button>}
          {isLive && <button className={editing ? 'tool on' : 'btn action'} aria-pressed={editing}
            onClick={() => { setEditing(value => !value); setAdding(false); setRenaming(null); setConfirming(false) }}>
            {editing ? 'Done editing' : 'Edit'}</button>}
          {isLive && editing && !confirming && <button className="btn ghost danger" onClick={() => setConfirming(true)}>Delete</button>}
          {dash.proposals > 0 && <button className="tool" onClick={() => toast('Analyst proposed rebinding the backlog panel to a ratified definition — review it like any diff')}>
            Review panel proposal</button>}
        </>} /> })()}

      {isLive && editing && <div className="dashboard-edit-note" role="status">
        <strong>Editing layout</strong><span>Drag panels to reorder. Use the controls to resize. Changes save immediately; there is no undo history.</span>
      </div>}
      {isLive && editing && <DashboardAIEdit dashboardId={dash.id}
        panelIds={(live?.panels ?? []).map(p => p.panel.id)} onApplied={reload} />}
      {isLive && editing && confirming && <div className="dashboard-delete-confirm" role="group" aria-label="Confirm dashboard deletion">
        <span>Delete {dash.title} and its {dash.panelCount} panel{dash.panelCount === 1 ? '' : 's'}? Metric definitions will be kept.</span>
        <button className="btn ghost danger" onClick={doDelete}>Delete it</button>
        <button className="tool" onClick={() => setConfirming(false)}>Keep it</button>
      </div>}

      <details className="dashboard-about">
        <summary>About this dashboard <span>Source, ownership &amp; definitions</span></summary>
        <dl className="kv">
          <dt>Owner</dt><dd>{dash.owner}{dash.agentOwner && ' · agent'}</dd>
          {isLive ? <><dt>Last change</dt><dd>{dash.updated === 0 ? 'today' : `${dash.updated}d ago`} · edits write in place; no revision history yet</dd></>
            : <><dt>Revision</dt><dd>rev {dash.rev} · updated {dash.updated === 0 ? 'today' : `${dash.updated}d ago`}</dd></>}
          <dt>Source</dt><dd>{isLive
            ? <>Queried from <span className="mono">{live?.dashboard.connection_id ?? 'the warehouse'}</span> for the selected window and filters.</>
            : <>Example data · {dash.refresh}</>}</dd>
          <dt>Metrics</dt><dd>{dash.metrics.length ? dash.metrics.map(metric => <span key={metric} className="dashboard-metric-id mono">{metric}</span>) : 'No metric definitions cited'}</dd>
          {!isLive && <><dt>Readers</dt><dd>{dash.viewers} people in the last 7 days</dd></>}
        </dl>
      </details>

      {/* A rejection is not automatically an outage. Every one of these arrived
          as "Could not reach the gateway — start uvicorn", including a typo in
          the filter box: the server had answered precisely, with a code, a
          message and the field it was about, and the UI threw all three away
          and blamed the network. */}
      {liveErr && (
        <div className="notice" role="alert">
          {liveErr.code === 'no_credentials' || liveErr.code === 'bad_credentials' ? (
            <>
              <b>Not signed in.</b> {liveErr.message}
            </>
          ) : liveErr.code === 'offline' ? (
            <>
              <b>Could not reach the gateway.</b> {liveErr.message}
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                This dashboard is a query, not seed data, so there is nothing to fall back to.
                Start the gateway with <span className="mono">uv run uvicorn commonindex.gateway.app:app --port 8000</span>.
              </div>
            </>
          ) : (
            <>
              <b>That request was refused.</b> {liveErr.message}
              {liveErr.field && <> <span className="mono">({liveErr.field})</span></>}
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                The panels below are from the previous read, so they do not reflect this.
              </div>
            </>
          )}
        </div>
      )}

      {/* One filter row, above everything it scopes — never inside a panel. */}
      {/* Two clusters, because there are two kinds of control here and they
          were in one undifferentiated row: what this page is SHOWING — the
          window and the slice, which change the numbers — and what you can DO
          to it, which mostly does not. Eight ranges, a sentence of prose, a
          freshness reading and four buttons all at one weight is a row you
          read left to right every time instead of going straight to the part
          you wanted. */}
      <div className="dtoolbar dashboard-toolbar" role="region" aria-label="Dashboard controls">
        <div className="dtool-view">
          {/* The sentence that used to sit here in full — "Scopes every panel
              below, so the tiles and the charts always agree" — is a guarantee
              worth stating and not worth stating permanently. It explains
              something true once; after that it is a paragraph in a toolbar.
              It lives on the label now, for anyone who asks. */}
          <span className="eyebrow" title="One window for the whole page: every panel below is re-queried over it, so a tile and the chart above it can never quote different periods.">Range</span>
          <div className="seg seg-range" role="group" aria-label="Date range">
            {offered.map(n => (
              // `7d`, not `Last 7d`. The word repeated eight times across the
              // row and carried no information the eyebrow beside it does not
              // already carry — it was most of the width of the toolbar.
              <button key={n} className={range === `${n}d` ? 'on' : ''} aria-pressed={range === `${n}d`}
                title={`Last ${n} ${n === 1 ? 'day' : 'days'}`}
                aria-label={`Last ${n} ${n === 1 ? 'day' : 'days'}`}
                onClick={() => setRange(n)}>{n}d</button>
            ))}
          </div>
          {isLive && <RangeMore range={range} onRange={setRange} compare={compare} onCompare={setCompare} />}
        </div>

        <div className="dtool-acts">
          {isLive ? <Freshness at={readAt} busy={loadingWindow} onRefresh={reload} />
            : <span className="p-filter-note">Example data · not a live warehouse query</span>}
        </div>
        {/* Filters on a row of their own, always there. Beside the range they
            wrapped onto a second line the moment a chip was added — "+ Filter"
            started up there and then came down — and everything moved. */}
        {isLive && (
          <div className="dtool-filters">
            <span className="eyebrow">Filters</span>
            <FilterBar value={filters} onChange={setFilters}
              columns={live?.filterable ?? []} partial={live?.filters_partial ?? []}
              saved={live?.default_filters ?? []} dashboardId={dash.id} days={days} range={range}
              panels={(live?.panels ?? []).map(p => ({ id: p.panel.id, title: p.panel.title }))}
              onSaveDefault={editing ? saveDefaultFilters : undefined} />
          </div>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="ratify-bar">
          {/* Since a person's own new definitions now arrive ratified, this
              banner only appears for work someone else proposed — almost always
              an agent. Naming them matters: "you defined it" was addressed to
              the wrong party, and reviewing your own writing and reviewing a
              bot's are different acts.

              Gated on PROPOSALS, not on every panel that failed. A dropped
              table and a revoked grant used to arrive here as "waiting on you",
              under a button that ratified a definition already ratified. */}
          <div>
            <b>{proposals.length === 1 ? 'This panel is' : `These ${proposals.length} panels are`} waiting on you.</b>
            {' '}<span className="mono">{dash.owner}</span> proposed
            {proposals.length === 1 ? ' this definition' : ' these definitions'}, and only ratified
            definitions run. Read {proposals.length === 1 ? 'it' : 'them'} in the panel below, then stand
            behind {proposals.length === 1 ? 'it' : 'them'} — or leave {proposals.length === 1 ? 'it' : 'them'} unratified.
          </div>
          <button className="btn action" disabled={ratifying !== null}
            onClick={() => ratifyAll(proposals.map(p => p.panel.metric_id!))}>
            {ratifying ? 'Ratifying…' : proposals.length === 1 ? 'Ratify it' : `Ratify all ${proposals.length}`}
          </button>
        </div>
      )}

      {/* Nobody is waiting on a human here — the query could not run. Saying
          so is the difference between "review this" and "this is broken". */}
      {broken.length > 0 && (
        <div className="ratify-bar broke">
          <div>
            <b>{broken.length === 1 ? 'A panel could not run.' : `${broken.length} panels could not run.`}</b>
            {' '}This is not a definition waiting for review — the query failed.
            The reason is on {broken.length === 1 ? 'the card' : 'each card'} below.
          </div>
        </div>
      )}

      {/* One empty panel explains itself in its own card; the banner is for
          when several are empty and one action fixes them all. */}
      {reach && reach.count > 1 && !editing && (
        <div className="dash-older" role="status">
          <span><b>{reach.count === 1 ? 'A panel has' : `${reach.count} panels have`} nothing in {/^\d+d$/.test(range) ? `the last ${days} days` : rangeLabel(range)}.</b>
            {' '}{reach.count === 1 ? 'Its data ends' : 'Their data ends by'} {new Date(reach.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.</span>
          <button type="button" className="btn action" onClick={() => setRange(reach.range)}>
            Show the last {reach.range} days
          </button>
        </div>
      )}

      {adding && dash && (
        <AddPanel dashboardId={dash.id} datasetId={live?.dashboard.dataset_id ?? null}
          connectionId={live?.dashboard.connection_id ?? ''}
          onCancel={() => setAdding(false)}
          onAdded={msg => { setAdding(false); toast(msg); reload() }} />
      )}

      <div className="dashboard-canvas-heading"><h2>{editing ? 'Arrange panels' : 'Overview'}</h2>
        <span>{loadingWindow ? 'Refreshing values…' : liveErr ? 'Latest query unavailable' : compare && live?.previous_window ? `${rangeLabel(range)}, compared with the ${days} ${days === 1 ? 'day' : 'days'} before` : rangeLabel(range)}</span></div>
      {panels === null ? (
        <div className="dashboard-empty">{liveErr ? <><h2>Panels could not be loaded</h2><p>Check the message above and try the query again.</p>
          <button className="tool" disabled={loadingWindow} onClick={reload}>Retry query</button></>
          : <span role="status">Loading panels…</span>}</div>
      ) : !arranged.length && !failed.length && !editing ? (
        <div className="dashboard-empty"><h2>No panels yet</h2><p>Add your first panel to turn a metric into a shared view.</p>
          {isLive && <button className="btn action" onClick={() => { setEditing(true); setAdding(true) }}>+ Add first panel</button>}</div>
      ) : (
        <div className={`panel-grid${loadingWindow ? ' is-loading' : ''}`} aria-busy={loadingWindow} aria-label="Dashboard panels">
          {arranged.map(p => (
            editing && isLive
              ? <div key={p.id}
                     className={`pv${dragId === p.id ? ' is-dragging' : ''}${overId === p.id && dragId !== p.id ? ' is-over' : ''}${sizingId === p.id ? ' is-resizing' : ''}`}
                     style={{ '--span': p.span, '--col': p.col ?? 'auto' } as React.CSSProperties}
                     draggable={sizingId === null}
                     onDragStart={e => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move' }}
                     onDragEnd={() => { setDragId(null); setOverId(null) }}
                     onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                                        if (overId !== p.id) setOverId(p.id) }}
                     onDrop={e => { e.preventDefault(); dropOn(p.id) }}>
                  <div className="pv-grip" aria-hidden>⠿</div>
                  <div className="pv-tools">
                    {/* Width, by dragging the edge it changes — a number in a
                        dropdown would need translating into a picture before
                        you could choose, and this is a picture already. These
                        are the keyboard path: a drag handle with no
                        alternative is a layout only a mouse can author.

                        Beside Remove, not floating over the footer, where it
                        covered the panel's own "not certified" line. */}
                    <span className="pv-size" role="group" aria-label={`Position of ${p.title}`}>
                      <button aria-label="Move earlier" title="Move earlier (left / up)"
                        disabled={arranged[0]?.id === p.id} onClick={() => void nudge(p.id, -1)}>◀</button>
                      <button aria-label="Move later" title="Move later (right / down)"
                        disabled={arranged.at(-1)?.id === p.id} onClick={() => void nudge(p.id, 1)}>▶</button>
                    </span>
                    <span className="pv-size" role="group" aria-label={`Column of ${p.title}`}>
                      <button aria-label="Shift left" title="Start one column further left"
                        disabled={p.col === 1}
                        onClick={e => setCol(p.id, Math.max(1, (p.col ?? drawnCol(e.currentTarget)) - 1))}>←</button>
                      <button className="pv-size-n pv-col" title={p.col ? 'Back to automatic: follow the panel before it' : 'Follows the panel before it'}
                        onClick={() => p.col && setCol(p.id, null)}>{p.col ? `col ${p.col}` : 'auto'}</button>
                      <button aria-label="Shift right" title="Start one column further right"
                        disabled={(p.col ?? 1) + p.span > 12}
                        onClick={e => setCol(p.id, Math.min(13 - p.span, (p.col ?? drawnCol(e.currentTarget)) + 1))}>→</button>
                    </span>
                    <span className="pv-size" role="group" aria-label={`Width of ${p.title}`}>
                      <button aria-label="Narrower" disabled={p.span <= 3}
                        onClick={() => setSpan(p.id, Math.max(3, p.span - 3))}>−</button>
                      <span className="pv-size-n">{p.span}/12</span>
                      <button aria-label="Wider" disabled={p.span >= 12}
                        onClick={() => setSpan(p.id, Math.min(12, p.span + 3))}>+</button>
                    </span>
                    <span className="pv-size" role="group" aria-label={`Height of ${p.title}`}>
                      <button aria-label="Shorter" disabled={(p.height ?? 264) <= 160}
                        onClick={() => setHeight(p.id, Math.max(160, (p.height ?? 264) - 60))}>−</button>
                      <span className="pv-size-n">{p.height ?? 264}px</span>
                      <button aria-label="Taller" disabled={(p.height ?? 264) >= 900}
                        onClick={() => setHeight(p.id, Math.min(900, (p.height ?? 264) + 60))}>+</button>
                    </span>
                    <button className="chip danger" onClick={() => doRemovePanel(p.id)}>Remove</button>
                  </div>
                  <PanelChart panel={p} days={days} />
                  {/* Three grips, because there are three intents. One grip in
                      the corner is not enough; a heatmap that
                      wants width and a table that wants height are different
                      asks, and forcing both through a diagonal drag means
                      changing one always nudges the other. */}
                  <div className="pv-edge pv-edge-x" role="separator"
                    aria-label={`Drag to widen or narrow ${p.title}`}
                    onPointerDown={e => beginResize(e, p, 'x')} />
                  <div className="pv-edge pv-edge-y" role="separator"
                    aria-label={`Drag to change the height of ${p.title}`}
                    onPointerDown={e => beginResize(e, p, 'y')} />
                  <div className="pv-corner" role="separator"
                    aria-label={`Drag to resize ${p.title}`}
                    onPointerDown={e => beginResize(e, p, 'xy')} />
                </div>
              : <PanelChart key={p.id} panel={p} days={days}
                  windowLabel={/^\d+d$/.test(range) ? undefined : rangeLabel(range)}
                  dataEnds={newest?.key === probeKey ? newest.by[p.id] : undefined}
                  widenLabel={reach ? `Show the last ${reach.range} days` : undefined}
                  onWidenRange={reach ? () => setRange(reach.range) : undefined} />
          ))}
          {/* The affordance that is actually findable: a tile where the next
              panel would go, the size of a panel, in the grid you are looking
              at, because nobody hunts a toolbar for the main thing on the screen. */}
          {editing && isLive && !adding && (
            <button className="panel add-tile" style={{ '--span': 6 } as React.CSSProperties}
              onClick={() => setAdding(true)}>
              <span className="at-plus" aria-hidden="true">+</span>
              <span className="at-t">Add a panel</span>
              <span className="at-s">cite a definition, write a new measure, or query with SQL</span>
            </button>
          )}
          {/* A panel awaiting ratification keeps its place in the grid rather
              than being exiled to a list underneath. The prose below has always
              claimed the panel "says so on its own face"; until now it said so
              on a different part of the page, which is why a dashboard you built
              a moment ago looked simply broken. */}
          {failed.map(p => (
            <PendingPanel key={p.panel.id} p={p} span={spanFor(p.panel.mark, failed.length + rest.length)}
              busy={ratifying === p.panel.metric_id}
              onRatify={() => p.panel.metric_id && ratify(p.panel.metric_id)}
              onMakeTask={isLive ? () => setFixing(p) : undefined} />
          ))}
        </div>
      )}

      {fixing && dash && (
        <MakeTaskDialog about={{ id: dash.id, type: 'dashboard', title: dash.title, key: dash.key }} rel="touches"
          onClose={() => setFixing(null)}
          prefill={{ title: `Fix the “${fixing.panel.title}” panel on ${dash.title}`,
                     detail: `It could not run: ${fixing.error ?? 'no reason was given'}` }} />
      )}

      <details className="dashboard-about dashboard-definition-help"><summary>How metric definitions work <span>Certification &amp; provenance</span></summary>
      <div className="card prose" style={{ padding: '13px 16px', color: 'var(--text2)', lineHeight: 1.65 }}>
        In a conventional BI tool every chart carries its own copy of the definition, so “refund rate” quietly means six
        different things across six dashboards and nobody can tell which one the exec deck used. Here a panel cites a
        metric object. Ratifying a definition is a decision with an owner; changing it re-renders every panel that cites
        it and shows up in the log as one event.
        {uncertified.length > 0 && (
          <> This dashboard has {uncertified.length} uncertified panel{uncertified.length > 1 ? 's' : ''}
          {sqlPanels > 0 && <> — {sqlPanels === uncertified.length ? 'each' : `${sqlPanels} of them`} carrying
          {sqlPanels === 1 ? ' its' : ' their'} own query, citing no definition at all</>}. That is why the
          certified badge is off, and why the panel says so on its own face rather than looking exactly like
          the trustworthy ones.</>
        )}
      </div>
      </details>
    </div>
  )
}

// ── the filter bar ─────────────────────────────────────────────────────────

/** Operators that take no value at all — the input disappears for these,
 *  because "is empty" with a value box beside it invites filling it in. */
const NULLARY: FilterOp[] = ['is_null', 'is_not_null']
/** Enough of a float to read, and not the seventeen digits a double prints. */
const round2 = (n: number) => Math.round(n * 100) / 100
/** Operators that take a list. Typed comma-separated, which is the one place
 *  a text box beats a multi-select: you usually already have the list. */
const LISTY: FilterOp[] = ['in', 'not_in', 'between']

/** The column to filter on, as a list in the panel rather than the browser's
 *  menu: searchable, grouped, and each column marked with what it holds, so
 *  `refunded` reads as a yes/no and `order_id` as a number before it is picked. */
function ColumnPicker({ columns, onPick }: { columns: FilterColumn[]; onPick: (name: string) => void }) {
  const [q, setQ] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const match = (c: FilterColumn) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())
  const mark = (k: string) => k === 'number' ? '#' : k === 'bool' ? '◐' : k === 'time' ? '◷' : 'Aa'
  const groups: [string, FilterColumn[]][] = [
    ['Slice by', columns.filter(c => c.kind !== 'number' && match(c))],
    ['Compare a number', columns.filter(c => c.kind === 'number' && match(c))],
  ]
  const first = groups.flatMap(([, cs]) => cs)[0]
  const options = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
  const move = (from: HTMLElement | null, step: number) => {
    const all = options(); const i = from ? all.indexOf(from) : -1
    all[Math.max(0, Math.min(all.length - 1, i + step))]?.focus()
  }
  return (
    <div className="fcol">
      <input className="fcol-q" value={q} onChange={e => setQ(e.target.value)} autoFocus
        placeholder="Search columns…" aria-label="Search columns"
        onKeyDown={e => {
          if (e.key === 'Enter' && first) { e.preventDefault(); onPick(first.name) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); move(null, 0) }
        }} />
      <div className="fcol-list" role="listbox" aria-label="Column to filter on" ref={list}>
        {groups.map(([label, cs]) => cs.length > 0 && (
          <div key={label} role="group" aria-label={label}>
            <div className="fcol-g" aria-hidden="true">{label}</div>
            {cs.map(c => (
              <div key={c.name} role="option" aria-selected={false} tabIndex={-1} className="fcol-o"
                onClick={() => onPick(c.name)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.name) }
                  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1) }
                }}>
                <span className={`fcol-k k-${c.kind}`} aria-hidden="true">{mark(c.kind)}</span>
                <span className="fcol-n">{c.name}</span>
              </div>
            ))}
          </div>
        ))}
        {!groups.some(([, cs]) => cs.length) && <div className="fvals-note">No column matches.</div>}
      </div>
    </div>
  )
}

function FilterBar({ value, onChange, columns, partial, saved, onSaveDefault,
                    dashboardId, days, range, panels }: {
  value: WireFilter[]
  onChange: (f: WireFilter[]) => void
  /** Each with its kind, so the operator list can be the ones that mean
   *  something for it rather than all thirteen. */
  columns: FilterColumn[]
  /** The slice the dashboard opens on, so a chip can say whether it is the
   *  page's own or something this reader added. */
  saved: WireFilter[]
  /** Present only in edit mode: saving a default changes what everyone sees. */
  onSaveDefault?: () => void
  /** Panels that could not honour the current bar. Named here as well as on
   *  the panels themselves, because the caption sits up here: if the page says
   *  "EMEA" and two cards are showing the total, this is where a reader is
   *  looking when they believe it. */
  partial: string[]
  /** Which dashboard and window to read a column's values over. */
  dashboardId: string
  days: number
  /** The range as the server takes it, for reading a column's values. */
  range: string
  /** The panels a filter can be narrowed to, by id and title. */
  panels: { id: string; title: string }[]
}) {
  const [open, setOpen] = useState(false)
  const addRoot = useRef<HTMLSpanElement>(null)
  // Closed by a click anywhere else, as a menu is.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!addRoot.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const [scoping, setScoping] = useState<number | null>(null)
  const [dim, setDim] = useState('')
  const kind = columns.find(c => c.name === dim)?.kind ?? 'string'
  const ops = opsFor(kind)
  // Whether a chip is the page's own slice or this reader's. Compared by value
  // rather than identity, because the saved list arrives off the wire.
  const key = (f: { dimension: string; op: string; values: unknown[] }) =>
    `${f.dimension}~${f.op}~${f.values.join('|')}`
  const savedKeys = new Set(saved.map(key))
  const isSaved = (f: WireFilter) => savedKeys.has(key(f))
  const differs = value.length !== saved.length || value.some(f => !isSaved(f))
  const [op, setOp] = useState<FilterOp>('eq')
  const [raw, setRaw] = useState('')

  // Picking a different column can strip the operator out from under you —
  // `contains` means nothing once you switch to a measure. Reset to the first
  // one that kind offers rather than sending a filter that runs and answers
  // nothing.
  useEffect(() => {
    if (!ops.includes(op)) setOp(ops[0])
  }, [ops, op])

  // What the column actually holds. Fetched when one is picked rather than up
  // front: a dashboard over a wide table has thirty columns, and scanning all
  // of them to populate a menu nobody opened is thirty scans for nothing.
  const [vals, setVals] = useState<ColumnValues | null>(null)
  const [loadingVals, setLoadingVals] = useState(false)
  useEffect(() => {
    setVals(null); setPicked([])
    if (!dim) return
    let stale = false
    setLoadingVals(true)
    columnValues(dashboardId, dim, range)
      .then(v => { if (!stale) setVals(v) })
      .catch(() => { if (!stale) setVals(null) })
      .finally(() => { if (!stale) setLoadingVals(false) })
    return () => { stale = true }
  }, [dim, dashboardId, range])

  // Chosen from the list. Several of them is an `in`, which is what "region is
  // emea or apac" means and what the operator list would otherwise make you
  // spell out by switching to "is one of" and typing both.
  const [picked, setPicked] = useState<string[]>([])
  // `?? []` twice over: this reads a response off the network, and
  // `vals.values.length` on a body that is not this shape takes the whole page
  // down with a TypeError rather than showing an empty list.
  // One box: what is typed narrows the list, and is the value if nothing in
  // it is picked. Two boxes ("value" and "find a value…") said the same thing.
  const shown = (vals?.values ?? []).filter(v =>
    !raw.trim() || String(v.value ?? '').toLowerCase().includes(raw.trim().toLowerCase()))

  const add = () => {
    if (!dim) return
    const typed = NULLARY.includes(op) ? []
      : LISTY.includes(op) ? raw.split(',').map(v => v.trim()).filter(Boolean)
      : [raw.trim()]
    const values = picked.length ? picked : typed
    if (!NULLARY.includes(op) && !values.length) return
    // Two values chosen from the list mean `in`, not two separate filters and
    // not an `eq` that silently drops one. `not_in` is the same courtesy for
    // the negative.
    const effective: FilterOp = picked.length > 1 && op === 'eq' ? 'in'
      : picked.length > 1 && op === 'ne' ? 'not_in'
      : op
    onChange([...value, { dimension: dim, op: effective, values }])
    setDim(''); setOp('eq'); setRaw(''); setPicked([]); setOpen(false)
  }

  return (
    <div className="fbar">
      {value.map((f, i) => (
        <span key={`${f.dimension}-${i}`}
          className={`fchip${isSaved(f) ? ' is-default' : ''}`}
          title={isSaved(f)
            ? "this dashboard's own slice — everyone opens on it"
            : 'yours, for this visit'}>
          <span className="mono">{f.dimension}</span> {OP_LABEL[f.op]}
          {f.values.length > 0 && <b> {f.values.join(', ')}</b>}
          {/* Scoped by hand. Said on the chip, because a filter that reaches
              four of eight panels for a reason nobody can see is the failure
              this whole bar reports its way out of — and doing it deliberately
              should not be the one case that goes unlabelled. */}
          {f.panels && (
            <span className="fchip-scope" title={f.panels.join(', ')}>
              · {f.panels.length} panel{f.panels.length === 1 ? '' : 's'}
            </span>
          )}
          <button aria-label={`Limit ${f.dimension} to some panels`}
            title="Choose which panels this filter is for"
            onClick={() => setScoping(scoping === i ? null : i)}>⌖</button>
          <button aria-label={`Remove filter on ${f.dimension}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}

      {scoping !== null && value[scoping] && (
        <div className="fscope">
          <div className="fvals-note">
            <span className="mono">{value[scoping].dimension}</span> reaches every panel
            whose table has that column. Narrow it when two tables share the name and
            mean different things.
          </div>
          <div className="fvals-list">
            {panels.map(p => {
              const on = !value[scoping]!.panels || value[scoping]!.panels!.includes(p.id)
              return (
                <button key={p.id} className={`fval${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => onChange(value.map((f, j) => {
                    if (j !== scoping) return f
                    const now = f.panels ?? panels.map(x => x.id)
                    const next = on ? now.filter(x => x !== p.id) : [...now, p.id]
                    // Back to "every panel that has the column" rather than a
                    // list that happens to name them all — the two behave the
                    // same today and diverge the moment a panel is added.
                    const all = next.length === panels.length
                    const { panels: _drop, ...rest } = f
                    return all ? rest : { ...rest, panels: next }
                  }))}>
                  <span className="fval-v">{p.title}</span>
                </button>
              )
            })}
          </div>
          <button className="tool" onClick={() => setScoping(null)}>Done</button>
        </div>
      )}

      {/* Edit mode only. Saving a default changes the page for everyone who
          opens it, which is an authoring act and not a reading one. */}
      {onSaveDefault && differs && (
        <button className="tool" onClick={onSaveDefault}>
          {value.length ? 'Open on this slice' : 'Open unfiltered'}
        </button>
      )}

      {/* A panel under the button, not fields in the bar: inline, the editor
          and its value list wrapped the toolbar onto a second line the moment
          a column was picked, and everything around it jumped. */}
      <span className="fadd-wrap" ref={addRoot}>
        <button className={`tool fadd${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="dialog"
          onClick={() => setOpen(o => !o)}
          disabled={!columns.length}
          title={columns.length ? undefined : 'No filterable columns on this dashboard'}>
          + Filter
        </button>
        {open && (
          <div className="fpop" role="dialog" aria-label="Add a filter"
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}>
            <div className="fpop-field"><span className="fpop-k">Column</span>
              {dim
                ? <div className="fcol-picked">
                    <span className={`fcol-k k-${kind}`} aria-hidden="true">{kind === 'number' ? '#' : kind === 'bool' ? '◐' : 'Aa'}</span>
                    <span className="fcol-n">{dim}</span>
                    <button type="button" className="doc-link" onClick={() => setDim('')}>Change</button>
                  </div>
                : <ColumnPicker columns={columns} onPick={setDim} />}
            </div>
            {dim && <>
            <div className="fpop-field"><span className="fpop-k">Condition</span>
            <select aria-label="How to compare" value={op}
              onChange={e => setOp(e.target.value as FilterOp)}>
              {ops.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
            </select>
            </div>
            {!NULLARY.includes(op) && <div className="fpop-field"><span className="fpop-k">Value</span>
              <input value={raw} onChange={e => setRaw(e.target.value)}
                // It had no accessible name: a text box in a popover with a
                // placeholder that changes to a numeric range is announced as
                // nothing at all.
                aria-label="Value to filter by"
                // A number's range, so `amount > 100` is written knowing the
                // column runs from 3 to 30 rather than guessing at its scale.
                placeholder={vals?.min != null
                  ? `${round2(vals.min)} … ${round2(vals.max ?? 0)}`
                  : vals?.values?.length ? 'Type to find, or pick below'
                  : LISTY.includes(op) ? 'a, b, c' : 'value'}
                onKeyDown={e => { if (e.key === 'Enter') add() }} />
            </div>}
            {/* The values the column actually holds.
                This was a free-text box: to slice by region you had to already
                know it holds `emea` and not `EMEA` or `eu-west`, and a typo
                returns an empty chart rather than an error. Every other blank on
                this page is picked from a list the data supplies. */}
            {dim && !NULLARY.includes(op) && (
              <div className="fvals">
                {loadingVals ? <div className="fvals-note">reading the column…</div>
                  : vals?.min != null ? (
                    <div className="fvals-note">
                      <span className="mono">{round2(vals.min)}</span> to{' '}
                      <span className="mono">{round2(vals.max ?? 0)}</span> over
                      the last {days} days
                    </div>
                  ) : !vals?.values?.length ? (
                    <div className="fvals-note">
                      {vals?.errors.length
                        ? vals.errors[0]
                        : 'no values read — type one instead'}
                    </div>
                  ) : (
                    <>
                      {picked.length > 0 && (
                        <div className="fvals-picked">
                          {picked.length} picked{picked.length > 1 ? ' — any of them' : ''}
                          <button className="doc-link" onClick={() => setPicked([])}>Clear</button>
                        </div>
                      )}
                      <div className="fvals-list" role="group" aria-label="Values">
                        {!shown.length && <div className="fvals-note">nothing matches — Apply uses what you typed</div>}
                        {shown.slice(0, 60).map(v => {
                          const val = String(v.value ?? '')
                          const on = picked.includes(val)
                          return (
                            <button key={val} className={`fval${on ? ' on' : ''}`}
                              aria-pressed={on}
                              onClick={() => setPicked(ps =>
                                on ? ps.filter(x => x !== val) : [...ps, val])}>
                              <span className="fval-check" aria-hidden="true">{on ? '✓' : ''}</span>
                              <span className="fval-v">{val || '(empty)'}</span>
                              <span className="fval-n">{v.rows.toLocaleString()}</span>
                            </button>
                          )
                        })}
                      </div>
                      <div className="fvals-note">
                        {/* Where they came FROM. A dashboard spans datasets, and
                            a value present in one is not present in another —
                            the panels without the column will still say so. */}
                        from <span className="mono">{vals.from.join(', ')}</span>
                        {vals.truncated && ' · showing the commonest, not all of them'}
                      </div>
                    </>
                  )}
              </div>
            )}
            </>}
            <div className="fpop-foot">
              <button className="chip" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn action" onClick={add} disabled={!dim}>
                {picked.length > 1 ? `Apply ${picked.length} values` : 'Apply'}</button>
            </div>
          </div>
        )}
      </span>

      {/* The whole reason the bar reports anything. Scoping filters to
          charts by hand and then renders the result silently, so a dashboard
          where two of six panels ignored the filter is indistinguishable from
          one where all six honoured it. */}
      {/* Gated on what the SERVER reported, not on what this component thinks
          it asked for. The two agree in practice — a panel can only be partial
          under a filter — and when they do not, the render is the one that
          knows, because it is the one that ran the queries. */}
      {partial.length > 0 && (
        // A tag, the sentence on hover: in full it was longer than the filters
        // it qualified, and pushed them around.
        <span className="fwarn" role="status"
          title={partial.length === 1
            ? '1 panel is not filtered — its dataset has no such column. It says so on its own card.'
            : `${partial.length} panels are not filtered — their datasets have no such column. Each says so on its own card.`}>
          ⚠ {partial.length} panel{partial.length === 1 ? '' : 's'} unfiltered
        </span>
      )}
    </div>
  )
}

/** The ranges the presets cannot say — a calendar period so far, a named span
 *  of days — and the comparison with the period before. Beside the presets,
 *  not instead of them: most readings are "the last 30 days". */
function RangeMore({ range, onRange, compare, onCompare }: {
  range: string; onRange: (r: string) => void
  compare: boolean; onCompare: (on: boolean) => void
}) {
  const span = spanOf(range)
  const today = new Date().toISOString().slice(0, 10)
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(span?.from ?? today.slice(0, 8) + '01')
  const [to, setTo] = useState(span?.to ?? today)
  const custom = `${from}..${to}`
  const chosen = !!span || range in TO_DATE
  return (
    <div className="range-more">
      <button type="button" className={`tool${chosen ? ' on' : ''}`} aria-expanded={open}
        onClick={() => setOpen(o => !o)}>{chosen ? rangeLabel(range) : 'Dates…'}</button>
      <label className="range-compare"
        title="Every number is compared with the same number of days just before this range">
        <input type="checkbox" checked={compare} onChange={e => onCompare(e.target.checked)} />
        Compare with {spanWords(previousSpan(range))}
      </label>
      {open && (
        <div className="range-pop" role="group" aria-label="More date ranges">
          <div className="seg">
            {(Object.keys(TO_DATE) as (keyof typeof TO_DATE)[]).map(k => (
              <button key={k} type="button" className={range === k ? 'on' : ''} aria-pressed={range === k}
                onClick={() => { onRange(k); setOpen(false) }}>{TO_DATE[k]}</button>
            ))}
          </div>
          <div className="range-span">
            <label>From <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
            <button type="button" className="btn action" disabled={!isRange(custom)}
              onClick={() => { onRange(custom); setOpen(false) }}>Show these dates</button>
          </div>
        </div>
      )}
    </div>
  )
}
