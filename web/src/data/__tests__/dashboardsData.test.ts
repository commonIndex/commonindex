import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetLiveDashboards, listDashboards } from '../api'
import { forgetWhoAmI } from '../gateway'

const rows = [
  { id: 'mine-approved', owner: 'maya', certified: true },
  { id: 'mine-review', owner: 'maya', certified: false },
  { id: 'other-approved', owner: 'rhea', certified: true },
].map(row => ({ ...row, key: row.id, title: row.id, panel_count: 1,
  unratified: row.certified ? 0 : 1, metrics: ['m.net_revenue'],
  metric_labels: { 'm.net_revenue': 'Net revenue after refunds' },
  connection_id: 'conn-platform', connection_name: 'Finance warehouse', updated_at: null,
}))

beforeEach(() => {
  forgetLiveDashboards(); forgetWhoAmI()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    if (!['dashboards.list', 'actors.me'].includes(op)) throw new Error(`Unexpected request: ${op}`)
    return { ok: true, status: 200, json: async () => op === 'dashboards.list'
      ? { dashboards: rows } : { id: 'maya', display: 'Maya', kind: 'human', space: 'pay', may: ['read'] } } as Response
  }))
})
afterEach(() => { vi.unstubAllGlobals(); forgetLiveDashboards(); forgetWhoAmI() })

describe('dashboard gallery data', () => {
  it('combines status and ownership rather than silently replacing the status filter', async () => {
    expect((await listDashboards({ filter: 'certified', ownership: 'mine' })).items.map(d => d.id)).toEqual(['mine-approved'])
    expect((await listDashboards({ filter: 'attention', ownership: 'mine' })).items.map(d => d.id)).toEqual(['mine-review'])
    expect((await listDashboards({ filter: 'mine' })).total).toBe(2)
  })

  it.each(['Finance warehouse', 'conn-platform', 'Net revenue after refunds', 'm.net_revenue'])(
    'searches both readable names and exact identifiers: %s', async q => {
      expect((await listDashboards({ q })).total).toBe(3)
    })

  it('reuses metadata when filtering and never requests warehouse values', async () => {
    await listDashboards({})
    await listDashboards({ filter: 'certified' })
    await listDashboards({ q: 'revenue' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('dashboards.list')
  })
})
