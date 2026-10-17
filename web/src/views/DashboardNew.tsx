import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { Link, useNavigate } from 'react-router-dom'
import { PanelChart } from '../components/PanelChart'
import { MARKS, markKind } from '../components/marks'
import { SqlEditor, type SqlError } from '../components/SqlEditor'
import { AGGS } from '../data/aggs'
import { Pill } from '../components/ui'
import { useToast } from '../components/Shell'
import { forgetLiveDashboards } from '../data/api'
import {
  GatewayError,
  checkConnection, createConnection, createDashboard, introspect, listConnections,
  previewPanel, previewSql, saveVirtualDataset, toPanel, unitOf, RANGES,
  type DraftPanel, type NewConnection, type SqlPreview, type WireConnection, type WireDataset,
} from '../data/gateway'
import type { Panel, PanelKind } from '../data/types'
import { DashboardAssist, DashboardPrompt, type StagedDashboardPanel } from './DashboardAssist'

/** A panel on the dashboard being built: the spec that will be saved, and the
 *  chart it produced. Keeping the chart is what lets the canvas below show the
 *  dashboard taking shape instead of a list of descriptions. */
type Added = StagedDashboardPanel
const PREVIEW_RANGES = RANGES.map(r => Number(r.slice(0, -1)))

// Building a dashboard on a table you have never seen.
//
// The shape of this screen follows the one rule the backend enforces: a panel
// cannot carry its own definition. So the last step does not "save a chart" —
// it writes each definition into the metric registry as a proposal, and the
// dashboard arrives uncertified with the reason on its face. That is the step a
// BI tool skips, and skipping it is how one company ends up with six meanings
// of "refund rate".
//
// Everything offered here comes from introspecting the connection: the tables,
// the columns, which ones can be a grain, which can be a slice. Nothing is
// typed in free-hand, because a free-text column box is a SQL console.

// Read inside the sentence: "…by day", "…in total". The label is written for
// where it lands, not for a column header.
const GRAINS = [
  { id: 'day', label: 'day' },
  { id: 'week', label: 'week' },
  { id: 'month', label: 'month' },
  { id: 'none', label: 'no time axis' },
]
//: How the number is FORMATTED — presentation, not part of the question. It
//: sits with the chart type for that reason, and is inferred from the column
//: name so it is an override rather than a decision.
const UNITS: { id: string; label: string }[] = [
  { id: '', label: 'Automatic (from measure)' },
  { id: 'count', label: 'a plain number' },
  { id: 'currency', label: 'money' },
  { id: 'pct', label: 'a percentage' },
  { id: 'duration', label: 'a duration' },
]

type Step = 1 | 2 | 3
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Database' }, { n: 2, label: 'Source' }, { n: 3, label: 'Panels' },
]
/** Marks the chart kit draws directly, keyed by the wire's name for them. */


const blank = (): DraftPanel => ({ title: '', mark: 'line', agg: 'count', grain: 'day' })

