/**
 * Writing a number down.
 *
 * `compact` ended in `Math.round(v)` — right for a count of rows, wrong for
 * everything else that arrives typed as one. `AVG(converted)` over a 0/1
 * column IS a conversion rate, and nothing tells the registry the column is a
 * flag, so it is inferred as `count`. A real rate of 0.097 was printed on the
 * dashboard as `0`, and two arms at 0.093 and 0.130 both read `0` — on a page
 * whose entire argument is that the numbers on it mean something.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { compact, fmtStat } from '../chartkit'
import { PanelChart } from '../PanelChart'

describe('a number smaller than one', () => {
  it('is not rounded away', () => {
    expect(compact(0.0972)).toBe('0.097')
    expect(compact(0.135)).toBe('0.14')
    expect(compact(0.5)).toBe('0.5')
  })

  it('keeps two arms distinguishable', () => {
    // The failure exactly: control and variant, both printed `0`.
    expect(compact(0.0926)).not.toBe(compact(0.1296))
  })

  it('survives being small', () => {
    expect(compact(0.0004)).toBe('0.0004')
    expect(compact(0)).toBe('0')
  })

  it('keeps its sign', () => {
    expect(compact(-0.0926)).toBe('-0.093')
  })
})

describe('a whole number', () => {
  it('is still written whole', () => {
    // Rounding was never the problem; rounding a number that is not one was.
    expect(compact(0)).toBe('0')
    expect(compact(1)).toBe('1')
    expect(compact(42)).toBe('42')
    expect(compact(1284)).toBe('1,284')
  })

  it('still compacts once it stops being readable in full', () => {
    expect(compact(12900)).toBe('12.9K')
    expect(compact(4.2e6)).toBe('4.2M')
    expect(compact(3.1e9)).toBe('3.1B')
  })
})

describe('a fraction with a whole part', () => {
  it('keeps one decimal up to a hundred, and none past it', () => {
    expect(compact(2.5)).toBe('2.5')
    expect(compact(99.94)).toBe('99.9')
    // Past a hundred a fraction is noise.
    expect(compact(1234.5)).toBe('1,235')
  })
})

describe('the units that were never affected', () => {
  it('leaves a percentage alone', () => {
    expect(fmtStat(9.72, 'pct')).toBe('9.72%')
  })

  it('leaves money alone', () => {
    expect(fmtStat(86.77, 'currency')).toBe('$86.77')
  })

  it('routes a count through compact', () => {
    expect(fmtStat(0.0972, 'count')).toBe('0.097')
  })
})

describe('the number as it reaches the screen', () => {
  it('a conversion rate on a stat tile is not printed as zero', () => {
    // The formatter in isolation is one thing; this is the path the dashboard
    // actually takes. `AVG(converted)` over a 0/1 column comes back typed
    // `count`, and the tile rendered `0` for a real rate of 9.7%.
    render(<PanelChart days={3} panel={{
      id: 'p1', title: 'Checkout conversion', kind: 'stat',
      unit: 'count', better: 'up', metric: 'm.conversion', ratified: true,
      source: 'warehouse', expr: 'AVG(converted)', dataset: 'd', span: 3,
      agg: 'last', series: [{ name: 'all', daily: [0.09, 0.11, 0.0972] }],
    }} />)
    expect(screen.getByText('0.097')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('two arms that differ still look different', () => {
    // Both printed `0` — on a page whose entire argument is that the numbers
    // on it mean something.
    const arm = (name: string, v: number) => ({ name, daily: [v, v, v] })
    render(<PanelChart days={3} panel={{
      id: 'p2', title: 'Conversion by arm', kind: 'table',
      unit: 'count', better: 'up', metric: 'm.conversion', ratified: true,
      source: 'warehouse', expr: 'AVG(converted)', dataset: 'd', span: 6,
      agg: 'mean', series: [arm('control', 0.0926), arm('variant', 0.1296)],
    }} />)
    expect(screen.getAllByText('0.093').length).toBeGreaterThan(0)
    expect(screen.getAllByText('0.13').length).toBeGreaterThan(0)
  })
})
