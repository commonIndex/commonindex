/**
 * Refreshing a page whose numbers were computed when it loaded.
 *
 * Both surfaces recompute on read and then sit there, so what is on screen is
 * a snapshot from load time and nothing said so. These cover the two halves:
 * the age is visible, and re-reading does not throw away what is already there.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Freshness } from '../../components/ui'
import { ExperimentDetail } from '../Experiments'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'exp-a' }),
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('the freshness control', () => {
  it('leads with the age, because that is the half that decides', async () => {
    render(<Freshness at={Date.now() - 8 * 60_000} onRefresh={vi.fn()} />)
    expect(screen.getByText(/8 min ago/)).toBeTruthy()
  })

  it('says nothing about age before the first read', () => {
    render(<Freshness at={null} onRefresh={vi.fn()} />)
    expect(screen.queryByText(/ago/)).toBeNull()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
  })

  it('cannot be pressed twice while it is reading', async () => {
    const onRefresh = vi.fn()
    render(<Freshness at={Date.now()} busy onRefresh={onRefresh} />)
    const btn = screen.getByRole('button')
    expect(btn.hasAttribute('disabled')).toBe(true)
    await userEvent.setup().click(btn).catch(() => {})
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('carries an exact time for anyone who needs one', () => {
    const at = Date.now() - 60_000
    render(<Freshness at={at} onRefresh={vi.fn()} />)
    expect(screen.getByText(/1 min ago/).getAttribute('title'))
      .toBe(new Date(at).toLocaleString())
  })
})

const ARMS = [{ name: 'control', n: 3000, mean: 0.1 }, { name: 'v', n: 3000, mean: 0.13 }]

function payload(lift: number) {
  return {
    dataset_id: 'sql.x', range: '30d', alpha: 0.05, sequential: true, tuning: 5000,
    pre_registered: true,
    experiment: { id: 'exp-a', title: 'A', planned_days: 14, mde: null },
    srm: { ran: true, passed: true, total: 6000, counted: 'units', threshold: 0.001,
           p_value: 1, arms: ARMS.map(a => ({ name: a.name, observed: a.n, expected: 3000, ratio: 1 })) },
    results: [{
      outcome: 'converted', role: 'target', cites: 'c', metric_label: 'Conversion',
      metric_status: 'ratified', metric_version: 1, metric_expr: 'AVG(converted)',
      unit: 'pct', better: 'up', direction_assumed: false, control: 'control', binary: true,
      arms: ARMS,
      comparisons: [{ variation: 'v', baseline: 'control', n: 3000, baseline_n: 3000,
        mean: 0.13, baseline_mean: 0.1, lift, lift_ci: [lift - 0.05, lift + 0.05],
        p_value: 0.01, test: 'sequential-two-proportion', undecidable: null,
        verdict: 'better' }],
    }],
    caveats: ['x'],
  }
}

/** The lift shows in the strip and again in the outcome column, so assertions
 *  name the card rather than the page. */
const liftShown = () =>
  Array.from(document.querySelectorAll('.oc-change b')).map(n => n.textContent)

function mount(bodies: unknown[]) {
  let n = 0
  const rows = { experiments: [{ id: 'exp-a', key: 'EXP-1', name: 'A', hypothesis: '',
    owner: 'alex', space: 'pay', metric: 'c', status: 'running', days: 14, day: 0,
    lift: null, lift_at: null, guardrail: 'clean', pre_registered: true, amendments: 0 }], total: 1 }
  const fetchMock = vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const body = op === 'experiments.readout' ? bodies[Math.min(n++, bodies.length - 1)] : rows
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MemoryRouter><ExperimentDetail /></MemoryRouter>)
  return fetchMock
}

describe('refreshing a readout', () => {
  it('runs it again against the warehouse', async () => {
    const fetchMock = mount([payload(0.30), payload(0.41)])
    await waitFor(() => expect(liftShown()).toContain('+30.0%'))

    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(liftShown()).toContain('+41.0%'))

    const readouts = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('experiments.readout'))
    expect(readouts.length).toBe(2)
  })

  it('keeps the numbers on screen while re-reading them', async () => {
    // Blanking the page and showing a spinner loses the reader's position on a
    // long readout, for data that is usually about to come back identical.
    let release: (v: unknown) => void = () => {}
    const rows = { experiments: [{ id: 'exp-a', key: 'EXP-1', name: 'A', hypothesis: '',
      owner: 'alex', space: 'pay', metric: 'c', status: 'running', days: 14, day: 0,
      lift: null, lift_at: null, guardrail: 'clean', pre_registered: true, amendments: 0 }], total: 1 }
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      if (op !== 'experiments.readout') return { ok: true, status: 200, json: async () => rows } as Response
      if (first) { first = false; return { ok: true, status: 200, json: async () => payload(0.30) } as Response }
      await new Promise(r => { release = r })
      return { ok: true, status: 200, json: async () => payload(0.41) } as Response
    }))
    render(<MemoryRouter><ExperimentDetail /></MemoryRouter>)
    await waitFor(() => expect(liftShown()).toContain('+30.0%'))

    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh/ }))
    // Mid-read: the old figure is still there, dimmed rather than removed.
    expect(liftShown()).toContain('+30.0%')
    expect(document.querySelector('.ro.is-reading')).toBeTruthy()
    expect(screen.queryByText(/Running the readout/)).toBeNull()

    release(null)
    await waitFor(() => expect(liftShown()).toContain('+41.0%'))
    expect(document.querySelector('.ro.is-reading')).toBeNull()
  })

  it('reports when it last read', async () => {
    mount([payload(0.30)])
    await waitFor(() => expect(liftShown()).toContain('+30.0%'))
    const head = document.querySelector('.ro-head')!
    expect(within(head as HTMLElement).getByText(/just now/)).toBeTruthy()
  })
})
