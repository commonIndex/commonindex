/**
 * What a card says about the slice it is showing.
 *
 * The failure this guards is quiet by construction: a dashboard filtered to
 * EMEA, where two of six panels have no `region` column, renders six cards that
 * look identical. The caption at the top says EMEA. Two of the cards are
 * showing the worldwide total, and nothing on them says so.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PanelChart } from '../PanelChart'
import type { Panel } from '../../data/types'

function panel(over: Partial<Panel> = {}): Panel {
  return {
    id: 'p1', title: 'Conversion', kind: 'line', unit: 'pct', better: 'up',
    metric: 'm.conversion', ratified: true, source: 'warehouse',
    expr: 'AVG(converted)', dataset: 'd.wide', span: 6, agg: 'mean',
    series: [{ name: 'all', daily: [1, 2, 3, 4, 5] }],
    ...over,
  }
}

describe('a panel under a dashboard filter', () => {
  it('says so when it could not honour one', () => {
    render(<PanelChart days={5} panel={panel({
      filtersSkipped: [{ dimension: 'region', op: 'eq', values: ['emea'],
                         why: 'd.narrow has no filterable column \'region\'' }],
    })} />)
    expect(screen.getByText(/not filtered by region/)).toBeTruthy()
    // And says what the number therefore IS, not only what it is not.
    expect(screen.getByText(/This is the unsliced number/)).toBeTruthy()
  })

  it('names the reason, not just the fact', () => {
    render(<PanelChart days={5} panel={panel({
      filtersSkipped: [{ dimension: 'region', op: 'eq', values: ['emea'],
                         why: 'this panel carries its own query' }],
    })} />)
    expect(screen.getByText(/carries its own query/)).toBeTruthy()
  })

  it('confirms the slice when it did honour one', () => {
    render(<PanelChart days={5} panel={panel({
      filtersApplied: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
    })} />)
    expect(screen.getByText(/region filtered/)).toBeTruthy()
    expect(screen.queryByText(/not filtered by/)).toBeNull()
  })

  it('says nothing at all when no filter is set', () => {
    render(<PanelChart days={5} panel={panel()} />)
    expect(screen.queryByText(/filtered/)).toBeNull()
  })

  it('lists every column it could not honour, not just the first', () => {
    render(<PanelChart days={5} panel={panel({
      filtersSkipped: [
        { dimension: 'region', op: 'eq', values: ['emea'], why: 'no such column' },
        { dimension: 'tier', op: 'eq', values: ['pro'], why: 'no such column' },
      ],
    })} />)
    expect(screen.getByText(/not filtered by region, tier/)).toBeTruthy()
  })
})
