/**
 * The dashboard view, in the URL.
 *
 * A number without the slice it was taken under is not reproducible — the
 * export already carries that, and the link did not. Filter a dashboard to
 * EMEA over 90 days, paste the URL into a thread, and the person who opens it
 * sees the unfiltered 30-day default while both of you believe you are looking
 * at the same page. That is the same class of failure as an uncertified badge:
 * two readers, one number, no way to tell they disagree.
 *
 * Parsing here is deliberately forgiving. A URL is untrusted input that people
 * hand-edit and chat clients truncate, so a filter that will not parse is
 * dropped rather than raised — a broken link should open the dashboard, not an
 * error page. What is NOT forgiving is the operator: it is checked against the
 * closed table, so a hand-edited URL cannot introduce one the compiler would
 * not accept.
 */
import { RANGES, type FilterOp, type WireFilter } from './gateway'

/** `region~eq~emea`, or `arm~in~control|variant`. One `f` per filter.
 *
 *  `~` and `|` rather than `:` and `,` because both appear in real values —
 *  timestamps and lists — and a separator that collides with the data is a
 *  parser that works until somebody filters on a time. */
const SEP = '~'
const VALS = '|'

const OPS = new Set<string>([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in',
  'contains', 'starts_with', 'is_null', 'is_not_null', 'between',
])

export interface ViewState {
  /** `30d`, `mtd`, `qtd`, `ytd`, or `2026-08-01..2026-08-31`. */
  range: string
  filters: WireFilter[]
  /** Compared with the window of the same length just before. */
  compare?: boolean
}

/** Calendar periods, from their first day until now. */
export const TO_DATE = { mtd: 'Month to date', qtd: 'Quarter to date', ytd: 'Year to date' } as const
const SPAN = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

/** Whether the server would accept this range: the same closed forms. */
export function isRange(r: string | null | undefined): r is string {
  if (!r) return false
  if ((RANGES as readonly string[]).includes(r) || r in TO_DATE) return true
  const m = SPAN.exec(r)
  // A real day reads back as itself: Date rolls "2026-02-30" over to March.
  const real = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d }
  return !!m && real(m[1]) && real(m[2]) && m[1] <= m[2]
}

/** A span's two dates, or null for a preset or a period to date. */
export function spanOf(r: string): { from: string; to: string } | null {
  const m = SPAN.exec(r)
  return m ? { from: m[1], to: m[2] } : null
}

/** How many days a range covers, both ends of a span included. */
export function rangeDays(r: string, now = new Date()): number {
  if (/^\d+d$/.test(r)) return Number(r.slice(0, -1))
  const span = spanOf(r)
  if (span) return Math.round((Date.parse(span.to) - Date.parse(span.from)) / 864e5) + 1
  const start = new Date(Date.UTC(now.getUTCFullYear(),
    r === 'ytd' ? 0 : r === 'qtd' ? Math.floor(now.getUTCMonth() / 3) * 3 : now.getUTCMonth(), 1))
  return Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 864e5))
}

/** The range in words: "Last 30 days", "Month to date", "Aug 1 – Aug 31, 2026". */
export function rangeLabel(r: string): string {
  if (/^\d+d$/.test(r)) return `Last ${r.slice(0, -1)} ${r === '1d' ? 'day' : 'days'}`
  if (r in TO_DATE) return TO_DATE[r as keyof typeof TO_DATE]
  const span = spanOf(r)
  if (!span) return r
  const day = (d: string, year: boolean) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
  return span.from === span.to ? day(span.from, true) : `${day(span.from, false)} – ${day(span.to, true)}`
}

export function parseView(params: URLSearchParams, fallback: string): ViewState {
  const raw = params.get('range')
  const range = isRange(raw) ? raw : fallback

  const filters: WireFilter[] = []
  for (const f of params.getAll('f')) {
    const [dimension, op, joined = ''] = f.split(SEP)
    // Dropped, not raised: a truncated link should open the dashboard.
    if (!dimension || !OPS.has(op)) continue
    const values = joined ? joined.split(VALS).filter(Boolean) : []
    filters.push({ dimension, op: op as FilterOp, values })
  }
  return { range, filters, compare: params.get('cmp') === '1' }
}

/** The half a reader can copy. Written into the existing params so anything
 *  else on the URL survives. */
export function writeView(params: URLSearchParams, view: ViewState): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('range', view.range)
  if (view.compare) next.set('cmp', '1')
  else next.delete('cmp')
  next.delete('f')
  for (const f of view.filters) {
    next.append('f', [f.dimension, f.op, f.values.map(String).join(VALS)]
      .filter((p, i) => i < 2 || p !== '')
      .join(SEP))
  }
  return next
}

/** The window "previous period" means: as long as the range, ending the day
 *  before it starts. Named, because "previous period" alone left a reader to
 *  work out which days a "▼ 0.7%" was against. */
export function previousSpan(r: string, now = new Date()): { from: string; to: string } {
  const day = 864e5
  const n = rangeDays(r, now)
  const span = spanOf(r)
  const end = span ? Date.parse(`${span.to}T00:00:00Z`)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = end - (n - 1) * day
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  return { from: iso(start - n * day), to: iso(start - day) }
}

/** "Aug 15 – Sep 13" (the year only when the two ends differ in it, or it is not this one). */
export function spanWords(s: { from: string; to: string }, now = new Date()): string {
  const d = (x: string) => new Date(`${x}T00:00:00Z`)
  const a = d(s.from), b = d(s.to)
  const y = a.getUTCFullYear() !== b.getUTCFullYear() || b.getUTCFullYear() !== now.getUTCFullYear()
  const f = (x: Date, year: boolean) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(year ? { year: 'numeric' } : {}) })
  return `${f(a, y)} – ${f(b, y)}`
}
