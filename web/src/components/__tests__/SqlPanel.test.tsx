/**
 * A panel that carries its own query.
 *
 * This test exists because the component was written, typechecked, built, and
 * verified end-to-end against a live warehouse — and was still unreachable in
 * a browser. Every renderer indexes `series[0]`, so PanelChart gates once on
 * "no series" and shows an empty card. A SQL panel returns ROWS and never has
 * a series, so it hit that gate on every render and the rows were never drawn.
 *
 * Checking the API told me nothing about it. Only rendering the component did.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PanelChart } from '../PanelChart'
import type { Panel } from '../../data/types'

function sqlPanel(over: Partial<Panel> = {}): Panel {
  return {
    id: 's1', title: 'Refunds by arm (raw)', kind: 'sql',
    unit: 'count', better: 'up', metric: '', ratified: false,
    source: 'warehouse', expr: '', dataset: '', span: 6, agg: 'last',
    series: [],                      // ← the whole point: there is never one
    sql: 'select arm, count(*) as users from refunds group by 1',
    columns: ['arm', 'users'],
    rows: [['control', 4000], ['variant', 4000]],
    ...over,
  }
}

describe('a SQL panel', () => {
  it('renders its rows even though it has no series', () => {
    render(<PanelChart panel={sqlPanel()} days={30} />)
    expect(screen.getByText('control')).toBeTruthy()
    expect(screen.getAllByText((4000).toLocaleString())).toHaveLength(2)    // grouped, like every other number
    expect(screen.queryByText(/No rows in the last/)).toBeNull()
  })

  it('gives a number column one number of decimals, so it lines up', () => {
    render(<PanelChart panel={sqlPanel({ columns: ['customer', 'spend'],
      rows: [['a', 1622.8], ['b', 1206.44], ['c', 996]] })} days={30} />)
    const two = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    for (const n of [1622.8, 1206.44, 996]) expect(screen.getByText(two(n))).toBeTruthy()
  })

  it('shows the query on the face rather than in a drawer', () => {
    const { container } = render(<PanelChart panel={sqlPanel()} days={30} />)
    // The one panel whose number nobody stands behind is the one that must not
    // hide what produced it — so it is not inside a <details>.
    const q = screen.getByText(/select arm, count/)
    expect(q.textContent).toContain('group by 1')
    expect(q.closest('details')).toBeNull()
    expect(container.querySelectorAll('details')).toHaveLength(0)
  })

  it('says it cites no definition instead of naming a metric', () => {
    render(<PanelChart panel={sqlPanel()} days={30} />)
    expect(screen.getByText(/raw SQL · no definition/)).toBeTruthy()
    // Said once, in the foot — not twice on the same card.
    expect(screen.getAllByText(/nobody has ratified/)).toHaveLength(1)
  })

  it('does not borrow the vocabulary of panels that have a binding', () => {
    render(<PanelChart panel={sqlPanel()} days={30} />)
    // No dataset, no aggregate, no "definition" drawer — it has none of them.
    expect(screen.queryByText(/over the window/)).toBeNull()
    expect(screen.queryByText('definition')).toBeNull()
    expect(screen.queryByText('Chart')).toBeNull()
  })

  it('distinguishes a query that returned nothing from one that returned no columns', () => {
    render(<PanelChart panel={sqlPanel({ rows: [] })} days={30} />)
    expect(screen.getByText('No rows.')).toBeTruthy()

    render(<PanelChart panel={sqlPanel({ columns: [], rows: [] })} days={30} />)
    expect(screen.getByText(/returned no columns/)).toBeTruthy()
  })
})
