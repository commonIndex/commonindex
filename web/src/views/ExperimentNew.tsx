import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useToast } from '../components/Shell'
import { forgetLiveExperiments } from '../data/api'
import {
  GatewayError, checkSrm, introspect, listConnections, listMetrics, planExperiment, previewSql,
  registerExperiment, saveVirtualDataset, type WirePlan,
  suggestExperiment,
  type WireConnection, type WireDataset, type WireMetric, type WireSrm, type WireSuggestion,
} from '../data/gateway'

// Connecting to an experiment that is already running, asked the way somebody
// would ask it out loud. {PRODUCT} does not set one up — it reads one out.
//
// This was four numbered steps of experiment-design vocabulary — arm column,
// unit of randomisation, outcome, guardrail — which is fine if you already know
// those words and useless if you do not. Only four things are actually
// required: a table, the column saying which version someone saw, and the
// column holding the result. Everything else improves the answer and none of it
// blocks starting, so it lives under "More settings" and the page asks four
// plain questions instead.

type Guard = { outcome: string; metric_id: string }

/** The names the backend treats as the baseline, in its order of preference —
 *  mirrored from `pick_control` so the page shows the guess that will actually
 *  be made rather than a different one. */
const BASELINE_NAMES = ['control', '0', 'a', 'baseline', 'off', 'false']

/** Which version the readout will compare against, and whether that was a
 *  guess. `new`/`old` resolves to `new`, which inverts every result — so a
 *  fallback is asked about rather than assumed. */
function guessBaseline(names: string[]): { pick: string; sure: boolean } {
  for (const want of BASELINE_NAMES) {
    const hit = names.find(n => n.toLowerCase() === want)
    if (hit) return { pick: hit, sure: true }
  }
  return { pick: names[0] ?? '', sure: false }
}

/** Refuses a column that cannot be an arm column.
 *
 *  A registration is a contract, and a contract written against the wrong
 *  column is worse than no contract: everything downstream reads as measured.
 *  This is the check that catches pointing the wizard at a table that is not
 *  an experiment at all — an id column's distinct values are identifiers, not
 *  two or three short labels, so it fails here rather than at the readout. */
function checkArms(column: string, values: string[]): string | null {
  if (!column || !values.length) return null
  if (values.length < 2) {
    return `${column} has only one distinct value, so there is nothing to compare.`
  }
  if (values.length > 6) {
    return `${column} has ${values.length} distinct values. An arm column holds a handful of labels — this looks like an identifier.`
  }
  const idish = values.filter(v => /[./\\]/.test(v) || v.length > 32)
  if (idish.length) {
    return `${column} holds values like “${idish[0]}”, which read as identifiers rather than arm names. An arm column usually holds short labels such as control and variant.`
  }
  return null
}

/** CommonIndex's own tables, from migrations/. The dev database registers itself as a
 *  warehouse connection, so these show up in the picker beside real data —
 *  including the two that hold secrets. None of them is an experiment. */
const OWN_TABLES = new Set([
  'actor_tokens', 'actors', 'chunks', 'connection_secrets', 'connections',
  'consumer_offsets', 'datasets', 'edges', 'events', 'grants', 'memberships',
  'metrics', 'object_types', 'objects', 'panel_bindings', 'proposals',
  'query_cache', 'relation_types', 'revisions', 'run_steps', 'runs',
  'space_seq', 'spaces',
])
const isOwnTable = (id: string) => OWN_TABLES.has(id.split('.').pop() ?? '')

/** A saved query reading CommonIndex's own tables is CommonIndex's own data wearing a new
 *  name — `select agent_id … from runs` is which agent did the work, never
 *  which version a person saw. */
const readsOwnTables = (sql: string) =>
  [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)]
    .some(m => OWN_TABLES.has((m[1] ?? '').split('.').pop() ?? ''))

const isOwnData = (t: { id: string; physical?: string; is_virtual?: boolean }) =>
  isOwnTable(t.id) || (!!t.is_virtual && !!t.physical && readsOwnTables(t.physical))

/** Column names that hold an experiment's identity. One exposure table
 *  routinely carries every experiment the company has ever run, so this is
 *  what turns "a table" into "an experiment". */
const EXP_COL = /^(experiment|experiment_id|experiment_name|experiment_key|test|test_id|test_name|ab_test|exp_id|exp_name)$/i
const qi = (id: string) => '"' + id.replace(/"/g, '""') + '"'
const ql = (v: string) => "'" + v.replace(/'/g, "''") + "'"
/** A picked row is a table or a saved query; both can be selected from. */
const srcOf = (t: WireDataset) => (t.is_virtual ? `(${t.physical}) src` : t.physical)

/** A saved query can pin the experiment in its WHERE and then not select the
 *  column at all — which looks identical to a table that never named one.
 *  Read the literal back so the difference is visible. */
function scopedUpstream(t: WireDataset): string | null {
  if (!t.is_virtual || !t.physical) return null
  const m = /\bwhere\b[\s\S]*?\b(?:experiment|experiment_id|experiment_name|test|test_id|test_name|ab_test|exp_id)\b\s*=\s*'([^']+)'/i
    .exec(t.physical)
  return m?.[1] ?? null
}

