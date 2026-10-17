import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { ExperimentContract } from '../ExperimentContract'
import type { WireContract } from '../../data/gateway'

const FULL: WireContract = {
  connection_id: 'c1', dataset_id: 'public.exp_checkout_badge', variation: 'arm', control: 'control',
  outcome: 'converted', binary: true, unit: 'user_id', weights: { control: 0.5, variant: 0.5 },
  metric_id: 'checkout_conv', metric_version: 3, mde: 0.02, planned_days: 14, alpha: 0.05,
  guardrails: [{ outcome: 'refunded', metric_id: 'refund_rate', metric_version: 1 }],
  registered_by: 'maya', registered_at: '2026-08-20T00:00:00Z',
}
afterEach(cleanup)

describe('what was registered', () => {
  it('says what it measures, on which units, against which split and effect', () => {
    render(<ExperimentContract contract={FULL} />)
    // At a glance, on one line.
    const line = document.querySelector('.xc-line')!.textContent!
    expect(line).toMatch(/converted as a rate · arm vs control \(control 50% \/ variant 50%\) · per user_id · 14 days · detects ≥2% · 1 guardrail/)
    // Nothing missing, so no gap tags.
    expect(document.querySelector('.xc-gaps')).toBeNull()
    expect(screen.getByText(/v3 pinned/)).toBeTruthy()
    expect(screen.getByText('Details')).toBeTruthy()
    // And in full, under Details.
    const grid = document.querySelector('.xc-grid') as HTMLElement
    expect(within(grid).getByText(/control 50% \/ variant 50%/)).toBeTruthy()
    expect(within(grid).getByText('user_id')).toBeTruthy()
    expect(screen.getByText(/a 2% change, relative/)).toBeTruthy()
    expect(within(grid).getByText('14 days')).toBeTruthy()
    // A readable name, the column on hover, under which way is good.
    const chip = within(grid).getByTitle('refunded')
    expect(chip.textContent).toBe('Refunded · refund_rate v1')
    expect(chip.closest('.xc-guards')!.textContent).toMatch(/^Direction from its definition/)
  })

  it('says the gaps out loud, because each changes how the numbers read', () => {
    render(<ExperimentContract contract={{ ...FULL, unit: null, mde: null, weights: null, guardrails: [], metric_id: null }} />)
    expect(screen.getByText(/counts are rows/)).toBeTruthy()
    expect(screen.getByText(/cannot be told from "too small to see"/)).toBeTruthy()
    expect(screen.getByText(/even split assumed/)).toBeTruthy()
    expect(screen.getByText(/nothing was agreed as unable to get worse/)).toBeTruthy()
    expect(screen.getByText(/No definition cited/)).toBeTruthy()
    // The same gaps as tags, each saying on hover why it matters.
    const tags = [...document.querySelectorAll('.xc-gap')]
    expect(tags.map(t => t.textContent)).toEqual(
      ['No metric definition', 'No unit', 'Even split assumed', 'No minimum effect', 'No guardrails'])
    expect(tags[3].getAttribute('title')).toMatch(/too small to see/)
  })

  it('reads a yes/no column as a rate when the contract did not say', () => {
    render(<ExperimentContract contract={{ ...FULL, binary: undefined }} rate />)
    expect(document.querySelector('.xc-line')!.textContent).toMatch(/^converted as a rate/)
  })

  it('keeps amendments on the record, with who and why', async () => {
    render(<ExperimentContract contract={FULL} amendments={[
      { at: '2026-08-22T00:00:00Z', by: 'maya', why: 'added the refund guardrail' }]} />)
    await userEvent.setup().click(screen.getByText('1 amendment on record'))
    expect(screen.getByText('added the refund guardrail')).toBeTruthy()
  })
})

describe('guardrails by which way is good', () => {
  it('lists higher-is-better and lower-is-better apart, by readable name', () => {
    render(<ExperimentContract contract={{ ...FULL, guardrails: [
      { outcome: 'added_to_cart', better: 'up' }, { outcome: 'payment_failed', better: 'down' },
      { outcome: 'page_load_ms', better: 'down' }] }} />)
    const rows = [...document.querySelectorAll('.xc-guards')].map(r => r.textContent)
    expect(rows).toEqual(['↑ Higher is betterAdded to cart', '↓ Lower is betterPayment failedPage load ms'])
  })
})
