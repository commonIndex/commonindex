/**
 * Editing a dashboard by saying what to change: proposed in words, made only
 * on Apply, through the ordinary panel operations — and a redefined panel keeps
 * its place.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardAIEdit } from '../DashboardAIEdit'

const EDIT = {
  summary: 'Adds revenue by region; revenue per day becomes bars; drops the gauge.',
  title: null,
  add: [{ title: 'Revenue by region', mark: 'bar', agg: 'sum', column: 'amount_usd', grain: 'none', dimension: 'region' }],
  replace: [{ panel_id: 'p1', panel: { title: 'Revenue per day', mark: 'bar', agg: 'sum', column: 'amount_usd', grain: 'day' } }],
  remove: ['p2'],
  titles: { p0: 'Orders', p1: 'Revenue per day', p2: 'Refund rate' },
  dataset_id: 'public.orders',
}

function mount() {
  const sent: { op: string; body: Record<string, unknown> }[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    sent.push({ op, body })
    const out = op === 'dashboards.ai_edit' ? EDIT : op === 'panels.add' ? { panel_id: `new${n++}` } : {}
    return new Response(JSON.stringify(out), { status: 200 })
  }))
  const onApplied = vi.fn()
  render(<DashboardAIEdit dashboardId="d1" panelIds={['p0', 'p1', 'p2']} onApplied={onApplied} />)
  return { sent, onApplied }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('edit a dashboard with AI', () => {
  it('says the change in words, changes nothing until Apply, then makes it in place', async () => {
    const u = userEvent.setup()
    const { sent, onApplied } = mount()
    await u.type(screen.getByRole('textbox', { name: 'What to change' }), 'bars for revenue, add by region, drop gauge')
    await u.click(screen.getByRole('button', { name: 'Suggest' }))
    const prop = await screen.findByRole('region', { name: 'Proposed change' })
    expect(prop.textContent).toContain('Revenue per day → Revenue per day as a bar chart')
    expect(prop.textContent).toContain('Add Revenue by region as a bar chart')
    expect(prop.textContent).toContain('Remove Refund rate')
    expect(sent.map(s => s.op)).toEqual(['dashboards.ai_edit'])            // a proposal saves nothing

    await u.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(onApplied).toHaveBeenCalled())
    const ops = sent.map(s => s.op)
    expect(ops).toEqual(['dashboards.ai_edit', 'panels.add', 'panels.add', 'panels.reorder', 'panels.remove', 'panels.remove'])
    // The redefined panel takes the old one's place; the new one goes at the end.
    expect(sent.find(s => s.op === 'panels.reorder')!.body.panel_ids).toEqual(['p0', 'new0', 'new1'])
    expect(sent.filter(s => s.op === 'panels.remove').map(s => s.body.panel_id)).toEqual(['p2', 'p1'])
  })
})
