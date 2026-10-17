import { useCallback, useRef, useState } from 'react'
import type { MetricUnit } from '../data/types'

// Shared chart primitives. Both the experiment readout and every dashboard
// panel draw through these, so a number formats the same wherever it appears
// and a gridline lands on the same round values.

// Categorical slots, in fixed order — identity, never rank. Slot 1 is the same
// blue the readout chart uses for control, so the product has one blue. The
// order is the colorblind-safety mechanism: validated against this surface
// (#fffdf9) at worst-adjacent ΔE 9.1 under protanopia, 19.6 unsimulated.
// Slots 3, 4 and 5 sit below 3:1 against paper, which is why every panel
// carries a table view — that is the relief, not an optional extra.
export const SERIES = ['#1d63dd', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']

/** Sequential ramp for magnitude — one hue, light → dark. Never for identity. */
export const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']

/** A value there is nothing to say about: missing, null, or not a number.
 *  Warehouse series do not all cover the same days, so every formatter below
 *  meets one sooner or later — and a formatter that throws takes the whole
 *  page down with it, where an em dash is the honest answer. */
export const MISSING = '—'
const absent = (v: unknown): v is null | undefined => typeof v !== 'number' || !Number.isFinite(v)

export function fmtValue(v: number | null | undefined, unit: MetricUnit) {
  if (absent(v)) return MISSING
  if (unit === 'currency') return `$${v.toFixed(2)}`
  if (unit === 'pct') return `${v.toFixed(2)}%`
  return v.toFixed(1)
}

export function fmtTick(v: number, unit: MetricUnit, step: number) {
  // As many decimals as the step actually needs — a 0.25 step labelled to one
  // decimal would print 2.25 as "2.3" and put a wrong number on a gridline.
  const s = String(step)
  const dp = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0
  return unit === 'currency' ? `$${v.toFixed(dp)}` : `${v.toFixed(dp)}${unit === 'pct' ? '%' : ''}`
}

export function signed(n: number, dp = 1) {
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`
}

// Gridlines land on round numbers *inside* the domain — the domain is set by
// the data, so the lines stay vertically centred whatever the metric's scale.
export function ticksFor(lo: number, hi: number, n: number) {
  const raw = (hi - lo) / n
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(+t.toFixed(6))
  return { ticks: out, step }
}

/** 1,284 · 12.9K · 4.2M · 0.097 — compact only once a number stops being
 *  readable in full, and never round one away.
 *
 *  This ended in `Math.round(v)`, which is right for a count of rows and wrong
 *  for everything else that arrives typed as one. A mean of a 0/1 column IS a
 *  conversion rate, and `AVG(converted)` is inferred as `count` because
 *  nothing tells the registry the column is a flag — so a real rate of 0.097
 *  was printed on the dashboard as `0`. Two arms at 0.093 and 0.130 both read
 *  `0`, on a page whose entire argument is that the numbers on it mean
 *  something.
 *
 *  A whole number is still written whole: rounding was never the problem, it
 *  was rounding a number that is not one.
 */
export function compact(v: number | null | undefined): string {
  if (absent(v)) return MISSING
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 10000) return `${(v / 1000).toFixed(1)}K`
  if (Number.isInteger(v)) return v.toLocaleString()
  // Past a hundred a fraction is noise; below it, it is the number.
  if (a >= 100) return Math.round(v).toLocaleString()
  if (a >= 1) return v.toFixed(1)
  // Two significant figures, so 0.097 and 0.13 stay distinguishable and a
  // value smaller than either does not collapse to nothing.
  return trimZeros(v.toPrecision(2))
}

const trimZeros = (s: string) =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s

/** The display form of a value: what a stat tile shows and a tooltip repeats. */
export function fmtStat(v: number | null | undefined, unit: MetricUnit): string {
  if (absent(v)) return MISSING
  if (unit === 'pct') return `${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%`
  if (unit === 'currency') return Math.abs(v) >= 10000 ? `$${compact(v)}` : `$${v.toFixed(2)}`
  return compact(v)
}

/** Axis ticks: round numbers, compacted, never more decimals than the step needs. */
export function fmtAxis(v: number | null | undefined, unit: MetricUnit, step: number): string {
  if (absent(v)) return MISSING
  if (unit === 'pct') return fmtTick(v, unit, step)
  // In thousands from $1,000, not $10,000: one axis read "$10.0K" over
  // "$7500" — two notations for one scale.
  if (unit === 'currency') return Math.abs(v) >= 1000 ? `$${trimZeros((v / 1000).toFixed(1))}K` : `$${Math.round(v)}`
  return compact(v)
}

/** A value beside a line's last point: as short as the axis it sits next to.
 *  "$4813.15" in full ran off the card's edge and matched nothing around it. */
export function fmtShort(v: number | null | undefined, unit: MetricUnit): string {
  if (absent(v)) return MISSING
  if (unit === 'currency' && Math.abs(v) >= 1000) return `$${trimZeros((v / 1000).toFixed(1))}K`
  return fmtStat(v, unit)
}

/** Truncate a category label to what an axis gutter can actually hold. */
export function clip(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/**
 * Measures the plot box. The SVG viewBox matches its rendered pixel size, so a
 * wider card buys more plot area instead of magnified labels. Re-measures
 * whenever the plot mounts (chart ↔ table) or the window resizes.
 */
export function usePlotWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const obs = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect()
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    obs.current = ro
  }, [])
  return [measure, width]
}
