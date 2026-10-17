import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { ExperimentCard, experimentState } from '../ExperimentCard'
import type { Experiment } from '../../data/types'

const base: Experiment = {
  id: 'exp-1', key: 'EXP-1', name: 'Checkout progress bar', owner: 'alex', space: 'pay',
  metric: 'checkout_conversion', hypothesis: 'A visible progress bar reduces abandonment.',
  status: 'running', day: 6, days: 14, lift: 4.2, guardrail: 'clean', updated: 0, live: true,
  preRegistered: true, startedAt: '2026-09-18T00:00:00Z', attention: [],
  liftCi: [1.1, 7.3], units: 9800, verdict: 'better', mde: 0.02,
}
const mount = (e: Experiment) => render(<MemoryRouter><ExperimentCard experiment={e} /></MemoryRouter>)
afterEach(cleanup)

describe('an experiment card', () => {
  it('shows the lift with its interval, not a bare percentage', () => {
    mount(base)
    expect(screen.getByText('+4.2%')).toBeTruthy()
    expect(screen.getByRole('img', { name: /interval \+1\.1% to \+7\.3%, minimum worth acting on ±2%/ })).toBeTruthy()
    expect(screen.getByText(/9,800 units/)).toBeTruthy()
    expect(screen.getByText('Running · day 6 of 14')).toBeTruthy()
  })

  it('links to the experiment', () => {
    mount(base)
    expect(screen.getByRole('link', { name: 'Open experiment Checkout progress bar' }).getAttribute('href'))
      .toBe('/experiments/exp-1')
  })

  it('puts what needs a decision on its face', () => {
    mount({ ...base, attention: ['reached its planned 14 days — decide'], srmPassed: false })
    expect(screen.getByText('reached its planned 14 days — decide')).toBeTruthy()
    expect(screen.getByText('split check failed')).toBeTruthy()
  })

  it('says when nothing has been read yet', () => {
    mount({ ...base, lift: null, liftCi: null, startedAt: null })
    expect(screen.getByText(/No readout recorded yet/)).toBeTruthy()
    // Running in the engine, with no start date here: said as that, not as the
    // opposite of the "running" beside it.
    expect(screen.getByText('Start date not recorded')).toBeTruthy()
    expect(screen.queryByText('Not started')).toBeNull()
  })

  it('dates a figure, since the page it opens reads the warehouse again', () => {
    mount({ ...base, lift: 16.9, liftCi: null, verdict: null, liftAt: '2026-08-31T12:00:00Z' })
    expect(screen.getByText(/^read .*31.* · no interval$/)).toBeTruthy()
  })
})

describe('where an experiment is', () => {
  it.each([
    [{ status: 'readout' }, 'Stopped · decide'],
    [{ day: 20 }, 'Day 20 · 6 past plan'],
    [{ status: 'shipped', decision: { outcome: 'ship', at: '2026-09-20T00:00:00Z' } }, /^Shipped · /],
    [{ status: 'killed', decision: { outcome: 'iterate', at: '2026-09-20T00:00:00Z' } }, /^Iterating · /],
  ] as const)('%o reads as %s', (over, want) => {
    const got = experimentState({ ...base, ...(over as Partial<Experiment>) })
    if (typeof want === 'string') expect(got).toBe(want)
    else expect(got).toMatch(want)
  })
})

describe('a result the readout would not stand behind', () => {
  it('is greyed, with the reason beside it', () => {
    mount({ ...base, srmPassed: false, verdict: 'no answer' })
    expect(screen.getByText('+4.2%').className).toBe('none')
    expect(screen.getByText(/no answer · split check failed/)).toBeTruthy()
  })
})

