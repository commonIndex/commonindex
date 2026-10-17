import { useCallback, useEffect, useState } from 'react'
import { CommentsButton } from '../components/discussion/Thread'
import { TasksButton } from '../components/TaskLinks'
import { ProjectsButton } from '../components/ProjectChips'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { forgetLiveExperiments, listExperiments, getExperiment, getExperimentSeries, type ExpFilter } from '../data/api'
import { GatewayError, getLiveExperiment, readout, type WireComparison, type WirePlan, type WireReadout, type WireResult, type WireSrm } from '../data/gateway'
import { usePagedList, useDebounced } from '../hooks'
import { VirtualList } from '../components/VirtualList'
import { MetricChart } from '../components/MetricChart'
import { Avatar, Oid, Pill, Stat, statusTone, Freshness } from '../components/ui'
import { PRODUCT } from '../product'
import { ExperimentLifecycle, usePlan, type LiveExperiment } from '../components/ExperimentLifecycle'
import { ReadoutTimeline } from '../components/ReadoutTimeline'
import { ExperimentCard, experimentState } from '../components/ExperimentCard'
import { ExperimentReferences } from '../components/ExperimentReferences'
import { ExperimentContract } from '../components/ExperimentContract'
import { ExperimentAICard, RECOMMEND, useExperimentAI } from '../components/ExperimentAI'
import type { Experiment, MetricSeries } from '../data/types'

const FILTERS: { id: ExpFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'readout', label: 'Stopped' },
  { id: 'attention', label: 'Needs a decision' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'iterated', label: 'Iterating' },
  { id: 'killed', label: 'Killed' },
  { id: 'mine', label: 'Mine' },
]

const VIEW_KEY = 'experiments.view'
function savedView(): 'grid' | 'list' {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}

export function ExperimentsView() {
  const [filter, setFilter] = useState<ExpFilter>('all')
  const [q, setQ] = useState('')
  // Cards by default, like Designs and Dashboards; rows for scanning many.
  const [view, setViewState] = useState<'grid' | 'list'>(savedView)
  const setView = (v: 'grid' | 'list') => {
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ }
  }
  const dq = useDebounced(q)
  const navigate = useNavigate()
  const filtered = !!q.trim() || filter !== 'all'
  const reset = () => { setQ(''); setFilter('all') }

  const fetcher = useCallback(
    (cursor?: number) => listExperiments({ cursor, filter, q: dq }),
    [filter, dq],
  )
  const { items, total, loading, error, loadMore, hasMore, retry } = usePagedList(`${filter}:${dq}`, fetcher)

  return (
    <div className="collection dashboard-collection workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Experiments <span className="total">{loading ? 'Loading…' : `${total} in this view`}</span></h1>
          <p className="coll-sub">
            Review experiment evidence and record decisions. Your engine runs the tests; {PRODUCT} connects the results to their registered plan.
          </p>
        </div>
        <div className="exp-gallery-actions">
          <Link to="/experiments/analysis" className="btn">Program analysis</Link>
          <Link to="/experiments/plan" className="btn">Plan one</Link>
          <button className="btn action" onClick={() => navigate('/experiments/new')}>Register an experiment</button>
        </div>
      </header>
      <div className="dash-collection-shell">
        <div className="coll-tools dash-gallery-tools">
          <div className="dash-gallery-filters" role="group" aria-label="Filter experiments">
            {FILTERS.map(f => <button key={f.id} className={`chip${filter === f.id ? ' on' : ''}`}
              aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
          <input type="search" className="dash-search" aria-label="Search experiments"
            placeholder="Search by name, metric, owner…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="dash-view-toggle" role="group" aria-label="Experiment display">
            <button aria-pressed={view === 'grid'} onClick={() => setView('grid')} aria-label="Grid view">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1.5 1.5h5v5h-5z M9.5 1.5h5v5h-5z M1.5 9.5h5v5h-5z M9.5 9.5h5v5h-5z" /></svg>
            </button>
            <button aria-pressed={view === 'list'} onClick={() => setView('list')} aria-label="List view">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 3h12 M2 8h12 M2 13h12" /></svg>
            </button>
          </div>
        </div>
        <div className="dash-gallery-results">
          <span role="status">{loading ? 'Loading experiments…' : error ? 'Experiments unavailable'
            : `${items.length} of ${total} experiments`}</span>
          {filtered && <button className="linkbtn" onClick={reset}>Clear filters</button>}
        </div>
        {!loading && error && <div className="dash-load-error" role="alert"><span><b>Could not load experiments.</b> {error.message}</span>
          <button className="tool" onClick={retry}>Retry</button></div>}
      </div>
      {loading ? <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="dash-card-skeleton"><div /><span /><span /></div>)}
      </div></div> : !items.length ? <div className="dash-gallery-scroll"><div className="dash-collection-shell dash-gallery-empty">
        {!error && <><h2>{filtered ? 'No matching experiments' : 'No experiments yet'}</h2>
          <p>{filtered ? 'Try a different search or clear your filters.'
            : 'Register one that is already running, or plan one before it starts.'}</p>
          {filtered ? <button className="tool" onClick={reset}>Show all experiments</button>
            : <button className="btn action" onClick={() => navigate('/experiments/new')}>Register an experiment</button>}</>}
      </div></div> : view === 'grid' ? <div className="dash-gallery-scroll">
        <div className="dash-collection-shell dash-gallery-grid" role="list" aria-label="Experiments">
          {items.map(e => <div role="listitem" key={e.id}><ExperimentCard experiment={e} /></div>)}
        </div>
        {hasMore && !error && <div className="dash-gallery-more"><button className="tool"
          onClick={loadMore}>Load more experiments</button></div>}
      </div> : (
      <VirtualList<Experiment>
        items={items}
        rowHeight={62}
        loading={loading}
        error={error}
        hasMore={hasMore}
        onEndReached={loadMore}
        listClass="list-exp"
        columns={['', 'experiment', '', 'state',
                  { label: 'lift', className: 'r' }, 'owner']}
        emptyText="No experiments match this view."
        onRowClick={e => navigate(`/experiments/${e.id}`)}
        byAgent={e => (e.attention?.length ?? 0) > 0 || (!e.live && (e.status === 'readout' || e.guardrail !== 'clean'))}
        render={e => (
          <>
            <span className="cell"><Oid id={e.key} /></span>
            <span className="cell stack">
              <span className="title">
                {/* A real link, so ⌘-click, middle-click and "copy link" work.
                    Its own click stops here; the row's handles the rest. */}
                <Link to={`/experiments/${e.id}`} className="exp-link" onClick={ev => ev.stopPropagation()}>{e.name}</Link>
                <span className="sub"> · {e.space} · {e.metric}</span>
                {e.live && <Pill tone="blue">warehouse</Pill>}
                {/* Worth saying on the row rather than three clicks in: an
                    experiment with no contract cannot be read out at all, and
                    finding that out at the readout is finding out too late. */}
                {e.live && e.preRegistered === false && <Pill tone="warn">no contract</Pill>}
              </span>
              <span className="prev">{e.hypothesis}</span>
            </span>
            <span className="cell sig">
              {e.attention?.length
                ? <span title={e.attention.join('\n')}><Pill tone="warn">{e.attention[0]}</Pill></span>
                : e.srmPassed === false ? <Pill tone="red">split check failed</Pill>
                : e.guardrail !== 'clean' && <Pill tone={statusTone(e.guardrail)}>guardrail {e.guardrail}</Pill>}
            </span>
            <span className="cell"><Stat tone={statusTone(e.status)}>{experimentState(e, true)}</Stat></span>
            {/* A live row's lift is a cache, so it is not presented as the
                answer — the detail page recomputes it. */}
            <span className="cell r num" title={e.liftCi ? `interval ${e.liftCi[0]}% to ${e.liftCi[1]}%` : undefined}>
              {e.lift === null ? '—' : `${e.lift > 0 ? '+' : ''}${e.lift}%`}</span>
            <span className="cell who"><span className="nm">{e.owner}</span><Avatar name={e.owner} /></span>
          </>
        )}
      />)}
    </div>
  )
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** Counts people read at a glance: "~2M", not "~1,972,540". */
const fmtCount = (n: number) => n >= 100_000
  ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  : n.toLocaleString()
