import { useMemo, useRef, useState } from 'react'
import type { Experiment, MetricArm, MetricSeries } from '../data/types'
import { SERIES, fmtTick, fmtValue, signed, ticksFor, usePlotWidth } from './chartkit'

// Every arm of an experiment on its target metric. Same contract as
// FlowDiagram: the series is the record, the picture is derived — nothing here
// is authored per experiment.
//
// Arms take categorical slots in fixed order, baseline first, so a colour
// follows an arm rather than its rank: filtering or re-sorting never repaints
// the survivors. Slots come from chartkit, validated for CVD separation on
// this surface.
//
// The plot is measured, not scaled: the SVG viewBox matches its rendered pixel
// size, so a wider card buys more plot area instead of magnified labels.

const PAD = { l: 56, r: 96, t: 16, b: 30 }
const LABEL_GAP = 13 // min vertical space between end labels

const pct = (v: number, base: number) => (base === 0 ? 0 : ((v - base) / base) * 100)

/** Push overlapping end labels apart, keeping their order, then pull the stack
 *  back inside the plot if it overflowed. Leader lines reattach the moved ones. */
function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b])
  const out = ys.slice()
  for (let k = 1; k < order.length; k++) {
    const prev = out[order[k - 1]]
    if (out[order[k]] - prev < gap) out[order[k]] = prev + gap
  }
  const overflow = out[order[order.length - 1]] - hi
  if (overflow > 0) {
    for (const i of order) out[i] -= overflow
    for (let k = order.length - 2; k >= 0; k--) {
      const next = out[order[k + 1]]
      if (next - out[order[k]] < gap) out[order[k]] = next - gap
    }
  }
  const under = lo - out[order[0]]
  if (under > 0) for (const i of order) out[i] += under
  return out
}