export function DashboardNew() {
  const [step, setStep] = useState<Step>(1)
  const [conns, setConns] = useState<WireConnection[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [conn, setConn] = useState<WireConnection | null>(null)
  const [tables, setTables] = useState<WireDataset[] | null>(null)
  const [ds, setDs] = useState<WireDataset | null>(null)
  const [timeCol, setTimeCol] = useState<string | null>(null)
  const [tq, setTq] = useState('')
  // Two ways to answer one question — which table, or which query. Held as a
  // mode rather than an "is the drawer open" flag, because the drawer framing
  // is what made writing SQL look like a footnote to picking a table.
  const [source, setSource] = useState<'table' | 'sql'>('table')
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState<DraftPanel>(blank())
  const [added, setAdded] = useState<Added[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewDays, setPreviewDays] = useState(30)
  const [instruction, setInstruction] = useState('')
  const navigate = useNavigate()
  const toast = useToast()

  const sourceRequest = useRef(0)
  const loadConnections = useCallback(async () => {
    setConns(null); setErr(null)
    try { setConns((await listConnections()).connections) }
    catch (error) { setConns([]); setErr(error instanceof Error ? error.message : String(error)) }
  }, [])
  useEffect(() => { void loadConnections() }, [loadConnections])

  /** Step back. Whatever the later steps chose is cleared, because a table
   *  belongs to a connection and panels belong to a table — leaving them on
   *  screen would show a selection that no longer applies to anything. */
  const goTo = (n: Step) => {
    sourceRequest.current++; setErr(null)
    if (n <= 2) { setDs(null); setAdded([]) }
    if (n === 1) { setConn(null); setTables(null); setTq('') }
    setStep(n)
  }

  const pickConnection = async (c: WireConnection) => {
    const request = ++sourceRequest.current
    setConn(c); setTables(null); setErr(null); setStep(2)
    try {
      const r = await introspect(c.id)
      if (sourceRequest.current === request) setTables(r.datasets)
    } catch (error) {
      if (sourceRequest.current === request) {
        setTables([]); setErr(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const pickTable = (t: WireDataset) => {
    setDs(t)
    setTimeCol(t.time_column)
    setTitle(prettify(t.id))
    // A table with no temporal column cannot be bucketed, so the default panel
    // is the one it can actually answer rather than one that errors on preview.
    setDraft({ ...blank(), grain: t.time_column ? 'day' : 'none', mark: t.time_column ? 'line' : 'stat' })
    setStep(3)
  }

  const save = async () => {
    if (!conn || !ds) return
    setSaving(true); setErr(null)
    try {
      const r = await createDashboard({
        title: title.trim() || prettify(ds.id),
        connection_id: conn.id, dataset_id: ds.id, time_column: timeCol,
        panels: added.map(a => a.draft),
        // Derived from the content, so pressing Create twice makes one
        // dashboard — the same guarantee the agent's retry needs.
        idempotencyKey: JSON.stringify([conn.id, ds.id, timeCol, title.trim(), added.map(a => a.draft)]),
      })
      forgetLiveDashboards()
      toast(r.message)
      navigate(`/dashboards/${r.dashboard_id}?range=${previewDays}d`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  const shown = useMemo(() => {
    if (!tables) return []
    const q = tq.trim().toLowerCase()
    return q ? tables.filter(t => t.id.toLowerCase().includes(q)) : tables
  }, [tables, tq])

  return (
    <div className="detail dashboard-new">
      <div className="crumb"><Link to="/dashboards">← Dashboards</Link> / new</div>
      <header className="dashboard-new-header">
        <div><h1>New dashboard</h1>
          <p>Describe what you need, choose your data, then review AI suggestions or build panels manually.</p></div>
        <span className="dashboard-step-count">Step {step} of 3</span>
      </header>

      {/* One line, and it does a job: the completed steps are the way back.
          This was three full-width cards showing three em-dashes until you had
          chosen something — a 50px band that told you nothing at step 1 and
          duplicated the heading below it thereafter. A step you cannot click
          is just a label, so the ones you have finished are buttons and the
          separate "change database" / "change table" chips are gone. */}
      <nav className="steps" aria-label="Progress">
        {STEPS.map(({ n, label }, i) => {
          const value = n === 1 ? conn?.name
            : n === 2 ? ds?.id
            : added.length ? `${added.length} panel${added.length > 1 ? 's' : ''}` : undefined
          const done = step > n && value !== undefined
          return (
            <span key={n} className="steps-seg">
              {i > 0 && <i className="steps-arrow" aria-hidden="true">›</i>}
              <button
                className={`step${step === n ? ' on' : ''}${done ? ' done' : ''}`}
                disabled={!done}
                aria-current={step === n ? 'step' : undefined}
                onClick={() => done && goTo(n)}>
                <i className="step-n">{done ? '✓' : n}</i>
                <span className="step-l">{label}</span>
                {value && <span className="step-v mono">{value}</span>}
              </button>
            </span>
          )
        })}
      </nav>

      {step < 3 && <section className="dashboard-assist dashboard-assist-intro" aria-labelledby="dashboard-assist-title">
        <DashboardPrompt instruction={instruction} onInstructionChange={setInstruction} beforeSource />
        <div className="dashboard-brief-next">
          <strong>{step === 1 ? 'Next, choose a database below' : source === 'sql' ? 'Next, run and save your SQL source below' : 'Next, choose a table or saved dataset below'}</strong>
          <span>{instruction.trim() ? 'Your description will follow you into the panel builder.' : 'Prefer to build manually? Leave the description empty and choose your data.'}</span>
        </div>
        <p id="dashboard-ai-privacy" className="builder-field-note">Nothing is sent to a model while you type. After choosing a source, select Suggest panels to generate a draft using its column names and types.</p>
      </section>}

      {err && <div className="dash-load-error" role="alert"><span>{err}</span>
        {step === 1 && <button className="tool" onClick={loadConnections}>Retry connections</button>}
        {step === 2 && conn && <button className="tool" onClick={() => pickConnection(conn)}>Retry tables</button>}
      </div>}

      {step === 1 && (
        <>
          <div className="section-label">Connections in this space
            <span className="hint">Choose where your dashboard will read its data.</span>
          </div>
          <div className="dashboard-source-grid">
          {conns === null ? <div className="empty">Loading…</div>
            : conns.length === 0 && !adding && !err ? <div className="empty">No databases connected yet.</div>
              : conns.map(c => (
                <button key={c.id} className="wiz-pick" onClick={() => pickConnection(c)}>
                  <span className="wp-n">{c.name}</span>
                  <span className="mono wp-d">{c.dsn}</span>
                  <span className="wp-s">
                    <Pill tone="gray">{c.kind}</Pill>
                    {c.last_error ? <Pill tone="red">last check failed</Pill>
                      : c.read_only && <Pill tone="green">read-only</Pill>}
                    {/* A connection that cannot run a query AS the caller marks every
                        panel built on it — we do not compensate by appending predicates. */}
                    {!c.impersonation && <Pill tone="warn">shared principal</Pill>}
                  </span>
                </button>
              ))}
          </div>
          {adding
            ? <AddConnection onCancel={() => setAdding(false)}
                onAdded={async c => {
                  setAdding(false)
                  setConns(await listConnections().then(r => r.connections))
                  pickConnection(c)
                }} />
            : <button className="wiz-add" onClick={() => setAdding(true)}>+ Connect a database</button>}
        </>
      )}

      {step === 2 && (
        <>
          {/* The heading names the connection, not the mode — the mode is the
              control right below it, and a heading that restates the selected
              tab is a heading that says nothing. The introspection note moved
              down to sit with the choice it explains. */}
          <div className="section-label">Where the numbers come from
            <span className="hint">on {conn?.name}</span>
          </div>
          {/* Source selection is a primary choice, not a muted table-list filter. */}
          <div className="dashboard-source-choices" role="group" aria-label="Source type">
            <button type="button" className="dashboard-source-choice" aria-pressed={source === 'table'}
              aria-labelledby="table-source-title" aria-describedby="table-source-description"
              onClick={() => setSource('table')}>
              <span className="source-choice-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M10 10v10" />
                </svg>
              </span>
              <span className="source-choice-copy">
                <strong id="table-source-title">Pick a table</strong>
                <span id="table-source-description">Browse existing tables and saved datasets.</span>
              </span>
              <span className="source-choice-state" aria-hidden="true">{source === 'table' ? '✓' : '→'}</span>
            </button>
            <button type="button" className="dashboard-source-choice" aria-pressed={source === 'sql'}
              aria-labelledby="sql-source-title" aria-describedby="sql-source-description"
              onClick={() => setSource('sql')}>
              <span className="source-choice-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" />
                </svg>
              </span>
              <span className="source-choice-copy">
                <strong id="sql-source-title">Write SQL</strong>
                <span id="sql-source-description">Join tables, filter rows, or calculate new columns.</span>
              </span>
              <span className="source-choice-state" aria-hidden="true">{source === 'sql' ? '✓' : '→'}</span>
            </button>
          </div>
          {/* Search is secondary to choosing a source, and only applies to tables. */}
          {source === 'table' && (
            <div className="coll-tools dashboard-table-search">
              <label htmlFor="dashboard-table-filter">Search tables</label>
              <div className="searchbox"><input id="dashboard-table-filter" type="search" placeholder="Filter tables…" value={tq} onChange={e => setTq(e.target.value)} /></div>
            </div>
          )}
          <div className="src-why">
            {source === 'table'
              ? 'Every table on the connection, discovered by introspection.'
              : 'Save a query as a dataset when no single table has what you need — a join, a filtered subset, a computed column.'}
          </div>

          {source === 'sql' && conn && (
            <SqlDataset conn={conn} onCancel={() => setSource('table')} onSaved={async d => {
              setSource('table')
              const r = await introspect(conn.id)
              setTables(r.datasets)
              const saved = r.datasets.find(x => x.id === d.dataset_id)
              if (saved) pickTable(saved)
            }} />
          )}
          {source === 'table' && <div className="dashboard-source-grid">
            {tables === null ? <div className="empty" role="status">Introspecting…</div>
            : !err && !shown.length ? <div className="dashboard-empty">
                <h2>{tq ? 'No matching tables' : 'No tables found'}</h2>
                <p>{tq ? 'Try a shorter table name or clear your search.' : 'Check the connection’s table permissions, or use a SQL query.'}</p>
                {tq && <button className="tool" onClick={() => setTq('')}>Clear table search</button>}
              </div>
            : shown.map(t => (
              <button key={t.id} className="wiz-pick" onClick={() => pickTable(t)}>
                <span className="wp-n mono">
                  {t.id}
                  {/* A saved query and a table are the same kind of thing to
                      everything downstream, so they share one list — but which
                      one you are about to build on is worth knowing. */}
                  {t.is_virtual && <Pill tone="agent">SQL</Pill>}
                </span>
                <span className="wp-d">
                  {t.measures.length} numeric · {t.slices.length} categorical
                  {t.times.length > 0 ? ` · ${t.times.length} time column${t.times.length > 1 ? 's' : ''}` : ''}
                </span>
                <span className="wp-s">
                  {t.time_column
                    ? <Pill tone="blue">{t.time_column}</Pill>
                    : <Pill tone="gray">no time axis</Pill>}
                </span>
              </button>
            ))}</div>}
        </>
      )}

      {step === 3 && ds && conn && (
        <PanelBuilder
          conn={conn} ds={ds} timeCol={timeCol} setTimeCol={setTimeCol}
          title={title} setTitle={setTitle}
          draft={draft} setDraft={setDraft}
          added={added} setAdded={setAdded}
          days={previewDays} setDays={setPreviewDays}
          instruction={instruction} onInstructionChange={setInstruction}
          onBack={() => setStep(2)} onSave={save} saving={saving}
        />
      )}
    </div>
  )
}

function PanelBuilder({ conn, ds, timeCol, setTimeCol, title, setTitle, draft, setDraft, added, setAdded, days, setDays, onSave, saving, instruction, onInstructionChange }: {
  conn: WireConnection; ds: WireDataset
  timeCol: string | null; setTimeCol: (v: string | null) => void
  title: string; setTitle: (v: string) => void
  draft: DraftPanel; setDraft: React.Dispatch<React.SetStateAction<DraftPanel>>
  added: Added[]; setAdded: (p: Added[]) => void
  days: number; setDays: (v: number) => void
  onBack: () => void; onSave: () => void; saving: boolean
  instruction: string; onInstructionChange: (value: string) => void
}) {
  const [preview, setPreview] = useState<Panel | null>(null)
  const [pErr, setPErr] = useState<string | null>(null)
  const [expr, setExpr] = useState('')
  const [rows, setRows] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [resultKey, setResultKey] = useState('')
  const [previewUnit, setPreviewUnit] = useState<string | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const revealCanvas = useRef(false)
  useEffect(() => {
    if (!revealCanvas.current) return
    revealCanvas.current = false
    canvas.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    canvas.current?.focus({ preventScroll: true })
  }, [added])
  // Adding a panel resets the draft to fields it may already have held — add a
  // "count of rows" panel and every dependency of the preview effect is
  // unchanged, so it never re-fires and the bench sits on "Preparing…" for
  // good. This makes "I added a panel" an event in its own right.
  const [nonce, setNonce] = useState(0)

  const agg = AGGS.find(a => a.id === draft.agg)!
  // Merge field changes without restoring an older draft snapshot.
  const set = (p: Partial<DraftPanel>) => setDraft(d => ({ ...d, ...p }))
  const seq = useRef(0)
  const queryKey = JSON.stringify([conn.id, ds.id, timeCol, days, draft.agg, draft.column,
    draft.denominator, draft.value, draft.grain, draft.dimension, draft.sort, draft.limit,
    draft.unit, nonce])
  const validation = agg.column && !draft.column ? 'Choose a column to measure.'
    : agg.denominator && !draft.denominator ? 'Choose a denominator.'
    : agg.value && (draft.value === undefined || draft.value === '') ? 'Enter a value to match.' : ''
  const titleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x'
  const usedTitles = new Set(added.filter((_, i) => i !== editingIndex).map(a => titleKey(a.draft.title)))
  let panelTitle = draft.title.trim() || describe(draft)
  if (!draft.title.trim()) {
    const base = panelTitle
    for (let n = 2; usedTitles.has(titleKey(panelTitle)); n++) panelTitle = `${base.slice(0, 30)} ${n}`
  }
  const titleError = usedTitles.has(titleKey(panelTitle)) ? 'Use a unique panel title.' : ''
  const ready = !!preview && resultKey === queryKey && !busy && !validation && !titleError
  const shownPreview = preview ? { ...preview, kind: markKind(draft.mark), title: panelTitle + (unitOf(previewUnit).suffix ?? '') } : null
  const wider = PREVIEW_RANGES.find(d => d > days)

  // Preview is a real query. It runs on a debounce because every keystroke in
  // the title box is not a reason to hit someone's warehouse.
  const run = useCallback(async () => {
    if (validation) { setPreview(null); setPErr(null); setBusy(false); return }
    // Two edits inside the debounce put two queries in flight and the warehouse
    // decides which answers last — so a slower, earlier query could overwrite a
    // newer result and leave the chart disagreeing with the sentence above it.
    const mine = ++seq.current
    setBusy(true); setPErr(null)
    try {
      const r = await previewPanel(conn.id, ds.id, draft, timeCol, `${days}d`)
      if (mine !== seq.current) return   // superseded while in flight
      setExpr(r.expr)
      setRows(r.rows)
      setPreviewUnit(r.unit)
      setResultKey(queryKey)
      setPreview(toPanel({
        panel: { id: 'preview', title: draft.title || describe(draft), mark: draft.mark,
                 metric_id: r.expr, dataset_id: ds.id, grain: draft.grain },
        unit: r.unit, better: r.better, series: r.series,
      }, 6, {
        // A draft is NOT ratified, and saying it is would be the one claim this
        // whole product exists to prevent. The dot goes amber and the binding
        // line shows the expression, because a draft has an expression and no
        // id — which is precisely what makes it a draft.
        ratified: false,
        expr: `${r.expr}\n  over ${ds.id}\n  not written down yet — no id anything could cite`,
        note: 'draft',
      }))
      // Inference belongs to this query, not the next draft. Only an explicit
      // format override is stored; preview and creation use the same inference.
    } catch (e) {
      if (mine !== seq.current) return
      setPreview(null)
      setPErr(e instanceof Error ? e.message : String(e))
    } finally { if (mine === seq.current) setBusy(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // draft.mark is deliberately absent: switching Line/Area/Bar changes how the
  // same numbers are drawn, and re-querying the warehouse for identical SQL is
  // a round trip nobody asked for.
  }, [queryKey, validation])

  useEffect(() => {
    const t = setTimeout(run, 220)
    return () => { clearTimeout(t); seq.current++ }
  }, [run])

  const add = () => {
    if (!ready || !shownPreview) return
    const spec = { ...draft, title: panelTitle }
    const staged = { draft: spec, days, panel: {
      ...shownPreview, id: `added-${editingIndex ?? added.length}`,
      // Still a draft on the canvas: adding a panel stages it, it does not
      // write anything down. Create is the step that does.
      note: 'staged — not saved until you create the dashboard',
    } }
    setAdded(editingIndex === null ? [...added, staged] : added.map((a, i) => i === editingIndex ? staged : a))
    setEditingIndex(null)
    // The grain, the split and the chart type are kept. Someone adding a second
    // panel is usually asking a neighbouring question, and resetting the form to
    // blank every time makes them re-make the same four choices.
    setDraft({ ...draft, title: '', column: undefined, denominator: undefined, value: undefined, unit: undefined, agg: 'count' })
    setPreview(null)
    setNonce(n => n + 1)
    // Back to the workbench, which `edit` has always done and `add` never did.
    // The canvas grows BELOW the form, so adding a panel pushed the form off
    // the top of the viewport and left the reader looking at the finished
    // dashboard and a Create button — with nothing on screen suggesting that
    // adding a second panel was even possible.
    workbench()
  }

  /** The form, scrolled back into view. One definition, because two callers
   *  drifting apart is how `edit` came to do this and `add` came not to. */
  const workbench = () =>
    document.querySelector('.wiz-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  /** Put a panel back on the workbench. Without this the only correction
   *  available is Remove-and-rebuild, which is why the old list felt final. */
  const edit = (i: number) => {
    setDraft(added[i].draft)
    setDays(added[i].days)
    setEditingIndex(i)
    workbench()
  }

  return (
    <>
      <DashboardAssist connectionId={conn.id} dataset={ds} timeColumn={timeCol} days={days}
        existing={added} title={title} useSuggestedTitle={!added.length && title === prettify(ds.id)}
        instruction={instruction} onInstructionChange={onInstructionChange}
        disabled={saving || editingIndex !== null}
        onAdd={(panels, suggestedTitle) => {
          revealCanvas.current = true
          setAdded([...added, ...panels])
          if (suggestedTitle) setTitle(suggestedTitle)
        }}
        onEdit={suggestion => { setDraft(suggestion); setNonce(n => n + 1); workbench() }} />

      <div className="section-label">Dashboard
        <span className="hint">
          on {conn.name} · <span className="mono">{ds.id}</span>
          {ds.is_virtual && <Pill tone="agent">SQL</Pill>}
        </span>
      </div>
      {/* A saved query is invisible once you are past the picker: the panel
          builder just names it, and "sql.review_wait" looks like any other
          table. Showing the query here is what makes the source auditable from
          where the panel is actually being built. */}
      {ds.is_virtual && (
        <details className="ds-sql">
          <summary>the query behind <span className="mono">{ds.id}</span></summary>
          <pre className="mono">{ds.physical}</pre>
          <div className="ds-sql-note">
            To change it, go back to <b>Source</b> and save a new query. Editing this one
            would silently move every panel already citing it.
          </div>
        </details>
      )}
      <div className="fld-row dashboard-title-field">
        <label className="fld">
          <span>Title</span>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Run economics" />
        </label>
      </div>

      <div className="section-label">Add a panel
        <span className="hint">the question first, then how it should look</span>
      </div>
      <div className="card wiz-panel dashboard-panel-builder">
        <div className="dashboard-builder-fields">
        {/* Named fields stay legible when optional rate and ranking inputs appear. */}
        <h3 className="builder-section-heading">Data</h3>
        <div className="builder-data-grid">
          <Inline name="Measure" value={draft.agg} onChange={v => set({ agg: v, column: undefined, denominator: undefined, value: undefined, unit: undefined })}
            options={AGGS.map(a => ({ id: a.id, label: ({ count: 'Row count', sum: 'Sum', avg: 'Average', max: 'Maximum', min: 'Minimum', count_distinct: 'Distinct count', ratio: 'Ratio of sums', share: 'Matching share' } as Record<string, string>)[a.id] ?? a.label }))} />
          {agg.column && (
            <Inline name="Column to measure" value={draft.column ?? ''} placeholder="Choose a column"
              onChange={v => set({ column: v || undefined, unit: undefined })}
              options={(draft.agg === 'count_distinct' || agg.value ? ds.columns.map(c => c.name) : ds.measures)
                .map(c => ({ id: c, label: c }))} mono />
          )}
          {/* The two clauses that make a RATE sayable. "Refund rate" is the
              example this product explains itself with, and until now the
              wizard could not build it: six aggregates, none of them a
              division. Written as part of the sentence, like everything else
              here, so it reads as a question rather than a form. */}
          {agg.denominator && (
            <Inline name="Denominator" value={draft.denominator ?? ''}
              placeholder="Choose a column" onChange={v => set({ denominator: v || undefined })}
              options={ds.measures.map(c => ({ id: c, label: c }))} mono />
          )}
          {agg.value && (
            <InlineText name="Value to match" value={String(draft.value ?? '')}
              placeholder="Enter an exact value" onChange={v => set({ value: v || undefined })} />
          )}
          {timeCol
            ? <><Inline name="Time bucket" value={draft.grain} onChange={v => set({ grain: v })}
                options={GRAINS} />
                {draft.grain !== 'none' && <Inline name="Time column" value={timeCol} onChange={setTimeCol}
                  disabled={added.length > 0} options={ds.times.map(t => ({ id: t, label: t }))} mono />}</>
            : <span className="builder-field-note">This table has no time column; the preview covers all rows.</span>}
          <Inline name="Split by" value={draft.dimension ?? ''}
            onChange={v => set({ dimension: v || undefined })}
            options={[{ id: '', label: 'No grouping' }, ...ds.slices.map(c => ({ id: c, label: c }))]} mono />
          {/* Ordering and a limit, written into the sentence like everything
              else. `panels.add` has taken both since the first migration and
              neither form offered them, so every panel built through the
              product was every row in bucket order. Together they are a
              top-N: "the largest, keeping 10". */}
          <Inline name="How many rows" value={String(draft.limit ?? 0)}
            onChange={v => {
              const n = Number(v) || 0
              // A limit on a chronological ordering takes the OLDEST n
              // buckets, which is never what anybody means by "top 10" — and
              // the server refuses the combination. Pick a ranking rather than
              // send it.
              set({ limit: n, ...(n && (draft.sort ?? 'bucket') === 'bucket'
                                  ? { sort: 'value_desc' } : {}) })
            }}
            options={[{ id: '0', label: 'every row' }, { id: '5', label: '5' },
                      { id: '10', label: '10' }, { id: '20', label: '20' },
                      { id: '50', label: '50' }]} />
          {(draft.limit ?? 0) > 0 && <>
            <Inline name="Order" value={draft.sort ?? 'bucket'}
              onChange={v => set({ sort: v })}
              options={[{ id: 'value_desc', label: 'largest first' },
                        { id: 'value_asc', label: 'smallest first' },
                        ...(draft.grain === 'none'
                            ? [{ id: 'bucket', label: 'in table order' }] : [])]} />
          </>}
        </div>
        {added.length > 0 && timeCol && <p className="builder-field-note">The time column is shared by all panels. Remove staged panels before changing it.</p>}

        {/* How it looks, kept apart from what it asks. */}
        <h3 className="builder-section-heading">Visualization</h3>
        <div className="qs-look">
          <div className="marks" role="radiogroup" aria-label="Chart type">
            {MARKS.map((m, index) => (
              <button key={m.id} role="radio" aria-checked={draft.mark === m.id}
                tabIndex={draft.mark === m.id ? 0 : -1}
                className={`mark${draft.mark === m.id ? ' on' : ''}`}
                title={`${m.label} — ${m.hint}`}
                onKeyDown={e => {
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? MARKS.length - 1
                    : ['ArrowRight', 'ArrowDown'].includes(e.key) ? (index + 1) % MARKS.length
                    : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? (index + MARKS.length - 1) % MARKS.length : null
                  if (next === null) return
                  e.preventDefault()
                  set({ mark: MARKS[next].id })
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
                }}
                onClick={() => set({ mark: m.id })}>
                <svg viewBox="0 0 16 16" width={17} height={17} aria-hidden="true">{m.icon}</svg>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
          <Inline name="Number format" value={draft.unit ?? ''} onChange={v => set({ unit: v || undefined })} options={UNITS} />
          <label className="fld grow">
            <span>Panel title</span>
            <input value={draft.title} onChange={e => set({ title: e.target.value })} placeholder={panelTitle} aria-invalid={!!titleError} />
          </label>
        </div>
        {!draft.unit && resultKey === queryKey && previewUnit && <p className="builder-field-note">Automatic format: {previewUnit === 'count' ? 'plain number' : previewUnit === 'pct' ? 'percentage' : previewUnit}.</p>}
        {titleError && <p role="alert" className="bad">{titleError}</p>}

        </div>
        <div className="wiz-prev">
          <div className="dashboard-preview-heading"><strong>Panel preview</strong>
            {timeCol && <label className="fld"><span>Preview range</span><select value={days} onChange={e => setDays(Number(e.target.value))}>
              {PREVIEW_RANGES.map(d => <option key={d} value={d}>Last {d} days</option>)}
            </select></label>}
            <button className="tool" disabled={busy || !!validation} onClick={() => setNonce(n => n + 1)}>Run preview</button>
          </div>
          <p className="builder-preview-status" role="status" aria-live="polite">
            {validation || (busy || resultKey !== queryKey ? 'Updating preview…' : pErr ? 'Preview failed' : `Preview ready · ${rows ?? 0} result rows`)}
          </p>
          {pErr ? <div className="notice" style={{ margin: 0 }}>{pErr}</div>
            : shownPreview && !validation ? (
              <>
                <div className={`panel-grid${resultKey !== queryKey || busy ? ' is-loading' : ''}`} aria-busy={busy || resultKey !== queryKey} style={{ marginTop: 0 }}>
                  <PanelChart panel={shownPreview} days={days} onWidenRange={timeCol && wider ? () => setDays(wider) : undefined} />
                </div>
                <div className="wiz-expr">
                  <details><summary>Query details</summary>
                    <p>This ran against <span className="mono">{ds.id}</span> as <span className="mono">{expr}</span>.</p>
                    <p>Preview only. A metric definition is saved when you create the dashboard.</p>
                  </details>
                  {rows === 0 && <p>No rows matched. {timeCol ? 'Try a wider date range or check the source query.' : 'Check the source query.'} You can still add this panel.</p>}
                </div>
              </>
            ) : <div className="empty">{validation || 'Preparing…'}</div>}
        </div>

        <div className="wiz-act">
          <button className="btn action" onClick={add} disabled={!ready}>
            {editingIndex !== null ? 'Update panel' : added.length ? 'Add another panel' : 'Add this panel'}
          </button>
          {editingIndex !== null && <button className="chip" onClick={() => { setEditingIndex(null); setDraft({ ...blank(), grain: timeCol ? 'day' : 'none' }); setNonce(n => n + 1) }}>Cancel edit</button>}
          <span className="p-filter-note">{editingIndex !== null ? 'The staged panel stays unchanged until you update it.' : 'Add the preview to your dashboard, then create to save.'}</span>
        </div>
      </div>

      {/* The dashboard as it will look, not a list of what it will contain.
          Adding a panel used to collapse a chart you had just previewed into a
          line of text, so you never saw the thing you were building — and the
          row it collapsed into was the one styled for "waiting on a human",
          which painted the chart type amber as though it were a warning. */}
      {added.length > 0 && (
        <>
          <div className="section-label">
            The dashboard so far
            <span className="hint">
              {added.length} panel{added.length > 1 ? 's' : ''} · hover one to change it,
              or build another above
            </span>
          </div>
          <div className="panel-grid canvas" ref={canvas} tabIndex={-1} role="region" aria-label="Dashboard draft preview">
            {added.map((a, i) => (
              <div key={i} className="pv" style={{ '--span': added.length === 1 ? 12 : 6 } as React.CSSProperties}>
                <div className="builder-field-note">Preview · {timeCol ? `last ${a.days} days` : 'all rows'}</div>
                <PanelChart panel={{ ...a.panel, span: added.length === 1 ? 12 : 6 }} days={a.days} />
                <div className="pv-tools">
                  <button className="chip" disabled={editingIndex !== null} onClick={() => edit(i)}>Edit</button>
                  <button className="chip" disabled={editingIndex !== null} onClick={() => setAdded(added.filter((_, k) => k !== i))}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="wiz-act dashboard-create-bar">
            <button className="btn action" onClick={onSave} disabled={saving || editingIndex !== null}>
              {saving ? 'Writing definitions…' : `Create dashboard with ${added.length} panel${added.length > 1 ? 's' : ''}`}
            </button>
            {/* Create is not the only move left, and sitting alone under the
                canvas it read as though it were. This is the same action as
                the button on the form above — offered here because this is
                where somebody who just added a panel is looking. */}
            <button className="chip" onClick={workbench}>+ Add another panel</button>
            <span className="p-filter-note">
              Creating saves the panels and their metric definitions. Definitions your role cannot
              ratify will need review before their panels run.
            </span>
          </div>
        </>
      )}
    </>
  )
}

/** Labeled native controls retain keyboard navigation and type-to-select. */
function InlineText({ value, onChange, name, placeholder }: {
  value: string
  onChange: (v: string) => void
  name: string
  placeholder?: string
}) {
  return (
    <label className="fld builder-field">
      <span>{name}</span>
      <input aria-label={name} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </label>
  )
}


function Inline({ value, options, onChange, name, placeholder, mono, disabled }: {
  value: string
  options: { id: string; label: string }[]
  onChange: (v: string) => void
  /** What this control chooses — the select's accessible name. Required,
   *  because a <select> inside prose has no visible label to borrow one from. */
  name: string
  placeholder?: string
  mono?: boolean
  disabled?: boolean
}) {
  const chosen = options.find(o => o.id === value)
  return (
    <label className="fld builder-field">
      <span>{name}</span>
      <select className={mono ? 'mono' : undefined} aria-label={name} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {placeholder && !chosen && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}

// The engines this screen offers. It has to agree with the gateway's own list
// — `connections.create` rejects a kind it has no spec for — and a hardcoded
// five here is why adding seven to the backend changed nothing anybody could
// see. `test_the_form_offers_every_engine_the_gateway_accepts` holds them
// together now.
//
// `port` is the conventional default, 0 where the engine does not take one.
// `file` marks the ones whose "database" is a path rather than a host.
const ENGINES = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432, file: false },
  { id: 'mysql', label: 'MySQL', port: 3306, file: false },
  { id: 'mariadb', label: 'MariaDB', port: 3306, file: false },
  { id: 'redshift', label: 'Redshift', port: 5439, file: false },
  { id: 'clickhouse', label: 'ClickHouse', port: 9000, file: false },
  { id: 'mssql', label: 'SQL Server', port: 1433, file: false },
  { id: 'snowflake', label: 'Snowflake', port: 0, file: false },
  { id: 'bigquery', label: 'BigQuery', port: 0, file: false },
  { id: 'databricks', label: 'Databricks', port: 0, file: false },
  { id: 'trino', label: 'Trino', port: 8080, file: false },
  { id: 'duckdb', label: 'DuckDB', port: 0, file: true },
  { id: 'sqlite', label: 'SQLite', port: 0, file: true },
]

/** Connect a database.
 *
 *  The password is posted once and never comes back: the gateway encrypts it
 *  into a store that is deliberately not part of the object graph, and keeps
 *  only a handle on the connection row. Everything this screen reads afterwards
 *  — including the DSN it shows you — has the credential stripped.
 *
 *  Nothing is saved until it connects. A row that has never opened successfully
 *  is worse than no row: it sits in the picker looking usable and fails on the
 *  first panel someone builds on it. */
/** Write a query, see it, save it as something panels can be built on.
 *
 *  A "virtual dataset", and the one place this design bends toward SQL
 *  in a dashboard. Two things get conflated under "SQL in a dashboard" and only one is the
 *  problem: an *adhoc metric* is SQL for the measure, inline on one chart,
 *  bypassing the registry — that is how six charts come to mean six things by
 *  "refund rate", and it stays refused. A *virtual dataset* is SQL that stands
 *  in for a table: it decides which rows exist, not what any number means.
 *
 *  So the SQL lands in the FROM clause. Metrics built on it are ratified like
 *  any other, and the declared-column rule that stops a panel naming something
 *  the source does not have applies to the query's columns exactly as it
 *  applies to a table's. */
function SqlDataset({ conn, onSaved, onCancel }: {
  conn: WireConnection
  onSaved: (d: { dataset_id: string }) => void
  onCancel: () => void
}) {
  const [sql, setSql] = useState('')
  const [out, setOut] = useState<SqlPreview | null>(null)
  // The code and the position, not just the words: a parse error goes to
  // the editor, which can point at the line it is about.
  const [err, setErr] = useState<
    { message: string; code?: string; at?: SqlError['at'] } | null>(null)
  const [name, setName] = useState('')
  const [timeCol, setTimeCol] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)

  const run = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await previewSql(conn.id, sql)
      setOut(r)
      // The first temporal column is offered as the timeline, and the author
      // can pick another. A query with none is still a perfectly good dataset;
      // it just cannot be bucketed by time, which the panel builder then says.
      setTimeCol(r.times[0] ?? null)
    } catch (e) {
      setOut(null)
      setErr(e instanceof GatewayError
        ? { message: e.message, code: e.code, at: e.at }
        : { message: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      onSaved(await saveVirtualDataset(conn.id, name.trim() || 'Saved query', sql, timeCol))
    } catch (e) {
      setErr(e instanceof GatewayError
        ? { message: e.message, code: e.code, at: e.at }
        : { message: e instanceof Error ? e.message : String(e) })
    } finally { setSaving(false) }
  }

  return (
    <div className="card sqlbox">
      <SqlEditor label={`Query ${conn.name}`} value={sql} onChange={setSql}
        onRun={run} running={busy}
        error={err && err.code === 'bad_sql'
          ? { message: err.message, at: err.at } : null}
        placeholder={'select author_id, status, created_at\n  from proposals\n where decided_at is not null'} />

      <div className="sql-act">
        <button className="btn action" disabled={busy || !sql.trim()} onClick={run}>
          {busy ? 'Running…' : 'Run'}
        </button>
        <button className="chip" onClick={onCancel}>Pick a table instead</button>
        <span className="p-filter-note">
          One <span className="mono">SELECT</span>, and the connection has <span className="mono">SELECT</span> and
          nothing else — the grant is what makes this safe, not the parser.
        </span>
      </div>

      {/* A parse error goes to the editor, which can point at the line. This
          is for everything else the warehouse says. */}
      {err && err.code !== 'bad_sql' && (
        <div className="notice" style={{ margin: '10px 0 0' }}>{err.message}</div>
      )}

      {out && (
        <>
          <div className="sql-res">
            <table className="sql-tbl">
              <thead>
                <tr>{out.columns.map(c => (
                  <th key={c.name}>{c.name}<i className={`ck ck-${c.kind}`}>{c.kind}</i></th>
                ))}</tr>
              </thead>
              <tbody>
                {out.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, k) => (
                    <td key={k} className={v === null ? 'nul' : ''}>{v === null ? 'null' : String(v)}</td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sql-foot">
            {out.row_count} row{out.row_count === 1 ? '' : 's'}
            {out.truncated && ' shown — the preview is capped'}
            {out.times.length === 0 && ' · no temporal column, so panels on this cannot use a time axis'}
          </div>

          <div className="fld-row" style={{ marginTop: 12 }}>
            <label className="fld grow"><span>Save it as</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Review wait" /></label>
            {out.times.length > 0 && (
              <label className="fld"><span>Timeline</span>
                <select value={timeCol ?? ''} onChange={e => setTimeCol(e.target.value || null)}>
                  {out.times.map(t => <option key={t} value={t}>{t}</option>)}
                </select></label>
            )}
            <button className="btn action" disabled={saving || !out.columns.length} onClick={save}>
              {saving ? 'Saving…' : 'Save and build on it'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Everything a connection string already tells you.
 *
 *  Anyone connecting a warehouse has a URL in their clipboard — it is what the
 *  provider hands you and what every other tool in the stack is configured
 *  with. Retyping it into six boxes is transcription work, and transcription is
 *  where the typo comes from. Paste it and the boxes fill; they stay editable,
 *  because the URL is a starting point and not a commitment. */
function parseUrl(raw: string): Partial<NewConnection> | null {
  const t = raw.trim()
  if (!t.includes('://')) return null
  try {
    const u = new URL(t)
    // The driver half of `postgresql+asyncpg` is ours to choose, not theirs.
    const scheme = u.protocol.replace(':', '').split('+')[0]
    const kind = { postgresql: 'postgres', postgres: 'postgres', snowflake: 'snowflake',
                   bigquery: 'bigquery', duckdb: 'duckdb', sqlite: 'sqlite' }[scheme]
    if (!kind) return null
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
    return {
      kind, database,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    }
  } catch { return null }
}

/** Connect a database.
 *
 *  The password is posted once and never comes back: the gateway encrypts it
 *  into a store deliberately outside the object graph and keeps only a handle.
 *  Everything read afterwards — including the connection string shown in the
 *  picker — has the password removed and the username kept.
 *
 *  Nothing is saved until it connects AND runs a query. A row that never opened
 *  is worse than no row: it sits in the picker looking usable and fails on the
 *  first panel built on it. */
function AddConnection({ onAdded, onCancel }: {
  onAdded: (c: WireConnection) => void
  onCancel: () => void
}) {
  const [f, setF] = useState<NewConnection>({ name: '', kind: 'postgres', host: 'localhost', port: 5432, database: '' })
  const [pasted, setPasted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const eng = ENGINES.find(e => e.id === f.kind)!
  const set = (p: Partial<NewConnection>) => setF(c => ({ ...c, ...p }))

  const takeUrl = (raw: string) => {
    const got = parseUrl(raw)
    if (!got) { setPasted(raw ? 'not a connection URL — fill the fields below instead' : null); return }
    setF(c => ({ ...c, ...got }))
    setPasted(`read as ${got.kind} · ${got.host ?? 'file'}${got.port ? ':' + got.port : ''} · ${got.database}`)
  }

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await createConnection({ ...f, name: f.name.trim() || f.database })
      await checkConnection(r.connection_id)
      onAdded({ id: r.connection_id, name: r.name, kind: r.kind, dsn: r.dsn,
                read_only: true, impersonation: false, checked_at: new Date().toISOString(), last_error: null })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="card wiz-conn">
      <label className="paste">
        <span className="eyebrow">Paste a connection URL</span>
        <input
          placeholder="postgresql://readonly:••••@warehouse.internal:5432/analytics"
          onChange={e => takeUrl(e.target.value)}
          onPaste={e => takeUrl(e.clipboardData.getData('text'))} />
        <span className={`paste-note${pasted?.startsWith('not a') ? ' bad' : ''}`}>
          {pasted ?? 'or fill the fields below'}
        </span>
      </label>

      <div className="conn-engines" role="radiogroup" aria-label="Engine">
        {ENGINES.map(e => (
          <button key={e.id} role="radio" aria-checked={f.kind === e.id}
            className={`chip${f.kind === e.id ? ' on' : ''}`}
            onClick={() => set({ kind: e.id, port: e.port || undefined,
                                 host: e.file ? undefined : (f.host ?? 'localhost') })}>
            {e.label}
          </button>
        ))}
      </div>

      {eng.file ? (
        <div className="conn-grid one">
          <label className="fld"><span>File path</span>
            <input autoFocus value={f.database} onChange={e => set({ database: e.target.value })}
              placeholder="/data/warehouse.duckdb" /></label>
        </div>
      ) : (
        <>
          {/* Widths follow the content: a host is long, a port is four digits.
              Equal-width boxes made the port look like it wanted a hostname. */}
          <div className="conn-grid">
            <label className="fld"><span>Host</span>
              <input value={f.host ?? ''} onChange={e => set({ host: e.target.value })} placeholder="localhost" /></label>
            <label className="fld port"><span>Port</span>
              <input value={f.port ?? ''} inputMode="numeric"
                onChange={e => set({ port: Number(e.target.value) || undefined })} /></label>
            <label className="fld"><span>Database <i>required</i></span>
              <input value={f.database} onChange={e => set({ database: e.target.value })} placeholder="analytics" /></label>
          </div>
          <div className="conn-grid">
            <label className="fld"><span>User</span>
              <input value={f.user ?? ''} onChange={e => set({ user: e.target.value })} placeholder="readonly" /></label>
            <label className="fld"><span>Password</span>
              <input type="password" value={f.password ?? ''} autoComplete="new-password"
                onChange={e => set({ password: e.target.value })} /></label>
            <label className="fld"><span>Show it as</span>
              {/* Last, and optional: the database name is a fine label and
                  making someone invent one before they can connect is a field
                  that exists for the form's benefit, not theirs. */}
              <input value={f.name} onChange={e => set({ name: e.target.value })}
                placeholder={f.database || 'the database name'} /></label>
          </div>
        </>
      )}

      {err && <div className="notice" style={{ margin: '12px 0 0' }}>{err}</div>}

      <div className="conn-foot">
        <button className="btn action" disabled={busy || !f.database} onClick={save}>
          {busy ? 'Connecting…' : 'Connect and test'}
        </button>
        <button className="chip" onClick={onCancel}>Cancel</button>
        <span className="conn-note">
          Nothing is saved unless it connects and runs a query.
          {' '}Give this user <span className="mono">SELECT</span> and nothing else — read-only is
          that grant, not a promise from us.
        </span>
      </div>
    </div>
  )
}

/** A default panel title that reads like the thing it measures. */
function describe(p: DraftPanel): string {
  const named: Record<string, string> = {
    count: 'Rows', sum: 'Total', avg: 'Average', max: 'Highest', min: 'Lowest',
    count_distinct: 'Distinct',
  }
  const base = p.column ? `${named[p.agg] ?? p.agg} ${p.column}` : 'Rows'
  return p.dimension ? `${base} by ${p.dimension}` : base
}

const prettify = (id: string) =>
  (id.split('.').pop() ?? id).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