const fmtDay = (at: string) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** A column name is not a label. Only used where nothing ratified was cited. */
const humanise = (s: string) =>
  s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

/** A rate or a mean, in the metric's own unit.
 *
 *  A binary outcome has no unit to cite but its mean is still a proportion —
 *  rendering it as 0.101 beside a detail card reading 10.1% is the same number
 *  twice in two languages. */
function fmtValue(x: number, unit?: string | null, binary?: boolean): string {
  if (unit === 'pct' || (!unit && binary)) return `${(x * 100).toFixed(1)}%`
  if (unit === 'currency') return `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (unit === 'ms') return `${Math.round(x).toLocaleString()}ms`
  // Fixed decimals by magnitude, so a column of arms shares a precision.
  // maximumFractionDigits alone rendered 27.383 beside 33.2074, which reads as
  // more precision on one arm than the other.
  const abs = Math.abs(x)
  const dp = abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4
  return x.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

/** Relative lift — the scale `lift` and `mde` are both on. */
const fmtRel = (x: number) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`

/** The absolute change, in the unit people actually argue about. Percentage
 *  POINTS for a rate: confusing +33% relative with +33pp is the classic error,
 *  so both are shown and each is named. */
/** Whether it moved enough to say which way: "▼ -0.0%" pointed down at a
 *  change that rounds to nothing. */
function moved(c: WireComparison | undefined, from: number, to: number): boolean {
  if (c && c.lift !== null) return Math.abs(c.lift) >= 0.0005
  return from !== to
}

function fmtAbs(from: number, to: number, unit?: string | null, binary?: boolean): string {
  const d = to - from
  // A 0/1 outcome is a rate whether or not a unit was declared for it; without
  // this a conversion difference printed as "+0.286".
  if (unit === 'pct' || (!unit && binary)) return `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`
  return `${d > 0 ? '+' : ''}${fmtValue(d, unit)}`
}

/** The engine's reasons, in words for the reader. The engine's own wording
 *  stays in the API, where an agent reads it; "baseline mean is zero, so
 *  relative lift is undefined" is accurate and says nothing to a person. */
function plainReason(why: string | null | undefined, r?: WireResult, c?: WireComparison): string | null {
  if (!why) return null
  if (why.startsWith('baseline mean is zero')) {
    const none = r?.binary ? 'no conversions' : `no ${humanise(r?.outcome ?? 'value').toLowerCase()}`
    return `The control group had ${none}${c ? ` (${c.baseline_n.toLocaleString()} units)` : ''}, so there is no base `
      + 'to measure a percentage change against'
      + (c ? ` — the difference is ${fmtAbs(c.baseline_mean, c.mean, r?.unit, r?.binary)} absolute.` : '.')
  }
  if (why.startsWith('an arm has fewer than two units')) return 'An arm has fewer than two units, so there is nothing to compare yet.'
  if (why.startsWith('no variance in either arm')) return 'Every unit in both arms had the same value, so there is no variation to compare.'
  return why
}

/** Two arms on one scale, bars from a zero baseline.
 *  Identity rides the row label and the direct value, so colour is
 *  supplementary rather than the only channel. */
function RateBars({ arms, unit, control }: {
  arms: { name: string; n: number; mean: number }[]
  unit?: string | null
  control?: string
}) {
  const max = Math.max(...arms.map(a => a.mean)) * 1.18 || 1
  return (
    <div className="rb">
      {arms.map(a => (
        <div className="rb-row" key={a.name}>
          <span className="rb-name">
            {a.name}{a.name === control && <span className="rb-base"> baseline</span>}
          </span>
          <span className="rb-track">
            <span
              className={`rb-fill ${a.name === control ? 'is-control' : 'is-variant'}`}
              style={{ width: `${clamp01(a.mean / max) * 100}%` }}
            />
          </span>
          <span className="rb-val">{fmtValue(a.mean, unit)}</span>
          <span className="rb-n">{a.n.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

/** The interval against zero — the one mark that answers "is this real?".
 *
 *  A reader should not have to compare two signed numbers in their head to work
 *  out whether the interval crosses zero. Here zero is a rule on the axis and
 *  the interval visibly touches it or does not.
 *
 *  Laid out in the DOM rather than SVG: this is one dimension, and a viewBox
 *  scaled non-uniformly to the container turns rounded ends into wedges and the
 *  point-estimate dot into an ellipse. */
function IntervalPlot({ lo, hi, point, mde, tone }: {
  lo: number; hi: number; point: number; mde?: number | null; tone: string
}) {
  // The domain always contains zero, so "does it cross" is answerable by eye.
  const marks = [lo, hi, point, 0, ...(mde ? [mde, -mde] : [])]
  const min = Math.min(...marks)
  const max = Math.max(...marks)
  const pad = (max - min) * 0.12 || 0.02
  const d0 = min - pad
  const d1 = max + pad
  const x = (v: number) => ((v - d0) / (d1 - d0)) * 100

  return (
    <div className="ip">
      <div className="ip-track">
        <span className="ip-zero" style={{ left: `${x(0)}%` }} />
        {/* Everything between -MDE and +MDE is an effect smaller than the one
            registered as worth detecting. A band says that; two loose ticks
            either side of zero just look like more axis. */}
        {mde ? (
          <span className="ip-dead" title={`smaller than the ${fmtRel(mde)} worth detecting`}
                style={{ left: `${x(-mde)}%`, width: `${x(mde) - x(-mde)}%` }} />
        ) : null}
        <span className={`ip-band tone-${tone}`}
              style={{ left: `${x(lo)}%`, width: `${Math.max(x(hi) - x(lo), 0.6)}%` }} />
        <span className={`ip-dot tone-${tone}`} style={{ left: `${x(point)}%` }} />
      </div>
      <div className="ip-axis">
        <span className="ip-end" style={{ left: `${x(lo)}%` }}>{fmtRel(lo)}</span>
        {/* Dropped when an end label is close enough to overlap it. The rule
            itself stays, so zero is still located — a clipped or overprinted
            label is worse than none. */}
        {Math.min(Math.abs(x(0) - x(lo)), Math.abs(x(0) - x(hi))) > 7 && (
          <span className="ip-zlab" style={{ left: `${x(0)}%` }}>0</span>
        )}
        <span className="ip-end" style={{ left: `${x(hi)}%` }}>{fmtRel(hi)}</span>
      </div>
    </div>
  )
}

/** One sentence saying what the interval means, so the reader is not left to
 *  assemble it from a pill and two signed numbers. */
function reading(c: WireComparison, better: string | undefined, mde: number | null | undefined,
                 r?: WireResult): string {
  if (c.invalidated_by === 'srm') {
    return 'The arms were not comparable, so this interval does not describe the change — it describes the change plus whatever caused the imbalance.'
  }
  if (c.undecidable) return plainReason(c.undecidable, r, c) ?? c.undecidable
  if (!c.lift_ci || c.lift === null) return 'Not enough data to compute an interval.'

  const [lo, hi] = c.lift_ci
  const good = better === 'down' ? 'a fall' : 'a rise'
  const bad = better === 'down' ? 'a rise' : 'a fall'

  if (lo <= 0 && 0 <= hi) {
    // Spanning zero says nothing on its own. A NARROW interval inside the
    // effect somebody registered as worth detecting is a real null; a wide one
    // is simply not enough data yet, and the two call for opposite decisions.
    if (mde && Math.abs(lo) < mde && Math.abs(hi) < mde) {
      return `The interval spans zero and sits entirely inside the ${fmtRel(mde)} registered as worth detecting — so this is a genuine null, not a shortage of data.`
    }
    return mde
      ? `The interval spans zero and is wider than the ${fmtRel(mde)} registered as worth detecting, so an effect that size is still consistent with this data. Underpowered rather than flat.`
      : 'The interval spans zero, so the data does not separate the arms.'
  }

  // The metric knows which way is good, so say improved or regressed rather
  // than leaving the reader to combine a sign with a direction.
  const improved = (c.lift > 0) === (better !== 'down')
  const clears = mde
    ? (Math.min(Math.abs(lo), Math.abs(hi)) >= mde
        ? ` The whole interval clears the ${fmtRel(mde)} registered as worth detecting.`
        : ` Part of it falls short of the ${fmtRel(mde)} registered as worth detecting.`)
    : ''
  return improved
    ? `The interval excludes zero and the metric improved — ${good} is what this one wants.${clears}`
    : `The interval excludes zero and the metric regressed — ${bad} is the wrong way for this one.${clears}`
}

function verdictTone(v: string, invalidated?: string) {
  if (invalidated) return 'dead'
  if (v === 'better') return 'good'
  if (v === 'worse') return 'bad'
  return 'flat'
}

/** What the whole readout adds up to.
 *
 *  An experiment with a target and three guardrails produces four verdicts, and
 *  the decision is not any one of them — it is their combination. A page that
 *  shows four cards and leaves the reader to combine them buries the case that
 *  matters most: the target improved AND something else broke, which reads as a
 *  win to anyone who stops at the first number. */
function summarise(r: WireReadout): { tone: string; headline: string; note?: string } {
  const target = r.results.find(x => x.role !== 'guardrail') ?? r.results[0]
  const guards = r.results.filter(x => x.role === 'guardrail')

  // EVERY comparison, not the first. A three-arm experiment produces two, and
  // reading `comparisons[0]` meant a headline could say "the target improved"
  // while the second variant had regressed — hidden in the one place on the
  // page whose whole job is to say "not a ship".
  const tcs = target?.comparisons ?? []
  const name = (c: WireComparison) => c.variation

  if (r.srm.ran && r.srm.passed === false) {
    return { tone: 'dead',
      headline: 'The assignment did not work, so none of these numbers can be read.',
      note: 'Diagnose the split before anything else — a lift measured across arms that were never comparable is measuring whatever made them differ.' }
  }
  if (!tcs.length || target?.error) {
    return { tone: 'flat', headline: 'The target metric could not be read.',
             note: target?.error ?? undefined }
  }

  const better = tcs.filter(c => c.verdict === 'better')
  const worse = tcs.filter(c => c.verdict === 'worse')
  const many = tcs.length > 1
  const list = (cs: WireComparison[]) => cs.map(name).join(' and ')

  // A guardrail is breached if ANY arm broke it, for the same reason.
  // "A, B and 2 more", not "A and B and C and D": four regressions joined by
  // "and" was a headline nobody could scan.
  const nameList = (ns: string[], max = 3) => ns.length <= max
    ? ns.length > 1 ? `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}` : ns.join('')
    : `${ns.slice(0, max).join(', ')} and ${ns.length - max} more`
  const breached = guards.filter(g => (g.comparisons ?? []).some(c => c.verdict === 'worse'))
  const unread = guards.filter(g => g.error || !g.comparisons?.length)

  // A guardrail whose direction was guessed cannot be said to have held. With
  // nothing cited the readout assumes higher is better, and support contacts,
  // refunds and latency are all metrics where a rise is the bad outcome — so
  // "held" on one of those is a coin toss reported as an all-clear.
  const guessed = guards.filter(g => g.direction_assumed)
  const plural = (n: number) => (n === 1 ? '' : 's')

  const targetPhrase =
    worse.length && better.length
      ? `${list(better)} improved the target and ${list(worse)} regressed it`
      : worse.length
        ? many ? `${list(worse)} regressed the target` : 'The target regressed'
        : better.length === tcs.length
          ? many ? `Both variants improved the target` : 'The target improved'
          : better.length
            ? `${list(better)} improved the target; ${list(tcs.filter(c => c.verdict !== 'better'))} did not`
            : null

  if (breached.length) {
    const names = nameList(breached.map(g => g.metric_label ?? humanise(g.outcome)))
    return {
      tone: 'bad',
      headline: better.length
        ? `${targetPhrase}, but ${names} regressed.`
        : `${names} regressed.`,
      note: better.length
        ? 'A guardrail is a thing that was agreed must not get worse. This is not a ship on the target alone.'
        : undefined,
    }
  }
  if (worse.length) {
    return { tone: 'bad', headline: `${targetPhrase}.` }
  }
  if (better.length === tcs.length) {
    const held = guards.length - guessed.length
    return {
      tone: guessed.length ? 'flat' : 'good',
      headline: guards.length
        ? guessed.length === guards.length
          ? `${targetPhrase}, but nothing checked what must not get worse.`
          : `${targetPhrase} — and ${held} guardrail${plural(held)} held.`
        : `${targetPhrase}.`,
      // Assembled rather than written as one wrapped template: a line break
      // inside a template literal IS part of the string, so the wrapped version
      // rendered a sentence with a newline and twelve spaces through the middle
      // of it.
      note: guessed.length
        ? [
            nameList(guessed.map(g => g.metric_label ?? humanise(g.outcome))),
            guessed.length === 1 ? 'cites' : 'cite',
            'no definition, so a rise in',
            guessed.length === 1 ? 'it' : 'them',
            'was read as an improvement. On a support or refund metric that is',
            'backwards — ratify a definition to make the direction something',
            'somebody stood behind.',
          ].join(' ')
        : unread.length ? `${unread.length} guardrail${plural(unread.length)} could not be read.` : undefined,
    }
  }
  if (better.length) {
    return { tone: 'good', headline: `${targetPhrase}.` }
  }
  if (tcs.every(c => c.verdict === 'no answer')) {
    const why = tcs.find(c => c.undecidable)
    return { tone: 'flat', headline: 'No answer on the target yet.',
             note: why ? plainReason(why.undecidable, target, why) ?? undefined : undefined }
  }
  return { tone: 'flat',
           headline: many ? 'No effect detected on the target, in either variant.'
                          : 'No effect detected on the target.' }
}

/** A verdict in a word or two, and a tone. Colour is kept for results that
 *  are actually significant: a table where every row is tinted has no signal. */
function verdictOf(c: WireComparison | undefined, r: WireResult): { label: string; tone: string } {
  if (r.error) return { label: 'Unreadable', tone: 'quiet' }
  if (!c) return { label: '—', tone: 'quiet' }
  if (c.invalidated_by === 'srm') return { label: 'Not comparable', tone: 'quiet' }
  if (c.verdict === 'better') return { label: 'Better', tone: 'good' }
  if (c.verdict === 'worse') return { label: 'Worse', tone: 'bad' }
  if (c.verdict === 'no difference detected') return { label: 'No difference', tone: 'flat' }
  return { label: 'No answer', tone: 'quiet' }
}

/** The interval as a shape: zero in the middle of every row, so the eye runs
 *  down one line and sees which side each result sits on and how wide it is.
 *  The numbers are in the tooltip — "−67.5% to +87.9%" as text had to be read
 *  and worked out. The shaded band is the effect registered as worth detecting. */
function IntervalMini({ lo, hi, point, mde, tone }: {
  lo: number; hi: number; point: number; mde?: number | null; tone: string
}) {
  const W = 160, H = 18
  const m = Math.max(Math.abs(lo), Math.abs(hi), mde ?? 0, 1e-9) * 1.12
  const x = (v: number) => W / 2 + (v / m) * (W / 2 - 4)
  const label = `${fmtRel(point)}, interval ${fmtRel(lo)} to ${fmtRel(hi)}`
  return <svg className={`sc-ci tone-${tone}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
    <title>{label}{mde ? ` · worth detecting: ±${(mde * 100).toFixed(1)}%` : ''}</title>
    <line x1={4} x2={W - 4} y1={H / 2} y2={H / 2} className="sc-ci-track" />
    {mde ? <rect x={x(-mde)} y={3} width={x(mde) - x(-mde)} height={H - 6} className="sc-ci-band" /> : null}
    <line x1={W / 2} x2={W / 2} y1={1} y2={H - 1} className="sc-ci-zero" />
    <line x1={x(lo)} x2={x(hi)} y1={H / 2} y2={H / 2} className="sc-ci-bar" />
    <circle cx={x(point)} cy={H / 2} r={3.5} className="sc-ci-pt" />
  </svg>
}

/** Every metric on one line: control, variant, the change, its interval and a
 *  verdict — the scorecard an experiment is read from.
 *
 *  It was a table with the metric column at 99%, the arms pushed to the far
 *  edge, four stacked lines in each cell and the interval as text. Now there is
 *  one line per metric (and per variant, when there are several), the values
 *  sit together where they are compared, and the interval is a shape. Counts
 *  are in the tooltips: they are the same on every row, and the strip above
 *  says them once. With a registered cohort the table re-reads per segment —
 *  overall first, always, because a cohort is a follow-up and never the
 *  headline. */
function ResultsTable({ results, mde, onOpen }: {
  results: WireResult[]; mde?: number | null; onOpen: (outcome: string) => void
}) {
  const cohorts = results[0]?.cohorts?.map(c => c.cohort) ?? []
  const [seg, setSeg] = useState('')

  const control = results.find(r => r.control)?.control ?? ''
  const variants = (results[0]?.arms ?? []).map(a => a.name).filter(n => n !== control)
  const multi = variants.length > 1
  const cols = multi ? 8 : 7

  const view = (r: WireResult) => {
    if (!seg) return { arms: r.arms ?? [], comparisons: r.comparisons ?? [] }
    const c = r.cohorts?.find(x => x.cohort === seg)
    return { arms: c?.arms ?? [], comparisons: c?.comparisons ?? [] }
  }

  // Grouped by the table each number came from — said only when there is more
  // than one; with one, a header naming it labelled nothing.
  const groups: { source: string; rows: WireResult[] }[] = []
  for (const r of results) {
    const key = r.source ?? ''
    const g = groups.find(x => x.source === key)
    if (g) g.rows.push(r); else groups.push({ source: key, rows: [r] })
  }

  return (
    <div className="sc">
      {cohorts.length > 0 && (
        <div className="ms-segs">
          <span className="ms-seglabel">breakdown</span>
          <button className={`chip${seg === '' ? ' on' : ''}`} onClick={() => setSeg('')}>overall</button>
          {cohorts.map(c => (
            <button key={c} className={`chip${seg === c ? ' on' : ''}`} onClick={() => setSeg(c)}>{c}</button>
          ))}
        </div>
      )}
      <div className="sc-scroll">
        <table className="sc-tbl">
          <thead>
            <tr>
              <th className="sc-metric">Metric</th>
              <th className="r">{control || 'Control'}</th>
              {multi && <th>Variant</th>}
              <th className="r">{multi ? 'Value' : variants[0] ?? 'Variant'}</th>
              <th className="r">Change</th>
              <th className="sc-plot">Interval</th>
              <th className="r">Absolute</th>
              <th>Verdict</th>
            </tr>
          </thead>
          {groups.map(g => (
            <tbody key={g.source || '_'}>
              {groups.length > 1 && <tr className="sc-grp"><td colSpan={cols}>
                from <span className="mono">{g.source || 'the assignment table'}</span></td></tr>}
              {g.rows.flatMap(r => {
                const v = view(r)
                const byName = Object.fromEntries(v.arms.map(a => [a.name, a]))
                const base = byName[control]
                const arms = variants.length ? variants : ['']
                const name = (
                  <td rowSpan={r.error ? 1 : arms.length} className="sc-metric">
                    <a className="sc-name" href={`#m-${r.outcome}`} onClick={() => onOpen(r.outcome)}>
                      {r.metric_label ?? humanise(r.outcome)}</a>
                    <span className="sc-sub">
                      {r.role === 'guardrail' ? 'Guardrail' : r.role === 'target' || !r.role ? 'Target' : humanise(r.role)}
                      {r.direction_assumed
                        ? <> · <span className="warn" title="No definition says which way is good, so a rise is read as better">direction assumed</span></>
                        : r.better === 'down' ? ' · lower is better' : null}
                    </span>
                  </td>
                )
                if (r.error) {
                  return [<tr key={r.outcome}>{name}<td colSpan={cols - 1} className="sc-err">Could not be read — {r.error}</td></tr>]
                }
                return arms.map((arm, i) => {
                  const a = byName[arm]
                  const c = v.comparisons.find(x => x.variation === arm)
                  const verdict = verdictOf(c, r)
                  const absolute = !!c && c.lift === null && !!a && !!base
                  return (
                    <tr key={`${r.outcome}:${arm}`} className={i ? 'sc-more' : undefined}>
                      {i === 0 && name}
                      {i === 0 && <td rowSpan={arms.length} className="r tnum sc-val"
                        title={base ? `${base.n.toLocaleString()} counted` : undefined}>
                        {base ? fmtValue(base.mean, r.unit, r.binary) : '—'}</td>}
                      {multi && <td className="sc-arm">{arm}</td>}
                      <td className="r tnum sc-val" title={a ? `${a.n.toLocaleString()} counted` : undefined}>
                        {a ? fmtValue(a.mean, r.unit, r.binary) : '—'}</td>
                      <td className={`r tnum sc-change tone-${verdict.tone}`}
                        title={absolute ? 'absolute difference' : undefined}>
                        {/* Up or down against control, said with an arrow, and by
                            how much in the metric's own units underneath: "+12.1%"
                            alone did not say whether a rate moved 1pt or 10. */}
                        {a && base && moved(c, base.mean, a.mean) && <span className="sc-arrow" aria-hidden="true">
                          {a.mean > base.mean ? '▲' : '▼'}</span>}
                        <span className="sc-rel">{!c ? '—' : c.lift !== null ? fmtRel(c.lift)
                          // No relative change exists against a zero baseline;
                          // the absolute one does, and it was not shown at all.
                          : a && base ? fmtAbs(base.mean, a.mean, r.unit, r.binary) : '—'}</span></td>
                      <td className="sc-plot">
                        {c?.lift_ci && c.lift !== null && !c.invalidated_by
                          ? <IntervalMini lo={c.lift_ci[0]} hi={c.lift_ci[1]} point={c.lift} mde={mde} tone={verdict.tone} />
                          : <span className="sc-none" title={plainReason(c?.undecidable, r, c) ?? undefined}>—</span>}
                      </td>
                      {/* By how much in the metric's own units, beside the
                          relative change: "+12.1%" alone did not say whether a
                          rate moved 1pt or 10. */}
                      <td className="r tnum sc-abs">{c && a && base && moved(c, base.mean, a.mean)
                        ? fmtAbs(base.mean, a.mean, r.unit, r.binary) : '—'}</td>
                      <td><span className={`sc-verdict tone-${verdict.tone}`}>{verdict.label}</span></td>
                    </tr>
                  )
                })
              })}
            </tbody>
          ))}
        </table>
      </div>
      {seg && (
        <div className="ms-foot">
          One segment of the cut registered up front. Each holds a fraction of the sample, so an
          effect that is real overall can read as no difference here — that is power, not absence.
        </div>
      )}
    </div>
  )
}

