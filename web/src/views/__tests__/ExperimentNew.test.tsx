/**
 * Setting up an experiment, driven through the real component.
 *
 * `fetch` is what is mocked, not the gateway client, so everything between the
 * click and the wire runs for real — including the exact contract body that
 * gets frozen. Mocking the client would test the mock.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExperimentNew } from '../ExperimentNew'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))
vi.mock('../../data/api', () => ({ forgetLiveExperiments: vi.fn() }))

const DATASET = {
  id: 'public.exposures', physical: 'public.exposures', is_virtual: false,
  time_column: 'ts', times: ['ts'], grains: ['day'], measures: [], slices: [],
  columns: [
    { name: 'user_id', kind: 'string' }, { name: 'arm', kind: 'string' },
    { name: 'converted', kind: 'number' }, { name: 'refunded', kind: 'number' },
  ],
}

const EVEN = { ran: true, passed: true, total: 8000, counted: 'units', threshold: 0.001,
  p_value: 1, arms: [{ name: 'control', observed: 4000, expected: 4000, ratio: 1 },
                     { name: 'variant', observed: 4000, expected: 4000, ratio: 1 }] }

const SUGGESTION = {
  dataset_id: 'public.exposures', rows: 8000, confident: true,
  verdict: 'arm looks like the version column',
  versions: [{ column: 'arm', distinct: 2, share: 0.00025 }],
  units: [{ column: 'user_id', distinct: 8000, share: 1 }],
  measures: [
    { column: 'converted', metric_id: 'conv_rate', label: 'Conversion',
      better: 'up', expr: 'AVG(converted)' },
    { column: 'refunded', metric_id: 'refund_rate', label: 'Refund rate',
      better: 'down', expr: 'AVG(refunded)' },
  ],
}

function gateway(over: Record<string, unknown> = {}) {
  const sent: Record<string, unknown> = {}
  const bodies: Record<string, unknown> = {
    'experiments.suggest': SUGGESTION,
    'connections.list': { connections: [{ id: 'c1', name: 'Warehouse', kind: 'postgres',
      dsn: '', read_only: true, impersonation: false, checked_at: null, last_error: null }] },
    'datasets.introspect': { connection: { id: 'c1', name: 'W', kind: 'postgres' },
      datasets: [DATASET] },
    'experiments.srm': { dataset_id: DATASET.id, range: '30d', srm: EVEN },
    'metrics.list': { metrics: [
      { id: 'conv_rate', version: 1, label: 'Conversion', expr: 'AVG(converted)',
        unit: 'pct', better: 'up', dataset: DATASET.id, status: 'ratified' },
      { id: 'refund_rate', version: 1, label: 'Refund rate', expr: 'AVG(refunded)',
        unit: 'pct', better: 'down', dataset: DATASET.id, status: 'ratified' },
    ] },
    'experiments.register': { experiment_id: 'exp-trust_badge', title: 'Trust badge',
      contract: {}, amended: false },
    ...over,
  }
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    sent[op] = JSON.parse(String(init.body))
    const body = bodies[op]
    const status = (body as { __status?: number })?.__status ?? 200
    return { ok: status < 400, status, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { sent, fetchMock }
}

/** Click a chip under the question with this text — scoped, because a column
 *  name also appears in the sentence describing what was found. */
async function answer(user: ReturnType<typeof userEvent.setup>, question: RegExp, option: string) {
  const section = screen.getByText(question, { selector: '.ask-q' }).closest('.ask')!
  await user.click(within(section as HTMLElement).getByRole('button', { name: option }))
}

/** Open the override panel and change one of the things the table suggested. */
async function change(user: ReturnType<typeof userEvent.setup>, label: RegExp, option: string) {
  const toggle = screen.queryByRole('button', { name: /Not right\? Change/ })
  if (toggle) await user.click(toggle)
  const field = screen.getByText(label, { selector: '.wiz-label' }).closest('.wiz-field')!
  await user.click(within(field as HTMLElement).getByRole('button', { name: option }))
}

/** Type the name, found by its question rather than its placeholder — the
 *  placeholder is derived from the table now and will change again. */
async function nameIt(user: ReturnType<typeof userEvent.setup>, text: string) {
  const section = screen.getByText(/call it/, { selector: '.ask-q' }).closest('.ask')!
  const box = within(section as HTMLElement).getAllByRole('textbox')[0]
  await user.clear(box)
  await user.type(box, text)
}

async function pickTable(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Warehouse' }))
  await user.click(await screen.findByRole('button', { name: 'public.exposures' }))
}

