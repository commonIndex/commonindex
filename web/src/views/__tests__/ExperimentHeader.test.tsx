import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExperimentDetail } from '../Experiments'
import { forgetLiveExperiments } from '../../data/api'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'exp-badge' }),
}))

const ROW = { id: 'exp-badge', key: 'EXP-12', name: 'Trust badge at checkout',
  hypothesis: 'A visible trust badge reduces abandonment at the payment step.', owner: 'maya',
  owner_id: 'maya', space: 'pay', metric: 'checkout_conv_clean', status: 'readout', days: 14, day: 0,
  lift: 63, lift_at: null, guardrail: 'clean', pre_registered: true, amendments: 1, attention: [] }

beforeEach(() => {
  forgetLiveExperiments()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const out = op === 'experiments.list' ? { experiments: [ROW], total: 1 } : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the experiment page header', () => {
  it('leads with the question, not a tagline', async () => {
    render(<MemoryRouter><ExperimentDetail /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Trust badge at checkout' })).toBeTruthy()
    expect(screen.getByText(ROW.hypothesis)).toBeTruthy()
    expect(screen.getByText('Stopped · decide')).toBeTruthy()
    expect(screen.queryByText(/hypothesis → contract → readout → decision/)).toBeNull()
    expect(screen.queryByText(/amendment\(s\)/)).toBeNull()
  })
})
