/**
 * Refreshing a dashboard.
 *
 * This test exists because it did not. The readout half of the same change had
 * tests and worked; the dashboard half was an edit that silently failed to
 * apply — the import landed, the JSX did not — and nothing caught it. The
 * button was simply absent from the page.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDetail } from '../Dashboards'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'dash-analyst_throughput-6e1d6693' }),
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const ROW = {
  id: 'dash-analyst_throughput-6e1d6693', key: 'DASH-1', title: 'Analyst throughput',
  panel_count: 1, certified: true, unratified: 0, metrics: ['agent_acceptance'],
  owner: 'alex', connection_id: 'conn-platform', updated_at: null,
}

function dash(value: number) {
  return {
    dashboard: { id: ROW.id, title: ROW.title, range: '30d',
                 connection_id: 'conn-platform', dataset_id: 'public.work' },
    certified: true, unratified: [], window_days: 30,
    panels: [{
      panel: { id: 'p1', title: 'Acceptance', mark: 'stat',
               metric_id: 'agent_acceptance', dataset_id: 'public.work', grain: 'none' },
      label: 'Acceptance', unit: 'pct', better: 'up',
      series: [{ name: 'all', points: [['2026-08-01T00:00:00Z', value]] }],
    }],
  }
}

/** Two panels, so there is something to reorder. */
function two(value: number) {
  const d = dash(value)
  const mk = (id: string, title: string) => ({
    panel: { id, title, mark: 'line', metric_id: 'agent_acceptance',
             dataset_id: 'public.work', grain: 'day' },
    label: title, unit: 'pct', better: 'up',
    series: [{ name: 'all', points: [['2026-08-01T00:00:00Z', value]] }],
  })
  return { ...d, panels: [mk('p1', 'First'), mk('p2', 'Second')] }
}

// `.p-title` is what a chart panel renders its name into. An earlier selector
// matched nothing, so the reorder assertion compared [] to [] and passed
// without exercising anything.
const titles = () =>
  Array.from(document.querySelectorAll('.pv .p-title')).map(n => n.textContent?.trim())

/** jsdom has no drag implementation, so the events are dispatched by hand with
 *  the dataTransfer the handlers read.
 *
 *  Each step is its own `act`: `dragstart` sets the dragged id in state, and
 *  `drop` reads it. Dispatched together they run against the state from before
 *  the first one, so the drop sees no drag in progress and returns. */
async function drag(from: HTMLElement, to: HTMLElement) {
  const dt = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' }
  const ev = async (t: string, el: HTMLElement) => {
    await act(async () => {
      const e = new Event(t, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
      e.dataTransfer = dt
      el.dispatchEvent(e)
    })
  }
  await ev('dragstart', from)
  await ev('dragover', to)
  await ev('drop', to)
}

function mount(bodies: unknown[]) {
  let n = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void init
    const op = String(url).split('/api/v1/')[1]
    const body = op === 'dashboards.render'
      ? bodies[Math.min(n++, bodies.length - 1)]
      : { dashboards: [ROW] }
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MemoryRouter><DashboardDetail /></MemoryRouter>)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('refreshing a dashboard', () => {
  it('keeps source metadata folded while the chart workspace is visible', async () => {
    mount([dash(61)])
    expect(await screen.findByRole('heading', { name: 'Analyst throughput' })).toBeTruthy()
    expect(document.querySelector('.dashboard-about')).toHaveProperty('open', false)
    expect(screen.getByRole('region', { name: 'Dashboard controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy()
  })

  it('renames the dashboard title in the header after saving', async () => {
    mount([dash(61)])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const title = screen.getByRole('textbox', { name: 'Dashboard title' })
    await user.clear(title)
    await user.type(title, 'Operational health{Enter}')
    await waitFor(() => expect(title).toHaveProperty('value', 'Operational health'))
    await user.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(screen.getByRole('heading', { name: 'Operational health' })).toBeTruthy()
  })

  it('offers the control at all', async () => {
    mount([dash(61)])
    // The whole point: the button was missing from the rendered page while the
    // import for it sat at the top of the file.
    expect(await screen.findByRole('button', { name: /Refresh/ })).toBeTruthy()
  })

  it('re-runs every panel against the warehouse', async () => {
    const fetchMock = mount([dash(61), dash(72)])
    await screen.findByRole('button', { name: /Refresh/ })
    const renders = () => fetchMock.mock.calls
      .filter(c => String(c[0]).endsWith('dashboards.render')).length
    await waitFor(() => expect(renders()).toBe(1))

    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(renders()).toBe(2))
  })

  it('reports when it last read', async () => {
    mount([dash(61)])
    expect(await screen.findByText(/just now/)).toBeTruthy()
  })

  it('holds the grid rather than blanking it while re-reading', async () => {
    mount([dash(61)])
    await screen.findByRole('button', { name: /Refresh/ })
    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh/ }))
    // .is-loading dims the existing grid; there is no skeleton to flash.
    await waitFor(() => expect(document.querySelector('.panel-grid')).toBeTruthy())
  })
})