export function MetricChart({ exp, series }: { exp: Experiment; series: MetricSeries }) {
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [measure, width] = usePlotWidth()
  const svgRef = useRef<SVGSVGElement>(null)

  const arms = series.arms
  const elapsed = Math.max(0, ...arms.map(a => a.daily.length))
  const baseIdx = Math.max(0, arms.findIndex(a => a.baseline))
  const base = arms[baseIdx]

  const W = Math.max(340, Math.round(width) || 720)
  const H = Math.round(Math.min(380, Math.max(256, W * 0.34)))
  const X0 = PAD.l
  const X1 = W - PAD.r
  const Y0 = PAD.t
  const Y1 = H - PAD.b

  const g = useMemo(() => {
    const vals = arms.flatMap(a => a.daily)
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = ((hi - lo) || Math.abs(hi) * 0.04 || 1) * 0.22
    const dlo = lo - pad
    const dhi = hi + pad
    const { ticks, step } = ticksFor(dlo, dhi, Math.max(4, Math.min(7, Math.round((Y1 - Y0) / 54))))
    const x = (d: number) => X0 + ((d - 1) / Math.max(1, series.days - 1)) * (X1 - X0)
    const y = (v: number) => Y1 - ((v - dlo) / (dhi - dlo || 1)) * (Y1 - Y0)
    return { ticks, step, x, y }
  }, [arms, series.days, X0, X1, Y0, Y1])

  if (elapsed === 0) {
    return (
      <div className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-label">Target metric · <span className="mono">{series.metric}</span></div>
            <div className="chart-value">No exposure yet</div>
            <div className="chart-caption">A draft has no arms running — the readout series starts on day 1.</div>
          </div>
        </div>
      </div>
    )
  }

  const lastOf = (a: MetricArm) => a.daily[a.daily.length - 1]
  const deltaOf = (a: MetricArm) => pct(lastOf(a), lastOf(base))
  const variants = arms.filter((_, i) => i !== baseIdx)
  // The arm that won on this metric's own direction, which is the one the
  // experiment's stated lift belongs to.
  const best = variants.reduce((b, a) =>
    (series.better === 'up' ? deltaOf(a) > deltaOf(b) : deltaOf(a) < deltaOf(b)) ? a : b, variants[0])

  const headline = exp.lift ?? (best ? deltaOf(best) : 0)
  const provisional = exp.lift === null
  const good = series.better === 'up' ? headline > 0 : headline < 0
  const colorOf = (i: number) => SERIES[i % SERIES.length]

  const line = (a: MetricArm) =>
    a.daily.map((v, i) => `${i ? 'L' : 'M'}${g.x(i + 1).toFixed(1)} ${g.y(v).toFixed(1)}`).join(' ')

  // End labels ride the lines at the last *measured* day, not the right edge,
  // so a mid-flight test's labels stay attached to where it got to.
  const endX = g.x(elapsed)
  const rawY = arms.map(a => g.y(lastOf(a)))
  const labelY = spread(rawY, LABEL_GAP, Y0 + 4, Y1 - 2)

  // A mid-flight test keeps the planned x domain — how far along it is, is
  // part of the reading. One label per ~130px of plot; anything landing within
  // 36px of its neighbour is cut.
  const running = elapsed < series.days
  const span = running ? elapsed : series.days
  const every = Math.max(1, Math.round(span / Math.max(2, Math.min(8, Math.round((X1 - X0) / 130)))))
  const xTicks = [1, ...Array.from({ length: span }, (_, i) => 1 + (i + 1) * every).filter(d => d < span), span]
    .reduce<number[]>((keep, d) => (keep.length && g.x(d) - g.x(keep[keep.length - 1]) < 36 ? keep : [...keep, d]), [])
  const lastTick = xTicks[xTicks.length - 1]

  function pointerToIndex(clientX: number) {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return null
    const vx = ((clientX - r.left) / r.width) * W
    const step = (X1 - X0) / Math.max(1, series.days - 1)
    return Math.max(0, Math.min(elapsed - 1, Math.round((vx - X0) / step)))
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const i = hover ?? elapsed - 1
    if (e.key === 'ArrowLeft') setHover(Math.max(0, i - 1))
    else if (e.key === 'ArrowRight') setHover(Math.min(elapsed - 1, i + 1))
    else if (e.key === 'Home') setHover(0)
    else if (e.key === 'End') setHover(elapsed - 1)
    else if (e.key === 'Escape') setHover(null)
    else return
    e.preventDefault()
  }

  const hoverX = hover === null ? 0 : g.x(hover + 1)
  const anchorRight = hoverX > (X0 + X1) / 2
  const tipStyle = anchorRight
    ? { right: `${100 - (hoverX / W) * 100}%`, marginRight: 10 }
    : { left: `${(hoverX / W) * 100}%`, marginLeft: 10 }

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <div className="chart-label">Target metric · <span className="mono">{series.metric}</span></div>
          <div className="chart-value">{signed(headline)}</div>
          <div className="chart-caption">
            {variants.length > 1 && best ? <><b>{best.name}</b>, best of {variants.length} variants</> : 'variant vs control'} ·{' '}
            {provisional
              ? <span>provisional — day {exp.day} of {exp.days}, no readout filed</span>
              : <><span className={good ? 'ok' : 'bad'}>{headline > 0 ? '↑' : '↓'} {good ? 'better' : 'worse'}</span> on {series.metric}</>}
          </div>
        </div>
        <div className="seg">
          <button className={asTable ? '' : 'on'} onClick={() => setAsTable(false)}>Chart</button>
          <button className={asTable ? 'on' : ''} onClick={() => setAsTable(true)}>Table</button>
        </div>
      </div>

      <div className="chart-legend">
        {arms.map((a, i) => (
          <span key={a.name}>
            <i className="key" style={{ background: colorOf(i) }} />{a.name}
            <span className="sub-inline">
              {' '}n {a.exposure.toLocaleString()}
              {a.baseline ? ' · baseline' : ` · ${signed(deltaOf(a))}`}
            </span>
          </span>
        ))}
      </div>

      {asTable ? (
        <div className="chart-table-wrap" style={{ maxHeight: H }}>
          <table className="chart-table">
            <thead>
              <tr><th>Day</th>{arms.map(a => <th key={a.name}>{a.name}</th>)}</tr>
            </thead>
            <tbody>
              {Array.from({ length: elapsed }, (_, d) => (
                <tr key={d}>
                  <td>{d + 1}</td>
                  {arms.map(a => <td key={a.name}>{fmtValue(a.daily[d], series.unit)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" ref={measure} style={{ minHeight: H }}>
          {width > 0 && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              width={W}
              height={H}
              className="chart-svg"
              role="img"
              tabIndex={0}
              aria-label={`${series.metric}, ${arms.length} arms, day 1 to ${elapsed}. ${arms.map(a => `${a.name} ${fmtValue(lastOf(a), series.unit)}`).join(', ')}. Arrow keys step through days; the table view lists every value.`}
              onPointerMove={e => setHover(pointerToIndex(e.clientX))}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(h => h ?? elapsed - 1)}
              onBlur={() => setHover(null)}
              onKeyDown={onKeyDown}
            >
              {g.ticks.map(t => (
                <g key={t}>
                  <line x1={X0} y1={g.y(t)} x2={X1} y2={g.y(t)} stroke="var(--border)" strokeWidth={1} />
                  <text x={X0 - 10} y={g.y(t) + 3.5} fontSize={10} fill="var(--muted)" textAnchor="end" className="tnum">
                    {fmtTick(t, series.unit, g.step)}
                  </text>
                </g>
              ))}
              {xTicks.map(d => (
                <text key={d} x={g.x(d)} y={Y1 + 18} fontSize={10} fill="var(--muted)" textAnchor={d === 1 ? 'start' : d === series.days ? 'end' : 'middle'} className="tnum">
                  {d === lastTick ? `day ${d}` : d}
                </text>
              ))}
              {running && (
                <text x={X1} y={Y1 + 18} fontSize={10} fill="var(--muted)" textAnchor="end">
                  readout at day {series.days}
                </text>
              )}

              {hover !== null && (
                <g>
                  <line x1={g.x(hover + 1)} y1={Y0} x2={g.x(hover + 1)} y2={Y1} stroke="var(--border2)" strokeWidth={1} />
                  {arms.map((a, i) => (
                    <circle key={a.name} cx={g.x(hover + 1)} cy={g.y(a.daily[hover])} r={4.5}
                      fill={colorOf(i)} stroke="var(--panel)" strokeWidth={2} />
                  ))}
                </g>
              )}

              {arms.map((a, i) => (
                <path key={a.name} d={line(a)} fill="none" stroke={colorOf(i)} strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round" />
              ))}

              {arms.map((a, i) => (
                <g key={a.name}>
                  {Math.abs(labelY[i] - rawY[i]) > 1 && (
                    <line x1={endX + 6} y1={rawY[i]} x2={endX + 13} y2={labelY[i]} stroke="var(--border2)" strokeWidth={1} />
                  )}
                  <circle cx={endX} cy={rawY[i]} r={4.5} fill={colorOf(i)} stroke="var(--panel)" strokeWidth={2} />
                  <text
                    x={endX + 16} y={labelY[i] + 3.5} fontSize={11.5} fontWeight={600}
                    fill="var(--text)" className="tnum"
                    style={{ paintOrder: 'stroke', stroke: 'var(--panel)', strokeWidth: 3 }}
                  >
                    {fmtValue(lastOf(a), series.unit)}
                  </text>
                </g>
              ))}
            </svg>
          )}

          {hover !== null && (
            <div className="chart-tip" style={tipStyle}>
              <div className="d">Day {hover + 1}</div>
              {arms
                .map((a, i) => ({ a, i }))
                .sort((p, q) => q.a.daily[hover] - p.a.daily[hover])
                .map(({ a, i }) => (
                  <div className="r" key={a.name}>
                    <i style={{ background: colorOf(i) }} />
                    <b>{fmtValue(a.daily[hover], series.unit)}</b><span>{a.name}</span>
                  </div>
                ))}
              <div className="f">
                {variants.map(a => `${a.name} ${signed(pct(a.daily[hover], base.daily[hover]))}`).join(' · ')}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="chart-foot">
        Cumulative estimate per arm · sequential test, external engine via MCP · read-only.
        {exp.guardrail !== 'clean' && ' Guardrail metrics are tracked separately — Analyst filed the flag in your inbox.'}
      </div>
    </div>
  )
}