/** One engagement table, reduced to one number per unit.
 *
 *  Outcomes do not all live beside the assignment: orders are in an orders
 *  table, tickets in a support table. The readout takes many outcomes but only
 *  one dataset, so each source becomes a LEFT JOIN and one more column, and a
 *  unit with no rows there is a zero rather than a missing row. */
interface EngSource { key: number; table: WireDataset; join: string; col: string; agg: 'count' | 'sum' | 'avg' | 'max' }

const engName = (e: EngSource) =>
  `${(e.table.id.split('.').pop() ?? 'eng').replace(/^eng_/, '')}_${e.agg === 'count' ? 'n' : e.agg}`

/** exposure LEFT JOIN each source, one row per unit, zeros where absent. */
function joinedSql(baseSql: string, unitCol: string, sources: EngSource[]) {
  const j = sources.map((e, i) => {
    const a = `j${i}`
    const measure = e.agg === 'count' ? 'count(*)' : `${e.agg}(${qi(e.col)})`
    return {
      sel: `coalesce(${a}.v, 0) as ${qi(engName(e))}`,
      join: `left join (select ${qi(e.join)} as unit, ${measure} as v from ${srcOf(e.table)} group by 1) ${a}`
            + ` on ${a}.unit = e.${qi(unitCol)}`,
    }
  })
  return `select e.*, ${j.map(x => x.sel).join(', ')} from (${baseSql}) e ${j.map(x => x.join).join(' ')}`
}

