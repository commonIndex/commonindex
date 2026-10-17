/**
 * Reading out an experiment with more than two arms.
 *
 * A three-arm experiment produces two comparisons per metric, and the summary
 * read `comparisons[0]`. Both variants happening to agree hid it — the moment
 * one improves and the other regresses, the headline reports the improvement
 * and drops the regression, in the one place on the page whose job is to say
 * "not a ship".
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExperimentDetail } from '../Experiments'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'exp-search_ranking_v2' }),
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const ARMS = [
  { name: 'control', n: 3000, mean: 27.383 },
  { name: 'ranker_a', n: 3000, mean: 33.2074 },
  { name: 'ranker_b', n: 3000, mean: 32.5764 },
]

function cmp(variation: string, lift: number, ci: [number, number], verdict: string) {
  return { variation, baseline: 'control', n: 3000, baseline_n: 3000,
           mean: 33.2, baseline_mean: 27.4, lift, lift_ci: ci, p_value: 0.001,
           test: 'sequential-welch-t', undecidable: null, verdict }
}

function readout(over: Record<string, unknown> = {}) {
  return {
    dataset_id: 'sql.search', range: '30d', alpha: 0.05, sequential: true, tuning: 5000,
    pre_registered: true,
    experiment: { id: 'e', title: 'Search ranking v2', planned_days: 21, mde: null },
    srm: { ran: true, passed: true, total: 9000, counted: 'units', threshold: 0.001,
           p_value: 1, arms: ARMS.map(a => ({ name: a.name, observed: a.n, expected: 3000, ratio: 1 })) },
    results: [
      { outcome: 'orders_sum', role: 'target', cites: 'orders', metric_label: 'Orders',
        metric_status: 'ratified', metric_version: 1, metric_expr: 'AVG(orders)',
        unit: null, better: 'up', direction_assumed: false, control: 'control', binary: false,
        arms: ARMS,
        comparisons: [cmp('ranker_a', 0.213, [0.063, 0.362], 'better'),
                      cmp('ranker_b', 0.190, [0.042, 0.337], 'better')] },
    ],
    caveats: ['always-valid intervals'],
    ...over,
  }
}

/** The detail page loads the collection first to find the experiment, then
 *  reads it out — so the mock routes by operation rather than answering every
 *  call with the readout. */
function mount(body: unknown) {
  const rows = {
    experiments: [{
      id: 'exp-search_ranking_v2', key: 'EXP-22', name: 'Search ranking v2',
      hypothesis: 'A better ranker lifts orders.', owner: 'alex', space: 'pay',
      metric: 'orders', status: 'running', days: 21, day: 0, lift: null,
      lift_at: null, guardrail: 'clean', pre_registered: true, amendments: 0,
    }],
    total: 1,
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const payload = op === 'experiments.readout' ? body : rows
    return { ok: true, status: 200, json: async () => payload } as Response
  }))
  render(<MemoryRouter><ExperimentDetail /></MemoryRouter>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('summarising across arms', () => {
  it('names both variants when both improved', async () => {
    mount(readout())
    expect(await screen.findByText(/Both variants improved the target/)).toBeTruthy()
  })

  it('does not hide a variant that regressed behind one that improved', async () => {
    mount(readout({
      results: [{ ...readout().results[0],
        comparisons: [cmp('ranker_a', 0.213, [0.063, 0.362], 'better'),
                      cmp('ranker_b', -0.180, [-0.31, -0.05], 'worse')] }],
    }))
    // Reading comparisons[0] reported only the improvement.
    const line = await screen.findByText(/ranker_a improved the target and ranker_b regressed it/)
    expect(line).toBeTruthy()
  })

  it('names which variant moved when only one did', async () => {
    mount(readout({
      results: [{ ...readout().results[0],
        comparisons: [cmp('ranker_a', 0.213, [0.063, 0.362], 'better'),
                      cmp('ranker_b', 0.01, [-0.12, 0.15], 'no difference detected')] }],
    }))
    expect(await screen.findByText(/ranker_a improved the target; ranker_b did not/)).toBeTruthy()
  })

  it('catches a guardrail broken by the second arm only', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, {
      outcome: 'support_n', role: 'guardrail', cites: 'support', metric_label: 'Support contacts',
      metric_status: 'ratified', metric_version: 1, metric_expr: 'AVG(support)',
      unit: null, better: 'down', direction_assumed: false, control: 'control', binary: false,
      arms: ARMS,
      comparisons: [cmp('ranker_a', -0.09, [-0.41, 0.22], 'no difference detected'),
                    cmp('ranker_b', 0.44, [0.12, 0.80], 'worse')] }] })

    // The breach is on the SECOND comparison of the guardrail.
    expect(await screen.findByText(/Support contacts regressed/)).toBeTruthy()
    expect(screen.getByText(/not a ship on the target alone/)).toBeTruthy()
  })
})

