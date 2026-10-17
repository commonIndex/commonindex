/**
 * A dashboard that stays up.
 *
 * Warehouse series do not all cover the same days. At 365 days the table on
 * "Two warehouses" had one series shorter than the other; the table indexed
 * every series by the first one's length, handed `undefined` to the number
 * formatter, and the formatter's throw replaced the whole app with a stack
 * trace. What is defended: a missing value reads as a dash, series line up on
 * their latest day, a panel that does fail says so in its own card, and a page
 * that fails does so inside the app.
 */
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { compact, fmtAxis, fmtShort, fmtStat, fmtValue } from '../chartkit'
import { PanelChart, partialLast } from '../PanelChart'
import { RouteError } from '../RouteError'
import type { Panel } from '../../data/types'

const table: Panel = {
  id: 'p-table', title: 'Spend by warehouse', kind: 'table', unit: 'count', better: 'up',
  metric: 'm.spend', ratified: false, source: 'warehouse', expr: 'SUM(spend)', dataset: 'd',
  span: 6, agg: 'sum', series: [],
}

describe('a missing value', () => {
  it.each(['line', 'area', 'stacked', 'stat', 'gauge', 'bar', 'heat'] as const)('draws %s geometry without NaN coordinates', kind => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 640, height: 300, top: 0, right: 640, bottom: 300, left: 0, x: 0, y: 0, toJSON: () => ({}),
    })
    try {
      const { container } = render(<PanelChart days={30} panel={{ ...table, kind, windowed: true,
        grain: 'day', bucketDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
        series: [{ name: 'first', daily: [3, NaN, 7, NaN] }, { name: 'second', daily: [NaN, 4, 0, NaN] }],
      }} />)
      expect(container.querySelector('svg')).toBeTruthy()
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally { rect.mockRestore() }
  })
  it('reads as a dash in every formatter, never a throw', () => {
    expect(compact(undefined)).toBe('—')
    expect(compact(null)).toBe('—')
    expect(fmtStat(undefined, 'count')).toBe('—')
    expect(fmtStat(null, 'pct')).toBe('—')
    expect(fmtStat(Number.NaN, 'currency')).toBe('—')
    expect(fmtValue(undefined, 'count')).toBe('—')
    expect(fmtAxis(undefined, 'count', 1)).toBe('—')
    // and a real zero is still a number
    expect(fmtStat(0, 'count')).toBe('0')
  })
})

describe('a table over series of different lengths', () => {
  it("labels live buckets with the warehouse's own dates rather than today", () => {
    render(<PanelChart days={1} panel={{ ...table, windowed: true,
      bucketDates: ['2026-08-01', '2026-08-04'], series: [{ name: 'all', daily: [42, NaN] }],
    }} />)
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'Aug 1, 2026' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'Aug 4, 2026' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '42' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '—' })).toBeTruthy()
    expect(screen.queryByText('today')).toBeNull()
  })
  it('lines them up on their latest day and dashes the days one does not have', () => {
    render(<PanelChart days={365} panel={{ ...table, series: [
      { name: 'ours', daily: [1, 2, 3, 4] },
      { name: 'theirs', daily: [30, 40] },   // started two days later
    ] }} />)
    const row = (label: string) => screen.getAllByRole('row').find(r => within(r).queryByText(label))!
    expect(within(row('today')).getByText('4')).toBeTruthy()
    expect(within(row('today')).getByText('40')).toBeTruthy()
    expect(within(row('1d')).getByText('30')).toBeTruthy()
    expect(within(row('3d')).getByText('1')).toBeTruthy()
    expect(within(row('3d')).getByText('—')).toBeTruthy()
  })
})

