import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExperimentPlan } from '../ExperimentPlan'

let asked: Record<string, unknown>[]
beforeEach(() => {
  asked = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)))
    return { ok: true, status: 200, json: async () => ({
      per_arm: { control: 31835, variant: 31835 }, total: 63670, delta: 0.005, sequential: true,
      days: 32, assumptions: ['always-valid (sequential) interval at alpha 0.05, 80% power'], measured: {},
    }) } as Response
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('planning an experiment', () => {
  it('turns a baseline, an effect and traffic into days', async () => {
    render(<MemoryRouter><ExperimentPlan /></MemoryRouter>)
    expect(await screen.findByText('32')).toBeTruthy()
    expect(screen.getByText(/63,670 people in total/)).toBeTruthy()
    expect(asked.at(-1)).toMatchObject({ baseline: 0.1, mde: 0.05, binary: true, daily_units: 2000,
                                         sequential: true, weights: { control: 0.5, variant: 0.5 } })
  })

  it('asks for the spread when the outcome is an amount', async () => {
    const u = userEvent.setup()
    render(<MemoryRouter><ExperimentPlan /></MemoryRouter>)
    await u.click(screen.getByRole('button', { name: /An amount/ }))
    expect(screen.getByText(/Spread per person/)).toBeTruthy()
    await u.type(screen.getByPlaceholderText('e.g. 30'), '30')
    await waitFor(() => expect(asked.at(-1)).toMatchObject({ binary: false, sd: 30 }))
  })
})
