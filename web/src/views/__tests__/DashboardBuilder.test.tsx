import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardNew } from '../DashboardNew'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async orig => ({
  ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate,
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const result = {
  expr: 'COUNT(*)', unit: 'count', better: 'up', rows: 1,
  series: [{ name: 'all', points: [['2026-08-01T00:00:00Z', 42]] }],
}
type RequestBody = Record<string, unknown>

async function setup(preview: (body: RequestBody) => unknown | Promise<unknown> = () => result) {
  const requests: { op: string; body: RequestBody }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init.body)) as RequestBody
    requests.push({ op, body })
    const response = op === 'connections.list' ? { connections: [{ id: 'conn-a', name: 'Warehouse', kind: 'postgres', read_only: true }] }
      : op === 'datasets.introspect' ? { datasets: [{
        id: 'public.events', physical: 'public.events', time_column: 'ts', times: ['ts', 'created_at'], grains: ['day'],
        columns: [{ name: 'amount', kind: 'number' }, { name: 'quantity', kind: 'number' }, { name: 'status', kind: 'string' }],
        measures: ['amount', 'quantity'], slices: ['status'],
      }] }
      : op === 'panels.preview' ? await preview(body)
      : op === 'dashboards.create' ? { dashboard_id: 'new-dashboard', message: 'Created' } : {}
    return { ok: true, status: 200, json: async () => response } as Response
  }))
  Element.prototype.scrollIntoView = vi.fn()
  render(<MemoryRouter><DashboardNew /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Warehouse/ }))
  await user.click(await screen.findByText('public.events'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(false))
  return { user, requests, previews: () => requests.filter(r => r.op === 'panels.preview') }
}

afterEach(() => { vi.unstubAllGlobals(); navigate.mockClear() })

describe('safe dashboard panel authoring', () => {
  it('queries the selected preview range and refuses the stale preview during debounce', async () => {
    const { user, previews } = await setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Preview range' }), '60')
    expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(previews().at(-1)?.body.range).toBe('60d'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(false))
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    await user.click(screen.getByRole('button', { name: 'Create dashboard with 1 panel' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboards/new-dashboard?range=60d'))
  })

  it('does not overwrite a newer query with an older response', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    const { user, previews } = await setup(body => body.range === '60d'
      ? new Promise(resolve => { resolveOld = resolve }) : result)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Preview range' }), '60')
    await waitFor(() => expect(previews().at(-1)?.body.range).toBe('60d'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Preview range' }), '90')
    await waitFor(() => expect(previews().at(-1)?.body.range).toBe('90d'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(false))
    await act(async () => { resolveOld({ ...result, rows: 99 }) })
    expect(screen.getByText('Preview ready · 1 result rows')).toBeTruthy()
    expect(screen.queryByText('Preview ready · 99 result rows')).toBeNull()
  })

  it('updates title and chart locally, but re-queries sorting and row limits', async () => {
    const { user, previews } = await setup()
    const before = previews().length
    await user.type(screen.getByRole('textbox', { name: 'Panel title' }), 'Orders')
    await user.click(screen.getByRole('radio', { name: 'Area' }))
    expect(screen.getByText('Orders', { selector: '.p-title' })).toBeTruthy()
    expect(previews()).toHaveLength(before)
    await user.selectOptions(screen.getByRole('combobox', { name: 'How many rows' }), '10')
    await waitFor(() => expect(previews().at(-1)?.body.limit).toBe(10))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Order' }), 'value_asc')
    await waitFor(() => expect(previews().at(-1)?.body.sort).toBe('value_asc'))
  })

  it('re-queries denominators and categorical matching values', async () => {
    const { user, previews } = await setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure' }), 'ratio')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Column to measure' }), 'amount')
    expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(true)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Denominator' }), 'quantity')
    await waitFor(() => expect(previews().at(-1)?.body.denominator).toBe('quantity'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Denominator' }), 'amount')
    await waitFor(() => expect(previews().at(-1)?.body.denominator).toBe('amount'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure' }), 'share')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Column to measure' }), 'status')
    await user.type(screen.getByRole('textbox', { name: 'Value to match' }), 'paid')
    await waitFor(() => expect(previews().at(-1)?.body.value).toBe('paid'))
    await user.clear(screen.getByRole('textbox', { name: 'Value to match' }))
    expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(true)
  })

  it('does not carry an inferred currency format into the next count panel', async () => {
    const { user, previews } = await setup(body => ({ ...result, unit: body.agg === 'sum' ? 'currency' : 'count' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure' }), 'sum')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Column to measure' }), 'amount')
    await screen.findByText('Automatic format: currency.')
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    await waitFor(() => expect(previews().at(-1)?.body.agg).toBe('count'))
    expect(previews().at(-1)?.body.unit).toBeUndefined()
    await screen.findByText('Automatic format: plain number.')
  })

  it('keeps staged panels during editing and assigns unique generated titles', async () => {
    const { user, requests } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    expect(screen.getByRole('combobox', { name: 'Time column' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Create dashboard with 1 panel' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Rows', { selector: '.canvas .p-title' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    const add = screen.getByRole('button', { name: 'Add another panel' })
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false))
    await user.click(add)
    await user.click(screen.getByRole('button', { name: 'Create dashboard with 2 panels' }))
    await waitFor(() => expect(requests.some(r => r.op === 'dashboards.create')).toBe(true))
    const saved = requests.find(r => r.op === 'dashboards.create')!.body
    expect((saved.panels as { title: string }[]).map(p => p.title)).toEqual(['Rows', 'Rows 2'])
    expect(String(saved.idempotencyKey)).toContain('"agg":"count"')
  })

  it('blocks explicit titles that collide with a staged metric slug', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    await user.type(screen.getByRole('textbox', { name: 'Panel title' }), 'Rows!')
    expect(screen.getByRole('alert').textContent).toBe('Use a unique panel title.')
    expect(screen.getByRole('button', { name: 'Add another panel' }).hasAttribute('disabled')).toBe(true)
    expect(within(screen.getByRole('group', { name: 'Rows display' })).getByRole('button', { name: 'Table' })).toBeTruthy()
  })
})
