/**
 * The wire, converted.
 *
 * `SqlPanel.test.tsx` builds a `Panel` by hand and asserts the component draws
 * it. That passed the whole time `toPanel` — the only thing that ever produces
 * a real one — threw on every SQL panel, because a panel citing no definition
 * has `metric_id: null` and this called `.split('.')` on it. The throw landed
 * in the render effect's catch, so a dashboard holding an inline-SQL panel
 * showed "Could not reach the gateway" with instructions to start uvicorn.
 *
 * The type said `metric_id: string`, so the compiler saw nothing. Verifying
 * through the API said nothing either — the API was correct. Only running the
 * conversion on what the API actually returns finds this.
 */
import { describe, expect, it, vi } from 'vitest'

import { toPanel, type WirePanel } from '../gateway'

/** Copied from a live `dashboards.render` against a dashboard with both kinds
 *  of panel on two warehouses. */
const CITED: WirePanel = {
  panel: {
    id: 'p1', title: 'Checkout conversion', mark: 'line',
    metric_id: 'dash-two_warehouses-31f44eef.checkout_conversion',
    dataset_id: 'public.exp_checkout_clean', grain: 'day',
  },
  label: 'Checkout conversion', unit: 'pct', better: 'up',
  series: [{ name: 'all', points: [['2026-09-01T00:00:00Z', 0.108]] }],
  filters_applied: [], filters_skipped: [],
}

const CARRIES_ITS_OWN: WirePanel = {
  panel: {
    id: 'p3', title: 'Refunds by arm (raw)', mark: 'sql',
    metric_id: null, dataset_id: '', grain: 'none',
  },
  unit: null, better: null,
  sql: 'select arm, count(*) as users from exp_checkout_clean group by 1',
  columns: ['arm', 'users'],
  rows: [['control', 4000], ['variant', 4000]],
  filters_applied: [], filters_skipped: [],
}

describe('converting a panel off the wire', () => {
  it('uses the authored panel title, not the underlying metric label', () => {
    expect(toPanel({ ...CITED, panel: { ...CITED.panel, title: 'Revenue by team' } }, 6).title).toBe('Revenue by team')
  })

  it('aligns series by timestamp and preserves missing readings, including SQL null', () => {
    const p = toPanel({ ...CITED, unit: 'count', series: [
      { name: 'a', points: [['2026-09-01T00:00:00Z', 12], ['2026-09-03T00:00:00Z', null]] },
      { name: 'b', points: [['2026-09-02T00:00:00Z', 0], ['2026-09-03T00:00:00Z', 8]] },
    ] }, 6)
    expect(p.windowed).toBe(true)
    expect(p.bucketDates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(p.series[0].daily).toEqual([12, NaN, NaN])
    expect(p.series[1].daily).toEqual([NaN, 0, 8])
  })

  it('does not invent zero buckets between observations or treat monthly buckets as days', () => {
    const p = toPanel({ ...CITED, panel: { ...CITED.panel, grain: 'month' }, series: [
      { name: 'all', points: [['2026-07-01T00:00:00Z', 1], ['2026-09-01T00:00:00Z', 2]] },
    ] }, 6)
    expect(p.bucketDates).toEqual(['2026-07-01', '2026-09-01'])
    expect(p.series[0].daily).toEqual([100, 200])
  })

  it("reads the warehouse's dates and wall-clock times as written, whatever this browser's zone", () => {
    // Buckets arrive as the warehouse's calendar dates and wall-clock times.
    // Read in this browser's zone, a time without one moved by its offset.
    vi.stubEnv('TZ', 'Asia/Kolkata')
    try {
      const days = toPanel({ ...CITED, series: [{ name: 'all', points: [['2026-08-26', 1]] }] }, 6)
      expect(days.bucketDates).toEqual(['2026-08-26'])
      const hours = toPanel({ ...CITED, panel: { ...CITED.panel, grain: 'hour' },
        series: [{ name: 'all', points: [['2026-08-26T05:00:00', 1]] }] }, 6)
      expect(hours.bucketDates).toEqual(['2026-08-26T05:00:00.000Z'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('carries the previous period beside each series, by name', () => {
    const p = toPanel({ ...CITED, unit: 'count', series: [{ name: 'a', points: [['2026-09-02', 3]] }],
      previous: [{ name: 'b', points: [['2026-08-01', 9]] }, { name: 'a', points: [['2026-08-02', 2], ['2026-08-03', null]] }] }, 6)
    expect(p.previous).toEqual([[2, NaN]])
    expect(toPanel(CITED, 6).previous).toBeUndefined()
  })

  it('retains the full timestamp of sub-day buckets', () => {
    const p = toPanel({ ...CITED, panel: { ...CITED.panel, grain: 'hour' } }, 6)
    expect(p.bucketDates).toEqual(['2026-09-01T00:00:00.000Z'])
  })
  it('does not throw on a panel that cites no definition', () => {
    expect(() => toPanel(CARRIES_ITS_OWN, 6)).not.toThrow()
  })

  it('leaves the metric empty rather than inventing one', () => {
    const p = toPanel(CARRIES_ITS_OWN, 6)
    expect(p.metric).toBe('')
    expect(p.kind).toBe('sql')
    expect(p.rows).toEqual([['control', 4000], ['variant', 4000]])
  })

  it('shows the query where a bound panel shows its expression', () => {
    // The definition drawer is where a reader looks for "what produced this".
    // For this panel the query IS that, and an empty drawer would be the one
    // panel with nothing to check hiding the only thing there is to check.
    expect(toPanel(CARRIES_ITS_OWN, 6).expr).toContain('select arm, count(*)')
  })

  it('still shortens a real metric id to its last segment', () => {
    const p = toPanel(CITED, 6)
    expect(p.metric).toBe('checkout_conversion')
    expect(p.expr).toContain('dash-two_warehouses-31f44eef.checkout_conversion')
    expect(p.expr).toContain('public.exp_checkout_clean')
  })

  it('converts a whole mixed dashboard, which is the shape that broke', () => {
    const panels = [CITED, CARRIES_ITS_OWN].map(w => toPanel(w, 6))
    expect(panels.map(p => p.kind)).toEqual(['line', 'sql'])
  })
})