beforeEach(() => { navigate.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('setting up an experiment', () => {
  it('reads the table and proposes, instead of asking', async () => {
    const { sent } = gateway()
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)

    await waitFor(() => expect(sent['experiments.suggest']).toBeTruthy())
    expect(sent['experiments.suggest']).toMatchObject({ dataset_id: 'public.exposures' })

    // Three questions the author cannot reliably answer about their own data,
    // replaced by one finding they can confirm at a glance.
    expect(await screen.findByText('Is this the experiment?')).toBeTruthy()
    const found = document.querySelector('.found')!
    expect(within(found as HTMLElement).getByText('arm')).toBeTruthy()
    expect(within(found as HTMLElement).getByText('user_id')).toBeTruthy()
    expect(within(found as HTMLElement).getByText(/Conversion/)).toBeTruthy()
  })

  it('starts from the finding with nothing left to add', async () => {
    const { sent } = gateway()
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)
    await screen.findByText('Is this the experiment?')
    // The name defaults from the table, so the finding alone is enough.
    await user.click(await screen.findByRole('button', { name: /Start measuring/ }))

    await waitFor(() => expect(sent['experiments.register']).toBeTruthy())
    expect((sent['experiments.register'] as { contract: Record<string, unknown> }).contract)
      .toMatchObject({
        dataset_id: 'public.exposures', variation: 'arm', unit: 'user_id',
        outcome: 'converted', metric_id: 'conv_rate',
      })
  })

  it('lets a wrong guess be corrected', async () => {
    const { sent } = gateway()
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)
    await screen.findByText('Is this the experiment?')

    await change(user, /hoping changes/, 'Refund rate')
    await nameIt(user, 'x')
    await user.click(screen.getByRole('button', { name: /Start measuring/ }))

    await waitFor(() => expect(sent['experiments.register']).toBeTruthy())
    const c = (sent['experiments.register'] as { contract: Record<string, unknown> }).contract
    expect(c.outcome).toBe('refunded')
    expect(c.metric_id).toBe('refund_rate')
  })

  it('opens the pickers itself when it is not sure', async () => {
    gateway({ 'experiments.suggest': { ...SUGGESTION, confident: false,
      verdict: 'several columns could hold the version' } })
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)

    // No "Not right? Change" to hunt for — an uncertain guess shows its work.
    expect(await screen.findByText(/which version each person saw/)).toBeTruthy()
  })

  it('says so when the table holds no experiment', async () => {
    gateway({ 'experiments.suggest': { dataset_id: 'public.exposures', rows: 6,
      confident: false, versions: [], units: [], measures: [],
      verdict: 'no column holds a small set of repeated values, so nothing here names a version' } })
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)

    expect(await screen.findByText(/nothing here names a version/)).toBeTruthy()
    expect(screen.getByText(/probably not where the experiment was recorded/)).toBeTruthy()
  })

  it('says up front that it measures rather than assigns', async () => {
    gateway()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    expect(screen.getByText(/already running/)).toBeTruthy()
    expect(screen.getByText(/does not split traffic or create versions itself/)).toBeTruthy()
  })

  it('still checks the split, and says what it found in the column', async () => {
    gateway()
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)

    expect(await screen.findByText(/2 versions:/)).toBeTruthy()
    expect(screen.getByText(/Consistent with an even split/)).toBeTruthy()
  })

  it('warns when the baseline was guessed', async () => {
    gateway({ 'experiments.srm': { dataset_id: 'public.exposures', range: '30d', srm: {
      ...EVEN, arms: [{ name: 'new', observed: 4000, expected: 4000, ratio: 1 },
                      { name: 'old', observed: 4000, expected: 4000, ratio: 1 }] } } })
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)

    // new/old resolves to `new`, which inverts every result.
    expect(await screen.findByText(/every result reads backwards/)).toBeTruthy()
  })

  it('keeps optional settings out of the way', async () => {
    gateway()
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)
    await screen.findByText('Is this the experiment?')

    expect(screen.queryByText(/must not get worse/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /More settings/ }))
    expect(screen.getByText(/must not get worse/)).toBeTruthy()
  })

  it('shows a rejection against the field the gateway names', async () => {
    gateway({ 'experiments.register': { __status: 422, error: {
      code: 'metric_dataset_mismatch', field: 'contract.metric_id',
      message: "conv_rate is defined on 'other.table'" } } })
    const user = userEvent.setup()
    render(<MemoryRouter><ExperimentNew /></MemoryRouter>)
    await pickTable(user)
    await nameIt(user, 'x')
    await user.click(screen.getByRole('button', { name: /Start measuring/ }))

    expect(await screen.findByText(/contract\.metric_id/)).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })
})
