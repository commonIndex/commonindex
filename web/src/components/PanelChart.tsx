import { Component, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Panel } from '../data/types'
import { collapse } from '../data/agg'
import {
  SEQ, SERIES, clip, fmtAxis, fmtShort, fmtStat, signed, ticksFor, usePlotWidth,
} from './chartkit'

// A panel renders from its spec — a mark, a window, and a metric binding. The
// spec is the record; the picture is derived. Nothing here is authored per
// dashboard, which is what makes a panel diffable and a proposal reviewable.
//
// Every form ships a table view. That is not a courtesy: three of the eight
// categorical slots sit below 3:1 against paper, and the table is the relief
// that makes them legal. It is also the answer to "the tooltip is the only way
// to read this value" — it never is.

// 208 was set when a chart shared a row with a neighbour on a 1180px page. On
// anything wider the plot became a strip: a month of daily points in 208px
// leaves each day about a pixel of vertical room, which is enough to draw a
// line and not enough to read one.
const PLOT_H = 264
/** What this panel's plot is actually given. A stored height beats the
 *  constant for the same reason a stored span beats the heuristic: 264 is a
 *  sensible default for a line chart and says nothing about a table of thirty
 *  rows, which wants height the way a heatmap wants width. */
const plotH = (p: Panel) => p.height ?? PLOT_H
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_COLS = 26 // past this, days bucket into weeks — 90 hairlines is not a bar chart

const dayLabel = (ago: number) => (ago === 0 ? 'today' : `${ago}d`)
const bucketLabel = (panel: Panel, index: number, n: number, short = false) => {
  const stamp = panel.bucketDates?.slice(-n)[index]
  if (!stamp) return panel.windowed ? 'Selected range' : dayLabel(n - 1 - index)
  if (!Number.isFinite(Date.parse(stamp))) return stamp
  if (['hour', 'minute'].includes(panel.grain ?? '')) return new Date(stamp).toISOString().replace('T', ' ').slice(0, 16)
  return new Date(stamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC' })
}
/** Separate paths at missing readings; never interpolate through SQL NULL. */
function segments(values: number[]) {
  const result: { value: number; index: number }[][] = []
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return
    if (index === 0 || !Number.isFinite(values[index - 1])) result.push([])
    result[result.length - 1].push({ value, index })
  })
  return result
}

/** 4px rounded data-end, square at the baseline. */
function capTop(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.max(0, Math.min(r, h, w / 2))
  return `M${x} ${y + h} V${y + rr} A${rr} ${rr} 0 0 1 ${x + rr} ${y} H${x + w - rr} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} V${y + h} Z`
}
function capRight(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.max(0, Math.min(r, w, h / 2))
  return `M${x} ${y} H${x + w - rr} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} V${y + h - rr} A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h} H${x} Z`
}

/** ~1 label per 90px of plot, always including the newest reading. */
function xTicks(n: number, span: number) {
  const want = Math.max(2, Math.min(6, Math.round(span / 90)))
  const every = Math.max(1, Math.round((n - 1) / want))
  const out: number[] = []
  for (let i = n - 1; i >= 0; i -= every) out.push(i)
  return out.reverse()
}

/** Mean per weekday, keyed to each day's place in the full history so the
 *  columns hold still when the range changes. */
function weekGrid(panel: Panel, win: number[][]): number[][] {
  const offset = panel.series[0].daily.length - win[0].length
  return win.map(s => WEEK.map((_, c) => {
    const dates = panel.bucketDates?.slice(-s.length)
    const vals = s.filter((v, i) => Number.isFinite(v) && (dates?.[i]
      ? (new Date(dates[i]).getUTCDay() + 6) % 7 === c : (offset + i) % 7 === c))
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Number.NaN
  }))
}

function Legend({ names, mark }: { names: string[]; mark: 'line' | 'rect' }) {
  if (names.length < 2) return null // one series — the title already names it
  return (
    <div className="p-legend">
      {names.map((n, i) => (
        <span key={n}>
          <i className={mark === 'line' ? 'key' : 'key key-rect'} style={{ background: SERIES[i % SERIES.length] }} />
          {n}
        </span>
      ))}
    </div>
  )
}

function Tip({ x, W, head, rows, foot }: {
  x: number; W: number; head: string
  rows: { name: string; value: string; color: string }[]
  foot?: string
}) {
  const right = x > W / 2
  const style = right
    ? { right: `${100 - (x / W) * 100}%`, marginRight: 10 }
    : { left: `${(x / W) * 100}%`, marginLeft: 10 }
  return (
    <div className="chart-tip" style={style}>
      <div className="d">{head}</div>
      {rows.map(r => (
        <div className="r" key={r.name}>
          <i style={{ background: r.color }} />
          <b>{r.value}</b><span>{r.name}</span>
        </div>
      ))}
      {foot && <div className="f">{foot}</div>}
    </div>
  )
}

// ── stat tile ──────────────────────────────────────────────────────────────
/** How a panel's number is calculated, on an ⓘ beside its title — shown on
 *  hover and on focus, rather than a "definition" drawer at
 *  the foot of every card. */
function DefinitionTip({ panel }: { panel: Panel }) {
  const id = useId()
  if (!panel.expr) return null
  return (
    <span className="p-info">
      <button type="button" className="p-info-btn" aria-describedby={id}
        aria-label={`How ${panel.title} is calculated`}>i</button>
      <span role="tooltip" id={id} className="p-info-tip">
        <b>{panel.source === 'prometheus' ? 'PromQL' : 'Definition'}</b>
        <code className="mono">{panel.expr}</code>
        <span className="p-info-meta">{panel.dataset}{panel.metric ? ` · ${panel.metric}` : ''} · {panel.ratified ? 'ratified' : 'not ratified'}</span>
      </span>
    </span>
  )
}

