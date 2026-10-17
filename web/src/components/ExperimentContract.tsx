import type { WireAmendment, WireContract } from '../data/gateway'

const when = (at?: string | null) => at
  ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
const humanName = (c: string) => { const t = c.replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1) }

function Item({ label, children, warn, wide }: { label: string; children: React.ReactNode; warn?: boolean; wide?: boolean }) {
  return <div className={`xc-item${warn ? ' warn' : ''}${wide ? ' wide' : ''}`}><dt>{label}</dt><dd>{children}</dd></div>
}

/** What was written down before the data existed.
 *
 *  One line a reviewer can read at a glance, the gaps as tags whose hover says
 *  why each matters, and the full record folded beneath. Written out as nine
 *  labelled sentences it was a wall, and the same gaps were then said again,
 *  in full, under "Against what was registered". */
export function ExperimentContract({ contract: c, amendments = [], rate }: {
  contract: WireContract
  amendments?: WireAmendment[]
  /** Whether the readout measured the outcome as a rate, for a contract that
   *  did not say: then the column's type decided, and the page should agree. */
  rate?: boolean
}) {
  const split = c.weights && Object.keys(c.weights).length
    ? Object.entries(c.weights).map(([arm, w]) => `${arm} ${pct(w)}`).join(' / ')
    : null
  const guards = c.guardrails ?? []
  const asRate = c.binary ?? rate ?? false
  const measures = asRate ? 'as a rate' : `per unit (${c.unit_agg ?? 'sum'})`
  const gaps: [string, string][] = []
  if (!c.metric_id) gaps.push(['No metric definition', 'No ratified definition is cited, so "better" is assumed to be up.'])
  if (!c.unit) gaps.push(['No unit', 'Nothing is named as the unit of randomisation: counts are rows, so intervals are too narrow.'])
  if (!split) gaps.push(['Even split assumed', 'No designed split was registered, so the readout assumes an even one.'])
  if (c.mde == null) gaps.push(['No minimum effect', '"No difference" cannot be told from "too small to see".'])
  if (!guards.length) gaps.push(['No guardrails', 'Nothing was agreed as unable to get worse.'])
  const dir = (g: { better?: 'up' | 'down' }) => g.better === 'down' ? ' ↓' : g.better === 'up' ? ' ↑' : ''

  return <section className="xcontract" aria-label="What was registered">
    <div className="xc-head">
      <span className="ro-sub">Registered</span>
      <span className="hint">{c.registered_by ?? 'unknown'}{c.registered_at && <> · {when(c.registered_at)}</>} · fixed before any data was seen</span>
    </div>
    <p className="xc-line">
      <code>{c.outcome}</code> {measures}
      <span className="xc-sep"> · </span><code>{c.variation}</code>{c.control && <> vs <code>{c.control}</code></>}
      {split && <span className="hint"> ({split})</span>}
      {c.unit && <><span className="xc-sep"> · </span>per <code>{c.unit}</code></>}
      {c.planned_days ? <><span className="xc-sep"> · </span>{c.planned_days} days</> : null}
      {c.mde != null && <><span className="xc-sep"> · </span>detects ≥{pct(c.mde)}</>}
      {guards.length > 0 && <><span className="xc-sep"> · </span>
        <span title={guards.map(g => `${g.outcome}${dir(g)}`).join(', ')}>
          {guards.length} guardrail{guards.length === 1 ? '' : 's'}</span></>}
    </p>
    {gaps.length > 0 && <ul className="xc-gaps" aria-label="Gaps in what was registered">
      {gaps.map(([label, why]) => <li key={label} className="xc-gap" title={why}>{label}</li>)}
    </ul>}
    <details className="xc-details">
      <summary>Details</summary>
    <dl className="xc-grid">
      <Item label="Measures">
        <code>{c.outcome}</code> {measures}
        <span className="hint"> · from <span className="mono">{c.dataset_id}</span></span>
      </Item>
      <Item label="Target metric" warn={!c.metric_id}>
        {c.metric_id
          ? <><span className="mono">{c.metric_id}</span>{c.metric_version != null && <> · v{c.metric_version} pinned</>}</>
          : 'No definition cited — "better" is assumed to be up'}
      </Item>
      <Item label="Split" warn={!split}>
        by <code>{c.variation}</code>{c.control && <>, against <code>{c.control}</code></>}
        <span className="hint"> · {split ?? 'even split assumed — none registered'}</span>
      </Item>
      <Item label="Randomised on" warn={!c.unit}>
        {c.unit ? <code>{c.unit}</code> : 'Nothing named — counts are rows, so intervals are too narrow'}
      </Item>
      <Item label="Worth detecting" warn={c.mde == null}>
        {c.mde != null ? `a ${pct(c.mde)} change, relative` : 'Not registered — "no difference" cannot be told from "too small to see"'}
      </Item>
      <Item label="Planned">
        {c.planned_days ? `${c.planned_days} days` : 'no duration registered'}
      </Item>
      <Item label="Read with">
        {c.sequential === false ? 'one look at the end' : 'an interval valid at every look'}
        <span className="hint"> · α {c.alpha ?? 0.05} · split check fails below {c.threshold ?? 0.001}</span>
      </Item>
      {c.cohort && <Item label="Broken down by"><code>{c.cohort}</code></Item>}
      <Item label="Registered">
        {c.registered_by ?? 'unknown'}{c.registered_at && <> · {when(c.registered_at)}</>}
      </Item>
      {/* Last and full width: twenty guardrails one per line made this panel
          taller than the readout it qualifies. */}
      <Item label="Guardrails" warn={!guards.length} wide>
        {/* By which way is good, in words a reader uses: twenty-two column
            names in a mono run, each with a tiny arrow, read as a wall. */}
        {guards.length
          ? ([['up', '↑ Higher is better'], ['down', '↓ Lower is better'], ['', 'Direction from its definition']] as const)
              .map(([way, label]) => {
                const these = guards.filter(g => way ? !g.metric_id && g.better === way : g.metric_id || !g.better)
                return these.length > 0 && <div key={way || 'def'} className="xc-guards">
                  <span className="xc-guards-k">{label}</span>
                  <span className="xc-guards-v">
                    {these.map(g => <span key={g.outcome} className="xc-chip" title={g.outcome}>
                      {humanName(g.outcome)}
                      {g.metric_id && <span className="hint"> · {g.metric_id}{g.metric_version != null ? ` v${g.metric_version}` : ''}</span>}
                    </span>)}
                  </span>
                </div>
              })
          : 'None — nothing was agreed as unable to get worse'}
      </Item>
    </dl>
    </details>
    {amendments.length > 0 && <details className="xc-amend">
      <summary>{amendments.length} {amendments.length === 1 ? 'amendment' : 'amendments'} on record</summary>
      <ul>{amendments.map((a, i) => <li key={i}>
        <b>{a.by}</b> · {when(a.at)} — {a.why ? <q>{a.why}</q> : <span className="hint">no reason given</span>}
      </li>)}</ul>
    </details>}
  </section>
}
