import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardsView } from '../Dashboards'
import { forgetLiveDashboards, listDashboards } from '../../data/api'
import { toRow } from '../../data/gateway'

vi.mock('../../data/api', async original => ({
  ...await original<typeof import('../../data/api')>(), listDashboards: vi.fn(), forgetLiveDashboards: vi.fn(),
}))
const rows = ['Revenue', 'Review wait'].map((title, i) => toRow({
  id: `d${i}`, key: `DASH-${i}`, title, panel_count: 2, certified: !i, unratified: i,
  queries: i, metrics: ['spend'], owner: 'Maya', connection_id: 'warehouse', updated_at: null,
  preview_panels: [{ id: `p${i}`, title: 'Spend over time', mark: i ? 'bar' : 'line', span: 6 }],
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listDashboards).mockImplementation(async ({ cursor = 0, filter, q }) => {
    const matches = rows.filter(row => (!q || row.title.toLowerCase().includes(q.toLowerCase()))
      && (filter !== 'certified' || row.certified) && (filter !== 'attention' || !row.certified))
    return { items: matches.slice(cursor, cursor + 1), total: matches.length,
      nextCursor: cursor + 1 < matches.length ? cursor + 1 : null }
  })
})
function mount() {
  render(<MemoryRouter initialEntries={['/dashboards']}><Routes>
    <Route path="/dashboards" element={<DashboardsView />} />
    <Route path="/dashboards/new" element={<h1>Create dashboard</h1>} />
    <Route path="/dashboards/:id" element={<h1>Dashboard detail</h1>} />
  </Routes></MemoryRouter>)
}

describe('dashboard gallery', () => {
  it('defaults to visual cards, provides accessible links, and paginates without querying dashboards', async () => {
    const u = userEvent.setup()
    mount()
    expect(await screen.findByRole('link', { name: 'Open dashboard Revenue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('img', { name: /Revenue: panel preview/ })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('1 of 2 dashboards')
    await u.click(screen.getByRole('button', { name: 'Load more dashboards' }))
    expect(await screen.findByRole('link', { name: 'Open dashboard Review wait' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('heading', { name: 'Dashboards 2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more dashboards' })).toBeNull()
    expect(listDashboards).toHaveBeenLastCalledWith({ cursor: 1, filter: 'all', q: '' })
    await u.click(screen.getByRole('link', { name: 'Open dashboard Revenue' }))
    expect(await screen.findByRole('heading', { name: 'Dashboard detail' })).toBeTruthy()
  })

  it('retains a compact list option without refetching on display changes', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open dashboard Revenue' })
    await u.click(screen.getByRole('button', { name: 'List view' }))
    expect(document.querySelector('.list-dash')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Dashboards' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Grid view' }))
    expect(screen.getByRole('link', { name: 'Open dashboard Revenue' })).toBeTruthy()
    expect(listDashboards).toHaveBeenCalledTimes(1)
  })

  it('searches, filters, and recovers from an empty result', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open dashboard Revenue' })
    await u.click(screen.getByRole('button', { name: 'Needs attention' }))
    expect(await screen.findByRole('link', { name: 'Open dashboard Review wait' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open dashboard Revenue' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search dashboards' }), { target: { value: 'Missing' } })
    await screen.findByRole('heading', { name: 'No matching dashboards' })
    await u.click(screen.getByRole('button', { name: 'Show all dashboards' }))
    expect(await screen.findByRole('link', { name: 'Open dashboard Revenue' })).toBeTruthy()
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('offers a retry on initial failure instead of claiming the collection is empty', async () => {
    const u = userEvent.setup()
    vi.mocked(listDashboards).mockRejectedValueOnce(new Error('Service unavailable'))
    mount()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service unavailable'))
    expect(screen.queryByRole('heading', { name: 'No matching dashboards' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Open dashboard Revenue' })).toBeTruthy()
    expect(forgetLiveDashboards).toHaveBeenCalledOnce()
  })

  it('retains existing cards on a paging failure and retries from a clean first page', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open dashboard Revenue' })
    vi.mocked(listDashboards).mockRejectedValueOnce(new Error('Page unavailable'))
    await u.click(screen.getByRole('button', { name: 'Load more dashboards' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('link', { name: 'Open dashboard Revenue' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Showing previously loaded results')
    await u.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 of 2 dashboards'))
    expect(listDashboards).toHaveBeenLastCalledWith({ cursor: 0, filter: 'all', q: '' })
  })

  it('makes dashboard creation a distinct primary action', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(screen.getByRole('button', { name: '+ New dashboard' }))
    expect(await screen.findByRole('heading', { name: 'Create dashboard' })).toBeTruthy()
  })

  it('keeps secondary filters tucked away, combines them with status, and clears both', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open dashboard Revenue' })
    expect(screen.queryByRole('radio', { name: 'Mine' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Show sample data' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Certified' }))
    await u.click(screen.getByRole('button', { name: 'Filters' }))
    await u.click(screen.getByRole('radio', { name: 'Mine' }))
    await waitFor(() => expect(listDashboards).toHaveBeenLastCalledWith({ cursor: 0, filter: 'certified', ownership: 'mine', q: '' }))
    expect(screen.getByRole('button', { name: 'Certified' }).getAttribute('aria-pressed')).toBe('true')
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Additional dashboard filters' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Filters/ }))
    await u.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(listDashboards).toHaveBeenLastCalledWith({ cursor: 0, filter: 'all', q: '' }))
  })

})
