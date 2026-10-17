import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getProgramStats } from '../data/api'
import { SERIES, compact, usePlotWidth } from '../components/chartkit'
import { PRODUCT } from '../product'
import type { ProgramStats } from '../data/types'

// How the whole program is doing — the answer to "are our experiments
// working", at the scale where nobody reads the collection row by row.
//
// Every number on this page is an aggregate over experiment objects {PRODUCT}
// already holds. No warehouse round trip and no statistics engine: the
// registry has declared avg(lift) a measure on this type since day one, and
// this is the first surface that reads it. That is the whole distinction —
// {PRODUCT} does not compute the *effect* of an experiment, but the portfolio is
// its own collection, so reasoning across it needs nobody's permission.

const SHIPPED = SERIES[0]
const KILLED = SERIES[1]

/** Rounded on the data end only, square at the baseline. */
function rr(x: number, y: number, w: number, h: number, r: number, tl: boolean, tr: boolean, br: boolean, bl: boolean) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2))
  const a = (c: boolean) => (c ? k : 0)
  const [TL, TR, BR, BL] = [a(tl), a(tr), a(br), a(bl)]
  return `M${x + TL} ${y}H${x + w - TR}${TR ? `a${TR} ${TR} 0 0 1 ${TR} ${TR}` : ''}` +
    `V${y + h - BR}${BR ? `a${BR} ${BR} 0 0 1 ${-BR} ${BR}` : ''}` +
    `H${x + BL}${BL ? `a${BL} ${BL} 0 0 1 ${-BL} ${-BL}` : ''}` +
    `V${y + TL}${TL ? `a${TL} ${TL} 0 0 1 ${TL} ${-TL}` : ''}Z`
}

function Tile({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="panel panel-stat" style={{ ['--span' as string]: 3 }}>
      <div className="p-label">{label}</div>
      <div className="p-value">{value}</div>
      <div className="p-delta p-mut">{sub}</div>
    </div>
  )
}

function Toggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="seg">
      <button className={on ? '' : 'on'} onClick={() => set(false)}>Chart</button>
      <button className={on ? 'on' : ''} onClick={() => set(true)}>Table</button>
    </div>
  )
}

function Legend() {
  return (
    <div className="p-legend">
      <span><i className="key key-rect" style={{ background: SHIPPED }} />Shipped</span>
      <span><i className="key key-rect" style={{ background: KILLED }} />Not shipped</span>
    </div>
  )
}

/** Outcome by target metric — volume in the bar, hit rate as a direct label. */
function ByMetric({ rows, total }: { rows: ProgramStats['byMetric']; total: number }) {
  const [asTable, setAsTable] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [measure, width] = usePlotWidth()

  const W = Math.max(320, Math.round(width) || 640)
  const LEFT = 150, RIGHT = 104, TOP = 6, ROW = 30, BAR = 15
  const H = rows.length * ROW + 24
  const max = Math.max(1, ...rows.map(r => r.shipped + r.killed))
  const x = (v: number) => LEFT + (v / max) * (W - LEFT - RIGHT)
  // Deduplicated: with a maximum of 1 the midpoint rounds onto it, which only
  // showed once the page counted real experiments instead of 240 generated ones.
  const ticks = [...new Set([0, Math.round(max / 2), max])]

  return (
    <div className="panel" style={{ ['--span' as string]: 7 }}>
      <div className="p-head">
        <div>
          <div className="p-binding">{total} experiment objects · grouped, not queried</div>
          <div className="p-title">Outcome by target metric</div>
        </div>
        <Toggle on={asTable} set={setAsTable} />
      </div>
      <Legend />
      {asTable ? (
        <div className="chart-table-wrap" style={{ maxHeight: H + 30 }}>
          <table className="chart-table">
            <thead><tr><th>Metric</th><th>Shipped</th><th>Not shipped</th><th>Ship rate</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.metric}><td>{r.metric}</td><td>{r.shipped}</td><td>{r.killed}</td><td>{r.rate}%</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="p-plot" ref={measure} style={{ minHeight: H }}>
          {width > 0 && (
            <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
              aria-label={`Ship rate by target metric. ${rows.map(r => `${r.metric} ${r.rate} percent of ${r.shipped + r.killed}`).join('; ')}.`}>
              {ticks.map(t => (
                <line key={t} x1={x(t)} y1={TOP} x2={x(t)} y2={rows.length * ROW + TOP} stroke="var(--border)" strokeWidth={1} />
              ))}
              {rows.map((r, i) => {
                const y = TOP + i * ROW + (ROW - BAR) / 2
                const total = r.shipped + r.killed
                const wS = x(r.shipped) - LEFT
                const wK = x(total) - x(r.shipped)
                const gap = wS > 0 && wK > 0 ? 2 : 0
                return (
                  <g key={r.metric} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                    <rect x={0} y={TOP + i * ROW} width={W} height={ROW} fill="transparent" />
                    <text x={0} y={y + BAR / 2 + 4} fontSize={11.5} fill="var(--text2)" style={{ fontFamily: 'var(--mono)' }}>{r.metric}</text>
                    {wS > 0 && <path d={rr(LEFT, y, wS, BAR, 4, false, wK === 0, wK === 0, false)} fill={SHIPPED} opacity={hover === null || hover === i ? 1 : .45} />}
                    {wK > 0 && <path d={rr(LEFT + wS + gap, y, Math.max(0, wK - gap), BAR, 4, false, true, true, false)} fill={KILLED} opacity={hover === null || hover === i ? 1 : .45} />}
                    <text x={W} y={y + BAR / 2 + 4} fontSize={11.5} textAnchor="end" className="tnum">
                      <tspan fontWeight={600} fill="var(--text)">{r.rate}%</tspan>
                      <tspan fill="var(--muted)" fontSize={10.5}> · n {total}</tspan>
                    </text>
                  </g>
                )
              })}
              {ticks.map(t => (
                <text key={`t${t}`} x={x(t)} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor={t === 0 ? 'start' : t === max ? 'end' : 'middle'} className="tnum">{t}</text>
              ))}
            </svg>
          )}
        </div>
      )}
      <div className="p-foot">
        Bar length is how many tests that metric has decided; the number is how many of them shipped.
        A high rate on a short bar is a small sample, not a strong signal.
      </div>
    </div>
  )
}

