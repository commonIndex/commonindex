import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { DashboardCard } from '../DashboardCard'
import { DashboardThumbnail, dashboardPreviewPanels } from '../DashboardThumbnail'
import { toRow, type WireListRow } from '../../data/gateway'
import type { DashboardPreviewPanel } from '../../data/types'

const row: WireListRow = {
  id: 'revenue', key: 'DASH-1', title: 'Revenue', panel_count: 3, certified: true,
  unratified: 0, metrics: ['m.revenue', 'm.regions'], owner: 'Maya', connection_id: 'warehouse', updated_at: null,
  preview_panels: [
    { id: 'trend', title: 'Revenue over time', mark: 'line', span: 8, height: 300 },
    { id: 'total', title: 'Total revenue', mark: 'stat', span: 3 },
    { id: 'regions', title: 'Revenue by region', mark: 'bar', span: 4 },
  ],
}

describe('dashboard gallery cards', () => {
  it('carries the real panel metadata through the API mapping', () => {
    expect(toRow(row).previewPanels).toEqual(row.preview_panels)
  })

  it('shows a real layout thumbnail and never fabricates a live KPI', () => {
    render(<MemoryRouter><DashboardCard dashboard={toRow(row)} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Open dashboard Revenue' }).getAttribute('href')).toBe('/dashboards/revenue')
    expect(screen.getByRole('img', { name: /Revenue: panel preview of 3 of 3 panels/ })).toBeTruthy()
    expect(screen.getByText('Panel preview · not live values')).toBeTruthy()
    expect(document.querySelector('[data-preview-panel="trend"] span')?.textContent).toBe('Revenue over time')
    expect(screen.queryByText('Warehouse dashboard')).toBeNull()
    expect(screen.queryByText(/Open dashboard/)).toBeNull()
    expect(screen.queryByText('Open to query')).toBeNull()
    expect(screen.queryByText('28-day sample trend')).toBeNull()
    expect(screen.getByText('Certified')).toBeTruthy()
  })

  it('shows actual metric names as a fallback for an older server', () => {
    render(<MemoryRouter><DashboardCard dashboard={toRow({ ...row, preview_panels: undefined })} /></MemoryRouter>)
    expect(screen.getByText('Panel layout unavailable')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('revenue')).toBeTruthy()
  })

  it('distinguishes SQL panels from unratified metric definitions', () => {
    render(<MemoryRouter><DashboardCard dashboard={toRow({ ...row, certified: false, queries: 2, unratified: 2 })} /></MemoryRouter>)
    expect(screen.getByText('2 custom queries')).toBeTruthy()
    expect(screen.queryByText('Certified')).toBeNull()
  })

  it('labels seeded numbers as sample data and handles missing trend points', () => {
    render(<MemoryRouter><DashboardCard dashboard={{ ...toRow(row), live: false, spark: [2],
      headline: { metric: 'revenue', value: 100, unit: 'count', delta: 0, better: 'up' } }} /></MemoryRouter>)
    expect(screen.getByText('Sample dashboard')).toBeTruthy()
    expect(screen.getByText('28-day sample trend')).toBeTruthy()
    expect(document.querySelector('.dash-card-trend')).toBeNull()
  })

  it('shows registry labels, source names, and definition changes without inventing data freshness', () => {
    render(<MemoryRouter><DashboardCard dashboard={toRow({ ...row,
      connection_name: 'Platform warehouse', metric_labels: { 'm.revenue': 'Net revenue', 'm.regions': 'Regions served' },
      approved_metrics: 2, updated_at: '2026-09-24T10:00:00Z',
    })} /></MemoryRouter>)
    expect(screen.getByText('Platform warehouse').closest('p')?.title).toBe('warehouse')
    expect(screen.getByText('Net revenue · Regions served').title).toContain('m.revenue')
    expect(screen.getByText('Uses 2 approved metrics')).toBeTruthy()
    expect(screen.getByText(/Definition updated/).getAttribute('datetime')).toBe('2026-09-24T10:00:00.000Z')
    expect(screen.getByText(/Definition updated/).title).toContain('Not the warehouse data refresh time')
  })

  it.each([null, 'invalid-date'])('does not invent an update time from %s', updated_at => {
    render(<MemoryRouter><DashboardCard dashboard={toRow({ ...row, updated_at })} /></MemoryRouter>)
    expect(screen.queryByText(/Definition updated/)).toBeNull()
  })

  it('shows partial approval and pending reviews without certifying the whole dashboard', () => {
    render(<MemoryRouter><DashboardCard dashboard={{ ...toRow({ ...row, certified: false, unratified: 1,
      queries: 1, approved_metrics: 1 }), proposals: 2 }} /></MemoryRouter>)
    expect(screen.getByText('Uses 1 approved metric')).toBeTruthy()
    expect(screen.getByText('2 proposals to review')).toBeTruthy()
    expect(screen.queryByText('Certified')).toBeNull()
  })
})

describe('dashboard layout thumbnails', () => {
  it('keeps a small dashboard in source order without mutating its saved layout', () => {
    const original = structuredClone(row.preview_panels!)
    expect(dashboardPreviewPanels(row.preview_panels!)).toEqual(original)
    expect(row.preview_panels).toEqual(original)
  })

  it('selects varied chart types instead of three nearly identical trends', () => {
    const panels = ['line', 'area', 'line', 'table', 'sql', 'heatmap', 'bar']
      .map((mark, i) => ({ id: `p${i}`, title: `Panel ${i}`, mark }))
    expect(dashboardPreviewPanels(panels).map(p => p.id)).toEqual(['p0', 'p3', 'p5'])
  })

  it('bounds large galleries and reports the panels omitted from the thumbnail', () => {
    const panels = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, title: `Panel ${i}`, mark: 'line' }))
    render(<DashboardThumbnail panels={panels} title="Large" count={14} metrics={[]} />)
    expect(document.querySelectorAll('[data-preview-panel]')).toHaveLength(3)
    expect(screen.getByText('+11 panels')).toBeTruthy()
  })

  it.each(['stat', 'line', 'area', 'stacked', 'bar', 'heatmap', 'heat', 'pie', 'gauge', 'table', 'sql', 'pivot', 'unknown'])(
    'supports the %s chart shape without needing query results', mark => {
      const panels: DashboardPreviewPanel[] = [{ id: 'p', title: 'A panel', mark }]
      render(<DashboardThumbnail panels={panels} title="Example" count={1} metrics={[]} />)
      expect(screen.getByRole('img', { name: /panel preview/ })).toBeTruthy()
      expect(document.querySelector('[data-preview-panel="p"] svg')).toBeTruthy()
    })
})