/** A readable default so nobody has to name a thing that already has a name. */
function defaultName(datasetId: string): string {
  const t = (datasetId.split('.').pop() ?? datasetId).replace(/^exp_/, '').replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function ExperimentNew() {
  const [conns, setConns] = useState<WireConnection[] | null>(null)
  const [conn, setConn] = useState<WireConnection | null>(null)
  const [tables, setTables] = useState<WireDataset[] | null>(null)
  const [ds, setDs] = useState<WireDataset | null>(null)
  // The row the user clicked. `ds` is what gets read out, and when the table
  // holds several experiments those are not the same thing.
  const [table, setTable] = useState<WireDataset | null>(null)
  const [expCol, setExpCol] = useState('')
  // What scoping the table to one experiment concluded. Always rendered:
  // deciding this silently is indistinguishable from not checking.
  const [scope, setScope] = useState<
    | { kind: 'none' }
    | { kind: 'one'; id: string }
    | { kind: 'upstream'; id: string }
    | { kind: 'many'; list: { id: string; n: number }[] }
    | null>(null)
  const [expId, setExpId] = useState('')
  const [baseSql, setBaseSql] = useState('')
  const [scoping, setScoping] = useState(false)
  const [scopeErr, setScopeErr] = useState<string | null>(null)
  // Where else these units showed up. Empty is fine — plenty of tables carry
  // the outcome beside the assignment.
  const [eng, setEng] = useState<EngSource[]>([])
  const [engSeq, setEngSeq] = useState(1)
  const [tq, setTq] = useState('')

  const [variation, setVariation] = useState('')
  const [unit, setUnit] = useState('')
  const [outcome, setOutcome] = useState('')
  const [name, setName] = useState('')
  const [namedByHand, setNamedByHand] = useState(false)
  // Whether an uneven delivery was on purpose. Asked only when the delivery
  // is actually uneven — typing "50 / 50" into a form before seeing any data
  // is the same as assuming even, which is what happens anyway when nothing is
  // registered. The question worth a human's time is the one they can answer:
  // it came out 90/10, was that the design?
  const [intent, setIntent] = useState<'designed' | 'fault' | null>(null)
  // The one cut the readout may break the arms down by. Fixed at registration
  // on purpose: choosing it after seeing the numbers is how a null becomes
  // "it worked on iOS".
  const [cohort, setCohort] = useState('')
  const [hypothesis, setHypothesis] = useState('')

  const [srm, setSrm] = useState<WireSrm | null>(null)
  const [srmBusy, setSrmBusy] = useState(false)
  const [metrics, setMetrics] = useState<WireMetric[] | null>(null)

  const [look, setLook] = useState<WireSuggestion | null>(null)
  const [looking, setLooking] = useState(false)
  const [edit, setEdit] = useState(false)
  const [more, setMore] = useState(false)
  const [control, setControl] = useState('')
  const [guards, setGuards] = useState<Guard[]>([])
  const [mde, setMde] = useState('2')
  const [days, setDays] = useState('14')
  // When traffic really began. The readout reads from here, so a date left at
  // "whenever it was registered" would drop every day before registration.
  const [startedOn, setStartedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [plan, setPlan] = useState<WirePlan | null>(null)

  const [err, setErr] = useState<string | null>(null)

  /** Why saving was refused — shown by the button that was pressed. */

  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => { listConnections().then(r => setConns(r.connections)).catch(() => setConns([])) }, [])
  // Can this design see the effect it names? Asked of the table itself, so the
  // traffic and the baseline are measured rather than typed.
  useEffect(() => {
    setPlan(null)
    const m = Number(mde) / 100
    if (!conn || !ds || !variation || !outcome || !m) return
    let alive = true
    const t = setTimeout(() => {
      planExperiment({ connection_id: conn.id, dataset_id: ds.id, variation, outcome,
        ...(unit ? { unit } : {}), ...(control ? { control } : {}), mde: m, binary: isBinary(outcome),
        ...(Number(days) ? { planned_days: Number(days) } : {}) })
        .then(p => { if (alive) setPlan(p) }).catch(() => { if (alive) setPlan(null) })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [conn, ds, variation, outcome, unit, control, mde, days])
  useEffect(() => {
    if (!conn) return
    setTables(null)
    introspect(conn.id).then(r => setTables(r.datasets)).catch(e => setErr(String(e.message)))
  }, [conn])
  // A table either holds one experiment or many. If it names them, the name
  // is in a column — so read that column rather than asking someone to
  // describe what is already written down. Whatever it concludes is shown.
  useEffect(() => {
    setDs(null); setExpCol(''); setScope(null); setExpId(''); setScopeErr(null)
    if (!conn || !table) return
    const col = table.columns.find(c => c.kind === 'string' && EXP_COL.test(c.name))?.name
    const up = scopedUpstream(table)
    if (!col) {
      setScope(up ? { kind: 'upstream', id: up } : { kind: 'none' })
      setDs(table); setBaseSql(`select * from ${srcOf(table)}`); return
    }
    setExpCol(col)
    previewSql(conn.id, `select ${qi(col)} as id, count(*) as n from ${srcOf(table)} group by 1 order by 2 desc limit 50`)
      .then(p => {
        const rows = p.rows.map(r => ({ id: String(r[0] ?? ''), n: Number(r[1] ?? 0) })).filter(r => r.id)
        if (rows.length <= 1) {
          // One value is not a choice — but it is still worth stating.
          setScope(rows.length ? { kind: 'one', id: rows[0].id } : { kind: 'none' })
          setDs(table); setBaseSql(`select * from ${srcOf(table)}`)
        } else setScope({ kind: 'many', list: rows })
      })
      .catch(e => { setScopeErr(e instanceof Error ? e.message : String(e)); setScope({ kind: 'none' }); setDs(table) })
  }, [conn, table])

  // Picking one saves the scoped rows as a dataset and reads out against that,
  // so the arms, the split and every number below belong to one experiment
  // rather than to every experiment in the table at once.
  useEffect(() => {
    if (!conn || !table || !expCol || !expId) return
    setScoping(true); setScopeErr(null)
    saveVirtualDataset(conn.id, `exp.${expId}`,
      `select * from ${srcOf(table)} where ${qi(expCol)} = ${ql(expId)}`, table.time_column)
      .then(d => {
        const sql = `select * from ${srcOf(table)} where ${qi(expCol)} = ${ql(expId)}`
        setBaseSql(sql)
        setDs({ ...table, id: d.dataset_id, is_virtual: true, physical: sql, columns: d.columns })
      })
      .catch(e => setScopeErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setScoping(false))
  }, [conn, table, expCol, expId])

  useEffect(() => {
    if (!ds) return
    listMetrics(ds.id).then(r => setMetrics(r.metrics.filter(m => m.status === 'ratified')))
      .catch(() => setMetrics([]))
  }, [ds])

  // Look at the table rather than interrogating the author about it. Which
  // column holds the version and which identifies the person are facts about
  // the data, and asking produced `author_id` picked as a version column.
  useEffect(() => {
    if (!conn || !ds) { setLook(null); return }
    let alive = true
    setLooking(true); setEdit(false)
    suggestExperiment(conn.id, ds.id)
      .then(r => {
        if (!alive) return
        setLook(r)
        setVariation(r.versions[0]?.column ?? '')
        setUnit(r.units[0]?.column ?? '')
        setOutcome(r.measures.find(m => m.metric_id)?.column ?? r.measures[0]?.column ?? '')
        if (!r.confident) setEdit(true)
      })
      .catch(() => { if (alive) { setLook(null); setEdit(true) } })
      .finally(() => { if (alive) setLooking(false) })
    return () => { alive = false }
  }, [conn, ds])

  useEffect(() => {
    if (!conn || !ds || !variation) { setSrm(null); return }
    let alive = true
    setSrmBusy(true)
    checkSrm({ connection_id: conn.id, dataset_id: ds.id, variation, unit: unit || undefined })
      .then(r => { if (alive) setSrm(r.srm) })
      .catch(() => { if (alive) setSrm(null) })
      .finally(() => { if (alive) setSrmBusy(false) })
    return () => { alive = false }
  }, [conn, ds, variation, unit])

  const cols = ds?.columns ?? []
  const strings = cols.filter(c => c.kind === 'string').map(c => c.name)
  // What an outcome can be: a number, or a yes/no column read as a rate
  // (`converted`), which the readout sums as 1/0.
  const numbers = cols.filter(c => c.kind === 'number' || c.kind === 'bool').map(c => c.name)
  const isBinary = (col: string) => cols.find(c => c.name === col)?.kind === 'bool'
  const versions = srm?.arms?.map(a => a.name) ?? []
  const baseline = guessBaseline(versions)
  const armCheck = checkArms(variation, versions)
  // Delivered shares, straight from the counts the check already ran.
  const srmTotal = srm?.arms?.reduce((n, a) => n + a.observed, 0) ?? 0
  const delivered = (srm?.arms ?? []).map(a => ({ name: a.name, pct: srmTotal ? (a.observed / srmTotal) * 100 : 0 }))
  const uneven = srm?.ran === true && srm.passed === false
  // Only a genuinely uneven split needs an answer before registering.
  const splitOk = !uneven || intent !== null

  // Two steps are conditional, so the numbers are counted rather than written
  // down — a wizard that goes 1, 2, 3, 5 looks like it lost a step.
  const showEng = !!(ds && variation && unit)
  const nEng = 3
  const nSplit = 3 + (showEng ? 1 : 0)
  const nName = nSplit + (uneven ? 1 : 0)
  const shown = useMemo(() => {
    const q = tq.trim().toLowerCase()
    return (tables ?? [])
      .filter(t => !isOwnData(t))
      .filter(t => !q || t.id.toLowerCase().includes(q))
  }, [tables, tq])

  // What somebody has already named and stood behind, offered by that name.
  //
  // The registry holds "Checkout conversion", and this page was offering
  // `converted` — asking the author to think in columns when the platform
  // already thinks in metrics. Only AVG(<column>) definitions can be an
  // experiment outcome, because a readout aggregates the column itself, so
  // anything else is left out rather than offered and refused on submit.
  const named = useMemo(() => (metrics ?? []).flatMap(m => {
    const col = /^avg\(\s*([a-z0-9_."]+)\s*\)$/i.exec(m.expr.trim())?.[1]?.replace(/"/g, '')
    return col && numbers.includes(col) ? [{ metric: m, column: col }] : []
  }), [metrics, numbers])

  // Columns nobody has defined yet. Still usable — the readout will say the
  // direction was assumed rather than quietly assuming it.
  const bare = useMemo(
    () => numbers.filter(c => !named.some(n => n.column === c)), [numbers, named])

  const matched = useMemo(
    () => named.find(n => n.column === outcome)?.metric ?? null, [named, outcome])

  // Derived, not demanded: the test is running in another system and already
  // has an identity there. Ask for a correction, not an invention.
  const title = name.trim() || (ds ? defaultName(ds.id) : '')
  const engOk = eng.every(e => e.join && (e.agg === 'count' || e.col))
  const ready = !!(conn && ds && variation && outcome && title && !armCheck && splitOk && engOk)

  async function save() {
    if (!conn || !ds) return
    setSaving(true); setSaveErr(null)
    try {
      // Engagement tables become columns on one joined dataset, because the
      // readout takes many outcomes but only one dataset.
      let datasetId = ds.id
      if (eng.length && unit) {
        const sql = joinedSql(baseSql, unit, eng)
        const name = `exp.${expId || (table?.id.split('.').pop() ?? 'exp')}.joined`
        const d = await saveVirtualDataset(conn.id, name, sql, ds.time_column)
        datasetId = d.dataset_id
      }
      const r = await registerExperiment({
        name: title, hypothesis: hypothesis.trim(), status: 'running',
        started_at: new Date(`${startedOn}T00:00:00`).toISOString(),
        idempotencyKey: `exp-${Date.now()}`,
        contract: {
          connection_id: conn.id, dataset_id: datasetId, variation, outcome, binary: isBinary(outcome),
          ...(cohort ? { cohort } : {}),
          ...(unit ? { unit } : {}),
          ...(control ? { control } : {}),
          // The arms, and the share each was meant to get. Without this every
          // readout assumes an even split and says so.
          // Registered only when a human said the uneven delivery was the
          // design. Otherwise nothing is claimed, and the readout goes on
          // saying it assumed an even split — which is true.
          ...(intent === 'designed' && delivered.length
            ? { weights: Object.fromEntries(delivered.map(d => [d.name, d.pct / 100])) }
            : {}),
          ...(matched ? { metric_id: matched.id } : {}),
          ...(() => {
            const extra = eng.map(engName).filter(n => n !== outcome).map(outcome => ({ outcome, metric_id: '' }))
            const all = [...guards.filter(g => g.outcome), ...extra]
            return all.length ? { guardrails: all } : {}
          })(),
          ...(mde ? { mde: Number(mde) / 100 } : {}),
          ...(days ? { planned_days: Number(days) } : {}),
        },
      })
      forgetLiveExperiments()
      toast(`${r.title} is running — open it any time to see where it stands`)
      navigate(`/experiments/${r.experiment_id}`)
    } catch (e) {
      const g = e as GatewayError
      setSaveErr(g.field ? `${g.field}: ${g.message}` : g.message)
      setSaving(false)
    }
  }

  return (
    <div className="detail wiz">
      <div className="crumb"><Link to="/experiments">← Experiments</Link> / new</div>
      <div className="page-title">Measure a running experiment</div>
      {/* Set the model before the first question. Every experimentation tool
          people have used assigns traffic — you define variants, give one 10%,
          and it decides who sees what. This one does not: assignment already
          happened in your product, and this reads the record of it. Not saying
          so means the author looks for a "create variant" button, does not
          find one, and picks whatever column has several values in it. */}
      <div className="page-sub">
        This measures an experiment that is <b>already running</b>. Your app or feature-flag tool
        decides who sees which version and writes it down; this reads that record and tells you
        what changed. It does not split traffic or create versions itself.
        <div className="page-sub-more">
          Not running yet? <Link to="/experiments/plan">Plan it first</Link> — how many people and days it needs.
        </div>
        <div className="page-sub-more">
          So you need a table with <b>one row per person exposed</b>, and a column saying which
          version they got — usually the same two values repeated, like <code>control</code> and{' '}
          <code>variant</code>. If nothing records that yet, that has to exist first.
        </div>
      </div>

      {err && <div className="wiz-err">{err}</div>}

      <Ask n={1} q="Where is the data?">
        {conns === null ? <div className="ro-loading">Loading…</div>
          : conns.length === 0
            ? <div className="ro-note warn">
                No warehouse connected yet. <Link to="/dashboards/new">Connect one first</Link> —
                the same connection is used for dashboards.
              </div>
            : <>
                <Chips value={conn?.id ?? ''} onChange={id => { setConn(conns.find(c => c.id === id) ?? null); setDs(null) }}
                       options={conns.map(c => c.id)} label={id => conns.find(c => c.id === id)!.name} />
                {conn && (tables === null
                  ? <div className="ro-loading">Reading the tables…</div>
                  : <>
                      <input className="wiz-in wiz-search" placeholder="Search tables…"
                             value={tq} onChange={e => setTq(e.target.value)} />
                      <div className="wiz-tables">
                        {shown.slice(0, 60).map(t => (
                          <button key={t.id} className={`wiz-table${table?.id === t.id ? ' on' : ''}`}
                                  onClick={() => { setTable(t); setVariation(''); setUnit(''); setOutcome(''); setCohort('') }}>
                            {t.id}
                          </button>
                        ))}
                      </div>
                    </>)}
                {scope && (
                  <div className="wiz-scope">
                    {scope.kind === 'many' ? (
                      <>
                        <div className="wiz-scope-q">
                          Which experiment? <span className="wiz-scope-h">
                            {table?.id} records {scope.list.length} of them in <span className="mono">{expCol}</span>.
                            Everything below is scoped to the one you pick.
                          </span>
                        </div>
                        <Chips value={expId} onChange={setExpId} options={scope.list.map(e => e.id)}
                               label={id => `${id} (${scope.list.find(e => e.id === id)!.n.toLocaleString()})`} />
                        {scoping && <div className="ro-loading">Scoping to {expId}…</div>}
                      </>
                    ) : scope.kind === 'upstream' ? (
                      <div className="wiz-scope-note">
                        This saved query already picks one: <b>{scope.id}</b>. It filters on the
                        experiment without selecting the column, so there was nothing left to ask.
                      </div>
                    ) : scope.kind === 'one' ? (
                      <div className="wiz-scope-note">
                        One experiment in this table: <b>{scope.id}</b>. Nothing to choose, so nothing was asked.
                      </div>
                    ) : (
                      <div className="wiz-scope-note warn">
                        No column here names an experiment, so the whole table is read as one.
                        If it actually holds several, their rows are being mixed together — scope it
                        first with a saved query.
                      </div>
                    )}
                  </div>
                )}
                {scopeErr && <div className="wiz-warnline">Could not read the experiments in this table: {scopeErr}</div>}
              </>}
      </Ask>

      {ds && (looking
        ? <section className="ask"><div className="ro-loading">Reading the table…</div></section>
        : <Ask n={2} q="Is this the experiment?">
            {look && !look.versions.length
              ? <div className="ro-note warn">
                  <b>{look.verdict}.</b> A version column holds the same two or three values over
                  and over — <code>control</code> and <code>variant</code>, <code>on</code> and{' '}
                  <code>off</code> — one row per person. If nothing in this table looks like that,
                  it is probably not where the experiment was recorded.
                </div>
              : <>
                  <dl className="found">
                    <dt>Versions</dt>
                    <dd>
                      <code>{variation || '—'}</code>
                      {srmBusy ? <span className="found-thin"> · looking…</span>
                        : srm?.ran ? <Found srm={srm} unit={unit} /> : null}
                    </dd>
                    <dt>One row per</dt>
                    <dd>
                      {unit ? <code>{unit}</code> : <span className="wiz-warnline">nothing — counting rows</span>}
                      {unit && <span className="found-thin"> · so a person seen twice counts once</span>}
                    </dd>
                    <dt>Measuring</dt>
                    <dd>
                      {matched
                        ? <>{matched.label} <span className="found-thin">· <code>{matched.expr}</code> · {matched.better === 'down' ? 'lower' : 'higher'} is better</span></>
                        : outcome ? <><code>{outcome}</code> <span className="wiz-warnline">· no saved metric definition, so it assumes higher is better</span></>
                        : <span className="wiz-warnline">nothing numeric to measure</span>}
                    </dd>
                    {versions.length > 1 && (
                      <>
                        <dt>Compared against</dt>
                        <dd>
                          <code>{control || baseline.pick}</code>
                          {!control && !baseline.sure &&
                            <span className="wiz-warnline"> · guessed. If that is the new version, every result reads backwards.</span>}
                        </dd>
                      </>
                    )}
                  </dl>
                  <button className="wiz-more" onClick={() => setEdit(!edit)}>
                    {edit ? '▾' : '▸'} {edit ? 'Hide' : 'Not right? Change'} what it picked
                  </button>
                  {edit && (
                    <div className="wiz-panel">
                      <Field label="Which column says which version each person saw?">
                        <Chips value={variation} onChange={setVariation} options={strings} />
                      </Field>
                      <Field label="Which column identifies each person?"
                             hint="So somebody on ten rows counts once, not ten times.">
                        <Chips value={unit} onChange={setUnit} options={strings.filter(c => c !== variation)}
                               none="one row per person already" />
                      </Field>
                      <Field label="What are you hoping changes?">
                        {named.length > 0 && (
                          <Chips value={outcome} onChange={setOutcome} options={named.map(n => n.column)}
                                 label={col => named.find(n => n.column === col)!.metric.label} />
                        )}
                        {bare.length > 0 && (
                          <div className="wiz-bare">
                            <div className="wiz-bare-t">
                              {named.length ? 'Or a column nobody has defined:' : 'Columns in this table:'}
                            </div>
                            <Chips value={outcome} onChange={setOutcome} options={bare} />
                          </div>
                        )}
                      </Field>
                      {versions.length > 1 && (
                        <Field label="Which version is the current one?"
                               hint="Everything else is compared against it.">
                          <Chips value={control || (baseline.sure ? baseline.pick : '')}
                                 onChange={setControl} options={versions} />
                        </Field>
                      )}
                      <Field label="Break the arms down by?"
                             hint="Optional, and fixed once it starts — picking a cut after seeing the numbers is how a null result becomes a finding. The overall answer stays the headline either way.">
                        <Chips value={cohort} onChange={setCohort}
                               options={strings.filter(c => c !== variation && c !== unit)}
                               none="no breakdown" />
                      </Field>
                    </div>
                  )}
                </>}
          </Ask>)}

      {ds && variation && unit && (
        <Ask n={nEng} q="Where else did these units show up?"
             why="Outcomes rarely sit beside the assignment. Each table you add becomes one number per unit on the joined dataset — and a unit with no rows there counts as zero, not as missing.">
          {eng.map(e => (
            <div className="eng-row" key={e.key}>
              <select className="wiz-in eng-t" value={e.table.id}
                      onChange={ev => setEng(eng.map(x => x.key === e.key
                        ? { ...x, table: (tables ?? []).find(t => t.id === ev.target.value)!, join: '', col: '' } : x))}>
                {(tables ?? []).filter(t => !isOwnData(t) && t.id !== table?.id).map(t => (
                  <option key={t.id} value={t.id}>{t.id}</option>
                ))}
              </select>
              <span className="eng-lbl">joined on</span>
              <select className="wiz-in eng-c" value={e.join}
                      onChange={ev => setEng(eng.map(x => x.key === e.key ? { ...x, join: ev.target.value } : x))}>
                <option value="">choose…</option>
                {e.table.columns.filter(c => c.kind === 'string').map(c => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <select className="wiz-in eng-a" value={e.agg}
                      onChange={ev => setEng(eng.map(x => x.key === e.key ? { ...x, agg: ev.target.value as EngSource['agg'] } : x))}>
                <option value="count">how many rows</option>
                <option value="sum">sum of</option>
                <option value="avg">average of</option>
                <option value="max">max of</option>
              </select>
              {e.agg !== 'count' && (
                <select className="wiz-in eng-c" value={e.col}
                        onChange={ev => setEng(eng.map(x => x.key === e.key ? { ...x, col: ev.target.value } : x))}>
                  <option value="">choose…</option>
                  {e.table.columns.filter(c => c.kind === 'number' || c.kind === 'bool').map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              )}
              <span className="eng-as">→ <span className="mono">{engName(e)}</span></span>
              <button className="btn ghost" onClick={() => setEng(eng.filter(x => x.key !== e.key))}>Remove</button>
            </div>
          ))}
          <button className="btn" onClick={() => {
            const t = (tables ?? []).find(x => !isOwnData(x) && x.id !== table?.id)
            if (!t) return
            setEng([...eng, { key: engSeq, table: t, join: unit, col: '', agg: 'count' }])
            setEngSeq(engSeq + 1)
          }}>Add an engagement table</button>
          {eng.some(e => !e.join || (e.agg !== 'count' && !e.col)) && (
            <div className="wiz-warnline">Every source needs a join column, and anything but a row count needs a column to measure.</div>
          )}
        </Ask>
      )}

      {uneven && (
        <Ask n={nSplit} q="The split is not even. Was that the design?"
             why="Only asked because it came out uneven. An even split needs no answer — nothing is registered and the readout says it assumed one.">
          <div className="split-rows">
            {delivered.map(d => (
              <div className="split-row" key={d.name}>
                <span className="split-n">{d.name}{d.name === (control || baseline.pick) ? <span className="split-b">baseline</span> : null}</span>
                <span className="split-in tnum">{d.pct.toFixed(1)}%</span>
                <span className="split-pc">delivered</span>
              </div>
            ))}
          </div>
          <div className="split-choose">
            <button className={`btn${intent === 'designed' ? ' primary' : ''}`} onClick={() => setIntent('designed')}>
              That was the design
            </button>
            <button className={`btn${intent === 'fault' ? ' primary' : ''}`} onClick={() => setIntent('fault')}>
              No — something is wrong
            </button>
          </div>
          {intent === 'designed' && (
            <div className="wiz-okline">
              Registered as intended, so the check compares against it instead of against an even split.
            </div>
          )}
          {intent === 'fault' && (
            <div className="wiz-warnline">
              Nothing registered. Every readout will keep reporting a sample ratio mismatch until the
              assignment is fixed — which is the point: the arms are not comparable.
            </div>
          )}
        </Ask>
      )}

      {ds && variation && outcome && (
        <Ask n={nName} q="What should {PRODUCT} call it here?"
             why="It already has a name wherever it is running. This is only the label on the record — corrected, not invented.">
          <input className="wiz-in wide"
                 value={namedByHand ? name : title}
                 onChange={e => { setNamedByHand(true); setName(e.target.value) }}
                 placeholder={ds ? defaultName(ds.id) : 'Trust badge at checkout'} />
          <textarea className="wiz-in wide" rows={2} value={hypothesis}
                    onChange={e => setHypothesis(e.target.value)}
                    placeholder="What you expect to happen, and why. Optional." />
          <label className="wiz-started">When did it start?
            <input type="date" className="wiz-in" value={startedOn}
                   max={new Date().toISOString().slice(0, 10)} onChange={e => setStartedOn(e.target.value)} />
            <span className="wiz-hint">Readouts read from this day on — not the last 30 days.</span>
          </label>
        </Ask>
      )}

      {ds && variation && outcome && (
        <>
          <button className="wiz-more" onClick={() => setMore(!more)}>
            {more ? '▾' : '▸'} More settings — none of these are required
          </button>
          {more && (
            <div className="wiz-panel">
              <Field label="Anything that must not get worse?"
                     hint="Checked alongside the main result. A win that breaks one of these is not a win.">
                {guards.map((g, i) => (
                  <div className="wiz-guard" key={i}>
                    {/* By name, and the definition comes with it — a guardrail's
                        direction is usually the opposite of the target's, and
                        picking a column then a metric separately is two chances
                        to mismatch them. */}
                    <Select value={g.outcome} empty="choose…"
                            onChange={v => setGuards(gs => gs.map((x, j) => j === i
                              ? { outcome: v, metric_id: named.find(n => n.column === v)?.metric.id ?? '' }
                              : x))}
                            options={numbers.filter(n => n !== outcome)}
                            label={col => {
                              const hit = named.find(n => n.column === col)
                              return hit
                                ? `${hit.metric.label} (${hit.metric.better === 'down' ? 'lower' : 'higher'} is better)`
                                : `${col} — no saved definition; assumes higher is better`
                            }} />
                    <button className="btn ghost danger" onClick={() => setGuards(gs => gs.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                ))}
                <button className="btn" onClick={() => setGuards(gs => [...gs, { outcome: '', metric_id: '' }])}>
                  + Add one
                </button>
              </Field>

              <div className="wiz-commit">
                <Field label="How long will you run it?" hint="You can look before then.">
                  <span className="wiz-unit"><input className="wiz-in short" value={days}
                        onChange={e => setDays(e.target.value)} inputMode="numeric" />days</span>
                </Field>
                <Field label="How big a change would matter?"
                       hint="Below this you would not act, so a smaller result counts as no result.">
                  <span className="wiz-unit"><input className="wiz-in short" value={mde}
                        onChange={e => setMde(e.target.value)} inputMode="decimal" />%</span>
                </Field>
              </div>

            </div>
          )}
        </>
      )}

      {plan && (
        <div className={`wiz-plan${plan.enough === false ? ' short' : ''}`} role="status">
          {plan.days != null
            ? <>At about <b>{Math.round(plan.measured.daily_units ?? 0).toLocaleString()}</b> units a day, seeing
                a {mde}% change needs about <b>{plan.total.toLocaleString()}</b> units — <b>{plan.days} days</b>
                {plan.enough === false
                  ? <>, not the {days} planned. A shorter run can only say “no difference detected”.</>
                  : <>, within the {days} planned.</>}</>
            : <>Seeing a {mde}% change needs about <b>{plan.total.toLocaleString()}</b> units.</>}
          <span className="wiz-hint"> Sized for the always-valid interval the readout uses.</span>
        </div>
      )}

      <div className="wiz-act">
        <button className="btn primary" disabled={!ready || saving} onClick={save}>
          {saving ? 'Connecting…' : 'Start measuring it'}
        </button>
        {ds && variation && outcome && !title && !armCheck && <span className="wiz-hint">Give it a name first.</span>}
        {ds && variation && outcome && !name.trim() && title && !armCheck && <span className="wiz-hint">Saved as “{title}” — rename it above if you like.</span>}
      </div>
      {/* Said where the button is: shown only at the top, a refusal was off screen. */}
      {saveErr && <div className="wiz-err" role="alert">{saveErr}</div>}
      {armCheck && (
        <div className="wiz-block">
          <b>Cannot register against this column.</b> {armCheck}
        </div>
      )}
      {ready && (
        <div className="wiz-foot">
          What you picked is fixed once it starts. That is the point — it is what stops the
          question changing after the numbers arrive.
        </div>
      )}
    </div>
  )
}

/** One question, numbered because the answers genuinely depend on each other. */
function Ask({ n, q, why, children }: {
  n: number; q: string; why?: string; children: React.ReactNode
}) {
  return (
    <section className="ask">
      <h2 className="ask-q"><span className="ask-n">{n}</span>{q}</h2>
      {why && <div className="ask-why">{why}</div>}
      {children}
    </section>
  )
}

/** What the version column actually contains, in a sentence. "The split, as it
 *  stands" told you the name of a statistical check; this tells you what is in
 *  your data. */
function Found({ srm, unit }: { srm: WireSrm; unit: string }) {
  const arms = srm.arms ?? []
  // "people".slice(0, -1) + "s" is "peopls". Irregular plurals do not survive
  // being chopped, so both forms are written out.
  const [one, many] = unit ? ['person', 'people'] : ['row', 'rows']
  const per = arms.length ? Math.round((srm.total ?? 0) / arms.length) : 0
  const thin = !!srm.note

  return (
    <div className="wiz-said">
      <b>{arms.length} version{arms.length === 1 ? '' : 's'}:</b>{' '}
      {arms.map((a, i) => (
        <span key={a.name}>
          {i > 0 && ', '}{a.name} ({a.observed.toLocaleString()})
        </span>
      ))}
      {'. '}
      {thin
        ? <span className="wiz-warnline">Too few {many} so far to tell whether that is an even split.</span>
        : srm.passed
          ? <span className="wiz-okline">
              Consistent with an even split — no designed split was registered, so that is what
              this was checked against.
            </span>
          : <span className="wiz-warnline">
              Not an even split. If that is deliberate — a small holdout, say — carry on. If it is
              not, something other than chance is deciding who sees what, and results from it will
              be misleading.
            </span>}
      {arms.length > 2 && per < 5 && (
        <div className="ro-note warn">
          <b>This does not look like a version column.</b> It has {arms.length} distinct values
          with about {per} {per === 1 ? one : many} each ({arms.slice(0, 3).map(a => a.name).join(', ')}
          {arms.length > 3 ? ', …' : ''}), which is what an id or a category looks like. A version
          column holds the same two or three values over and over — <code>control</code> and{' '}
          <code>variant</code>, <code>on</code> and <code>off</code> — one per person.
          <div className="wiz-said-more">
            If no column in this table looks like that, this is probably not the table the
            experiment was recorded in. The one you want has a row per person exposed, saying which
            version they got.
          </div>
        </div>
      )}
      {!unit && !thin && (
        <div className="ro-note warn">
          Counting rows, not people. If anyone appears more than once, answer the next question or
          the numbers will overcount them.
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="wiz-field">
      <div className="wiz-label">{label}{hint && <span className="wiz-hint">{hint}</span>}</div>
      {children}
    </div>
  )
}

function Chips({ value, onChange, options, none, label }: {
  value: string; onChange: (v: string) => void; options: string[]
  none?: string; label?: (v: string) => string
}) {
  return (
    <div className="wiz-chips">
      {options.map(o => (
        <button key={o} className={`chip${value === o ? ' on' : ''}`}
                onClick={() => onChange(value === o ? '' : o)}>{label ? label(o) : o}</button>
      ))}
      {none && (
        <button className={`chip muted${value === '' ? ' on' : ''}`} onClick={() => onChange('')}>
          {none}
        </button>
      )}
    </div>
  )
}

function Select({ value, onChange, options, empty, label }: {
  value: string; onChange: (v: string) => void; options: string[]
  empty?: string; label?: (v: string) => string
}) {
  return (
    <select className="wiz-in" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{empty ?? 'choose…'}</option>
      {options.map(o => <option key={o} value={o}>{label ? label(o) : o}</option>)}
    </select>
  )
}
