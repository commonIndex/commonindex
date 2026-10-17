/**
 * Reading a readout that is not a result yet — and reading one at all.
 *
 * EXP-12 read 12–18 units from "the last 30 days", 3 against 9, and the page
 * called the split "held" in green, explained a zero baseline in the engine's
 * words, and laid the numbers out across five coloured regions as though they
 * were a result.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExperimentDetail } from '../Experiments'
import { forgetLiveExperiments } from '../../data/api'
import { forgetWhoAmI } from '../../data/gateway'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'exp-badge' }),
}))

const ROW = { id: 'exp-badge', key: 'EXP-12', name: 'Trust badge at checkout', hypothesis: 'h', owner: 'maya',
  owner_id: 'maya', space: 'pay', metric: 'checkout_conv', status: 'readout', days: 14, day: 0,
  lift: null, lift_at: null, guardrail: 'clean', pre_registered: true, amendments: 0, attention: [] }

function arms(c: number, v: number, cm: number, vm: number) {
  return [{ name: 'control', n: c, mean: cm }, { name: 'variant', n: v, mean: vm }]
}
function srm(c: number, v: number, p: number) {
  return { ran: true, passed: true, p_value: p, threshold: 0.001, total: c + v, counted: 'units',
           arms: [{ name: 'control', observed: c, expected: (c + v) / 2, ratio: c / ((c + v) / 2) },
                  { name: 'variant', observed: v, expected: (c + v) / 2, ratio: v / ((c + v) / 2) }] }
}

const READOUT = {
  dataset_id: 'public.exp', range: '30d', alpha: 0.05, sequential: true, pre_registered: true,
  experiment: { id: 'exp-badge', title: 'Trust badge at checkout', planned_days: 14, mde: 0.02 },
  window: { start: '2026-08-26T00:00:00Z', end: '2026-09-25T00:00:00Z', basis: 'range', applied: true,
            note: 'No start date on record, so this read the last 30 days.' },
  srm: srm(4, 14, 0.018),
  results: [
    { outcome: 'converted', role: 'target', metric_label: 'Checkout conversion', binary: true, unit: null,
      better: 'up', control: 'control', arms: arms(4, 14, 0, 0.286),
      comparisons: [{ variation: 'variant', baseline: 'control', n: 14, baseline_n: 4, mean: 0.286,
        baseline_mean: 0, lift: null, lift_ci: null, p_value: 0.2, test: 'sequential-two-proportion',
        undecidable: 'baseline mean is zero, so relative lift is undefined', verdict: 'no answer' }] },
    { outcome: 'latency_ms', role: 'guardrail', metric_label: 'Checkout latency', binary: false, unit: 'ms',
      better: 'down', direction_assumed: false, control: 'control', arms: arms(4, 14, 197, 208),
      comparisons: [{ variation: 'variant', baseline: 'control', n: 14, baseline_n: 4, mean: 208,
        baseline_mean: 197, lift: 0.056, lift_ci: [-0.771, 0.882], p_value: 0.8,
        test: 'sequential-welch-t', undecidable: null, verdict: 'no difference detected' }] },
  ],
  caveats: [],
}

const RECORD = {
  experiment: { id: 'exp-badge', status: 'readout', decision: null },
  contract: { connection_id: 'c1', dataset_id: 'public.exp', variation: 'arm', outcome: 'converted',
              unit: 'user_id', binary: true, mde: 0.02, planned_days: 14 },
  pre_registered: true,
  progress: { day: 0, days: 14, started_at: null, ends_at: null, stopped_at: null, due: false },
  attention: [],
}

function mount(readout: unknown, withRecord = false) {
  forgetLiveExperiments(); forgetWhoAmI()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const out = op === 'experiments.readout' ? readout
      : op === 'experiments.list' ? { experiments: [ROW], total: 1 }
      : op === 'experiments.get' && withRecord ? RECORD
      : op === 'experiments.plan' && withRecord ? { per_arm: { control: 985000, variant: 985000 },
          total: 1970000, delta: 0.002, sequential: true, days: null, assumptions: [], measured: {} }
      : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  render(<MemoryRouter><ExperimentDetail /></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const strip = () => document.querySelector('.rs') as HTMLElement
const stat = (k: string) => within(strip()).getByText(k).parentElement as HTMLElement

describe('a readout of the wrong days', () => {
  it('says so first, in one line, and points at the fix', async () => {
    mount(READOUT)
    const banner = await screen.findByRole('note')
    expect(banner.textContent).toMatch(/Reading the last 30 days, not this experiment’s own — 18 units/)
    expect(within(banner).getByRole('link', { name: 'Record when it ran' }).getAttribute('href')).toBe('#lifecycle')
  })

  it('does not appear once the experiment reads its own days', async () => {
    mount({ ...READOUT, window: { ...READOUT.window, basis: 'experiment', note: undefined } })
    await screen.findByText(/No answer on the target yet/)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('too little data', () => {
  it('is the headline, in users, against what the plan needs', async () => {
    mount(READOUT, true)
    expect(await screen.findByText('Too little data to read yet.')).toBeTruthy()
    // In the reader's locale — "2M" in en-US, "19.7L" in en-IN — like every
    // other number on the page.
    const need = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(1970000)
    expect(screen.getByText(`18 users so far, where the registered 2% effect needs about ${need}.`)).toBeTruthy()
    expect(within(stat('Users')).getByText(`of ~${need} needed`)).toBeTruthy()
  })
})

describe('up or down against control', () => {
  it('marks each row with an arrow, and the absolute change in its own column', async () => {
    mount(READOUT)
    await screen.findByText(/No answer on the target yet/)
    const row = screen.getByRole('link', { name: 'Checkout latency' }).closest('tr') as HTMLElement
    const change = row.querySelector('.sc-change') as HTMLElement
    expect(change.querySelector('.sc-arrow')!.textContent).toBe('▲')      // 197ms → 208ms went up
    expect(row.querySelector('td.sc-abs')!.textContent).toBe('+11ms')
  })
})

describe('users, with more than two arms', () => {
  it('gives the total and every arm, rather than cutting the third off', async () => {
    const three = [{ name: 'banner_bottom', n: 4000, mean: 0.105 }, { name: 'banner_top', n: 4000, mean: 0.12 },
                   { name: 'control', n: 4000, mean: 0.099 }]
    const split = { ...srm(4000, 4000, 1), total: 12000,
                    arms: three.map(a => ({ name: a.name, observed: 4000, expected: 4000, ratio: 1 })) }
    mount({ ...READOUT, srm: split, results: [{ ...READOUT.results[0], arms: three }] })
    await screen.findByText(/No answer on the target yet/)
    const cell = within(strip()).getByText(/^(Users|Units)$/).parentElement as HTMLElement
    const v = within(cell).getByText(/across 3 arms/).parentElement as HTMLElement
    expect(v.textContent).toBe(`${(12000).toLocaleString()} across 3 arms`)
    expect(v.getAttribute('title')).toContain(`control ${(4000).toLocaleString()}`)
  })
})

// The split is said under the count of users: "split held", in a word.
const users = () => within(strip()).getByText(/^(Users|Units)$/).parentElement as HTMLElement
const split = () => within(users()).getByText(/^split /)

describe('the split, in a word', () => {
  it('is too few to judge on a handful — never "held"', async () => {
    mount(READOUT)
    await screen.findByText(/No answer on the target yet/)
    expect(split().textContent).toBe('split too few to judge')
    expect(within(strip()).queryByText(/split held/)).toBeNull()
    // The bars are for a split that failed; one that could not be judged is a word.
    expect(document.querySelector('.arms')).toBeNull()
  })

  it('is watched when it is uneven but has not failed', async () => {
    mount({ ...READOUT, srm: srm(180, 240, 0.003) })
    await screen.findByText(/No answer on the target yet/)
    expect(split().textContent).toBe('split uneven — watching')
  })

  it('held, quietly, when there was enough to check', async () => {
    mount({ ...READOUT, srm: srm(5000, 5010, 0.92) })
    await screen.findByText(/No answer on the target yet/)
    expect(split().textContent).toBe('split held')
    expect(users().className).not.toMatch(/warn|bad/)
  })
})

describe('a zero baseline', () => {
  it('is explained in words, with the absolute difference it hid', async () => {
    mount(READOUT)
    // In the verdict at the top and in that metric's own card.
    expect((await screen.findAllByText(/The control group had no conversions \(4 units\)/)).length).toBe(2)
    expect(screen.queryByText('baseline mean is zero, so relative lift is undefined')).toBeNull()
    // Up against control, said with an arrow, then by how much.
    expect(screen.getByTitle('absolute difference').textContent).toBe('▲+28.6pp')
  })
})

describe('the scorecard', () => {
  it('reads one line per metric: values, change, interval as a shape, verdict', async () => {
    mount(READOUT)
    await screen.findByText(/No answer on the target yet/)
    const row = screen.getByRole('link', { name: 'Checkout latency' }).closest('tr') as HTMLElement
    expect(within(row).getByText('197ms')).toBeTruthy()
    expect(within(row).getByText('208ms')).toBeTruthy()
    expect(within(row).getByText('+5.6%')).toBeTruthy()
    expect(within(row).getByRole('img', { name: '+5.6%, interval -77.1% to +88.2%' })).toBeTruthy()
    expect(within(row).getByText('No difference')).toBeTruthy()
    expect(within(row).getByText(/lower is better/)).toBeTruthy()
    // Counts are said once, in the strip, and in the tooltip — not on every row.
    expect(within(row).getByText('208ms').getAttribute('title')).toBe('14 counted')
    expect(screen.queryByText(/assignment table/i)).toBeNull()
  })

  it('keeps each metric’s full card folded until it is asked for', async () => {
    const u = userEvent.setup()
    mount(READOUT)
    await screen.findByText(/No answer on the target yet/)
    const detail = document.querySelector('.ro-detail') as HTMLDetailsElement
    expect(detail.open).toBe(false)
    await u.click(screen.getByRole('link', { name: 'Checkout conversion' }))
    expect(detail.open).toBe(true)
  })
})

describe('guardrails, counted once each', () => {
  it('puts a guessed-direction guardrail with no answer in one bucket, never "-1 held"', async () => {
    const guessedNoAnswer = { ...READOUT.results[1], outcome: 'refunds', metric_label: 'Refunds',
      direction_assumed: true, comparisons: [{ ...READOUT.results[1].comparisons[0], lift: null,
        lift_ci: null, verdict: 'no answer', undecidable: 'an arm has fewer than two units' }] }
    mount({ ...READOUT, results: [READOUT.results[0], READOUT.results[1], guessedNoAnswer] })
    await screen.findByText(/No answer on the target yet/)
    const cell = stat('Guardrails')
    expect(cell.querySelector('.rs-v')!.textContent).toBe('1 of 2 held')
    expect(cell.querySelector('.rs-sub')!.textContent).toBe('1 no answer')
    expect(cell.textContent).not.toMatch(/-\d/)
  })
})
