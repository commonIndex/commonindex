/**
 * The export, and what it carries with it.
 *
 * A CSV is the one artefact that reliably destroys what this platform is for:
 * a grid of numbers with no definition, no window and no certification, which
 * in a spreadsheet is indistinguishable from a number somebody typed. These
 * assert that the provenance travels — not that the numbers are right, which
 * the panels already own.
 */
import { describe, expect, it } from 'vitest'

import { cell, dashboardCsv, exportName, sqlPanelCsv, windowDays } from '../csv'
import type { Panel } from '../types'
import type { ExportContext } from '../csv'

const AT = new Date('2026-09-03T10:00:00Z')

function ctx(over: Partial<ExportContext> = {}): ExportContext {
  return {
    dashboard: { id: 'dash-1', title: 'Checkout' } as ExportContext['dashboard'],
    days: 3, certified: true, filters: [], partial: [], generatedAt: AT, ...over,
  }
}

function panel(over: Partial<Panel> = {}): Panel {
  return {
    id: 'p1', title: 'Conversion', kind: 'line', unit: 'pct', better: 'up',
    metric: 'm.conversion', ratified: true, source: 'warehouse',
    expr: 'AVG(converted)', dataset: 'd.wide', span: 6, agg: 'mean',
    series: [{ name: 'all', daily: [0.1, 0.2, 0.3] }],
    ...over,
  }
}

const lines = (s: string) => s.trimEnd().split('\n')
const head = (s: string) => lines(s).filter(l => l.startsWith('#'))
const body = (s: string) => lines(s).filter(l => !l.startsWith('#'))

describe('quoting', () => {
  it('quotes what would otherwise change the parse', () => {
    expect(cell('a,b')).toBe('"a,b"')
    expect(cell('say "hi"')).toBe('"say ""hi"""')
    expect(cell('one\ntwo')).toBe('"one\ntwo"')
    expect(cell('plain')).toBe('plain')
  })

  it('writes null and undefined as empty, not as the word', () => {
    // "null" in a numeric column is a string that silently becomes text on
    // import, and every downstream aggregate then skips the column.
    expect(cell(null)).toBe('')
    expect(cell(undefined)).toBe('')
    expect(cell(0)).toBe('0')
  })
})