describe('reordering panels', () => {
  it('puts persistent resize controls before the chart instead of over its title', async () => {
    mount([two(61)])
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit' }))
    const panel = document.querySelector('.pv')!
    const controls = panel.querySelector('.pv-tools')!
    const chart = panel.querySelector('.panel')!
    expect(controls.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/Changes save immediately; there is no undo history/)).toBeTruthy()
  })

  it('is not offered while reading — only in edit mode', async () => {
    mount([dash(61)])
    await screen.findByRole('button', { name: /Refresh/ })
    // The panels are the read surface too. A stray drag on a chart would
    // rewrite the dashboard for everyone looking at it.
    expect(document.querySelector('[draggable="true"]')).toBeNull()
  })

  it('sends the whole order, not the pair that moved', async () => {
    const fetchMock = mount([two(61)])
    await screen.findByRole('button', { name: /Refresh/ })
    await userEvent.setup().click(screen.getByRole('button', { name: /Edit/ }))

    const tiles = Array.from(document.querySelectorAll('.pv')) as HTMLElement[]
    expect(tiles).toHaveLength(2)
    await drag(tiles[1], tiles[0])

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('panels.reorder'))
      expect(call).toBeTruthy()
      // Both ids, in the new order — a from/to pair would leave the stored
      // order briefly neither old nor new.
      expect(JSON.parse(String(call![1]?.body)).panel_ids).toEqual(['p2', 'p1'])
    })
  })

  it('moves a panel to the right by dropping it on the one after it', async () => {
    // Inserting before the target put a panel dropped on its right-hand
    // neighbour back where it was: left worked, right never did.
    const fetchMock = mount([two(61)])
    await screen.findByRole('button', { name: /Refresh/ })
    await userEvent.setup().click(screen.getByRole('button', { name: /Edit/ }))
    const tiles = Array.from(document.querySelectorAll('.pv')) as HTMLElement[]
    await drag(tiles[0], tiles[1])
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('panels.reorder'))
      expect(JSON.parse(String(call![1]?.body)).panel_ids).toEqual(['p2', 'p1'])
    })
  })

  it('moves a panel one place with its own buttons, no drag needed', async () => {
    const fetchMock = mount([two(61)])
    const u = userEvent.setup()
    await screen.findByRole('button', { name: /Refresh/ })
    await u.click(screen.getByRole('button', { name: /Edit/ }))
    const later = screen.getAllByRole('button', { name: 'Move later' })
    expect(later[1]).toHaveProperty('disabled', true)             // the last cannot go further
    expect(screen.getAllByRole('button', { name: 'Move earlier' })[0]).toHaveProperty('disabled', true)
    await u.click(later[0])
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('panels.reorder'))
      expect(JSON.parse(String(call![1]?.body)).panel_ids).toEqual(['p2', 'p1'])
    })
  })

  it('places a panel at a column: shift right, and back to automatic', async () => {
    const fetchMock = mount([two(61)])
    const u = userEvent.setup()
    await screen.findByRole('button', { name: /Refresh/ })
    await u.click(screen.getByRole('button', { name: /Edit/ }))
    const tile = (document.querySelectorAll('.pv') as NodeListOf<HTMLElement>)[0]
    await u.click(screen.getAllByRole('button', { name: 'Shift right' })[0])
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('panels.resize'))
      expect(JSON.parse(String(call![1]?.body)).cols).toEqual({ p1: 2 })   // from where it was drawn, one right
    })
    expect(tile.style.getPropertyValue('--col')).toBe('2')
    await u.click(screen.getAllByRole('button', { name: /col 2/ })[0])
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('panels.resize'))
      expect(JSON.parse(String(calls.at(-1)![1]?.body)).cols).toEqual({ p1: null })
    })
  })

  it('moves the panel immediately rather than waiting for the write', async () => {
    mount([two(61)])
    await screen.findByRole('button', { name: /Refresh/ })
    await userEvent.setup().click(screen.getByRole('button', { name: /Edit/ }))

    const before = titles()
    expect(before).toEqual(['First', 'Second'])   // the selector must actually match
    await drag(document.querySelectorAll('.pv')[1] as HTMLElement,
               document.querySelectorAll('.pv')[0] as HTMLElement)
    await waitFor(() => expect(titles()).toEqual([...before].reverse()))
  })
})

