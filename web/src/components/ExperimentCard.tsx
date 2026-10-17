import { Link } from 'react-router-dom'
import type { Experiment } from '../data/types'
import { Avatar, Oid, Pill, statusTone } from './ui'

const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
const day = (at?: string | null) => at
  ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''

/** Where it is in its life, in the words the detail page uses. `short` is for
 *  a list column, where the long form was cut off mid-word. */
export function experimentState(e: Experiment, short = false): string {
  if (e.status === 'shipped' || e.status === 'killed' || e.status === 'iterated') {
    const word = e.status === 'iterated' || e.decision?.outcome === 'iterate' ? 'Iterating' : e.status === 'shipped' ? 'Shipped' : 'Killed'
    return e.decision?.at && !short ? `${word} · ${day(e.decision.at)}` : word
  }
  if (e.status === 'readout') return short ? 'Stopped' : 'Stopped · decide'
  if (e.status === 'draft') return 'Draft'
  // It runs in the engine whatever this says; what is missing is the date its
  // traffic started, without which a readout reads the wrong days. "Not
  // started" beside a "running" pill said two opposite things at once.
  if (e.live && !e.startedAt) return short ? 'No start date' : 'Start date not recorded'
  if (short) return `Day ${e.day}/${e.days}`
  return e.day > e.days ? `Day ${e.day} · ${e.day - e.days} past plan` : `Day ${e.day} of ${e.days}`
}

/** The lift against zero, with its interval, and the band the contract said
 *  was too small to act on. A bare "+4%" on a card cannot be told from a coin
 *  flip; the interval is what says whether it is one. */
function Interval({ ci, lift, mde, verdict }: {
  ci: [number, number]; lift: number; mde?: number | null; verdict?: string | null
}) {
  const band = mde ? mde * 100 : 0
  const lo = Math.min(ci[0], -band, 0), hi = Math.max(ci[1], band, 0)
  const pad = Math.max((hi - lo) * 0.12, 0.5)
  const x = (v: number) => 8 + ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * 284
  const tone = verdict === 'better' ? 'up' : verdict === 'worse' ? 'down' : 'flat'
  return <svg viewBox="0 0 300 44" className="exp-card-ci" role="img"
    aria-label={`Lift ${signed(lift)}, interval ${signed(ci[0])} to ${signed(ci[1])}${band ? `, minimum worth acting on ±${band}%` : ''}`}>
    {band > 0 && <rect x={x(-band)} y={8} width={x(band) - x(-band)} height={22} className="exp-card-ci-band" />}
    <line x1={x(0)} x2={x(0)} y1={4} y2={34} className="exp-card-ci-zero" />
    <line x1={x(ci[0])} x2={x(ci[1])} y1={19} y2={19} className={`exp-card-ci-bar ${tone}`} />
    <circle cx={x(lift)} cy={19} r={5} className={`exp-card-ci-pt ${tone}`} />
    <text x={x(0)} y={43} textAnchor="middle" className="exp-card-ci-axis">0</text>
  </svg>
}

function Preview({ e }: { e: Experiment }) {
  const running = e.status === 'running' && (!e.live || !!e.startedAt)
  const pct = e.days ? Math.min(100, Math.round((e.day / e.days) * 100)) : 0
  // A number the readout refused to stand behind is not the headline. It stays
  // visible for diagnosis, greyed, with the reason beside it.
  const untrusted = e.srmPassed === false || e.verdict === 'no answer'
  const tone = untrusted ? 'none' : e.verdict === 'better' ? 'up' : e.verdict === 'worse' ? 'down' : ''
  return <>
    {/* Where it stands, as the page's own status line says it. */}
    <div className="exp-card-state"><span className={`xdot tone-${statusTone(e.status)}`} aria-hidden="true" />
      {e.status === 'running' && (!e.live || e.startedAt) ? `Running · ${experimentState(e).replace(/^Day/, 'day')}` : experimentState(e)}</div>
    {e.lift !== null && e.liftCi ? <>
      <div className="exp-card-lift"><strong className={tone}>{signed(e.lift)}</strong>
        {(() => {
          const why = `${e.srmPassed === false ? 'no answer · split check failed' : e.verdict ?? 'no verdict'}`
            + (e.units ? ` · ${e.units.toLocaleString()} units` : '') + (e.liftAt ? ` · read ${day(e.liftAt)}` : '')
          return <span title={why}>{why}</span>
        })()}</div>
      <Interval ci={e.liftCi} lift={e.lift} mde={e.mde} verdict={e.verdict} />
    </> : e.lift !== null ? <>
      <div className="exp-card-lift"><strong>{signed(e.lift)}</strong>
        {/* Dated, because the figure is what an earlier readout said — and the
            page it opens reads the warehouse again, and can say something else. */}
        <span>{e.liftAt ? `read ${day(e.liftAt)} · no interval` : 'interval not recorded'}</span></div>
      <div className="exp-card-note">Record a readout to see the interval.</div>
    </> : <>
      {/* Nothing recorded yet is not a number to show. The page reads the
          warehouse when it opens; a dash the size of a headline said
          "something is missing" about an experiment working as intended. */}
      <div className="exp-card-unread">{e.live && !e.preRegistered
        ? 'No contract, so it cannot be read out.'
        : <>No readout recorded yet — open it to read the warehouse.</>}</div>
    </>}
    {running && <div className={`exp-card-progress${e.day > e.days ? ' over' : ''}`}
      aria-label={`${pct}% of planned days`}><span style={{ width: `${pct}%` }} /></div>}
  </>
}

/** One experiment, in the same card as a design and a dashboard: what it is
 *  asking, where it is, and what the numbers say so far. Nothing here queries a
 *  warehouse; the figures are what the last recorded readout said. */
export function ExperimentCard({ experiment: e }: { experiment: Experiment }) {
  // What needs attention, as words with a dot — the state is already on the
  // card's first line, so it is not said again as a pill under the title.
  const flags = [
    ...(e.srmPassed === false ? [<span key="s" className="exp-flag bad">split check failed</span>] : []),
    ...(e.guardrail === 'breach' ? [<span key="g" className="exp-flag bad">guardrail breach</span>] : []),
    ...(e.attention?.length ? [<span key="a" className="exp-flag warn">{e.attention[0]}</span>] : []),
    ...(e.live && e.preRegistered === false ? [<span key="c" className="exp-flag warn">no contract</span>] : []),
  ]
  return <Link className="dash-card exp-card" to={`/experiments/${e.id}`} aria-label={`Open experiment ${e.name}`}>
    <div className={`dash-card-preview exp-card-preview`}>
      <div className="dash-card-preview-label">
        <span>{e.live ? 'Warehouse experiment' : 'Experiment'}</span><Oid id={e.key} />
      </div>
      <Preview e={e} />
    </div>
    <div className="dash-card-content">
      <h2>{e.name}</h2>
      <div className="dash-card-facts">
        <span>{e.space}</span><span>·</span><span className="mono">{e.metric || 'no metric cited'}</span>
      </div>
      {flags.length > 0 && <div className="exp-card-flags"
        title={e.attention?.length ? e.attention.join('\n') : undefined}>{flags}</div>}
      {e.hypothesis && <p className="exp-card-hypothesis">{e.hypothesis}</p>}
      <div className="dash-card-footer"><span><Avatar name={e.owner} />{e.owner}</span>
        <span>Open experiment <span aria-hidden="true">↗</span></span></div>
    </div>
  </Link>
}