/** One outcome, one column per arm.
 *
 *  Arms are columns because they are being compared: a reader holds one metric
 *  in mind and looks across. The previous layout stacked them as horizontal
 *  bars and then read `comparisons[0]`, which meant a third arm was drawn in
 *  the bar chart and silently missing from every number under it. */
function Outcome({ r, mde, dataset }: {
  r: WireResult; mde?: number | null; dataset?: string
}) {
  if (r.error) return <div className="ro-note warn">{r.error}</div>
  const arms = r.arms ?? []
  if (!arms.length || !r.comparisons?.length) return null
  const control = r.control ?? ''
  const byName = Object.fromEntries((r.comparisons ?? []).map(c => [c.variation, c]))
  const worst = (r.comparisons ?? [])
    .map(c => verdictTone(c.verdict, c.invalidated_by))
    .reduce((acc, t) => (acc === 'bad' || t === 'bad' ? 'bad' : t === 'good' ? (acc === 'flat' ? 'good' : acc) : acc), 'flat' as string)

  return (
    <div className={`oc tone-${worst}`} id={`m-${r.outcome}`}>
      <div className="oc-head">
        <span className="oc-metric">{r.metric_label ?? humanise(r.outcome)}</span>
        {r.metric_status === 'ratified'
          ? <Pill tone="green">ratified v{r.metric_version}</Pill>
          : r.cites
            ? <Pill tone="warn">{r.metric_status} v{r.metric_version}</Pill>
            : <Pill tone="warn">no definition cited</Pill>}
        {r.role === 'guardrail' && <Pill tone="gray">guardrail</Pill>}
        {r.source && <span className="oc-src">from <span className="mono">{r.source}</span></span>}
      </div>
      <div className="oc-def">
        {r.metric_expr ? <code>{r.metric_expr}</code> : <code>{r.outcome}</code>}
        {dataset && <span> · <span className="mono">{dataset}</span></span>}
        {!r.direction_assumed &&
          <span> · {r.better === 'down' ? 'lower' : 'higher'} is better</span>}
      </div>

      {/* Still said, because it decides whether every verdict here is the right
          way up — but as one line, not a banner over every card. */}
      {r.direction_assumed && (
        <div className="oc-assumed-line">
          <b>Direction assumed:</b> a rise reads as better. If a rise in{' '}
          <span className="mono">{r.outcome}</span> is bad, these verdicts are inverted — ratify a definition to fix it.
        </div>
      )}

      {/* One row per arm, control first: up or down against it at a glance. Two
          side-by-side panels spent half the card on a control box that said
          "everything else is measured against this" and little else. */}
      <div className="oc-rows">
        {arms.map(a => {
          const c = byName[a.name]
          const isBase = a.name === control
          const tone = c ? verdictTone(c.verdict, c.invalidated_by) : 'flat'
          const base = arms.find(x => x.name === control)
          return (
            <div className={`oc-row${isBase ? ' is-base' : ''}`} key={a.name}>
              <span className="oc-arm">{a.name}{isBase && <span className="oc-armsub"> baseline</span>}</span>
              <span className="oc-val tnum">{fmtValue(a.mean, r.unit, r.binary)}</span>
              <span className="oc-n tnum">n {a.n.toLocaleString()}</span>
              {isBase ? <span className="oc-ref">what each arm is compared with</span>
                : c ? <>
                  <span className={`oc-change tone-${tone}`}>
                    {base && moved(c, base.mean, a.mean) && <span className="sc-arrow" aria-hidden="true">{a.mean > base.mean ? '▲' : '▼'}</span>}
                    <b className="tnum">{c.lift === null ? '—' : fmtRel(c.lift)}</b>
                    <span className="oc-abs2">{fmtAbs(c.baseline_mean, c.mean, r.unit, r.binary)}</span>
                  </span>
                  <span className="oc-verdict">
                    <Pill tone={tone === 'good' ? 'green' : tone === 'bad' ? 'red' : 'gray'}>{c.verdict}</Pill>
                  </span>
                  <span className="oc-plot">
                    {c.lift_ci && c.lift !== null && (
                      <IntervalPlot lo={c.lift_ci[0]} hi={c.lift_ci[1]} point={c.lift} mde={mde} tone={tone} />
                    )}
                  </span>
                  <div className="oc-read">{reading(c, r.better, mde, r)}</div>
                </>
                : <span className="oc-ref">no comparison returned for this arm</span>}
            </div>
          )
        })}
      </div>

        {/* Once per outcome rather than once per arm — the same test ran for
            every column — and folded, because the interval above is what the
            verdict comes from and a p-value at equal weight invites reading
            that instead. */}
        {r.comparisons?.[0] && (
          <details className="oc-how">
            <summary>How this was tested</summary>
            <div className="oc-how-body">
              <div>{testName(r.comparisons[0].test)}</div>
              <div className="oc-ps">
                {r.comparisons.map(c => c.p_value === null ? null : (
                  <span key={c.variation}>
                    {c.variation} p&nbsp;{c.p_value < 1e-4
                      ? c.p_value.toExponential(1) : c.p_value.toFixed(4)}
                  </span>
                ))}
              </div>
              <div className="oc-how-note">
                The interval is what the verdict comes from, not the p-value —
                under a confidence sequence the p-value is still fixed-horizon
                and would call winners the interval does not.
              </div>
            </div>
          </details>
        )}
    </div>
  )
}

