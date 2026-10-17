/**
 * Taking numbers out of the workspace.
 *
 * Every BI tool has this and it is the one export that reliably destroys the
 * thing this platform is for. A CSV is a grid of numbers with no definition,
 * no window, no slice and no certification — and the moment it lands in a
 * spreadsheet it is indistinguishable from a number somebody typed. "Which
 * refund rate is this?" has no answer once the file is detached, which is
 * exactly the drift the metric registry exists to prevent.
 *
 * Refusing to export does not fix that; it just moves the export to a
 * screenshot, or to somebody re-typing the figures, which is worse because
 * then there is not even a filename. So the export exists and it carries its
 * own provenance: what each column means, which definition produced it,
 * whether anyone has ratified that definition, over what window, under which
 * filters, and which panels could not honour those filters.
 *
 * The provenance rides as leading `#` lines. Every tool that reads CSV
 * seriously skips them (pandas `comment='#'`, R `read.csv(comment.char='#')`,
 * DuckDB, csvkit); Excel shows them as text rows above the table, which is
 * ugly and readable and still better than a grid that has forgotten where it
 * came from.
 */
import type { Dashboard, Panel } from './types'
import type { WireFilter } from './gateway'

/** RFC 4180: quote when the value could otherwise change the parse. */
export function cell(v: unknown): string {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const row = (cells: unknown[]) => cells.map(cell).join(',')

function describeFilter(f: { dimension: string; op: string; values: unknown[] }) {
  return f.values.length ? `${f.dimension} ${f.op} ${f.values.join('|')}` : `${f.dimension} ${f.op}`
}

/** The dates a window of N days covers, oldest first, as ISO days.
 *
 *  Derived from the same tail-slice rule every chart uses, so the export and
 *  the picture are the same numbers on the same days rather than two
 *  independent reconstructions that agree until one of them changes. */
export function windowDays(days: number, today = new Date()): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export interface ExportContext {
  dashboard: Pick<Dashboard, 'id' | 'title'>
  days: number
  certified: boolean
  filters: WireFilter[]
  /** Panel ids that could not honour the filters. Named individually, because
   *  "3 panels are unfiltered" is not something a reader can act on and
   *  "Spend, Latency, Refunds are unfiltered" is. */
  partial: string[]
  generatedAt?: Date
}

/**
 * One long-format table for the whole dashboard.
 *
 *  panel, series, date, value — rather than a column per panel. A wide table
 *  needs every panel to share an axis, and this dashboard may hold a stat, a
 *  daily line, and a SQL panel returning three arbitrary columns. Long format
 *  is the only shape all three fit without inventing alignment that is not
 *  there, and it is what a pivot table wants anyway.
 */
export function dashboardCsv(panels: Panel[], ctx: ExportContext): string {
  const now = ctx.generatedAt ?? new Date()
  const dates = windowDays(ctx.days, now)
  const partial = new Set(ctx.partial)

  const head = [
    `# ${ctx.dashboard.title}`,
    `# exported ${now.toISOString()} from the CommonIndex workspace`,
    `# window: last ${ctx.days} days, ending ${dates[dates.length - 1]}`,
    '# each row is one BUCKET, not one day — `covers` says which',
    `# certified: ${ctx.certified ? 'yes — every panel cites a ratified definition'
      : 'NO — at least one panel cites a definition nobody has ratified'}`,
    ctx.filters.length
      ? `# filters: ${ctx.filters.map(describeFilter).join('; ')}`
      : '# filters: none',
  ]
  // Gated on what the render reported, not on whether this caller thinks it
  // asked for a filter. The render is the one that ran the queries.
  if (partial.size) {
    const names = panels.filter(p => partial.has(p.id)).map(p => p.title)
    head.push(`# NOT filtered: ${names.join('; ')} — these rows are unsliced totals`)
  }
  head.push('#')

  const body: string[] = [
    row(['panel', 'metric', 'ratified', 'series', 'bucket_start', 'covers', 'value', 'unit'])]
  for (const p of panels) {
    // A panel carrying its own query has no metric, no unit and no date axis.
    // Forcing it into these columns would be filling them with something, and
    // the something would be wrong.
    if (p.kind === 'sql') continue
    const grain = p.grain ?? 'day'
    // The dates the panel actually plotted. `daily` holds one entry per
    // BUCKET, so a weekly panel's four entries are four weeks — and labelling
    // them with four consecutive calendar days, which is what deriving the
    // date from the index did, put values up to a month from where they
    // belong. In the file whose entire purpose is provenance.
    const stamps = p.bucketDates?.length ? p.bucketDates : dates
    for (const s of p.series) {
      const win = p.windowed ? s.daily : s.daily.slice(-ctx.days)
      // Right-aligned to the end: `daily` is a tail slice, so a series holding
      // fewer buckets than the window starts LATER, not earlier.
      const labels = stamps.slice(-win.length)
      win.forEach((v, i) => body.push(row([
        p.title, p.metric || '(none)', p.ratified ? 'yes' : 'no',
        s.name, labels[i] ?? '', grain, v, p.unit,
      ])))
    }
  }
  return [...head, ...body].join('\n') + '\n'
}

/**
 * One panel that carried its own query, as the columns it actually returned.
 *
 *  These do not go in the long table above: an arbitrary SELECT has no metric,
 *  no unit and no date axis, so it would be four empty columns and a lie in
 *  the fifth. It gets its own file, with the query itself in the header —
 *  which is the only thing standing behind the numbers.
 */
export function sqlPanelCsv(panel: Panel, ctx: ExportContext): string {
  const now = ctx.generatedAt ?? new Date()
  const head = [
    `# ${panel.title} — from ${ctx.dashboard.title}`,
    `# exported ${now.toISOString()} from the CommonIndex workspace`,
    '# NOT certified: this panel carries its own query and cites no ratified',
    '# definition, so nobody has agreed what these numbers mean.',
    `# query: ${(panel.sql ?? '').replace(/\s+/g, ' ').trim()}`,
    '#',
  ]
  const body = [row(panel.columns ?? []),
                ...(panel.rows ?? []).map(r => row(r))]
  return [...head, ...body].join('\n') + '\n'
}

/** A filename that still says what the file is once it is in a Downloads
 *  folder next to four others. */
export function exportName(title: string, ctx: ExportContext, suffix = ''): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const parts = [slug(title)]
  if (suffix) parts.push(slug(suffix))
  parts.push(`${ctx.days}d`)
  if (ctx.filters.length) parts.push(ctx.filters.map(f => slug(f.dimension)).join('-'))
  if (!ctx.certified) parts.push('uncertified')
  parts.push((ctx.generatedAt ?? new Date()).toISOString().slice(0, 10))
  return `${parts.filter(Boolean).join('_')}.csv`
}

/** Hand the file to the browser. Kept apart from the builders above so those
 *  stay pure and testable — the DOM half has nothing to assert. */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
