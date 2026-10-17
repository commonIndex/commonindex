/**
 * Start, stop and decide — for real, and only what the gateway will accept.
 *
 * The page promised "hypothesis → contract → readout → decision" and the last
 * step was a toast. Then, for an experiment stopped before dates existed, it
 * offered Start (refused for a stopped experiment, and defaulted to today) and
 * hid the decision it said it was waiting for.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExperimentLifecycle, type LiveExperiment } from '../ExperimentLifecycle'
import { forgetWhoAmI, type WirePlan } from '../../data/gateway'

const CONTRACT = { connection_id: 'c1', dataset_id: 'exposures', variation: 'arm', outcome: 'converted',
  unit: 'user_id', control: 'control', binary: true, mde: 0.02, planned_days: 14 }

let may: string[]
let calls: { op: string; body: Record<string, unknown> }[]

beforeEach(() => {
  forgetWhoAmI()
  calls = []
  may = ['read', 'propose', 'merge']
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ op, body })
    const out =
      op === 'actors.me' ? { id: 'alex', display: 'Alex', kind: 'human', space: 'pay', may }
      : op === 'experiments.extent' ? { first_seen: '2026-08-06T09:00:00Z', last_seen: '2026-08-26T18:00:00Z', rows: 6791 }
      : op === 'experiments.readout' ? { recorded: { id: 'readout-1', at: 'now' }, results: [] }
      : op === 'experiments.draft_rationale' ? { rationale: `We ${body.decision}: payment failures rose 43.5%.`,
          decision: body.decision, note: 'A draft.' }
      : { status: 'ok' }
    return { ok: true, status: 200, json: async () => out } as Response
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sent = (op: string) => calls.filter(c => c.op === op)

function live(experiment: Record<string, unknown>, progress: Record<string, unknown>,
              attention: string[] = []): LiveExperiment {
  return { experiment: { id: 'exp-1', status: 'running', decision: null, ...experiment },
           contract: CONTRACT, pre_registered: true,
           progress: { day: 0, days: 14, started_at: null, ends_at: null, stopped_at: null, due: false, ...progress },
           attention } as unknown as LiveExperiment
}

const PLAN: WirePlan = { per_arm: { control: 20000, variant: 20000 }, total: 40000, delta: 0.002,
  sequential: true, days: 20, assumptions: [], measured: {} }

function mount(l: LiveExperiment, units: number | null = null, plan: WirePlan | null = PLAN) {
  const onChanged = vi.fn()
  render(<ExperimentLifecycle id="exp-1" live={l} units={units} plan={plan} onChanged={onChanged} />)
  return onChanged
}

describe('an experiment with no dates on record', () => {
  it('asks a running one when traffic started, offering the table’s first day', async () => {
    const u = userEvent.setup()
    const onChanged = mount(live({}, {}))
    expect(await screen.findByText('When did traffic start?')).toBeTruthy()
    const date = screen.getByLabelText('Started') as HTMLInputElement
    await waitFor(() => expect(date.value).toBe('2026-08-06'))
    await u.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(String(sent('experiments.start')[0].body.started_at)).toMatch(/^2026-08-0[56]/)
    expect(sent('experiments.start')[0].body.stopped_at).toBeUndefined()
  })

  it('asks a stopped one when it ran — both dates — instead of offering Start', async () => {
    const u = userEvent.setup()
    mount(live({ status: 'readout' }, {}, ['stopped and waiting for a decision']))
    expect(await screen.findByText('When did it run?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    await waitFor(() => expect((screen.getByLabelText('Stopped') as HTMLInputElement).value).toBe('2026-08-26'))
    expect(screen.getByText(/The table's traffic runs/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Record dates' }))
    await waitFor(() => expect(sent('experiments.start')).toHaveLength(1))
    const body = sent('experiments.start')[0].body
    expect(String(body.started_at)).toMatch(/^2026-08-0[56]/)
    expect(String(body.stopped_at)).toMatch(/^2026-08-2[67]/)
  })

  it('still lets a stopped one be decided, saying which days that would be on', async () => {
    mount(live({ status: 'readout' }, {}, ['stopped and waiting for a decision']))
    expect(await screen.findByRole('radio', { name: 'Ship it' })).toBeTruthy()
    expect(screen.getByText(/decides on the last 30 days of data/)).toBeTruthy()
  })

  it('will not record a stop before the start', async () => {
    const u = userEvent.setup()
    mount(live({ status: 'readout' }, {}))
    const stop = await screen.findByLabelText('Stopped') as HTMLInputElement
    await waitFor(() => expect(stop.value).toBe('2026-08-26'))
    await u.clear(stop)
    await u.type(stop, '2026-08-01')
    expect(screen.getByRole('button', { name: 'Record dates' })).toHaveProperty('disabled', true)
  })
})

describe('a running experiment', () => {
  it('shows the day, and how far through the planned sample it is', async () => {
    mount(live({}, { day: 6, started_at: '2026-09-18T00:00:00Z', ends_at: '2026-10-02T00:00:00Z' }), 10000)
    expect(await screen.findByText('Day 6 of 14')).toBeTruthy()
    expect(await screen.findByText(/10,000 of ~40,000 needed \(25%\)/)).toBeTruthy()
    // 20 days at today's traffic against 14 planned — said out loud.
    expect(screen.getByText(/~20 days at today’s traffic, not 14/)).toBeTruthy()
  })

  it('drafts the reason for the decision chosen, for the person to edit and record', async () => {
    const u = userEvent.setup()
    mount(live({}, { day: 15, started_at: '2026-09-09T00:00:00Z', ends_at: '2026-09-23T00:00:00Z', due: true }))
    await u.click(await screen.findByRole('radio', { name: 'Kill it' }))
    await u.click(screen.getByRole('button', { name: 'Draft with AI' }))
    await waitFor(() => expect((screen.getByLabelText('Why') as HTMLTextAreaElement).value)
      .toBe('We kill: payment failures rose 43.5%.'))
    expect(sent('experiments.draft_rationale')[0].body).toMatchObject({ experiment_id: 'exp-1', decision: 'kill' })
    expect(sent('experiments.decide')).toHaveLength(0)            // a draft records nothing
  })

  it('records the readout and cites it when deciding, and needs a reason', async () => {
    const u = userEvent.setup()
    mount(live({}, { day: 15, started_at: '2026-09-09T00:00:00Z', ends_at: '2026-09-23T00:00:00Z', due: true },
      ['reached its planned 14 days — decide', "the last readout's sample-ratio check failed"]))
    await u.click(await screen.findByRole('radio', { name: 'Ship it' }))
    const go = screen.getByRole('button', { name: 'Record: ship' })
    expect(go).toHaveProperty('disabled', true)
    await u.type(screen.getByLabelText('Why'), 'clear win, guardrails flat')
    await u.click(go)
    await waitFor(() => expect(sent('experiments.decide')).toHaveLength(1))
    expect(sent('experiments.readout')[0].body).toMatchObject({ record: true })
    expect(sent('experiments.decide')[0].body).toMatchObject(
      { decision: 'ship', rationale: 'clear win, guardrails flat', readout_id: 'readout-1' })
  })

  it('does not repeat what the decision panel already says, but keeps what it does not', async () => {
    mount(live({}, { day: 15, started_at: '2026-09-09T00:00:00Z', due: true },
      ['reached its planned 14 days — decide', "the last readout's sample-ratio check failed"]))
    expect(await screen.findByText(/sample-ratio check failed/)).toBeTruthy()
    expect(screen.queryByText(/reached its planned 14 days/)).toBeNull()
  })
})

describe('deciding', () => {
  it('is not offered to someone who cannot make one', async () => {
    may = ['read', 'propose']
    mount(live({ status: 'readout' }, { day: 9, started_at: '2026-09-15T00:00:00Z', stopped_at: '2026-09-24T00:00:00Z' }))
    expect(await screen.findByText(/Deciding needs merge access/)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Ship it' })).toBeNull()
  })

  it('shows what was decided, by whom and why', async () => {
    mount(live({ status: 'shipped', decision: {
      outcome: 'ship', rationale: 'clear win', by: 'maya', at: '2026-09-20T00:00:00Z',
      readout_id: 'readout-abc', decision_id: 'dec-1', lift: 4.2 } }, { started_at: '2026-09-01T00:00:00Z' }))
    expect(await screen.findByText('clear win')).toBeTruthy()
    expect(screen.getByText('maya')).toBeTruthy()
    expect(screen.getByText(/\+4.2%/)).toBeTruthy()
  })
})

describe('the page’s Decide button', () => {
  it('opens the decision on a running experiment before its planned end', async () => {
    const l = live({}, { day: 5, days: 14, started_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-15T00:00:00Z' })
    const props = { id: 'exp-1', live: l, units: null, plan: PLAN, onChanged: vi.fn() }
    const { rerender } = render(<ExperimentLifecycle {...props} />)
    await screen.findByRole('button', { name: 'Decide early…' })
    expect(screen.queryByRole('radiogroup', { name: 'Decision' })).toBeNull()
    rerender(<ExperimentLifecycle {...props} deciding={1} />)
    expect(await screen.findByRole('radiogroup', { name: 'Decision' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decide early…' })).toBeNull()
  })
})