/** The test, in words. `sequential-welch-t` is precise and unreadable. */
function testName(t: string): string {
  const anytime = t.startsWith('sequential')
    ? ', with an interval valid at every sample size' : ''
  if (t.includes('two-proportion')) return `Comparing two rates${anytime}.`
  if (t.includes('welch')) return `Comparing two averages that may vary differently${anytime}.`
  return t
}

/** Observed split per arm, against the split that was registered.
 *  Every number is measured: `observed` counts what landed in each arm and
 *  `expected` is what the contract said should. Their ratio is the whole SRM
 *  story, so it is on the row rather than in a footnote. */
function ArmsPanel({ srm, baseline }: { srm: WireSrm; baseline: string }) {
  if (!srm.ran) {
    return <div className="ro-note warn">Assignment could not be checked: {srm.error}</div>
  }
  const arms = srm.arms ?? []
  const total = srm.total ?? arms.reduce((n, a) => n + a.observed, 0)
  const broken = srm.passed === false
  // Passed, but only because the check fails at 0.001: at p below 0.05 the
  // split is uneven enough to watch. 4 users against 14 read "split as
  // designed", which it visibly was not.
  const watch = !broken && !srm.note && (srm.p_value ?? 1) < 0.05
  const few = total < 200
  const max = Math.max(1, ...arms.map(a => a.observed))
  const pct = (n: number) => (total ? (n / total) * 100 : 0)

  return (
    <div className={`arms${broken ? ' arms-broken' : ''}`}>
      <div className="arms-head">
        <span className="arms-t">Arms</span>
        <span className="arms-status">
          {broken
            ? <b className="arms-bad">split does not match the design</b>
            : srm.note
              ? <span className="arms-warn">not yet checkable — {srm.note}</span>
              : <><b>{total.toLocaleString()}</b> {srm.counted} · {watch
                  ? <span className="arms-warn">split looks uneven — not failed</span>
                  : 'split held'}
                  {srm.assumed_even_split ? ' (even split assumed)' : ''}</>}
        </span>
      </div>

      {broken && (
        <p className="arms-alarm">
          Something other than the randomiser decided who landed in each arm, so every lift
          below is confounded with whatever that was. Furthest from its design: <b>{srm.worst}</b>.
        </p>
      )}

      <div className="arms-rows">
        {arms.map(a => (
          <div className="arm" key={a.name}>
            <div className="arm-n">
              {a.name}
              {a.name === baseline && <span className="arm-base">baseline</span>}
            </div>
            <div className="arm-bar"><i style={{ width: `${(a.observed / max) * 100}%` }} /></div>
            <div className="arm-obs tnum">{a.observed.toLocaleString()}</div>
            <div className="arm-share tnum">{pct(a.observed).toFixed(1)}%</div>
            <div className="arm-design tnum">
              {srm.assumed_even_split ? <span className="arms-warn">assumed {pct(a.expected).toFixed(0)}%</span>
                                      : <>designed {pct(a.expected).toFixed(0)}%</>}
            </div>
            {/* Coloured only when the check failed. A split that passed is
                allowed to wobble, and ×1.032 in red read as an alarm about a
                test that had just been cleared. */}
            <div className={`arm-ratio tnum${broken && a.ratio > 1.001 ? ' over' : broken && a.ratio < 0.999 ? ' under' : ''}${watch ? ' watch' : ''}`}>
              ×{a.ratio.toFixed(3)}
            </div>
          </div>
        ))}
      </div>

      {srm.p_value !== undefined && (
        <div className="arms-foot" title="A chi-square test of each arm's count against the registered split">
          {broken ? 'Split check failed' : watch ? 'Uneven enough to watch, not enough to fail' : 'Split check passed'}
          {' '}— p {srm.p_value < 0.001 ? srm.p_value.toExponential(2) : srm.p_value.toFixed(3)}; it fails below {srm.threshold}.
          {!broken && few && ` With only ${total.toLocaleString()} ${srm.counted}, it could not catch much.`}
          {srm.assumed_even_split ? ' No designed split was registered, so an even one was assumed.' : ''}
        </div>
      )}
      {srm.warning && <div className="ro-note warn">{srm.warning}</div>}
    </div>
  )
}

