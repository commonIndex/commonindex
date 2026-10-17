import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardAssist as Assistant } from '../DashboardAssist'
import { DashboardNew } from '../DashboardNew'
import type { DashboardSuggestion, WireDataset } from '../../data/gateway'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async orig => ({
  ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate,
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const TABLE: WireDataset = {
  id: 'public.events', physical: 'public.events', time_column: 'ts', times: ['ts'], grains: ['day'],
  columns: [{ name: 'ts', kind: 'time' }, { name: 'amount', kind: 'number' }, { name: 'status', kind: 'string' }],
  measures: ['amount'], slices: ['status'], is_virtual: false,
}
const SQL_TABLE = { ...TABLE, id: 'sql.events', is_virtual: true, physical: 'select * from events' }
const SUGGESTION: DashboardSuggestion = {
  title: 'Activity overview', summary: 'Counts events, not people.', model: 'test-model',
  range: '30d', time_column: 'ts', note: 'Nothing saved.',
  panels: [
    { title: 'Rows', agg: 'count', mark: 'stat', grain: 'none' },
    { title: 'Daily amount', agg: 'sum', column: 'amount', mark: 'line', grain: 'day', unit: 'count' },
  ],
}
const PREVIEW = { expr: 'COUNT(*)', unit: 'count', better: 'up', rows: 1,
  series: [{ name: 'all', points: [['2026-10-01T00:00:00Z', 42]] }] }
type Body = Record<string, unknown>
const fail = (message: string) => new Response(JSON.stringify({ error: { code: 'test_error', message } }), { status: 502 })

function mockGateway(override?: (op: string, body: Body) => unknown | Promise<unknown>) {
  const requests: { op: string; body: Body }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init.body)) as Body
    requests.push({ op, body })
    const custom = await override?.(op, body)
    const data = custom ?? (op === 'connections.list' ? { connections: [{ id: 'c1', name: 'Warehouse', kind: 'postgres', read_only: true }] }
      : op === 'datasets.introspect' ? { datasets: [TABLE, SQL_TABLE] }
      : op === 'dashboards.generate' ? SUGGESTION
      : op === 'panels.preview' ? PREVIEW
      : op === 'datasets.preview_sql' ? { columns: TABLE.columns, times: TABLE.times, rows: [], row_count: 0, truncated: false }
      : op === 'datasets.create_virtual' ? { dataset_id: SQL_TABLE.id }
      : op === 'dashboards.create' ? { dashboard_id: 'new-dashboard', message: 'Created' } : {})
    return data instanceof Response ? data : new Response(JSON.stringify(data))
  }))
  return requests
}

function props() {
  return { connectionId: 'c1', dataset: TABLE, timeColumn: 'ts', days: 30, existing: [], title: 'Events',
    useSuggestedTitle: true, disabled: false, onAdd: vi.fn(), onEdit: vi.fn(),
    instruction: '', onInstructionChange: vi.fn() }
}
function DashboardAssist(p: ComponentProps<typeof Assistant>) {
  const [instruction, setInstruction] = useState(p.instruction)
  return <Assistant {...p} instruction={instruction} onInstructionChange={setInstruction} />
}
async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Overview' }))
  await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
  await screen.findByRole('heading', { name: 'Review suggestions' })
}

afterEach(() => { vi.unstubAllGlobals(); navigate.mockClear() })