/** Effect sizes actually observed, oriented so positive always means a win. */
function EffectSize({ dist }: { dist: ProgramStats['dist'] }) {
  const [asTable, setAsTable] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [measure, width] = usePlotWidth()

  const W = Math.max(300, Math.round(width) || 440)
  const LEFT = 30, RIGHT = 8, TOP = 10, BOT = 40
  const H = 250
  const max = Math.max(1, ...dist.map(d => d.shipped + d.killed))
  const band = (W - LEFT - RIGHT) / dist.length
  const bw = Math.min(24, band - 8)
  const y = (v: number) => H - BOT - (v / max) * (H - BOT - TOP)
  // Deduplicated: with a maximum of 1 the midpoint rounds onto it, which only
  // showed once the page counted real experiments instead of 240 generated ones.
  const ticks = [...new Set([0, Math.round(max / 2), max])]
  const zeroIdx = dist.findIndex(d => d.lo === 0)

  return (
    <div className="panel" style={{ ['--span' as string]: 5 }}>
      <div className="p-head">
        <div>
          <div className="p-binding">decided tests · improvement on their own metric</div>
          <div className="p-title">How big the effects actually are</div>
        </div>
        <Toggle on={asTable} set={setAsTable} />
      </div>
      <Legend />
      {asTable ? (
        <div className="chart-table-wrap" style={{ maxHeight: H }}>
          <table className="chart-table">
            <thead><tr><th>Improvement</th><th>Shipped</th><th>Not shipped</th></tr></thead>
            <tbody>{dist.map(d => (
              <tr key={d.label}><td>{d.label}%</td><td>{d.shipped}</td><td>{d.killed}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="p-plot" ref={measure} style={{ minHeight: H }}>
          {width > 0 && (
            <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
              aria-label={`Distribution of improvement across decided experiments. ${dist.map(d => `${d.label} percent: ${d.shipped} shipped, ${d.killed} killed`).join('; ')}.`}>
              {ticks.map(t => (
                <g key={t}>
                  <line x1={LEFT} y1={y(t)} x2={W - RIGHT} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                  <text x={LEFT - 7} y={y(t) + 3.5} fontSize={10} fill="var(--muted)" textAnchor="end" className="tnum">{t}</text>
                </g>
              ))}
              {zeroIdx > 0 && (
                <line x1={LEFT + zeroIdx * band} y1={TOP} x2={LEFT + zeroIdx * band} y2={H - BOT}
                  stroke="var(--border2)" strokeWidth={1.5} />
              )}
              {dist.map((d, i) => {
                const cx = LEFT + i * band + band / 2
                const bx = cx - bw / 2
                const hS = (d.shipped / max) * (H - BOT - TOP)
                const hK = (d.killed / max) * (H - BOT - TOP)
                const gap = hS > 0 && hK > 0 ? 2 : 0
                const yK = y(d.shipped + d.killed)
                return (
                  <g key={d.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                    <rect x={LEFT + i * band} y={TOP} width={band} height={H - BOT - TOP} fill="transparent" />
                    {hK > 0 && <path d={rr(bx, yK, bw, Math.max(0, hK - gap), 4, true, true, false, false)} fill={KILLED} opacity={hover === null || hover === i ? 1 : .45} />}
                    {hS > 0 && <path d={rr(bx, y(d.shipped), bw, hS, 4, hK === 0, hK === 0, false, false)} fill={SHIPPED} opacity={hover === null || hover === i ? 1 : .45} />}
                    <text x={cx} y={H - BOT + 15} fontSize={10} fill="var(--muted)" textAnchor="middle" className="tnum">{d.label}</text>
                  </g>
                )
              })}
              <text x={LEFT} y={H - 6} fontSize={10} fill="var(--muted)">← worse</text>
              <text x={W - RIGHT} y={H - 6} fontSize={10} fill="var(--muted)" textAnchor="end">better →</text>
            </svg>
          )}
        </div>
      )}
      <div className="p-foot">
        Lift is reoriented so positive always means the variant won — a refund rate that fell 18% is a +18 here.
      </div>
    </div>
  )
}

export function ExperimentAnalysis() {
  const [s, setS] = useState<ProgramStats | null>(null)
  useEffect(() => { setS(null); getProgramStats().then(setS) }, [])

  if (!s) return <div className="detail"><div className="empty">Loading…</div></div>
  const pctOf = (n: number, d: number) => d ? `${Math.round((n / d) * 100)}%` : '—'
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v}%`

  return (
    <div className="collection">
      <div className="coll-head">
        <div className="coll-title">
          Program analysis
          <span className="total">{s.total} experiments · {s.decided} decided</span>
        </div>
        <div className="coll-sub">
          Nobody reads {s.total} experiments. This is what they say together — every number here is a
          group-by over objects {PRODUCT} already holds, so it needs no warehouse and no stats engine.
          <Link to="/experiments" style={{ color: 'var(--accent)', marginLeft: 6 }}>Back to the collection →</Link>
        </div>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0 28px' }}>
        <div className="panel-grid prog-grid">
          <Tile label="In flight" value={String(s.running + s.readout)}
            sub={<>{s.running} running · {s.readout} stopped, awaiting a decision</>} />
          <Tile label="Reached a decision" value={compact(s.decided)}
            sub={<>{pctOf(s.decided, s.total)} of the program</>} />
          <Tile label="Ship rate" value={s.decided ? `${s.winRate}%` : '—'}
            sub={<>{s.shipped} shipped · {s.iterated ?? 0} iterating · {s.killed} killed</>} />
          <Tile label="Median win" value={s.shipped ? signed(s.medianWin) : '—'}
            sub={<>shipped tests, on their own metric</>} />

          <ByMetric rows={s.byMetric.map(r => ({ ...r, killed: r.killed + (r.iterated ?? 0) }))} total={s.total} />
          <EffectSize dist={s.dist.map(d => ({ ...d, killed: d.killed + (d.iterated ?? 0) }))} />
        </div>

        <div className="section-label">Reading this honestly <span className="hint">what the numbers cannot tell you</span></div>
        <div className="card" style={{ padding: '13px 16px', color: 'var(--text2)', lineHeight: 1.65 }}>
          <div className="prose">
          <p><b>Killing a test is a good outcome.</b> A program that ships everything it starts is not testing;
          it is shipping with extra steps. {s.killed === 1 ? 'The 1 killed test is the one' : `The ${s.killed} killed tests are the ones`} that paid for the process.</p>
          <p style={{ marginTop: 9 }}><b>This is a censored sample.</b> Ship rate and median win describe the tests
          that reached a decision, not the population of ideas. The {s.draft + s.running + s.readout} still in flight
          are missing from every number above, and they are not missing at random — the ones in trouble get killed early.</p>
          <p style={{ marginTop: 9 }}><b>These are claimed effects, not realised ones.</b> Each figure is the readout
          the engine produced at decision time. What the change actually did after shipping is a different
          measurement, and the two diverge more often than anyone expects — that gap is what a long-run holdout exists
          to find.</p>
          <p style={{ marginTop: 9 }}><b>{PRODUCT} did not compute any of this from raw data.</b> Effects arrive read-only
          from the experiment engine; what happens here is arithmetic over decisions the workspace already recorded.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