/** What a readout counted: "users" when the contract randomised on people. */
function unitNoun(unit?: string | null): string {
  const u = (unit ?? '').toLowerCase()
  if (/user|customer|member|visitor|person|people|buyer|shopper/.test(u)) return 'users'
  if (/account|org|company|tenant|workspace/.test(u)) return 'accounts'
  if (/session/.test(u)) return 'sessions'
  if (/device/.test(u)) return 'devices'
  return 'units'
}

/** The split in a word. "Held" is said only when there were enough units for
 *  the check to have caught anything: 3 against 9 "held" at p 0.083, which was
 *  a statement about twelve people, not about the randomiser. */
function splitState(srm: WireSrm): { label: string; tone: string; sub: string } {
  const arms = srm.arms ?? []
  const total = srm.total ?? arms.reduce((n, a) => n + a.observed, 0)
  const p = srm.p_value
  const pTxt = p === undefined ? '' : `p ${p < 0.001 ? p.toExponential(1) : p.toFixed(3)}`
  if (!srm.ran) return { label: 'not checked', tone: 'warn', sub: srm.error ?? '' }
  if (srm.passed === false) return { label: 'failed', tone: 'bad', sub: `${pTxt}, below ${srm.threshold}` }
  if (srm.note || total < 100) return { label: 'too few to judge', tone: 'warn', sub: `only ${total.toLocaleString()} counted` }
  if ((p ?? 1) < 0.05) return { label: 'uneven — watching', tone: 'warn', sub: `${pTxt}; fails below ${srm.threshold}` }
  return { label: 'held', tone: '', sub: arms.map(a => `${((a.observed / total) * 100).toFixed(1)}%`).join(' / ') }
}