describe('AI dashboard review', () => {
  it('generates without querying or saving, then previews before adding drafts', async () => {
    const requests = mockGateway()
    const p = props()
    render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Suggest panels' }).hasAttribute('disabled')).toBe(true)
    await generate(user)
    expect(requests.map(r => r.op)).toEqual(['dashboards.generate'])
    expect(requests[0].body).toMatchObject({ connection_id: 'c1', dataset_id: TABLE.id, range: '30d', time_column: 'ts' })
    expect(screen.getByText('Counts events, not people.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Preview and add 2 panels' }))
    await waitFor(() => expect(p.onAdd).toHaveBeenCalledOnce())
    expect(p.onAdd.mock.calls[0][0].map((v: { draft: unknown }) => v.draft)).toEqual(SUGGESTION.panels)
    expect(p.onAdd.mock.calls[0][1]).toBe('Activity overview')
    expect(requests.map(r => r.op)).toEqual(['dashboards.generate', 'panels.preview', 'panels.preview'])
  })

  it('lets the author deselect and edit suggestions before adding', async () => {
    mockGateway()
    const p = props()
    render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    await generate(user)
    await user.click(screen.getAllByRole('button', { name: 'Edit in builder' })[0])
    expect(p.onEdit).toHaveBeenCalledWith(SUGGESTION.panels[0])
    expect((screen.getByRole('checkbox', { name: 'Rows' }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: /Use dashboard title/ }))
    await user.click(screen.getByRole('button', { name: 'Preview and add 1 panel' }))
    await waitFor(() => expect(p.onAdd).toHaveBeenCalledOnce())
    expect(p.onAdd.mock.calls[0][0]).toHaveLength(1)
    expect(p.onAdd.mock.calls[0][1]).toBeUndefined()
  })

  it('retains the proposal on preview failure and lets the author exclude that panel', async () => {
    mockGateway((op, body) => op === 'panels.preview' && body.agg === 'sum' ? fail('Cannot measure amount') : undefined)
    const p = props()
    render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: 'Preview and add 2 panels' }))
    await screen.findByText('Cannot measure amount')
    expect(p.onAdd).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Daily amount' }))
    await user.click(screen.getByRole('button', { name: 'Preview and add 1 panel' }))
    await waitFor(() => expect(p.onAdd).toHaveBeenCalledOnce())
  })

  it('shows actionable model errors and supports a retry', async () => {
    let failOnce = true
    mockGateway(op => op === 'dashboards.generate' && failOnce ? fail('Configure a model or build manually.') : undefined)
    render(<DashboardAssist {...props()} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'An overview')
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Configure a model')
    failOnce = false
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    await screen.findByRole('heading', { name: 'Review suggestions' })
  })

  it('does not invent panels when the model needs more information', async () => {
    mockGateway(op => op === 'dashboards.generate' ? { ...SUGGESTION, panels: [], summary: 'Choose a source with revenue.' } : undefined)
    render(<DashboardAssist {...props()} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'Revenue')
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    await screen.findByText('Choose a source with revenue.')
    expect(screen.queryByRole('button', { name: /Preview and add/ })).toBeNull()
  })

  it.each(['source', 'range', 'dismiss'])('ignores late generation after %s changes', async change => {
    let resolve: (value: unknown) => void = () => {}
    mockGateway(op => op === 'dashboards.generate' ? new Promise(r => { resolve = r }) : undefined)
    const p = props()
    const view = render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'Overview')
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    if (change === 'dismiss') await user.click(screen.getByRole('button', { name: 'Dismiss request' }))
    else view.rerender(<DashboardAssist {...p} {...(change === 'source' ? { dataset: SQL_TABLE } : { days: 60 })} />)
    await act(async () => { resolve(SUGGESTION) })
    expect(screen.queryByRole('heading', { name: 'Review suggestions' })).toBeNull()
    expect(p.onAdd).not.toHaveBeenCalled()
  })

  it('does not stage old previews over a dashboard changed during the request', async () => {
    let resolve: (value: unknown) => void = () => {}
    const requests = mockGateway(op => op === 'panels.preview' ? new Promise(r => { resolve = r }) : undefined)
    const p = props()
    const view = render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: 'Preview and add 2 panels' }))
    await waitFor(() => expect(requests.some(r => r.op === 'panels.preview')).toBe(true))
    view.rerender(<DashboardAssist {...p} title="My changed title" />)
    await act(async () => { resolve(PREVIEW) })
    await screen.findByText(/Your dashboard changed while previews were running/)
    expect(p.onAdd).not.toHaveBeenCalled()
    expect(requests.filter(r => r.op === 'panels.preview')).toHaveLength(1)
  })

  it('discards suggestions without modifying the dashboard', async () => {
    mockGateway()
    const p = props()
    render(<DashboardAssist {...p} />)
    const user = userEvent.setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: 'Discard suggestions' }))
    expect(screen.queryByRole('heading', { name: 'Review suggestions' })).toBeNull()
    expect(p.onAdd).not.toHaveBeenCalled()
  })
})

