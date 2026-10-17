import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { planExperiment, type WirePlan } from '../data/gateway'

/** Before an experiment exists: can it see the effect you care about?
 *
 *  Everything else in Experiments starts from traffic that is already flowing.
 *  This is the question that has to come first, and nothing asked it — so a
 *  2% effect could be registered for 14 days on a page that needed 60 to see
 *  it, and "no difference detected" was the only answer it could ever give. */
export function ExperimentPlan() {
  const [kind, setKind] = useState<'rate' | 'amount'>('rate')
  const [baseline, setBaseline] = useState('10')
  const [sd, setSd] = useState('')
  const [mde, setMde] = useState('5')
  const [daily, setDaily] = useState('2000')
  const [share, setShare] = useState('50')
  const [sequential, setSequential] = useState(true)
  const [plan, setPlan] = useState<WirePlan | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const b = Number(baseline), m = Number(mde) / 100, c = Number(share) / 100
    if (!b || !m || !(c > 0 && c < 1)) { setPlan(null); return }
    let alive = true
    const t = setTimeout(() => {
      planExperiment({
        baseline: kind === 'rate' ? b / 100 : b, mde: m, binary: kind === 'rate',
        ...(kind === 'amount' && Number(sd) ? { sd: Number(sd) } : {}),
        ...(Number(daily) ? { daily_units: Number(daily) } : {}),
        weights: { control: c, variant: 1 - c }, control: 'control', sequential,
      }).then(p => { if (alive) { setPlan(p); setErr(null) } })
        .catch(e => { if (alive) { setPlan(null); setErr(e instanceof Error ? e.message : String(e)) } })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [kind, baseline, sd, mde, daily, share, sequential])

  return (
    <div className="detail xplan">
      <div className="crumb"><Link to="/experiments">← Experiments</Link> / plan</div>
      <div className="page-title">Plan an experiment</div>
      <div className="page-sub">
        How many people, and how many days, before it can tell you anything. Sized for the interval the
        readout will actually use, so the plan and the result agree about what “detectable” means.
      </div>

      <div className="xplan-grid">
        <fieldset><legend>What are you measuring?</legend>
          <span className="xplan-chips">
            <button aria-pressed={kind === 'rate'} className={`chip${kind === 'rate' ? ' on' : ''}`} onClick={() => setKind('rate')}>A rate (converted or not)</button>
            <button aria-pressed={kind === 'amount'} className={`chip${kind === 'amount' ? ' on' : ''}`} onClick={() => setKind('amount')}>An amount (revenue, time)</button>
          </span>
        </fieldset>
        <label>{kind === 'rate' ? 'Today’s rate' : 'Today’s average per person'}
          <span className="wiz-unit"><input className="wiz-in short" inputMode="decimal" value={baseline}
            onChange={e => setBaseline(e.target.value)} />{kind === 'rate' ? '%' : ''}</span>
        </label>
        {kind === 'amount' && <label>Spread per person (standard deviation)
          <input className="wiz-in short" inputMode="decimal" value={sd} placeholder="e.g. 30"
            onChange={e => setSd(e.target.value)} />
        </label>}
        <label>Smallest change worth acting on
          <span className="wiz-unit"><input className="wiz-in short" inputMode="decimal" value={mde}
            onChange={e => setMde(e.target.value)} />% relative</span>
        </label>
        <label>People reaching it per day
          <input className="wiz-in short" inputMode="numeric" value={daily} onChange={e => setDaily(e.target.value)} />
        </label>
        <label>Share kept on the current version
          <span className="wiz-unit"><input className="wiz-in short" inputMode="numeric" value={share}
            onChange={e => setShare(e.target.value)} />%</span>
        </label>
        <fieldset><legend>How it will be read</legend>
          <span className="xplan-chips">
            <button aria-pressed={sequential} className={`chip${sequential ? ' on' : ''}`} onClick={() => setSequential(true)}>Any time (always-valid)</button>
            <button aria-pressed={!sequential} className={`chip${!sequential ? ' on' : ''}`} onClick={() => setSequential(false)}>Once, at the end</button>
          </span>
        </fieldset>
      </div>

      {err && <div className="wiz-err">{err}</div>}
      {plan && <div className="xplan-out" role="status">
        <div className="xplan-big">
          {plan.days != null ? <><b>{plan.days}</b> day{plan.days === 1 ? '' : 's'}</> : <b>{plan.total.toLocaleString()} people</b>}
        </div>
        <div>{plan.total.toLocaleString()} people in total — {Object.entries(plan.per_arm)
          .map(([k, v]) => `${v.toLocaleString()} ${k === 'control' ? 'on the current version' : 'on the new one'}`).join(', ')}.</div>
        {plan.days != null && plan.days > 42 && <div className="ro-warn-text">
          Over six weeks. Seasonality and novelty start to move the baseline under you — consider a bigger
          change, a more sensitive metric, or more traffic.</div>}
        <ul className="xplan-assume">{plan.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
      </div>}

      <p className="hint">
        When it is live, <Link to="/experiments/new">register it</Link> with the same change size — the
        readout will then say how far through this plan it is.
      </p>
    </div>
  )
}