describe('a panel that cannot be drawn', () => {
  it('says so in its own card, and the page around it carries on', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<>
      <PanelChart days={3} panel={{ ...table, title: 'Broken panel', series: null as unknown as Panel['series'] }} />
      <p>the next panel</p>
    </>)
    expect(screen.getByRole('alert').textContent).toMatch(/Broken panel.*could not be drawn/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText('the next panel')).toBeTruthy()
    quiet.mockRestore()
  })
})

describe('a page that throws', () => {
  it('shows what happened inside the app, with the sidebar and a way back', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Boom(): never { throw new Error('kaboom') }
    const router = createMemoryRouter([{
      element: <div><nav>sidebar</nav><Outlet /></div>,
      children: [{ errorElement: <RouteError />, children: [{ path: '/x', element: <Boom /> }] }],
    }], { initialEntries: ['/x'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByText('This page hit a problem')).toBeTruthy()
    expect(screen.getByText('kaboom')).toBeTruthy()
    expect(screen.getByText('sidebar')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to the Board' }).getAttribute('href')).toBe('/board')
    quiet.mockRestore()
  })
})

describe('compared with the previous period', () => {
  it('says the change, coloured by which way is better', () => {
    render(<PanelChart days={30} panel={{ ...table, kind: 'line', windowed: true, better: 'down',
      bucketDates: ['2026-09-01', '2026-09-02'], series: [{ name: 'all', daily: [60, 60] }],
      previous: [[50, 50]] }} />)
    const said = screen.getByText(/vs the previous period/)
    expect(said.textContent).toBe('+20.0% vs the previous period (100)')
    expect(said.className).toMatch(/bad/)   // spend going up is worse
  })

  it('says nothing when no comparison was asked for', () => {
    render(<PanelChart days={30} panel={{ ...table, kind: 'line', windowed: true,
      bucketDates: ['2026-09-01'], series: [{ name: 'all', daily: [60] }] }} />)
    expect(screen.queryByText(/vs the previous period/)).toBeNull()
  })
})

describe('a number over the whole range', () => {
  it('draws no trend line: one value is not a trend, and its hover read "none bucket"', () => {
    const { container } = render(<PanelChart days={30} panel={{ ...table, kind: 'stat', title: 'Tickets', agg: 'sum',
      grain: 'none', bucketDates: ['2026-09-01'], series: [{ name: 'all', daily: [1228] }] }} />)
    expect(screen.getByText('1,228')).toBeTruthy()
    expect(container.querySelector('.p-spark')).toBeNull()
    expect(container.innerHTML).not.toMatch(/none bucket/)
  })
})

describe('money on an axis and at a line\'s end', () => {
  it('uses one notation from a thousand up, so an axis does not mix $10.0K and $7500', () => {
    expect([10000, 7500, 5000, 2500, 0].map(v => fmtAxis(v, 'currency', 2500))).toEqual(['$10K', '$7.5K', '$5K', '$2.5K', '$0'])
    expect(fmtShort(4813.15, 'currency')).toBe('$4.8K')
    expect(fmtShort(109.39, 'currency')).toBe('$109.39')
  })
})

describe('a period still under way', () => {
  const now = Date.parse('2026-10-14T15:00:00Z')            // a Wednesday afternoon
  it('is today, this week or this month — never a finished one', () => {
    expect(partialLast({ grain: 'day', bucketDates: ['2026-10-13', '2026-10-14'] }, now)).toBe(true)
    expect(partialLast({ grain: 'day', bucketDates: ['2026-10-11', '2026-10-12'] }, now)).toBe(false)
    expect(partialLast({ grain: 'week', bucketDates: ['2026-10-05', '2026-10-12'] }, now)).toBe(true)
    expect(partialLast({ grain: 'week', bucketDates: ['2026-09-28', '2026-10-05'] }, now)).toBe(false)
    expect(partialLast({ grain: 'month', bucketDates: ['2026-09-01', '2026-10-01'] }, now)).toBe(true)
    expect(partialLast({ grain: 'none', bucketDates: ['2026-10-14'] }, now)).toBe(false)
  })
})