describe('dashboard creation with AI through the existing builder', () => {
  it('starts with the brief and preserves it through source modes, Back, and a new source', async () => {
    const requests = mockGateway()
    render(<MemoryRouter><DashboardNew /></MemoryRouter>)
    const user = userEvent.setup()
    const brief = 'Compare weekly activity and total event volume.'
    await user.type(screen.getByRole('textbox', { name: 'What would you like to understand?' }), brief)
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: /Warehouse/ }))
    const composer = screen.getByRole('region', { name: 'Describe your dashboard' })
    const sources = screen.getByRole('group', { name: 'Source type' })
    expect(composer.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    expect((screen.getByRole('textbox', { name: 'What would you like to understand?' }) as HTMLTextAreaElement).value).toBe(brief)
    await user.click(screen.getByRole('button', { name: 'Pick a table' }))
    await user.click(screen.getByText('public.events'))
    expect((screen.getByRole('textbox', { name: 'What would you like to understand?' }) as HTMLTextAreaElement).value).toBe(brief)
    expect(requests.some(r => r.op === 'dashboards.generate')).toBe(false)
    await user.click(within(screen.getByRole('navigation', { name: 'Progress' })).getByRole('button', { name: /Source/ }))
    await user.click(screen.getByText('sql.events'))
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    await screen.findByRole('heading', { name: 'Review suggestions' })
    expect(requests.find(r => r.op === 'dashboards.generate')!.body).toMatchObject({ instruction: brief, dataset_id: SQL_TABLE.id })
  })

  it('keeps an early brief when a SQL source is saved and built on', async () => {
    const requests = mockGateway()
    render(<MemoryRouter><DashboardNew /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Warehouse/ }))
    await user.click(screen.getByRole('button', { name: 'Top categories' }))
    const brief = (screen.getByRole('textbox', { name: 'What would you like to understand?' }) as HTMLTextAreaElement).value
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    await user.type(screen.getByRole('textbox', { name: 'Query Warehouse' }), 'select * from events')
    await user.click(screen.getByRole('button', { name: 'Run' }))
    await user.click(await screen.findByRole('button', { name: 'Save and build on it' }))
    await screen.findByRole('button', { name: 'Suggest panels' })
    expect((screen.getByRole('textbox', { name: 'What would you like to understand?' }) as HTMLTextAreaElement).value).toBe(brief)
    expect(requests.some(r => r.op === 'dashboards.generate')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Suggest panels' }))
    await screen.findByRole('heading', { name: 'Review suggestions' })
    expect(requests.find(r => r.op === 'dashboards.generate')!.body.instruction).toBe(brief)
  })

  it.each(['table', 'SQL'])('creates from %s only after explicit review and save', async source => {
    const requests = mockGateway()
    Element.prototype.scrollIntoView = vi.fn()
    render(<MemoryRouter><DashboardNew /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Warehouse/ }))
    if (source === 'SQL') {
      await user.click(screen.getByRole('button', { name: 'Write SQL' }))
      await user.type(screen.getByRole('textbox', { name: 'Query Warehouse' }), 'select * from events')
      await user.click(screen.getByRole('button', { name: 'Run' }))
      await user.click(await screen.findByRole('button', { name: 'Save and build on it' }))
    } else await user.click(await screen.findByText('public.events'))
    await screen.findByRole('heading', { name: 'Describe your dashboard' })
    await generate(user)
    expect(requests.some(r => r.op === 'dashboards.create')).toBe(false)
    expect(requests.find(r => r.op === 'dashboards.generate')!.body.dataset_id).toBe(source === 'SQL' ? SQL_TABLE.id : TABLE.id)
    await user.click(screen.getByRole('button', { name: 'Preview and add 2 panels' }))
    const save = await screen.findByRole('button', { name: 'Create dashboard with 2 panels' })
    expect(requests.some(r => r.op === 'dashboards.create')).toBe(false)
    expect(screen.getByRole('textbox', { name: 'Title' }).getAttribute('value')).toBe('Activity overview')
    await user.click(save)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboards/new-dashboard?range=30d'))
    expect(requests.find(r => r.op === 'dashboards.create')!.body.panels).toEqual(SUGGESTION.panels)
  })

  it('preserves manual panels and custom titles, renaming colliding AI panels', async () => {
    const requests = mockGateway()
    Element.prototype.scrollIntoView = vi.fn()
    render(<MemoryRouter><DashboardNew /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Warehouse/ }))
    await user.click(await screen.findByText('public.events'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add this panel' }).hasAttribute('disabled')).toBe(false))
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    await user.clear(screen.getByRole('textbox', { name: 'Title' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'My dashboard')
    await generate(user)
    expect((screen.getByRole('checkbox', { name: /Use dashboard title/ }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Preview and add 2 panels' }))
    await user.click(await screen.findByRole('button', { name: 'Create dashboard with 3 panels' }))
    await waitFor(() => expect(requests.some(r => r.op === 'dashboards.create')).toBe(true))
    const saved = requests.find(r => r.op === 'dashboards.create')!.body
    expect(saved.title).toBe('My dashboard')
    expect((saved.panels as { title: string }[]).map(p => p.title)).toEqual(['Rows', 'Rows 2', 'Daily amount'])
    expect(within(screen.getByRole('region', { name: 'Describe your dashboard' })).queryByRole('heading', { name: 'Review suggestions' })).toBeNull()
  })
})
