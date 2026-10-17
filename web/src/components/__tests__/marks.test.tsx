/**
 * The three shapes added to round out the chart types, and what each is actually for.
 *
 * They read the same numbers a panel already holds — a series per row, a value
 * per bucket — so none of them needs a new query. What they do not include is
 * as deliberate: a gantt needs a START and an END per row, which is a different
 * query rather than a different drawing of this one.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PanelChart } from '../PanelChart'
import { MARKS } from '../marks'
import type { Panel, PanelKind } from '../../data/types'

const panel = (kind: PanelKind, over: Partial<Panel> = {}): Panel => ({
  // `count`, not `duration`: the wire's `duration` is converted to hours by
  // `unitOf` before it reaches a Panel, and `Panel.unit` is the unit AFTER
  // that. There is no duration for a renderer to handle.
  id: kind, title: kind, kind, unit: 'count', better: 'down',
  metric: 'latency_ms', ratified: true, source: 'warehouse',
  expr: 'AVG(latency_ms)', dataset: 'd', span: 6, agg: 'mean',
  bucketDates: ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01'],
  series: [
    { name: 'control', daily: [206, 219, 231, 224, 240] },
    { name: 'variant', daily: [198, 205, 201, 210, 208] },
  ],
  ...over,
})

const svg = (c: HTMLElement) => c.querySelector('svg')!

describe('pie', () => {
  it('draws one slice per series', () => {
    const { container } = render(<PanelChart panel={panel('pie')} days={5} />)
    expect(svg(container).querySelectorAll('path')).toHaveLength(2)
  })

  it('puts the total in the hole, which a pie otherwise hides', () => {
    // A pie makes a reader add the slices up to learn the one number they were
    // looking at. The donut has somewhere to put it.
    render(<PanelChart panel={panel('pie')} days={5} />)
    expect(screen.getByText('total')).toBeTruthy()
  })

  it('shows each share as a percentage', () => {
    // These were drawn at `legendX + W - 8` — off the right of the canvas —
    // because `x` inside a translated group is relative to the group.
    render(<PanelChart panel={panel('pie')} days={5} />)
    expect(screen.getByText('52.3%')).toBeTruthy()
    expect(screen.getByText('47.7%')).toBeTruthy()
  })

  it('leaves out a series with nothing in it rather than drawing a hairline', () => {
    const { container } = render(<PanelChart days={5} panel={panel('pie', {
      series: [{ name: 'a', daily: [10, 10] }, { name: 'empty', daily: [0, 0] }],
    })} />)
    expect(svg(container).querySelectorAll('path')).toHaveLength(1)
  })
})

describe('gauge', () => {
  it('scales to the range the number has actually been in', () => {
    // A gauge with no target is a needle pointing at nothing. There is no
    // target in the model — a metric has a direction and no goal — so the
    // honest scale is the window's own low and high, and both are printed.
    render(<PanelChart panel={panel('gauge')} days={5} />)
    expect(screen.getByText('its range over the window')).toBeTruthy()
    expect(screen.getByText('206')).toBeTruthy()
    expect(screen.getByText('240')).toBeTruthy()
  })

  it('never sweeps more than half a circle', () => {
    // The large-arc flag was being set from `t > 0.5`, reading t as a fraction
    // of a FULL turn — so the track drew the reflex arc and the grey half
    // circle appeared underneath the coloured one instead of behind it.
    const { container } = render(<PanelChart panel={panel('gauge')} days={5} />)
    for (const p of svg(container).querySelectorAll('path')) {
      expect(p.getAttribute('d')).toMatch(/A[\d.]+ [\d.]+ 0 0 1/)
    }
  })

  it('colours by the metric direction, not by how full it looks', () => {
    // A full gauge is not automatically a good one.
    const up = render(<PanelChart days={5} panel={panel('gauge', {
      // Clear of the midpoint: at exactly half the colour is a coin toss and
      // the test would be asserting the tie-break rather than the rule.
      better: 'up', series: [{ name: 'a', daily: [1, 10, 10] }],
    })} />)
    const fill = up.container.querySelectorAll('svg path')[1].getAttribute('stroke')
    expect(fill).toBe('var(--pro)')
  })
})

describe('pivot', () => {
  it('is the table with a total per row', () => {
    // Which is the whole difference between a table and a pivot table.
    render(<PanelChart panel={panel('pivot')} days={5} />)
    // 224 is both control's mean and its value on 08-31, so the total is
    // identified by the class the margin styling hangs off.
    const totals = Array.from(document.querySelectorAll('td.pv-total'))
      .map(t => t.textContent)
    expect(totals).toEqual(['224', '204', '214'])
  })

  it('and a total per column', () => {
    render(<PanelChart panel={panel('pivot')} days={5} />)
    const margin = document.querySelector('tr.pv-margin')!
    expect(margin.textContent).toContain('all')
    expect(margin.textContent).toContain('214')    // across both rows
  })

  it('names the columns by the bucket they cover, newest first', () => {
    render(<PanelChart panel={panel('pivot')} days={5} />)
    const head = Array.from(document.querySelectorAll('th')).map(t => t.textContent)
    expect(head.slice(2, 4)).toEqual(['09-01', '08-31'])
  })

  it('drops the margin when there is only one row to add up', () => {
    render(<PanelChart days={5} panel={panel('pivot', {
      series: [{ name: 'only', daily: [1, 2] }],
    })} />)
    expect(document.querySelector('tr.pv-margin')).toBeNull()
  })
})

describe('what the picker offers', () => {
  it('includes all three', () => {
    const ids = MARKS.map(m => m.id)
    expect(ids).toContain('pie')
    expect(ids).toContain('gauge')
    expect(ids).toContain('pivot')
  })

  it('does not offer a shape the query cannot answer', () => {
    // A gantt needs a start and an end per row. `Query` carries one metric,
    // one optional dimension and one time grain — a bar with two ends is a
    // different query, not a different drawing of this one.
    expect(MARKS.map(m => m.id)).not.toContain('gantt')
  })
})
