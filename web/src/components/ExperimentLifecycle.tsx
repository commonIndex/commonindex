import { useEffect, useState } from 'react'
import {
  draftRationale, decideExperiment, experimentExtent, getLiveExperiment, planExperiment, readout, startExperiment,
  stopExperiment, whoAmI, type WireContract, type WireMe, type WirePlan,
} from '../data/gateway'
import { Pill } from './ui'

export type LiveExperiment = Awaited<ReturnType<typeof getLiveExperiment>>

const fmtDate = (at?: string | null) => at
  ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''
const pad = (n: number) => String(n).padStart(2, '0')
/** yyyy-mm-dd in local time, which is what a date input shows and returns. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = () => localDay(new Date())
const daysBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000))

/** Where an experiment is in its life, and the one next thing to do about it.
 *
 *  Each state offers only an action the gateway will accept. The version before
 *  this offered Start on an experiment that had already stopped — refused by the
 *  gateway, and defaulted to today, which would have read nothing — and hid the
 *  decision from the one experiment that was waiting for it. */
export function ExperimentLifecycle({ id, live, units, plan, onChanged, deciding = 0 }: {
  id: string
  live: LiveExperiment
  /** Units the current readout counted, to set against the plan. */
  units: number | null
  /** What the contract's effect needs, sized once on the page for every panel. */
  plan: WirePlan | null
  onChanged: () => void
  /** Bumped by the page's Decide button: opens the decision here, early or
   *  not, and brings it into view. */
  deciding?: number
}) {
  const [me, setMe] = useState<WireMe | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [startOn, setStartOn] = useState('')
  const [stopOn, setStopOn] = useState('')
  const [seen, setSeen] = useState<{ first: string | null; last: string | null } | null>(null)
  const [choice, setChoice] = useState<'ship' | 'kill' | 'iterate' | null>(null)
  const [why, setWhy] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [draftErr, setDraftErr] = useState('')
  const draft = async () => {
    if (!choice) return
    setDrafting(true); setDraftErr('')
    try { setWhy((await draftRationale(id, choice)).rationale) }
    catch (e) { setDraftErr(e instanceof Error ? e.message : String(e)) }
    finally { setDrafting(false) }
  }

  const exp = live.experiment
  const prog = live.progress
  const status = exp.status
  const decided = exp.decision
  const noDates = !prog?.started_at
  const stopped = status === 'readout'
  const c = live.contract

  useEffect(() => { let alive = true; whoAmI().then(m => { if (alive) setMe(m) }); return () => { alive = false } }, [])

  // With no dates on record, the table's own first and last day of traffic are
  // the best evidence of when it ran — offered, never written without asking.
  useEffect(() => {
    if (!noDates || decided) return
    let alive = true
    experimentExtent(id).then(x => {
      if (!alive) return
      setSeen({ first: x.first_seen, last: x.last_seen })
      if (x.first_seen) setStartOn(v => v || localDay(new Date(x.first_seen!)))
      if (x.last_seen && stopped) setStopOn(v => v || localDay(new Date(x.last_seen!)))
    }).catch(() => { if (alive) setSeen(null) })
    return () => { alive = false }
  }, [id, noDates, decided, stopped])

  // Optional all the way down: an answer without `may` means no rights, not a crash.
  const mayMerge = !!me?.may?.includes('merge')
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await run(); onChanged(); return true }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }
  const decide = () => act(async () => {
    // Record the numbers as they stand, then decide on exactly those. The
    // decision cites what was read at the moment it was made, not whatever the
    // warehouse says next month.
    const recorded = await readout(id, { record: true })
    await decideExperiment({ experiment_id: id, decision: choice!, rationale: why.trim(),
      readout_id: recorded.recorded?.id })
  })

  const datesBad = !startOn || (stopped && (!stopOn || stopOn < startOn)) || startOn > today()
  const saveDates = () => act(() => startExperiment(id,
    new Date(`${startOn}T00:00:00`).toISOString(),
    // End of the stop day, so its traffic is counted.
    stopped ? new Date(`${stopOn}T23:59:59`).toISOString() : undefined))

  const [asked, setAsked] = useState(false)
  useEffect(() => {
    if (!deciding) return
    setAsked(true)
    document.getElementById('lifecycle')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [deciding])
  const showDecide = !decided && mayMerge && (stopped || !!prog?.due || !!choice || asked)
  // What the state above already says is not repeated underneath it.
  const extra = (live.attention ?? []).filter(a =>
    !(showDecide && /stopped and waiting|reached its planned/.test(a)) && !(noDates && /stopped and waiting/.test(a)))
  const pct = prog?.days ? Math.min(100, Math.round((prog.day / prog.days) * 100)) : 0
  const samplePct = plan && units ? Math.min(100, Math.round((units / plan.total) * 100)) : null

  let main: React.ReactNode
  if (decided) {
    main = <div className={`xlife-decided ${decided.outcome}`}>
      <Pill tone={decided.outcome === 'ship' ? 'green' : decided.outcome === 'kill' ? 'red' : 'gray'}>
        {decided.outcome === 'iterate' ? 'iterate (not shipped)' : decided.outcome}</Pill>
      <span>Decided by <b>{decided.by}</b> on {fmtDate(decided.at)}
        {/* Quoted only on a ship: a kill or iterate is often made because the
            number cannot be trusted, and repeating it beside the decision
            reads as the reason. */}
        {decided.outcome === 'ship' && decided.lift != null && <> at {decided.lift > 0 ? '+' : ''}{decided.lift}%</>}</span>
      <q>{decided.rationale}</q>
      {decided.readout_id && <span className="hint">cites readout {decided.readout_id.slice(0, 16)}…</span>}
    </div>
  } else if (noDates) {
    main = <div className="xlife-row">
      <div className="xlife-what">
        <div className="xlife-title">{stopped ? 'When did it run?' : 'When did traffic start?'}</div>
        <div className="hint">
          {stopped
            ? 'It stopped before its dates were recorded, so readouts read the last 30 days instead of the days it ran.'
            : 'Until this is recorded, readouts read the last 30 days instead of the days it has run.'}
          {seen?.first && <> The table's traffic runs <b>{fmtDate(seen.first)}</b>{' → '}<b>{fmtDate(seen.last)}</b>.</>}
          {' '}Dates are recorded once and not moved afterwards.
        </div>
      </div>
      <div className="xlife-dates">
        <label className="xlife-date">Started
          <input type="date" value={startOn} max={today()} onChange={e => setStartOn(e.target.value)} />
        </label>
        {stopped && <label className="xlife-date">Stopped
          <input type="date" value={stopOn} min={startOn || undefined} max={today()} onChange={e => setStopOn(e.target.value)} />
        </label>}
        <button className="btn action" disabled={busy || datesBad} onClick={saveDates}>
          {stopped ? 'Record dates' : 'Start'}</button>
      </div>
    </div>
  } else if (stopped) {
    main = <div className="xlife-row">
      <div className="xlife-what">
        <div className="xlife-title">Stopped</div>
        <div className="hint">Ran {fmtDate(prog!.started_at)} → {fmtDate(prog!.stopped_at)}
          {prog!.stopped_at && ` · ${daysBetween(prog!.started_at!, prog!.stopped_at)} days · ${prog!.days} planned`}</div>
      </div>
    </div>
  } else {
    main = <div className="xlife-row">
      <div className="xlife-what">
        <div className="xlife-title">{prog!.day > prog!.days
          ? `Day ${prog!.day} — ${prog!.day - prog!.days} past its planned ${prog!.days}`
          : `Day ${prog!.day} of ${prog!.days}`}</div>
        <div className="hint">started {fmtDate(prog!.started_at)} · planned end {fmtDate(prog!.ends_at)}</div>
        <div className="xlife-bar" aria-label={`${pct}% of planned days`}><span style={{ width: `${pct}%` }} /></div>
        {samplePct !== null && <div className="hint">
          {units?.toLocaleString()} of ~{plan!.total >= 100_000
            ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(plan!.total)
            : plan!.total.toLocaleString()} needed ({samplePct}%)
          <span title={`Units the registered ${Math.round((c?.mde ?? 0) * 100)}% effect needs to be seen`}> for a {Math.round((c?.mde ?? 0) * 100)}% effect</span>
          {plan!.days && prog!.days && plan!.days > prog!.days
            ? <> · <span className="ro-warn-text">~{plan!.days} days at today’s traffic, not {prog!.days}</span></> : null}
        </div>}
      </div>
      {status === 'running' && <button className="btn" disabled={busy}
        onClick={() => act(() => stopExperiment(id))}>Stop counting</button>}
    </div>
  }

  return <section className="xlife" aria-label="Lifecycle" id="lifecycle">
    {main}
    {extra.length > 0 && !decided && <ul className="xlife-attn">{extra.map(a => <li key={a}>{a}</li>)}</ul>}

    {showDecide && <div className="xlife-decide">
      <div className="xlife-title">Decide</div>
      {noDates && <p className="ro-warn-text xlife-decide-warn">
        Deciding now decides on the last 30 days of data, not the days it ran. Record its dates first to
        decide on its own window.</p>}
      <div className="xlife-choices" role="radiogroup" aria-label="Decision">
        {(['ship', 'kill', 'iterate'] as const).map(d =>
          <button key={d} role="radio" aria-checked={choice === d}
            className={`tool${choice === d ? ' on' : ''}`} onClick={() => setChoice(d)}>
            {d === 'ship' ? 'Ship it' : d === 'kill' ? 'Kill it' : 'Iterate'}</button>)}
      </div>
      {choice && <>
        <textarea rows={2} aria-label="Why" placeholder="Why — the reason people will read when they ask later"
          value={why} onChange={e => setWhy(e.target.value)} />
        {/* A draft from the readout, for the decision already chosen: the
            person still reads, edits and records it. */}
        <div className="xlife-draft">
          <button type="button" className="doc-link" disabled={drafting} onClick={() => void draft()}>
            {drafting ? 'Drafting…' : why.trim() ? 'Redraft with AI' : 'Draft with AI'}</button>
          {draftErr && <span className="hint warn">{draftErr}</span>}
        </div>
        <div className="xlife-decide-go">
          <span className="hint">Records the readout as it stands now and cites it.</span>
          <button className="btn action" disabled={busy || !why.trim()} onClick={decide}>
            {busy ? 'Recording…' : `Record: ${choice}`}</button>
        </div>
      </>}
    </div>}
    {!decided && !mayMerge && me && (stopped || prog?.due || asked) &&
      <p className="hint">Deciding needs merge access in this space.</p>}
    {!decided && status === 'running' && !noDates && !prog?.due && !choice && !asked && mayMerge &&
      <button className="linkbtn xlife-early" onClick={() => setChoice('kill')}>Decide early…</button>}

    {err && <p className="p-warn" role="alert">{err}</p>}
  </section>
}

/** What the contract's effect needs, sized once for the page: the lifecycle
 *  sets it against the days, the readout against the units it counted. */
export function usePlan(c: WireContract | null | undefined): WirePlan | null {
  const [plan, setPlan] = useState<WirePlan | null>(null)
  useEffect(() => {
    if (!c?.mde) { setPlan(null); return }
    let alive = true
    planExperiment({ mde: c.mde, binary: c.binary ?? undefined, alpha: c.alpha ?? undefined,
      weights: c.weights ?? undefined, control: c.control ?? undefined,
      connection_id: c.connection_id, dataset_id: c.dataset_id, variation: c.variation,
      outcome: c.outcome, unit: c.unit ?? undefined, planned_days: c.planned_days ?? undefined,
      // Sized as the readout will read it: capped, and aggregated per unit.
      unit_agg: c.unit_agg ?? undefined, cap: c.cap ?? undefined, null_is_zero: c.null_is_zero ?? undefined })
      .then(p => { if (alive) setPlan(p) }).catch(() => { if (alive) setPlan(null) })
    return () => { alive = false }
  }, [c?.mde, c?.dataset_id, c?.outcome, c?.binary, c?.alpha, c?.weights, c?.control,
      c?.connection_id, c?.variation, c?.unit, c?.planned_days, c?.unit_agg, c?.cap, c?.null_is_zero])
  return plan
}