function StatPanel({ panel, win, prev }: { panel: Panel; win: number[][]; prev: number[][] }) {
  const [hi, setHi] = useState<number | null>(null)
  const [measure, width] = usePlotWidth()
  const pts = win[0]
  const value = collapse(pts, panel.agg)
  const before = prev[0].length ? collapse(prev[0], panel.agg) : null
  const delta = before === null || before === 0 ? null : ((value - before) / before) * 100
  const good = delta === null ? null : panel.better === 'up' ? delta > 0 : delta < 0

  const W = Math.max(120, Math.round(width) || 220)
  const H = 34
  const finite = pts.filter(Number.isFinite)
  const lo = Math.min(...finite)
  const span = Math.max(Math.max(...finite) - lo, 1e-9)
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * (W - 5) + 2.5
  const y = (v: number) => H - 4 - ((v - lo) / span) * (H - 8)
  const path = (from: number) =>
    segments(pts.slice(from)).map(part => part.map(({ value, index }, k) => `${k ? 'L' : 'M'}${x(from + index).toFixed(1)} ${y(value).toFixed(1)}`).join(' ')).join(' ')
  // The current quarter of the window takes the accent; the rest recedes.
  const recent = Math.max(0, pts.length - Math.max(2, Math.round(pts.length / 4)) - 1)
  // One value over the whole range (no time bucket) is not a trend: drawn, it
  // was a stray dot, and hovering it read "Selected range · none bucket".
  const trend = pts.length > 1

  return (
    <>
      <div className="p-title-row"><div className="p-label">{panel.title}</div><DefinitionTip panel={panel} /></div>
      <div className="p-value">{fmtStat(hi === null ? value : pts[hi], panel.unit)}</div>
      <div className="p-delta">
        {hi !== null && trend
          ? <span className="p-mut">{bucketLabel(panel, hi, pts.length)} · {panel.grain ?? 'day'} bucket</span>
          : delta === null
            ? <span className="p-mut">{panel.windowed ? 'turn on Compare to see the change' : 'no prior window at this range'}</span>
            : <>
                <span className={good ? 'ok' : 'bad'}>{delta > 0 ? '▲' : '▼'} {signed(delta)}</span>
                <span className="p-mut"> vs prior {pts.length}d</span>
              </>}
      </div>
      {trend && <div
        className="p-spark" ref={measure}
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setHi(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))))
        }}
        onPointerLeave={() => setHi(null)}
      >
        {width > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
            <path d={path(0)} fill="none" stroke="var(--border2)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <path d={path(recent)} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hi !== null && Number.isFinite(pts[hi]) && (
              <circle cx={x(hi)} cy={y(pts[hi])} r={4} fill={SERIES[0]} stroke="var(--panel)" strokeWidth={2} />
            )}
          </svg>
        )}
      </div>}
    </>
  )
}

// ── line · area · stacked ──────────────────────────────────────────────────
/** Whether the last bucket is a period still under way — today, this week,
 *  this month. Its value is a part-total, and drawn like the others it reads
 *  as a fall: revenue "dropping" to a fraction of yesterday on a day that is
 *  only half over. Decided by the calendar, so a finished day is never marked. */
export function partialLast(panel: Pick<Panel, 'bucketDates' | 'grain'>, now = Date.now()): boolean {
  const last = panel.bucketDates?.at(-1)
  const grain = panel.grain ?? 'day'
  if (!last || !['day', 'week', 'month'].includes(grain)) return false
  const start = Date.parse(last.length <= 10 ? `${last}T00:00:00Z` : last)
  if (!Number.isFinite(start)) return false
  const d = new Date(start)
  const end = grain === 'day' ? start + 86_400_000 : grain === 'week' ? start + 7 * 86_400_000
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return start <= now && now < end
}

