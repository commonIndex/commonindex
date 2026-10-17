import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExperimentsView } from '../Experiments'
import { forgetLiveExperiments } from '../../data/api'

const ROWS = [{ id: 'exp-a', key: 'EXP-1', name: 'Checkout progress bar', hypothesis: 'h', owner: 'alex',
  owner_id: 'alex', space: 'pay', metric: 'm', status: 'running', days: 14, day: 3, lift: 4.2,
  lift_at: null, lift_ci: [1.1, 7.3], units: 900, verdict: 'better', mde: 0.02, guardrail: 'clean',
  pre_registered: true, amendments: 0, attention: [], started_at: '2026-09-20T00:00:00Z' }]

beforeEach(() => {
  forgetLiveExperiments()
  try { localStorage.removeItem('experiments.view') } catch { /* */ }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
    json: async () => ({ experiments: ROWS, total: 1 }) }) as Response))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the experiments gallery', () => {
  it('shows cards, like Designs and Dashboards', async () => {
    render(<MemoryRouter><ExperimentsView /></MemoryRouter>)
    const list = await screen.findByRole('list', { name: 'Experiments' })
    expect(list.querySelectorAll('.exp-card')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Open experiment Checkout progress bar' })).toBeTruthy()
  })

  it('switches to rows for scanning many, and remembers it', async () => {
    const u = userEvent.setup()
    render(<MemoryRouter><ExperimentsView /></MemoryRouter>)
    await screen.findByRole('list', { name: 'Experiments' })
    await u.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.queryByRole('list', { name: 'Experiments' })).toBeNull()
    expect(localStorage.getItem('experiments.view')).toBe('list')
  })
})
