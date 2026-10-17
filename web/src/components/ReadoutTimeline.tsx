import { useEffect, useState } from 'react'
import { readoutHistory, type WireRecordedReadout } from '../data/gateway'

/** What the recorded readouts said over time: the lift and its interval, one
 *  point per recording. Real numbers only — a live experiment used to have no
 *  chart at all, and a fabricated series beside a real readout would be worse.
 *  A verdict that flipped, or an interval that narrowed onto zero, is visible
 *  here as a shape rather than as whatever today's readout happens to say. */
export function ReadoutTimeline({ id, refresh }: { id: string; refresh: number }) {
  const [rows, setRows] = useState<WireRecordedReadout[] | null>(null)
  useEffect(() => {
    let alive = true
    readoutHistory(id).then(r => { if (alive) setRows(r.readouts) }).catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [id, refresh])

  const pts = (rows ?? []).filter(r => r.lift != null && r.lift_ci).reverse()
  if (!rows || rows.length === 0) return null

  const W = 640, H = 150, P = 28
  const lo = Math.min(0, ...pts.map(p => p.lift_ci![0]))
  const hi = Math.max(0, ...pts.map(p => p.lift_ci![1]))
  const span = hi - lo || 1
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P)
  const x = (i: number) => pts.length === 1 ? W / 2 : P + (i / (pts.length - 1)) * (W - 2 * P)
  const pctLabel = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

  return <section className="xtimeline" aria-label="Recorded readouts">
    <div className="ro-sub">Recorded readouts <span className="hint">{rows.length} — lift on the target, with its interval</span></div>
    {pts.length > 0 && <svg viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Lift over ${pts.length} recorded readouts, latest ${pctLabel(pts[pts.length - 1].lift!)}`}>
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="xt-zero" />
      <text x={4} y={y(0) + 4} className="xt-axis">0</text>
      {pts.map((p, i) => <g key={p.id}>
        <line x1={x(i)} x2={x(i)} y1={y(p.lift_ci![0])} y2={y(p.lift_ci![1])}
          className={`xt-ci ${p.verdict === 'better' ? 'up' : p.verdict === 'worse' ? 'down' : ''}`} />
        <circle cx={x(i)} cy={y(p.lift!)} r={4}
          className={`xt-pt ${p.srm_passed === false ? 'broken' : ''}`}>
          <title>{`${new Date(p.at).toLocaleString()} · ${pctLabel(p.lift!)} [${pctLabel(p.lift_ci![0])}, ${pctLabel(p.lift_ci![1])}] · ${p.verdict}`}</title>
        </circle>
      </g>)}
      {pts.length > 1 && <polyline className="xt-line" fill="none"
        points={pts.map((p, i) => `${x(i)},${y(p.lift!)}`).join(' ')} />}
    </svg>}
    <ul className="xt-list">
      {rows.slice(0, 5).map(r => <li key={r.id}>
        <span className="mono">{new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span>{r.lift != null ? pctLabel(r.lift) : '—'}</span>
        <span className="hint">{r.verdict ?? 'no answer'}{r.srm_passed === false && ' · split check failed'}</span>
        <span className="hint">by {r.by}</span>
      </li>)}
    </ul>
  </section>
}