describe('multiple comparisons', () => {
  it('counts comparisons, not metrics, and says what they cost', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, {
      ...base.results[0], outcome: 'support_n', role: 'guardrail',
      metric_label: 'Support contacts', better: 'down' }] })

    // Two variants across two metrics is four tests; counting metrics said two.
    expect(await screen.findByText(/4 comparisons here/)).toBeTruthy()
    expect(screen.getByText(/19% chance/)).toBeTruthy()
  })

  it('stays quiet on a plain two-arm, one-metric experiment', async () => {
    mount(readout({
      results: [{ ...readout().results[0], arms: ARMS.slice(0, 2),
        comparisons: [cmp('ranker_a', 0.213, [0.063, 0.362], 'better')] }],
    }))
    await waitFor(() => expect(screen.queryByText(/comparisons here/)).toBeNull())
  })
})

describe('a guardrail whose direction was guessed', () => {
  const guessed = {
    outcome: 'support_n', role: 'guardrail', cites: null, metric_label: 'Support contacts',
    metric_status: null, metric_version: null, metric_expr: null,
    unit: null, better: 'up', direction_assumed: true, control: 'control', binary: false,
    arms: ARMS,
    comparisons: [cmp('ranker_a', -0.09, [-0.41, 0.22], 'no difference detected'),
                  cmp('ranker_b', 0.06, [-0.30, 0.42], 'no difference detected')],
  }

  it('is not reported as having held', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, guessed] })

    // "all 1 guardrail held" was true only by luck: with nothing cited the
    // readout assumes higher is better, and on support contacts a rise is the
    // bad outcome — so a real breach there would have read as a hold.
    expect(await screen.findByText(/nothing checked what must not get worse/)).toBeTruthy()
    expect(screen.queryByText(/guardrail held/)).toBeNull()
  })

  it('says which metric and what to do about it', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, guessed] })
    // Said in two places on purpose — the summary for someone scanning, the
    // card for someone reading that metric — so this asserts the summary's.
    const note = await screen.findByText(/Support contacts cites no definition/)
    expect(note.textContent).toMatch(/ratify a definition/)
    expect(note.closest('.sum')).toBeTruthy()
  })

  it('warns on the card itself, not as a parenthetical', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, guessed] })
    expect(await screen.findByText(/Direction assumed:/)).toBeTruthy()
    expect(screen.getByText(/these verdicts are inverted/)).toBeTruthy()
  })

  it('still says "held" when the direction was actually cited', async () => {
    const base = readout()
    mount({ ...base, results: [...base.results, { ...guessed, cites: 'support',
      metric_status: 'ratified', metric_version: 1, better: 'down',
      direction_assumed: false }] })
    expect(await screen.findByText(/1 guardrail held/)).toBeTruthy()
    expect(screen.queryByText(/Direction assumed:/)).toBeNull()
  })
})

describe('the statistics, folded away', () => {
  it('names the test in words rather than as a slug', async () => {
    mount(readout())
    expect(await screen.findByText(/Comparing two averages that may vary differently/)).toBeTruthy()
    expect(screen.queryByText('sequential-welch-t')).toBeNull()
  })

  it('says the interval decides, not the p-value', async () => {
    mount(readout())
    expect(await screen.findByText(/not the p-value/)).toBeTruthy()
  })

  it('shows the test once, not once per arm', async () => {
    mount(readout())
    await screen.findByText(/Comparing two averages/)
    // Two variants, one card, one explanation.
    expect(document.querySelectorAll('.oc-how')).toHaveLength(1)
    expect(document.querySelectorAll('.oc-ps span')).toHaveLength(2)
  })
})