describe('the window', () => {
  it('exports all server-windowed buckets and leaves missing values blank', () => {
    const csv = dashboardCsv([panel({
      windowed: true, grain: 'hour', bucketDates: ['2026-09-01T01:00:00Z', '2026-09-01T02:00:00Z', '2026-09-01T03:00:00Z'],
      series: [{ name: 'all', daily: [1, NaN, 0] }],
    })], ctx({ days: 1 }))
    expect(body(csv)).toHaveLength(4)
    expect(body(csv)[1]).toContain('2026-09-01T01:00:00Z,hour,1,pct')
    expect(body(csv)[2]).toContain('2026-09-01T02:00:00Z,hour,,pct')
    expect(body(csv)[3]).toContain('2026-09-01T03:00:00Z,hour,0,pct')
  })
  it('is the same tail slice the charts draw', () => {
    expect(windowDays(3, AT)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  })

  it('right-aligns a series shorter than the window', () => {
    // `daily` is a tail slice, so a series holding fewer days than the window
    // starts LATER. Left-aligning would date every value wrongly and the error
    // would look like a plausible shift rather than a bug.
    const csv = dashboardCsv([panel({ series: [{ name: 'all', daily: [0.9] }] })], ctx())
    expect(body(csv).slice(1)).toEqual(
      ['Conversion,m.conversion,yes,all,2026-09-03,day,0.9,pct'])
  })
})

describe('what rides with the numbers', () => {
  it('names the window, so a number cannot be read against the wrong period', () => {
    expect(head(dashboardCsv([panel()], ctx())).join('\n'))
      .toMatch(/window: last 3 days, ending 2026-09-03/)
  })

  it('says plainly when nobody has ratified the definitions', () => {
    const h = head(dashboardCsv([panel()], ctx({ certified: false }))).join('\n')
    expect(h).toMatch(/certified: NO/)
    expect(h).toMatch(/nobody has ratified/)
  })

  it('carries the slice the numbers were taken under', () => {
    const h = head(dashboardCsv([panel()], ctx({
      filters: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
    }))).join('\n')
    expect(h).toMatch(/filters: region eq emea/)
  })

  it('names the panels the slice did not reach, not just how many', () => {
    // "3 panels are unfiltered" is not something a reader can act on once the
    // file is open in a spreadsheet; three titles are.
    const h = head(dashboardCsv(
      [panel(), panel({ id: 'p2', title: 'Spend' })],
      ctx({ filters: [{ dimension: 'region', op: 'eq', values: ['emea'] }], partial: ['p2'] }),
    )).join('\n')
    expect(h).toMatch(/NOT filtered: Spend/)
    expect(h).not.toMatch(/NOT filtered:.*Conversion/)
  })

  it('marks each row with the definition behind it and whether it is ratified', () => {
    const csv = dashboardCsv([panel({ ratified: false })], ctx())
    expect(body(csv)[0])
      .toBe('panel,metric,ratified,series,bucket_start,covers,value,unit')
    expect(body(csv)[1]).toContain('m.conversion,no')
  })
})

describe('long format', () => {
  it('gives one row per series per day, so panels need not share an axis', () => {
    const csv = dashboardCsv([panel({
      series: [{ name: 'control', daily: [1, 2, 3] }, { name: 'variant', daily: [4, 5, 6] }],
    })], ctx())
    expect(body(csv)).toHaveLength(1 + 6)
  })

  it('leaves a query panel out of the shared table', () => {
    // An arbitrary SELECT has no metric, no unit and no date axis. Forcing it
    // into those columns fills four with nothing and the fifth with a lie.
    const csv = dashboardCsv([panel(), panel({
      id: 'p2', title: 'Raw', kind: 'sql', sql: 'select 1',
      columns: ['n'], rows: [[1]], series: [],
    })], ctx())
    expect(csv).not.toMatch(/Raw/)
  })
})

describe('a query panel exports on its own', () => {
  it('as the columns it actually returned', () => {
    const csv = sqlPanelCsv(panel({
      title: 'Raw', kind: 'sql', sql: 'select arm,\n  count(*) as users from t group by 1',
      columns: ['arm', 'users'], rows: [['control', 4000], ['variant', 4000]], series: [],
    }), ctx({ certified: false }))
    expect(body(csv)).toEqual(['arm,users', 'control,4000', 'variant,4000'])
  })

  it('with the query itself, since that is all that stands behind it', () => {
    const csv = sqlPanelCsv(panel({
      title: 'Raw', kind: 'sql', sql: 'select arm,\n  count(*) from t', series: [],
      columns: ['arm'], rows: [],
    }), ctx())
    // Flattened to one line so it survives being a CSV comment.
    expect(head(csv).join('\n')).toMatch(/# query: select arm, count\(\*\) from t/)
    expect(head(csv).join('\n')).toMatch(/NOT certified/)
  })
})

describe('the filename', () => {
  it('still says what the file is, in a folder full of others', () => {
    expect(exportName('Checkout conversion', ctx()))
      .toBe('checkout-conversion_3d_2026-09-03.csv')
  })

  it('says when the numbers were not certified', () => {
    expect(exportName('Checkout', ctx({ certified: false })))
      .toContain('uncertified')
  })

  it('says which slice, so two exports of one dashboard are distinguishable', () => {
    expect(exportName('Checkout', ctx({
      filters: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
    }))).toContain('region')
  })
})

describe('a panel that is not daily', () => {
  it('dates each row by the bucket it actually covers', () => {
    // `daily` holds one entry per BUCKET. Four weekly points labelled with
    // four consecutive calendar days put values up to a month from where they
    // belong — in the file whose entire purpose is provenance.
    const csv = dashboardCsv([panel({
      grain: 'week',
      series: [{ name: 'all', daily: [10, 20, 30, 40] }],
      bucketDates: ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'],
    })], ctx({ days: 30 }))
    expect(body(csv).slice(1)).toEqual([
      'Conversion,m.conversion,yes,all,2026-08-03,week,10,pct',
      'Conversion,m.conversion,yes,all,2026-08-10,week,20,pct',
      'Conversion,m.conversion,yes,all,2026-08-17,week,30,pct',
      'Conversion,m.conversion,yes,all,2026-08-24,week,40,pct',
    ])
  })

  it('says what a row covers, so a week is not read as a day', () => {
    const csv = dashboardCsv([panel({ grain: 'month' })], ctx())
    expect(head(csv).join('\n')).toMatch(/one BUCKET, not one day/)
    expect(body(csv)[1]).toContain(',month,')
  })
})