describe('a window after the data stopped', () => {
  const at = (daysAgo: number, value: number | null) => {
    const d = dash(0)
    const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
    return { ...d, panels: d.panels.map(p => ({ ...p,
      series: [{ name: 'all', points: value === null ? [] : [[when, value]] }] })) }
  }

  it('says where the newest data is, and offers the range that reaches it', async () => {
    const fetchMock = mount([at(0, null), at(40, 61), at(40, 61)])
    const offer = await screen.findByRole('button', { name: 'Show the last 60 days' })
    // One empty panel explains itself in its own card; no banner repeats it.
    expect(document.querySelector('.panel-empty .p-none')!.textContent)
      .toMatch(/^Nothing in the last 30 days\. The latest reading is from /)
    expect(document.querySelector('.dash-older')).toBeNull()
    const ranges = () => fetchMock.mock.calls.filter(c => String(c[0]).endsWith('dashboards.render'))
      .map(c => JSON.parse(String((c[1] as RequestInit).body)).range)
    // The year was read once, to find it.
    expect(ranges()).toEqual(['30d', '365d'])
    await userEvent.setup().click(offer)
    await waitFor(() => expect(ranges().at(-1)).toBe('60d'))
    expect(screen.getByRole('button', { name: 'Last 60 days' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('looks at the empty panels only: another panel with data from today changes nothing', async () => {
    // One panel has today's data; the other's table stopped 40 days ago.
    const mixed = (emptyToday: boolean) => {
      const d = two(0)
      const now = new Date().toISOString()
      const then = new Date(Date.now() - 40 * 86_400_000).toISOString()
      return { ...d, panels: [
        { ...d.panels[0], series: [{ name: 'all', points: [[now, 5]] }] },
        { ...d.panels[1], series: [{ name: 'all', points: emptyToday ? [] : [[then, 7]] }] },
      ] }
    }
    mount([mixed(true), mixed(false)])
    expect(await screen.findByRole('button', { name: 'Show the last 60 days' })).toBeTruthy()
    expect(document.querySelectorAll('.panel-empty')).toHaveLength(1)
  })

  it('offers nothing when the year is empty too', async () => {
    const fetchMock = mount([at(0, null), at(0, null)])
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => String(c[0]).endsWith('dashboards.render')).length).toBe(2))
    expect(document.querySelector('.dash-older')).toBeNull()
  })
})