function TimePanel({ panel, win }: { panel: Panel; win: number[][] }) {
  const [measure, width] = usePlotWidth()
  const [hi, setHi] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const stacked = panel.kind === 'stacked'
  const names = panel.series.map(s => s.name)

  // A stacked chart of 90 daily columns is a texture, not a chart. Bucket to
  // weeks past the threshold and say so in the footer.
  const { cols, bucket } = useMemo(() => {
    const n = win[0].length
    const size = stacked && !panel.windowed ? Math.ceil(n / MAX_COLS) : 1
    if (size <= 1) return { cols: win.map(s => [...s]), bucket: 1 }
    const out = win.map(s => {
      const acc: number[] = []
      for (let i = 0; i < n; i += size) {
        const slice = s.slice(i, i + size)
        acc.push(panel.agg === 'sum' ? slice.reduce((a, b) => a + b, 0) : slice.reduce((a, b) => a + b, 0) / slice.length)
      }
      return acc
    })
    return { cols: out, bucket: size }
  }, [win, stacked, panel.agg, panel.windowed])

  const n = cols[0].length
  const W = Math.max(260, Math.round(width) || 640)
  const wide = W > 430 && !stacked && names.length <= 4
  const PAD = { l: 50, r: wide ? 58 : 14, t: 10, b: 24 }
  const H = plotH(panel)
  const [X0, X1, Y0, Y1] = [PAD.l, W - PAD.r, PAD.t, H - PAD.b]

  const totals = useMemo(
    () => Array.from({ length: n }, (_, i) => cols.reduce((a, s) => a + (Number.isFinite(s[i]) ? s[i] : 0), 0)),
    [cols, n],
  )
  const g = useMemo(() => {
    // Area and stacked measure magnitude, so they must start at zero; a line of
    // rates does not, and zero-basing it would flatten the thing being read.
    const flat = cols.flat().filter(Number.isFinite)
    const hiV = stacked ? Math.max(...totals) : Math.max(...flat)
    const loV = stacked || panel.kind === 'area' ? 0 : Math.min(...flat)
    const pad = ((hiV - loV) || Math.abs(hiV) * 0.04 || 1) * (loV === 0 ? 0.08 : 0.2)
    const dlo = loV === 0 ? 0 : loV - pad
    const dhi = hiV + pad
    const { ticks, step } = ticksFor(dlo, dhi, Math.max(3, Math.min(6, Math.round((Y1 - Y0) / 46))))
    const stamps = panel.bucketDates?.slice(-n).map(at => Date.parse(at))
    const timed = stamps?.length === n && stamps.every(Number.isFinite) && stamps[n - 1] > stamps[0]
    return {
      ticks, step,
      x: (i: number) => {
        return X0 + (timed ? (stamps[i] - stamps[0]) / (stamps[n - 1] - stamps[0]) : n === 1 ? 0.5 : i / (n - 1)) * (X1 - X0)
      },
      y: (v: number) => Y1 - ((v - dlo) / (dhi - dlo || 1)) * (Y1 - Y0),
    }
  }, [cols, totals, stacked, panel.kind, panel.bucketDates, X0, X1, Y0, Y1, n])

  const band = (X1 - X0) / Math.max(1, n)
  const colW = Math.min(24, Math.max(3, band - 2))
  const ticks = xTicks(n, X1 - X0)
  const hp = hi === null ? null : hi

  function toIndex(clientX: number) {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return null
    const vx = ((clientX - r.left) / r.width) * W
    return cols[0].reduce((closest, _, i) => Math.abs(g.x(i) - vx) < Math.abs(g.x(closest) - vx) ? i : closest, 0)
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const i = hi ?? n - 1
    if (e.key === 'ArrowLeft') setHi(Math.max(0, i - 1))
    else if (e.key === 'ArrowRight') setHi(Math.min(n - 1, i + 1))
    else if (e.key === 'Home') setHi(0)
    else if (e.key === 'End') setHi(n - 1)
    else if (e.key === 'Escape') setHi(null)
    else return
    e.preventDefault()
  }

  // End labels ride the lines, pushed apart with a leader line when the series
  // converge — only when the card is wide enough to hold them without clipping.
  const ends = wide
    ? cols.map((s, i) => ({ i, v: s[n - 1], y: g.y(s[n - 1]) })).filter(e => Number.isFinite(e.v)).sort((a, b) => a.y - b.y)
    : []
  const endY = ends.map(e => e.y)
  for (let k = 1; k < endY.length; k++) if (endY[k] - endY[k - 1] < 13) endY[k] = endY[k - 1] + 13

  const unit = bucket > 1 ? `${bucket}d bucket` : 'day'
  // Only on the buckets the server dated; a browser-bucketed column is not one.
  const partial = bucket === 1 && n > 1 && partialLast(panel)
  const partialX = partial ? (g.x(n - 2) + g.x(n - 1)) / 2 : 0
  return (
    <>
      <Legend names={names} mark={stacked || panel.kind === 'area' ? 'rect' : 'line'} />
      <div className="p-plot" ref={measure} style={{ minHeight: H }}>
        {width > 0 && (
          <svg
            ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg"
            role="img" tabIndex={0}
            aria-label={`${panel.title}. ${names.length} series over ${win[0].length} ${panel.windowed ? 'observed buckets' : 'days'}. Latest ${names.map((nm, i) => `${nm} ${fmtStat(cols[i][n - 1], panel.unit)}`).join(', ')}. Arrow keys step through; the table view lists every value.`}
            onPointerMove={e => setHi(toIndex(e.clientX))}
            onPointerLeave={() => setHi(null)}
            onFocus={() => setHi(h => h ?? n - 1)}
            onBlur={() => setHi(null)}
            onKeyDown={onKeyDown}
          >
            {g.ticks.map(t => (
              <g key={t}>
                <line x1={X0} y1={g.y(t)} x2={X1} y2={g.y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={X0 - 8} y={g.y(t) + 3.5} fontSize={9.5} fill="var(--muted)" textAnchor="end" className="tnum">
                  {fmtAxis(t, panel.unit, g.step)}
                </text>
              </g>
            ))}
            {ticks.map(i => (
              <text
                key={i} x={g.x(i)} y={Y1 + 16} fontSize={9.5} fill="var(--muted)" className="tnum"
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              >
                {panel.windowed ? bucketLabel(panel, i, n, true) : dayLabel((n - 1 - i) * bucket)}
              </text>
            ))}

            {partial && <g aria-hidden="true">
              <rect x={partialX} y={Y0} width={Math.max(0, X1 - partialX + (stacked ? colW / 2 : 0))} height={Y1 - Y0}
                fill="var(--sunk)" opacity={0.7} />
              <text x={Math.min(W - 16, (partialX + X1) / 2 + (stacked ? colW / 4 : 0))} y={Y0 + 9} textAnchor="middle"
                fontSize={9.5} fill="var(--muted)" style={{ paintOrder: 'stroke', stroke: 'var(--panel)', strokeWidth: 3 }}>so far</text>
            </g>}

            {hp !== null && !stacked && (
              <line x1={g.x(hp)} y1={Y0} x2={g.x(hp)} y2={Y1} stroke="var(--border2)" strokeWidth={1} />
            )}

            {stacked
              ? Array.from({ length: n }, (_, i) => {
                  let acc = 0
                  return (
                    <g key={i} opacity={(hp === null || hp === i ? 1 : 0.62) * (partial && i === n - 1 ? 0.45 : 1)}>
                      {cols.map((s, k) => {
                        if (!Number.isFinite(s[i])) return null
                        const y0 = g.y(acc + s[i])
                        const y1 = g.y(acc)
                        acc += s[i]
                        // 2px of surface between segments — the gap separates
                        // them, never a stroke drawn around each one.
                        const h = Math.max(0, y1 - y0 - (k === 0 ? 0 : 2))
                        const x = g.x(i) - colW / 2
                        const top = k === cols.length - 1
                        return h <= 0 ? null : top
                          ? <path key={names[k]} d={capTop(x, y0, colW, h)} fill={SERIES[k % SERIES.length]} />
                          : <rect key={names[k]} x={x} y={y0} width={colW} height={h} fill={SERIES[k % SERIES.length]} />
                      })}
                    </g>
                  )
                })
              : cols.map((s, k) => {
                  return (
                    <g key={names[k]}>
                      {segments(s).map((part, segment) => {
                        const d = part.map(({ value, index }, j) => `${j ? 'L' : 'M'}${g.x(index).toFixed(1)} ${g.y(value).toFixed(1)}`).join(' ')
                        // The step into a period still under way is dashed: the
                        // line is not finished there, and should not look it.
                        const open = partial && part.length > 1 && part.at(-1)!.index === n - 1
                        const solid = open ? part.slice(0, -1) : part
                        const ds = solid.map(({ value, index }, j) => `${j ? 'L' : 'M'}${g.x(index).toFixed(1)} ${g.y(value).toFixed(1)}`).join(' ')
                        const tail = open ? `M${g.x(part.at(-2)!.index).toFixed(1)} ${g.y(part.at(-2)!.value).toFixed(1)} L${g.x(n - 1).toFixed(1)} ${g.y(part.at(-1)!.value).toFixed(1)}` : ''
                        return <g key={segment}>
                          {panel.kind === 'area' && <path d={`${d} L${g.x(part.at(-1)!.index)} ${Y1} L${g.x(part[0].index)} ${Y1} Z`} fill={SERIES[k % SERIES.length]} opacity={0.1} />}
                          <path d={ds} fill="none" stroke={SERIES[k % SERIES.length]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                          {open && <path d={tail} fill="none" stroke={SERIES[k % SERIES.length]} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" className="p-partial" />}
                          {part.length === 1 && <circle cx={g.x(part[0].index)} cy={g.y(part[0].value)} r={3.5} fill={SERIES[k % SERIES.length]} />}
                        </g>
                      })}
                    </g>
                  )
                })}

            {hp !== null && !stacked && cols.map((s, k) => Number.isFinite(s[hp]) && (
              <circle key={k} cx={g.x(hp)} cy={g.y(s[hp])} r={4.5} fill={SERIES[k % SERIES.length]} stroke="var(--panel)" strokeWidth={2} />
            ))}

            {ends.map((e, k) => (
              <g key={e.i}>
                {Math.abs(endY[k] - e.y) > 1 && (
                  <line x1={X1 + 4} y1={e.y} x2={X1 + 10} y2={endY[k]} stroke="var(--border2)" strokeWidth={1} />
                )}
                <circle cx={g.x(n - 1)} cy={e.y} r={4} fill={SERIES[e.i % SERIES.length]} stroke="var(--panel)" strokeWidth={2} />
                <text
                  x={X1 + 13} y={endY[k] + 3.5} fontSize={10.5} fontWeight={600} fill="var(--text)" className="tnum"
                  style={{ paintOrder: 'stroke', stroke: 'var(--panel)', strokeWidth: 3 }}
                >
                  {fmtShort(e.v, panel.unit)}
                </text>
              </g>
            ))}
          </svg>
        )}
        {hp !== null && (
          <Tip
            x={g.x(hp)} W={W}
            head={`${panel.windowed ? bucketLabel(panel, hp, n) : dayLabel((n - 1 - hp) * bucket)}${bucket > 1 ? ` · ${unit}` : ''}`}
            rows={cols.map((s, k) => ({ name: names[k], value: fmtStat(s[hp], panel.unit), color: SERIES[k % SERIES.length] }))}
            foot={stacked ? `${fmtStat(totals[hp], panel.unit)} total` : undefined}
          />
        )}
      </div>
    </>
  )
}

// ── horizontal bar ─────────────────────────────────────────────────────────
function BarPanel({ panel, win }: { panel: Panel; win: number[][] }) {
  const [measure, width] = usePlotWidth()
  const [hi, setHi] = useState<number | null>(null)
  const rows = panel.series.map((s, i) => ({ name: s.name, v: collapse(win[i], panel.agg) })).filter(r => Number.isFinite(r.v))
  const W = Math.max(240, Math.round(width) || 320)
  const H = plotH(panel)
  const PAD = { l: Math.min(112, Math.max(74, W * 0.32)), r: 50, t: 6, b: 6 }
  const [X0, X1] = [PAD.l, W - PAD.r]
  const max = Math.max(...rows.map(r => r.v), 1e-9)
  const band = (H - PAD.t - PAD.b) / rows.length
  const th = Math.min(24, band - 8)
  const total = rows.reduce((a, r) => a + r.v, 0)

  return (
    <div className="p-plot" ref={measure} style={{ minHeight: H }}>
      {width > 0 && (
        <svg
          viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
          aria-label={`${panel.title}. ${rows.map(r => `${r.name} ${fmtStat(r.v, panel.unit)}`).join(', ')}.`}
        >
          {rows.map((r, i) => {
            const y = PAD.t + i * band + (band - th) / 2
            const w = Math.max(0, (r.v / max) * (X1 - X0))
            return (
              <g
                key={r.name}
                onPointerEnter={() => setHi(i)} onPointerLeave={() => setHi(null)}
                tabIndex={0} onFocus={() => setHi(i)} onBlur={() => setHi(null)}
                className="p-bar"
              >
                {/* the hit target is the whole band, never the painted pixels */}
                <rect x={0} y={PAD.t + i * band} width={W} height={band} fill="transparent" />
                <path d={capRight(X0, y, w, th)} fill={SERIES[0]} opacity={hi === null || hi === i ? 1 : 0.55} />
                <text x={X0 - 9} y={y + th / 2 + 3.5} fontSize={10.5} fill="var(--muted)" textAnchor="end">
                  {clip(r.name, Math.floor(PAD.l / 6.2))}
                </text>
                <text x={X0 + w + 7} y={y + th / 2 + 3.5} fontSize={10.5} fill="var(--text2)" className="tnum">
                  {fmtStat(r.v, panel.unit)}
                </text>
              </g>
            )
          })}
          <line x1={X0} y1={PAD.t} x2={X0} y2={H - PAD.b} stroke="var(--border2)" strokeWidth={1} />
        </svg>
      )}
      {hi !== null && (
        <Tip
          x={W * 0.34} W={W} head={rows[hi].name}
          rows={[{ name: panel.metric.replace(/_/g, ' '), value: fmtStat(rows[hi].v, panel.unit), color: SERIES[0] }]}
          foot={total > 0 ? `${((rows[hi].v / total) * 100).toFixed(1)}% of the window` : undefined}
        />
      )}
    </div>
  )
}

// ── pie ────────────────────────────────────────────────────────────────────
/** The share each series takes of the whole.
 *
 *  The same numbers `bar` draws as lengths. A reader asking "how is this split"
 *  is asking a different question from "which is biggest", and the answer to
 *  the first is easier to see as parts of one circle than as bars you have to
 *  add up by eye.
 *
 *  A donut rather than a full pie: the hole is where the total goes, which is
 *  the number a pie chart otherwise makes you reconstruct.
 */
function PiePanel({ panel, win }: { panel: Panel; win: number[][] }) {
  const [measure, width] = usePlotWidth()
  const [hi, setHi] = useState<number | null>(null)
  const rows = panel.series
    .map((s, i) => ({ name: s.name, v: collapse(win[i], panel.agg) }))
    .filter(r => r.v > 0)
  const total = rows.reduce((a, r) => a + r.v, 0)

  const W = Math.max(220, Math.round(width) || 320)
  const H = plotH(panel)
  const R = Math.min(H / 2 - 14, 116)
  const inner = R * 0.58
  // The legend is as wide as it needs to be, and the ring and legend sit
  // together in the middle: stretched to the card's edge, the shares stood
  // a gap away from the names they belong to, with the middle left empty.
  const ringW = 2 * R + 42
  const legendW = Math.min(300, Math.max(80, W - ringW))
  const offset = Math.max(0, (W - ringW - legendW) / 2)
  const cx = offset + R + 16
  const cy = H / 2
  const legendX = cx + R + 26

  // Angles accumulate, so a rounding error cannot leave a gap: each slice ends
  // exactly where the next begins.
  let at = -Math.PI / 2
  const slices = rows.map((r, i) => {
    const sweep = total > 0 ? (r.v / total) * Math.PI * 2 : 0
    const from = at
    at += sweep
    const arc = (rad: number, ang: number) =>
      `${(cx + rad * Math.cos(ang)).toFixed(1)} ${(cy + rad * Math.sin(ang)).toFixed(1)}`
    const big = sweep > Math.PI ? 1 : 0
    return {
      ...r, i,
      // A single slice is a full circle, which an arc path cannot draw — it
      // would close on itself and paint nothing.
      d: sweep >= Math.PI * 2 - 1e-9
        ? `M${arc(R, 0)} A${R} ${R} 0 1 1 ${arc(R, Math.PI)} A${R} ${R} 0 1 1 ${arc(R, 0)} Z`
        : `M${arc(inner, from)} L${arc(R, from)} A${R} ${R} 0 ${big} 1 ${arc(R, at)}`
          + ` L${arc(inner, at)} A${inner} ${inner} 0 ${big} 0 ${arc(inner, from)} Z`,
    }
  })

  return (
    <div className="p-plot" ref={measure} style={{ minHeight: H }}>
      {width > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
          aria-label={`${panel.title}. ${rows.map(r =>
            `${r.name} ${((r.v / total) * 100).toFixed(1)}%`).join(', ')}.`}>
          {slices.map(sl => (
            <path key={sl.name} d={sl.d} fill={SERIES[sl.i % SERIES.length]}
              opacity={hi === null || hi === sl.i ? 1 : 0.4}
              onPointerEnter={() => setHi(sl.i)} onPointerLeave={() => setHi(null)}
              tabIndex={0} onFocus={() => setHi(sl.i)} onBlur={() => setHi(null)} />
          ))}
          {/* The total, in the hole. A pie otherwise makes a reader add the
              slices up to learn the one number they were looking at. */}
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize={17} fontWeight={600}
            fill="var(--text)" className="tnum">
            {fmtStat(hi === null ? total : rows[hi].v, panel.unit)}
          </text>
          <text x={cx} y={cy + 15} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
            {hi === null ? 'total' : clip(rows[hi].name, 16)}
          </text>

          {rows.map((r, i) => (
            // `x` inside a translated group is RELATIVE to it, so the share was
            // being drawn at `legendX + W - 8` — off the right of the canvas
            // entirely, which is why the legend had names and no numbers.
            <g key={r.name} transform={`translate(${legendX} ${cy - (rows.length * 19) / 2 + i * 19 + 6})`}
              onPointerEnter={() => setHi(i)} onPointerLeave={() => setHi(null)}>
              <rect x={0} y={-7} width={9} height={9} rx={2} fill={SERIES[i % SERIES.length]}
                opacity={hi === null || hi === i ? 1 : 0.4} />
              <text x={15} y={0} fontSize={11} fill="var(--text2)">
                {clip(r.name, Math.max(4, Math.floor((legendW - 120) / 6.2)))}
              </text>
              <text x={legendW - 58} y={0} fontSize={11} textAnchor="end"
                fill="var(--text)" className="tnum">
                {fmtStat(r.v, panel.unit)}
              </text>
              <text x={legendW - 8} y={0} fontSize={11} textAnchor="end"
                fill="var(--muted)" className="tnum">
                {total > 0 ? `${((r.v / total) * 100).toFixed(1)}%` : '—'}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  )
}

// ── gauge ──────────────────────────────────────────────────────────────────
/** One number against the range it has actually been in.
 *
 *  A gauge with no target is a decoration: a needle at some angle, against
 *  nothing. There is no target in the model — a metric object has a direction
 *  and no goal — so the honest scale is the window's own low and high, and
 *  the question it answers is "where in its recent range is this now".
 */
function GaugePanel({ panel, win }: { panel: Panel; win: number[][] }) {
  const [measure, width] = usePlotWidth()
  const pts = (win[0] ?? []).filter(Number.isFinite)
  const value = collapse(pts, panel.agg)
  // One value has no range: the scale was 0.063 to 0.063, with the needle at
  // its left end. Then the scale starts at zero and ends at a round number above
  // the value — 1 for a fraction, the next 1/2/5 step otherwise.
  const single = Math.max(...pts, value) - Math.min(...pts, value) < Math.abs(value) * 1e-9 + 1e-12
  const roundUp = (x: number) => { const m = 10 ** Math.floor(Math.log10(x)); return [1, 2, 5, 10].map(k => k * m).find(k => k >= x) ?? 10 * m }
  const lo = single ? Math.min(0, value) : Math.min(...pts, value)
  const hi = single ? (value > 0 && value <= 1 ? 1 : value > 0 ? roundUp(value * 1.25) : 1) : Math.max(...pts, value)
  const span = hi - lo || 1
  const frac = Math.min(1, Math.max(0, (value - lo) / span))

  const W = Math.max(200, Math.round(width) || 300)
  const H = plotH(panel)
  const R = Math.min(W / 2 - 24, H - 46, 132)
  const cx = W / 2
  const cy = H / 2 + R / 2.6
  const pt = (rad: number, t: number) => {
    const a = Math.PI * (1 + t)
    return `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`
  }
  const track = 13
  // The large-arc flag is ALWAYS 0. The gauge spans half a circle, so no sweep
  // across it can exceed 180 degrees — `t > 0.5` was reading t as a fraction
  // of a FULL turn and setting the flag for the track, which then drew the
  // reflex arc: the grey half circle appeared underneath the coloured one
  // instead of behind it.
  const arc = (t: number) =>
    `M${pt(R, 0)} A${R} ${R} 0 0 1 ${pt(R, t)}`
  // Up is good or down is good, and the colour follows the metric rather than
  // the geometry — a full gauge is not automatically a good one.
  const good = panel.better === 'down' ? frac < 0.5 : frac > 0.5

  return (
    <div className="p-plot" ref={measure} style={{ minHeight: H }}>
      {width > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
          aria-label={`${panel.title}. ${fmtStat(value, panel.unit)}, between ${
            fmtStat(lo, panel.unit)} and ${fmtStat(hi, panel.unit)} over the window.`}>
          <path d={arc(1)} fill="none" stroke="var(--sunk)" strokeWidth={track}
            strokeLinecap="round" />
          <path d={arc(Math.max(frac, 0.004))} fill="none" strokeWidth={track}
            strokeLinecap="round" stroke={good ? 'var(--pro)' : SERIES[1]} />
          <text x={cx} y={cy - 12} textAnchor="middle" fontSize={26} fontWeight={600}
            fill="var(--text)" className="tnum">{fmtStat(value, panel.unit)}</text>
          {/* The ends of the scale, said out loud. A gauge whose range is
              invisible is a needle pointing at nothing. */}
          <text x={cx - R} y={cy + 19} textAnchor="middle" fontSize={10.5} fill="var(--muted)"
            className="tnum">{fmtStat(lo, panel.unit)}</text>
          <text x={cx + R} y={cy + 19} textAnchor="middle" fontSize={10.5} fill="var(--muted)"
            className="tnum">{fmtStat(hi, panel.unit)}</text>
          <text x={cx} y={cy + 19} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
            {single ? 'one value — scale from zero' : 'its range over the window'}
          </text>
        </svg>
      )}
    </div>
  )
}

// ── heatmap ────────────────────────────────────────────────────────────────
function HeatPanel({ panel, win }: { panel: Panel; win: number[][] }) {
  const [measure, width] = usePlotWidth()
  const [hi, setHi] = useState<{ r: number; c: number } | null>(null)
  // The generator gives every series a 7-day rhythm, so bucketing the same
  // window by weekday reads that rhythm back out of the very same numbers.
  // Bucket on the day's position in the *full* history, not in the window —
  // otherwise a range change slides every column onto a different weekday.
  const grid = useMemo(() => weekGrid(panel, win), [panel, win])
  const flat = grid.flat().filter(Number.isFinite)
  const lo = Math.min(...flat)
  const hiV = Math.max(...flat)
  const step = (v: number) => Number.isFinite(v) ? SEQ[Math.min(SEQ.length - 1, Math.floor(((v - lo) / (hiV - lo || 1)) * SEQ.length))] : 'var(--panel2)'

  const W = Math.max(360, Math.round(width) || 900)
  const L = 118
  const cellH = 26
  const H = grid.length * cellH + 22
  const cellW = (W - L - 8) / WEEK.length

  return (
    <>
      <div className="p-plot" ref={measure} style={{ minHeight: H }}>
        {width > 0 && (
          <svg
            viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="p-svg" role="img"
            aria-label={`${panel.title}. Mean ${panel.metric.replace(/_/g, ' ')} per weekday for ${grid.length} categories, from ${fmtStat(lo, panel.unit)} to ${fmtStat(hiV, panel.unit)}. The table view lists every cell.`}
          >
            {WEEK.map((d, c) => (
              <text key={d} x={L + c * cellW + cellW / 2} y={12} fontSize={9.5} fill="var(--muted)" textAnchor="middle">{d}</text>
            ))}
            {grid.map((row, r) => (
              <g key={panel.series[r].name}>
                <text x={L - 10} y={22 + r * cellH + cellH / 2 + 3.5} fontSize={10.5} fill="var(--muted)" textAnchor="end">
                  {clip(panel.series[r].name, 17)}
                </text>
                {row.map((v, c) => (
                  <rect
                    key={c}
                    x={L + c * cellW + 1} y={22 + r * cellH + 1}
                    width={Math.max(0, cellW - 2)} height={cellH - 2} rx={3}
                    fill={step(v)}
                    stroke={hi && hi.r === r && hi.c === c ? 'var(--ink)' : 'none'} strokeWidth={1.5}
                    onPointerEnter={() => setHi({ r, c })} onPointerLeave={() => setHi(null)}
                  />
                ))}
              </g>
            ))}
          </svg>
        )}
        {hi && (
          <Tip
            x={L + hi.c * cellW + cellW / 2} W={W} head={`${panel.series[hi.r].name} · ${WEEK[hi.c]}`}
            rows={[{ name: `mean ${panel.metric.replace(/_/g, ' ')}`, value: fmtStat(grid[hi.r][hi.c], panel.unit), color: step(grid[hi.r][hi.c]) }]}
          />
        )}
      </div>
      <div className="p-scale">
        <span className="tnum">{fmtStat(lo, panel.unit)}</span>
        {SEQ.map(c => <i key={c} style={{ background: c }} />)}
        <span className="tnum">{fmtStat(hiV, panel.unit)}</span>
      </div>
    </>
  )
}

// ── table view — every panel has one ───────────────────────────────────────
/** The table with its margins: a total per row and per column.
 *
 *  That is the whole difference between a table and a pivot table, and the
 *  numbers for it are already on the panel — a series per row, a bucket per
 *  column. Reading a column of daily figures and adding them up by eye is what
 *  the margin is for.
 */
function PivotView({ panel, win }: { panel: Panel; win: number[][] }) {
  const names = panel.series.map(s => s.name)
  const days = win[0]?.length ?? 0
  const dates = panel.bucketDates?.slice(-days) ?? []
  // Newest first, and capped: a pivot of ninety columns is a spreadsheet, and
  // the point of the margin is that you do not have to scroll to it.
  const cols = Array.from({ length: Math.min(days, 14) }, (_, i) => days - 1 - i)
  const cell = (i: number, d: number) => win[i]?.[d] ?? Number.NaN
  const rowTotal = (i: number) => collapse(win[i] ?? [], panel.agg)
  const colTotal = (d: number) =>
    collapse(names.map((_, i) => cell(i, d)), panel.agg === 'last' ? 'sum' : panel.agg)
  const grand = collapse(names.map((_, i) => rowTotal(i)),
                         panel.agg === 'last' ? 'sum' : panel.agg)

  // The newest column, when its period is still under way, says so: its small
  // numbers are a part-week, not a bad week.
  const open = (d: number) => d === days - 1 && partialLast(panel)
  const so = (d: number) => open(d) ? ' pv-partial' : ''
  return (
    <TableShell height={plotH(panel)}
      head={[panel.metric.replace(/_/g, ' '), panel.agg, ...cols.map(d =>
        (dates[d] ? dates[d].slice(5) : dayLabel(days - 1 - d)) + (open(d) ? ' so far' : ''))]}>
      {names.map((name, i) => (
        <tr key={name}>
          <td>{name}</td>
          <td className="pv-total">{fmtStat(rowTotal(i), panel.unit)}</td>
          {cols.map(d => <td key={d} className={so(d) || undefined}>{fmtStat(cell(i, d), panel.unit)}</td>)}
        </tr>
      ))}
      {names.length > 1 && (
        <tr className="pv-margin">
          <td>all</td>
          <td className="pv-total">{fmtStat(grand, panel.unit)}</td>
          {cols.map(d => <td key={d} className={so(d) || undefined}>{fmtStat(colTotal(d), panel.unit)}</td>)}
        </tr>
      )}
    </TableShell>
  )
}

function TableView({ panel, win }: { panel: Panel; win: number[][] }) {
  const names = panel.series.map(s => s.name)
  if (panel.kind === 'pivot') return <PivotView panel={panel} win={win} />
  if (panel.kind === 'bar' || (panel.windowed && panel.grain === 'none')) {
    const rows = names.map((name, i) => ({ name, v: collapse(win[i], panel.agg) }))
    const total = rows.reduce((a, r) => a + (Number.isFinite(r.v) ? r.v : 0), 0)
    return (
      <TableShell height={plotH(panel)}
        head={[panel.metric.replace(/_/g, ' '), 'value', 'share']}>
        {rows.map(r => (
          <tr key={r.name}>
            <td>{r.name}</td><td>{fmtStat(r.v, panel.unit)}</td>
            <td>{total > 0 && Number.isFinite(r.v) ? `${((r.v / total) * 100).toFixed(1)}%` : '—'}</td>
          </tr>
        ))}
      </TableShell>
    )
  }
  if (panel.kind === 'heat') {
    const grid = weekGrid(panel, win)
    return (
      <TableShell height={plotH(panel)} head={['category', ...WEEK]}>
        {grid.map((row, r) => (
          <tr key={names[r]}>
            <td>{names[r]}</td>
            {row.map((v, c) => <td key={c}>{fmtStat(v, panel.unit)}</td>)}
          </tr>
        ))}
      </TableShell>
    )
  }
  // Rows are days back from today, read from the end of each series. Series
  // do not all cover the same days — one warehouse can start later than the
  // other — so they line up on their latest day, and a day a series does not
  // have is a dash rather than someone else's number (or a crash, which is
  // what indexing every series by the first one's length produced).
  const n = Math.max(0, ...win.map(s => s.length))
  return (
    <TableShell height={plotH(panel)}
      head={[!panel.bucketDates?.length ? 'day' : ['hour', 'minute'].includes(panel.grain ?? '') ? 'Time' : 'Date', ...names]}>
      {Array.from({ length: n }, (_, ago) => (
        <tr key={ago}>
          <td>{bucketLabel(panel, n - 1 - ago, n)}</td>
          {win.map((s, k) => <td key={k}>{fmtStat(s[s.length - 1 - ago], panel.unit)}</td>)}
        </tr>
      ))}
    </TableShell>
  )
}

function TableShell({ head, children, height = PLOT_H }: {
  head: string[]; children: React.ReactNode
  /** The panel's own height, where it has one — a table is the panel type
   *  most likely to want more of it, and the one a wider column does least
   *  for. */
  height?: number
}) {
  return (
    <div className="chart-table-wrap" style={{ maxHeight: height + 24 }}>
      <table className="chart-table">
        <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

// ── the card ───────────────────────────────────────────────────────────────
/** A panel that fails to draw says so in its own card, at its own width, and
 *  the rest of the dashboard carries on. Without it one bad value in one table
 *  replaced the whole app with a stack trace. */
class PanelBoundary extends Component<{ panel: Panel; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) { return { error } }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { panel } = this.props
    return (
      <div className={`panel panel-${panel.kind} panel-broken`} role="alert"
        style={{ '--span': panel.span, '--col': panel.col ?? 'auto' } as React.CSSProperties}>
        <div className="p-title">{panel.title}</div>
        <p className="p-broken">This panel could not be drawn — {error.message}. The rest of the
          dashboard is unaffected.</p>
        <button className="tool" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

/** One series against the same panel over the period before: "+12% vs the
 *  previous period", coloured by which way is better. Several series are
 *  left alone — which of them the sentence is about is not obvious. */
function Compared({ panel, win, prev }: { panel: Panel; win: number[][]; prev: number[][] }) {
  if (win.length !== 1 || !prev[0]?.some(Number.isFinite)) return null
  const now = collapse(win[0], panel.agg)
  const before = collapse(prev[0], panel.agg)
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null
  if (before === 0) return <> · <span className="p-compare">previous period: {fmtStat(0, panel.unit)}</span></>
  const change = ((now - before) / Math.abs(before)) * 100
  const good = panel.better === 'down' ? change < 0 : change > 0
  return <> · <span className={`p-compare ${Math.abs(change) < 0.05 ? '' : good ? 'good' : 'bad'}`}>
    {change >= 0 ? '+' : ''}{change.toFixed(1)}% vs the previous period ({fmtStat(before, panel.unit)})</span></>
}

export function PanelChart({ panel, days, onWidenRange, widenLabel, dataEnds, windowLabel }: {
  panel: Panel; days: number; onWidenRange?: () => void
  /** What the widening does, in words: "Show the last 60 days". */
  widenLabel?: string
  /** When this panel's data last had a reading, if the page has looked. */
  dataEnds?: string
  /** The window in words, for a range that is not a number of days. */
  windowLabel?: string
}) {
  // Keyed by the window too, so changing the range gives a failed panel a
  // fresh attempt rather than keeping it failed.
  return <PanelBoundary key={`${panel.id}:${days}`} panel={panel}><PanelBody panel={panel} days={days} onWidenRange={onWidenRange}
    widenLabel={widenLabel} dataEnds={dataEnds} windowLabel={windowLabel} /></PanelBoundary>
}

function PanelBody({ panel, days, onWidenRange, widenLabel, dataEnds, windowLabel }: {
  panel: Panel; days: number; onWidenRange?: () => void; widenLabel?: string; dataEnds?: string; windowLabel?: string
}) {
  // A `table` panel is one whose primary presentation is rows. Every panel has
  // had a table view behind a toggle since the accessibility pass; what was
  // missing was the ability to say "this one is a table" and have it open that
  // way. The toggle stays, because a table you want to see as a shape is one
  // click either direction.
  const [asTable, setAsTable] = useState(panel.kind === 'table' || panel.kind === 'pivot')
  const win = useMemo(() => panel.series.map(s => panel.windowed ? s.daily : s.daily.slice(-days)), [panel, days])
  // Live panels are windowed by the server; the window before arrives beside
  // them only when a comparison was asked for.
  const prev = useMemo(() => panel.series.map((s, i) => panel.windowed ? (panel.previous?.[i] ?? [])
    : s.daily.slice(-2 * days, -days)), [panel, days])
  const isStat = panel.kind === 'stat'
  // A panel carrying its own query returns rows, never a series, so the
  // empty-series gate below would swallow every one of them. Its own "no rows"
  // case is handled inside SqlRows, where the query is on hand to show.
  const isSql = panel.kind === 'sql'

  // A query that matched nothing is a legitimate answer, not a failure — an
  // empty table, or a window nothing happened in. Every renderer below indexes
  // series[0] on the first line, so this is gated once here rather than
  // defended five times. Seeded panels can never be empty, which is why this
  // only started mattering when panels became real queries.
  const empty = !isSql && !win.some(s => s.some(Number.isFinite))
  if (empty) {
    return (
      <div className={`panel panel-${panel.kind} panel-empty`}
        style={{ '--span': panel.span, '--col': panel.col ?? 'auto' } as React.CSSProperties}>
        <div className="p-binding">
          <i className={`dot dot-${panel.ratified ? 'green' : 'warn'}`} />
          <span className="mono">{panel.metric}</span>
        </div>
        <div className="p-title">{panel.title}</div>
        {/* An empty window is not a failure, and must not read like one:
            say what is known — when the data stops — and the one thing to do. */}
        <div className="p-none" role="status">
          Nothing in {windowLabel ?? `the last ${days} ${days === 1 ? 'day' : 'days'}`}.{' '}
          {dataEnds
            ? <>The latest reading is from {new Date(`${dataEnds.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US',
                { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.</>
            : win.some(s => s.length)
              ? <><span className="mono">{panel.dataset}</span> returned only missing values.</>
              : <><span className="mono">{panel.dataset}</span> returned no rows for this window.</>}
        </div>
        {onWidenRange && <button className="tool p-empty-action" onClick={onWidenRange}>{widenLabel ?? 'Try a wider date range'}</button>}
      </div>
    )
  }

  return (
    <div
      className={`panel panel-${panel.kind}`}
      // The span is a custom property, not an inline grid-column, so the
      // responsive rules can reflow the grid without fighting inline specificity.
      style={{ '--span': panel.span, '--col': panel.col ?? 'auto' } as React.CSSProperties}
    >
      {isStat ? (
        <StatPanel panel={panel} win={win} prev={prev} />
      ) : (
        <>
          <div className="p-head">
            <div>
              <div className="p-binding">
                <i className={`dot dot-${!isSql && panel.ratified ? 'green' : 'warn'}`} />
                {/* There is no metric to name, so naming one would be a lie.
                    What this panel binds to is a query, and the honest label
                    is that it binds to nothing anyone has agreed on. */}
                {isSql
                  ? <span className="mono">raw SQL · no definition</span>
                  : <>
                      <span className="mono">{panel.metric}</span>
                      {panel.ratified ? ' · ratified' : ' · not ratified'}
                    </>}
              </div>
              <div className="p-title-row"><div className="p-title">{panel.title}</div>{!isSql && <DefinitionTip panel={panel} />}</div>
            </div>
            {!isSql && (
              <div className="seg" role="group" aria-label={`${panel.title} display`}>
                <button className={asTable ? '' : 'on'} aria-pressed={!asTable} onClick={() => setAsTable(false)}>Chart</button>
                <button className={asTable ? 'on' : ''} aria-pressed={asTable} onClick={() => setAsTable(true)}>Table</button>
              </div>
            )}
          </div>
          {panel.kind === 'sql' ? <SqlRows panel={panel} />
            : asTable ? <TableView panel={panel} win={win} />
            : panel.kind === 'bar' ? <BarPanel panel={panel} win={win} />
            : panel.kind === 'heat' ? <HeatPanel panel={panel} win={win} />
            : panel.kind === 'pie' ? <PiePanel panel={panel} win={win} />
            : panel.kind === 'gauge' ? <GaugePanel panel={panel} win={win} />
            : <TimePanel panel={panel} win={win} />}
          <div className="p-foot">
            {/* A SQL panel has no dataset binding and no aggregate — it ran
                the author's statement against a connection and printed what
                came back. The foot says that instead of borrowing vocabulary
                from panels that do have those things. */}
            <span className="mono">{isSql ? 'ran as written'
              : panel.source === 'prometheus' ? 'prometheus' : panel.dataset}</span>
            {/* How the window's buckets became one value — only where they did:
                a chart showing every day, or a single value over the whole
                range, read "mean over the window" for a sum of revenue. */}
            {!isSql && ['pie', 'bar', 'gauge'].includes(panel.kind) && (panel.bucketDates?.length ?? 0) > 1 && panel.grain && panel.grain !== 'none' &&
              <>{' · '}{panel.agg === 'last' ? 'latest' : panel.agg} of each {panel.grain} over the window</>}
            {!isStat && <Compared panel={panel} win={win} prev={prev} />}
            {panel.bucketDates?.length ? <> · <span>Through {bucketLabel(panel, panel.bucketDates.length - 1, panel.bucketDates.length)}</span></> : null}
            {/* A panel that explains its own state does not also need the
                generic explanation. The draft on the authoring bench is not on
                any dashboard yet, so "two dashboards can disagree" is not the
                thing wrong with it — "nobody has written it down" is. */}
            {/* The dashboard asked for a slice this card could not take. Said
                here, on the card, because that is where somebody reading the
                number is looking — a caption at the top of the page saying
                "EMEA" over a card showing the worldwide total is the exact
                failure a scoped filter produces silently. */}
            {(panel.filtersSkipped?.length ?? 0) > 0 && (
              <> · <span className="p-warn">
                not filtered by {panel.filtersSkipped!.map(f => f.dimension).join(', ')} —
                {' '}{panel.filtersSkipped![0].why}. This is the unsliced number.
              </span></>
            )}
            {(panel.filtersApplied?.length ?? 0) > 0 && (
              <> · <span className="p-slice">
                {panel.filtersApplied!.map(f => f.dimension).join(', ')} filtered
              </span></>
            )}
            {isSql
              ? <> · <span className="p-warn">this panel is not certified — nobody has ratified the number it prints</span></>
              : panel.note
              ? <> · <span className="p-warn">{panel.note === 'draft'
                  ? 'a draft — saved when you create the dashboard'
                  : panel.note}</span></>
              : !panel.ratified && <> · <span className="p-warn">this metric has no ratified definition — two dashboards can legitimately disagree on it</span></>}
            {/* The binding, not a copy of it: every panel citing this metric sends
                the identical expression, which is why the numbers agree. */}
            {/* SqlRows already puts the query on the face — the one panel
                whose number nobody stands behind is the one that should not
                hide what produced it in a drawer. */}
          </div>
        </>
      )}
    </div>
  )
}

/** A panel that carried its own query, shown as the rows it returned.
 *
 *  No unit to scale by and no grain to bucket into — an arbitrary SELECT has
 *  neither — so the values are printed as they came back. The query is on the
 *  face rather than in a drawer: this is the one panel whose number nobody has
 *  stood behind, and the SQL is the only thing a reader can check it against.
 */
function SqlRows({ panel }: { panel: Panel }) {
  const cols = panel.columns ?? []
  const rows = panel.rows ?? []
  if (!cols.length) return <div className="p-empty">The query returned no columns.</div>
  // Each number column to its own consistent decimals (at most two), grouped
  // in thousands: "1622.8" over "1206.44" did not line up or read as money.
  const dps = cols.map((_, j) => Math.min(2, Math.max(0, ...rows.map(r => {
    const v = r[j]
    return typeof v === 'number' && !Number.isInteger(v) ? (String(v).split('.')[1]?.length ?? 0) : 0
  }))))
  const num = (v: number, j: number) => v.toLocaleString(undefined, { minimumFractionDigits: dps[j], maximumFractionDigits: dps[j] })

  return (
    <div className="sqlp">
      {/* A query panel is the one most likely to be resized for height: the
          fix for "I cannot see the rows" is more rows, not a wider column. */}
      <div className="sqlp-scroll" style={{ maxHeight: plotH(panel) + 36 }}>
        <table className="sqlp-table">
          <thead>
            <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'num tnum' : ''}>
                    {v === null ? <span className="sqlp-null">null</span> : typeof v === 'number' ? num(v, j) : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <div className="p-empty">No rows.</div>}
      {/* Open, not collapsed. The foot already says nobody ratified this
          number; the query is the only thing a reader can check it against,
          so it does not go behind a disclosure triangle. */}
      <pre className="sqlp-q">{panel.sql}</pre>
    </div>
  )
}