function StripItem({ k, v, sub, tone = '' }: { k: string; v: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return <div className={`rs-item${tone ? ` ${tone}` : ''}`}>
    <div className="rs-k">{k}</div>
    <div className="rs-v">{v}</div>
    {sub && <div className="rs-sub">{sub}</div>}
  </div>
}

/** Four numbers before anything else: what the target did, whether anything
 *  agreed not to get worse did, how many were counted, and what the AI
 *  recommends. Neutral unless something is wrong — colour on everything is
 *  colour on nothing. The same rules as the verdict below: a guardrail whose
 *  direction was guessed is never "held", and a split is "held" only when
 *  there were enough units for the check to have caught anything. */
function KeyNumbers({ r, plan, noun, ai }: {
  r: WireReadout; plan?: WirePlan | null; noun: string; ai: ReturnType<typeof useExperimentAI>
}) {
  const target = r.results.find(x => x.role !== 'guardrail') ?? r.results[0]
  const guards = r.results.filter(x => x.role === 'guardrail')
  const arms = r.srm.ran && r.srm.arms?.length
    ? r.srm.arms.map(a => ({ name: a.name, n: a.observed }))
    : (target?.arms ?? []).map(a => ({ name: a.name, n: a.n }))
  const total = arms.reduce((n, a) => n + a.n, 0)
  // Short of the plan matters while the answer is still open. The plan is
  // sized for the smallest effect worth acting on; a far larger one can be
  // conclusive long before, and warning then would contradict the verdict.
  const conclusive = (target?.comparisons ?? []).some(c => c.verdict === 'better' || c.verdict === 'worse')
  const need = plan && typeof plan.total === 'number' && !conclusive ? plan.total : null
  const split = splitState(r.srm)
  // One bucket per guardrail, in this order. Counted as overlapping sets, a
  // guessed-direction guardrail with no answer was subtracted twice from
  // "held" — which could then read "-1 held".
  const bucket = (g: WireResult) =>
    g.error || !g.comparisons?.length || g.comparisons.every(c => c.verdict === 'no answer') ? 'unread'
    : g.comparisons.some(c => c.verdict === 'worse') ? 'worse'
    : g.direction_assumed ? 'guessed' : 'held'
  const count = (b: string) => guards.filter(g => bucket(g) === b).length
  const worse = count('worse'), unread = count('unread'), guessed = count('guessed'), held = count('held')
  const breached = guards.filter(g => bucket(g) === 'worse')

  const c = target?.comparisons?.[0]
  const base = target?.arms?.find(a => a.name === c?.baseline)
  const arm = target?.arms?.find(a => a.name === c?.variation)
  const word = !c ? 'no answer yet' : c.invalidated_by ? 'not comparable'
    : c.verdict === 'better' ? 'better' : c.verdict === 'worse' ? 'worse'
    : c.verdict === 'no difference detected' ? 'not certain yet' : 'no answer yet'
  const rec = ai.summary ? RECOMMEND[ai.summary.recommendation] : null

  return <div className="rs">
    <StripItem k={target ? target.metric_label ?? humanise(target.outcome) : 'Target'}
      tone={c?.verdict === 'better' ? 'good' : c?.verdict === 'worse' ? 'bad' : ''}
      v={c && c.lift !== null ? fmtRel(c.lift) : '—'}
      sub={<>{base && arm ? `${fmtValue(base.mean, target!.unit, target!.binary)} → ${fmtValue(arm.mean, target!.unit, target!.binary)} · ` : ''}{word}
        {(target?.comparisons?.length ?? 0) > 1 && ` · ${c!.variation}, +${target!.comparisons!.length - 1} more`}</>} />
    <StripItem k="Guardrails" tone={worse ? 'bad' : !guards.length || unread || guessed ? 'warn' : ''}
      v={!guards.length ? 'None registered' : worse ? `${worse} of ${guards.length} worse`
        : held === guards.length ? 'All held' : `${held} of ${guards.length} held`}
      sub={!guards.length ? 'nothing agreed as unable to get worse'
        // Two named, the rest counted: four regressions in a stat's subtitle
        // wrapped to three lines and pushed the row apart.
        : worse ? breached.slice(0, 2).map(g => {
            const w = g.comparisons?.find(x => x.verdict === 'worse')
            return `${g.metric_label ?? humanise(g.outcome)}${w?.lift != null ? ` ${fmtRel(w.lift)}` : ''}`
          }).join(' · ') + (breached.length > 2 ? ` · +${breached.length - 2} more` : '')
        : [guessed && `${guessed} direction assumed`, unread && `${unread} no answer`].filter(Boolean).join(' · ') || 'none got worse'} />
    <StripItem k={noun[0].toUpperCase() + noun.slice(1)} tone={split.tone || (need && total < need * 0.1 ? 'warn' : '')}
      // Two arms read as a total and an even share; a third was cut off with
      // an ellipsis, and the arm it hid was the control. Past two, the total,
      // each arm on hover.
      v={arms.length > 2
        ? <span title={arms.map(a => `${a.name} ${a.n.toLocaleString()}`).join(' · ')}>
            {total.toLocaleString()} <small>across {arms.length} arms</small></span>
        : total.toLocaleString()}
      sub={<>{need ? <span>of ~{fmtCount(need)} needed</span>
          : arms.length === 2 ? <span>{arms.map(a => a.n.toLocaleString()).join(' / ')}</span> : null}
        {' · '}<span title={split.sub}>split {split.label}</span></>} />
    <StripItem k="Recommendation" tone={rec ? 'ai' : ''}
      v={rec ? rec.label : ai.explaining ? '…' : '—'}
      sub={rec ? 'AI, checked against the numbers' : ai.explaining ? 'AI is reading the results' : ai.error ? 'AI could not summarise' : 'not asked yet'} />
  </div>
}

function LiveReadout({ id, refresh = 0, plan, unit, onRead, onBusy }: {
  id: string; refresh?: number; plan?: WirePlan | null; unit?: string | null; onRead?: (r: WireReadout) => void
  /** Whether it is reading, for the page's Refresh in the header. */
  onBusy?: (busy: boolean) => void
}) {
  const [r, setR] = useState<WireReadout | null | undefined>(undefined)
  const [err, setErr] = useState<GatewayError | null>(null)
  const [range, setRange] = useState('30d')
  const [busy, setBusy] = useState(false)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [detail, setDetail] = useState(false)
  const ai = useExperimentAI(id, readAt)

  // Only a different experiment blanks the page. A refetch of the SAME one
  // keeps what is on screen and dims it, because throwing the numbers away and
  // showing a spinner in their place makes the page jump and loses the reader's
  // position on a long readout — for data that is usually about to come back
  // identical.
  useEffect(() => { setR(undefined); setReadAt(null) }, [id])
  useEffect(() => { onBusy?.(busy) }, [busy])

  useEffect(() => {
    let alive = true
    setBusy(true)
    setErr(null)
    readout(id, { range })
      .then(x => { if (alive) { setR(x); setReadAt(Date.now()); onRead?.(x) } })
      .catch(e => { if (alive) { setErr(e as GatewayError); setR(null) } })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
    // onRead is a notification, not an input to what is read.
  }, [id, range, refresh])

  if (err) {
    return (
      <div className="ro">
        <div className="ro-alarm">
          <div className="ro-alarm-t">This experiment cannot be read out</div>
          <div className="ro-alarm-b">{err.message}</div>
        </div>
      </div>
    )
  }
  if (r === undefined) return <div className="ro"><div className="ro-loading">Running the readout against the warehouse…</div></div>
  if (r === null) return null

  const target = r.results.find(x => x.role !== 'guardrail') ?? r.results[0]
  const guards = r.results.filter(x => x.role === 'guardrail')
  const srm = r.srm
  const broken = srm.ran && srm.passed === false
  // The registration panel already tags these two gaps; said again here they
  // were two more full-width sentences between the plan and the answer.
  const notes = (r.contract_notes ?? []).filter(n =>
    !/^No minimum detectable effect was registered|^No designed split registered/.test(n))
  const noun = unitNoun(unit)
  const counted = (target?.arms ?? []).reduce((n, a) => n + a.n, 0)
  const conclusive = (target?.comparisons ?? []).some(c => c.verdict === 'better' || c.verdict === 'worse')
  const mde = r.experiment?.mde
  const need = plan && typeof plan.total === 'number' ? plan.total : null

  // Thin enough that nothing below can mean anything yet — said as the
  // headline, rather than left for "no answer" and a zero-baseline
  // explanation to imply.
  let v = summarise(r)
  if (need && !conclusive && counted < need * 0.05 && v.tone !== 'dead' && v.tone !== 'bad') {
    v = { tone: 'flat', headline: 'Too little data to read yet.',
          note: `${counted.toLocaleString()} ${noun} so far, where the registered ${mde ? `${(mde * 100).toFixed(0)}% ` : ''}`
            + `effect needs about ${fmtCount(need)}.` }
  }
  // The count that matters is comparisons, not metrics: two variants on two
  // metrics is four tests. Nothing adjusts for that, so the page says what it
  // costs — a ceiling, since the tests share a control and are not independent.
  const tests = r.results.reduce((n, x) => n + (x.comparisons?.length ?? 0), 0)
  const fwer = Math.round((1 - Math.pow(1 - r.alpha, tests)) * 100)

  const control = r.results.find(x => x.control)?.control ?? target?.comparisons?.[0]?.baseline ?? 'control'
  const variants = (target?.comparisons ?? []).map(c => c.variation)
  return (
    <div className={`ro${busy ? ' is-reading' : ''}`}>
      {/* Four numbers first, then what the AI makes of them, then the evidence. */}
      <KeyNumbers r={r} plan={plan} noun={noun} ai={ai} />
      {r.experiment && <ExperimentAICard ai={ai} />}

      {/* First, when these are not the experiment's own days: every number
          below is whatever else ran in that window. */}
      {r.experiment && r.window?.basis === 'range' && (
        <div className="ro-banner" role="note">
          <span><b>Reading the last {range.replace('d', ' days')}, not this experiment’s own</b> — {counted.toLocaleString()} {noun} from
            whatever ran in that window.</span>
          <a href="#lifecycle">Record when it ran</a>
        </div>
      )}
      {/* Up front: a pinned metric version that is no longer the ratified one
          changes what every number below means. */}
      {notes.length > 0 && (
        // Folded to one line: three full-width sentences sat between the
        // registration and the answer, two of them repeating its gap tags.
        // A pinned definition that has moved on stays open — it changes what
        // every number below means.
        <details className="ro-notes" open={notes.some(n => /pinned at v/.test(n))}>
          <summary>
            <span className="ro-sub">{notes.length} {notes.length === 1 ? 'note' : 'notes'} on this reading</span>
            <span className="hint ro-notes-first">{notes[0]}</span>
          </summary>
          {notes.map((n, i) => <div key={i} className="ro-note">{n}</div>)}
        </details>
      )}
      {/* The arms in full only when the split failed — then it is the finding,
          and everything below is confounded. Otherwise the strip says it in a
          word, which is all a split that worked needs. */}
      {broken && <ArmsPanel srm={srm} baseline={r.results.find(x => x.control)?.control ?? ''} />}
      {srm.warning && !broken && <div className="ro-note warn">{srm.warning}</div>}

      <div className="ro-head">
        <h2 className="ro-title">Results</h2>
        <span className="ro-ctx">
          {variants.length > 1 ? `${variants.length} variants` : variants[0] ?? 'variant'} vs {control}
          {' · '}{Math.round((1 - r.alpha) * 100)}% intervals
          {/* A started experiment reads its own days; offering 7d/30d/90d
              there would be offering to read somebody else's traffic. */}
          {r.window?.basis === 'experiment' && <> · {fmtDay(r.window.start)} → {r.window.end && Date.parse(r.window.end) < Date.now() - 3_600_000
            ? fmtDay(r.window.end) : 'now'}</>}
        </span>
        <span className="ro-spacer" />
        {r.window?.basis !== 'experiment' && ['7d', '30d', '90d'].map(x => (
          <button key={x} className={`chip${range === x ? ' on' : ''}`} onClick={() => setRange(x)}>{x}</button>
        ))}
        {/* Nothing here is stored: every figure was computed when the page
            loaded and the warehouse has moved on since. */}
        <Freshness at={readAt} busy={busy} />
      </div>

      {/* The verdict in words, then the scorecard it was read from. */}
      <div className={`sum tone-${v.tone}`}>
        <div className="sum-line">{v.headline}</div>
        {v.note && <div className="sum-note">{v.note}</div>}
        <ResultsTable results={r.results} mde={mde} onOpen={() => setDetail(true)} />
        {tests >= 3 && (
          <div className="sum-mc">
            {tests} comparisons here, not adjusted for each other — at α&nbsp;{r.alpha}, up to a {fwer}% chance
            that one reads significant by luck alone.
          </div>
        )}
      </div>

      {/* Each metric's own card — definition, arms, interval, how it was
          tested — folded, because the table above carries what a reader
          scans for, and three full cards under it repeated the same numbers. */}
      <details className="ro-detail" open={detail} onToggle={e => setDetail(e.currentTarget.open)}>
        <summary>Each metric in detail <span className="hint">definitions, intervals, and how each was tested</span></summary>
        {target && <Outcome r={target} mde={mde} dataset={r.dataset_id} />}
        {guards.length > 0 && (
          <div className="ro-guards">
            <div className="ro-sub">Guardrails — agreed not to get worse</div>
            {guards.map(g => <Outcome key={g.outcome} r={g} mde={mde} dataset={r.dataset_id} />)}
          </div>
        )}
      </details>

      <details className="ro-caveats">
        <summary>What this interval does and does not account for ({r.caveats.length})</summary>
        {r.caveats.map((c, i) => <div key={i} className="ro-note">{c}</div>)}
      </details>
    </div>
  )
}

export function ExperimentDetail() {
  const { id } = useParams()
  const [exp, setExp] = useState<Experiment | null | undefined>(undefined)
  // The full record of a warehouse experiment — contract, dates, amendments —
  // fetched once here and handed to every panel that needs it.
  const [record, setRecord] = useState<LiveExperiment | null>(null)
  const [series, setSeries] = useState<MetricSeries | null>(null)
  const [changed, setChanged] = useState(0)
  const [units, setUnits] = useState<number | null>(null)
  // What the readout measured the target as, for a contract that left it unsaid.
  const [rate, setRate] = useState<boolean | undefined>(undefined)
  // The header's Refresh and Decide act on panels further down the page.
  const [reload, setReload] = useState(0)
  const [reading, setReading] = useState(false)
  const [deciding, setDeciding] = useState(0)

  useEffect(() => {
    setSeries(null)
    getExperiment(id ?? '').then(e => setExp(e ?? null))
    getExperimentSeries(id ?? '').then(s => setSeries(s ?? null))
  }, [id, changed])
  useEffect(() => {
    if (!exp?.live) { setRecord(null); return }
    let alive = true
    getLiveExperiment(exp.id).then(r => { if (alive) setRecord(r) }).catch(() => { if (alive) setRecord(null) })
    return () => { alive = false }
  }, [exp?.id, exp?.live, changed])
  const plan = usePlan(record?.contract)

  if (exp === undefined) return <div className="detail"><div className="empty">Loading…</div></div>
  if (exp === null) return <div className="detail"><div className="empty">Experiment not found. <Link to="/experiments">Back to the collection.</Link></div></div>

  const live = exp.live === true
  // Started, stopped or decided: the list's cache is stale, the page is not.
  const onChanged = () => { forgetLiveExperiments(); setChanged(k => k + 1) }
  const amendments = Array.isArray(record?.experiment?.amendments) ? record!.experiment.amendments! : []
  const readable = live && exp.preRegistered
  const canDecide = readable && !!record?.pre_registered && !!record.experiment && !record.experiment.decision
  // Dates first when there are none: until they are recorded every number
  // below reads the wrong days. Otherwise the decision follows the evidence.
  const noDates = !record?.progress?.started_at
  const lifecycle = record?.pre_registered && record.experiment &&
    <ExperimentLifecycle id={exp.id} live={record} units={units} plan={plan} onChanged={onChanged} deciding={deciding} />

  return (
    <div className="detail xdetail">
      <div className="crumb xcrumb"><Link to="/experiments">Experiments</Link> / <span className="mono">{exp.key}</span></div>
      {/* The question first. The title row used to lead with a tagline —
          "hypothesis → contract → readout → decision" — and put the
          hypothesis itself in a table of labels underneath. */}
      <header className="xhead">
        <div className="xhead-row">
          <h1 className="xhead-title">{exp.name}</h1>
          <div className="xhead-actions">
            {live && <><ProjectsButton about={{ id: exp.id, type: 'experiment' }} /><TasksButton about={{ id: exp.id, type: 'experiment', title: exp.name, key: exp.key }} /><CommentsButton subjectId={exp.id} title={exp.name} /></>}
            {readable && <button className="btn" disabled={reading} onClick={() => setReload(k => k + 1)}
              title="Run it again against the warehouse">{reading ? 'Reading…' : 'Refresh'}</button>}
            {canDecide && <button className="btn action" onClick={() => setDeciding(k => k + 1)}>Decide</button>}
          </div>
        </div>
        {/* Where it stands, in one line: state, days, and the two facts that
            decide whether any number below can be trusted. */}
        <div className="xhead-status">
          <span className={`xdot tone-${statusTone(exp.status)}`} aria-hidden="true" />
          <span>{exp.status === 'running' && exp.startedAt
            ? `Running · ${experimentState(exp).replace(/^Day/, 'day')}` : experimentState(exp)}</span>
          {live && <><span className="sep">·</span><span className={exp.preRegistered ? '' : 'warn'}>
            {exp.preRegistered ? 'pre-registered' : 'exploratory — nothing fixed what was measured'}</span></>}
          {exp.srmPassed === true && <><span className="sep">·</span><span>split check passed</span></>}
          {exp.srmPassed === false && <><span className="sep">·</span><span className="bad">split check failed</span></>}
          {exp.guardrail === 'breach' && <><span className="sep">·</span><span className="bad">guardrail breach</span></>}
          <span className="sep">·</span><span className="xhead-owner"><Avatar name={exp.owner} />{exp.owner}</span>
        </div>
        {exp.hypothesis
          ? <p className="xhead-lede">{exp.hypothesis}</p>
          : <p className="xhead-lede muted">No hypothesis was written down.</p>}
      </header>

      {live ? (
        exp.preRegistered ? <>
          {noDates && lifecycle}
          <LiveReadout id={exp.id} refresh={changed + reload} plan={plan} unit={record?.contract?.unit} onBusy={setReading}
            onRead={r => { const t = r.results.find(x => x.role !== 'guardrail'); setRate(t?.binary); setUnits(t?.arms ? t.arms.reduce((n, a) => n + a.n, 0) : null) }} />
          {!noDates && lifecycle}
          {record?.contract && <ExperimentContract contract={record.contract} amendments={amendments} rate={rate} />}
          <ReadoutTimeline id={exp.id} refresh={changed} />
          <ExperimentReferences id={exp.id} refresh={changed} />
        </> : (
          <div className="xnocontract">
            <b>No contract, so this cannot be read out.</b> Nothing fixed what it measures, so any
            number would answer whichever question looked best. <Link to="/experiments/new">Register it</Link> against
            its table to read it out.
          </div>
        )
      ) : (
        <>
          {/* A seeded row. Saying so is the honest thing: this page used to
              assert a flag rollout nothing tracks and stamp a green "ratified"
              badge on a metric nobody had checked, which made a fixture look
              exactly like a measured result. */}
          <div className="seeded">
            <div className="seeded-t">Sample experiment — not measured</div>
            <div className="seeded-b">
              Generated for demos. It carries no contract, so there is nothing to read out: its lift is
              fixture data, not a number computed from a warehouse, and there is no decision to record.
            </div>
          </div>
          <dl className="kv">
            <dt>Target metric</dt><dd><span className="mono">{exp.metric}</span></dd>
            <dt>Guardrails</dt><dd>{exp.guardrail === 'clean' ? 'all within bounds' : exp.guardrail}</dd>
            <dt>Lift</dt><dd>
              {exp.lift === null
                ? 'no readout'
                : `${exp.lift > 0 ? '+' : ''}${exp.lift}% on ${exp.metric}${series ? ((series.better === 'up') === (exp.lift > 0) ? ' · better' : ' · worse') : ''}`}
            </dd>
          </dl>
          {series && <MetricChart exp={exp} series={series} />}
        </>
      )}
    </div>
  )
}
