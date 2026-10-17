import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignGalleryCard, designCollection, sortDesigns, updatedTime } from '../DesignGalleryCard'
import type { WireDesign } from '../../data/gateway'

const tokens = { 'color.accent': { $value: '#007766', $type: 'color' as const } }
const design = (over: Partial<WireDesign> = {}): WireDesign => ({
  id: 'd1', title: 'Checkout', surface: 'web', state: 'draft',
  spec: { screens: [{ id: 'home', name: 'Home', w: 1280, h: 900, elements: [
    { id: 'cta', role: 'button', text: 'Continue', cites: 'color.accent', x: 24, y: 24, w: 160, h: 44 },
  ] }] }, ...over,
})
const mount = (d: WireDesign) => render(<MemoryRouter><DesignGalleryCard design={d} tokens={tokens} /></MemoryRouter>)
afterEach(() => vi.restoreAllMocks())

describe('gallery classification and ordering', () => {
  it('separates templates from ordinary approved work and supports legacy names', () => {
    expect(designCollection(design({ state: 'approved' }))).toBe('designs')
    expect(designCollection(design({ template_kind: 'layout' }))).toBe('starters')
    expect(designCollection(design({ template_kind: 'system' }))).toBe('systems')
    expect(designCollection(design({ title: 'Starter · Review' }))).toBe('starters')
    expect(designCollection(design({ title: 'System · Moss' }))).toBe('systems')
    expect(designCollection(design({ title: 'System · Demo', template_kind: 'layout' }))).toBe('starters')
  })

  it('sorts recent timestamps first, unknown dates last, without mutating the list', () => {
    const items = [design({ id: 'unknown', title: 'A', updated_at: 'not-a-date' }),
      design({ id: 'old', title: 'Z', updated_at: '2026-09-20T10:00:00Z' }),
      design({ id: 'new', title: 'B', updated_at: '2026-09-22T10:00:00Z' })]
    expect(sortDesigns(items, 'updated').map(d => d.id)).toEqual(['new', 'old', 'unknown'])
    expect(sortDesigns(items, 'name').map(d => d.id)).toEqual(['unknown', 'new', 'old'])
    expect(items[0].id).toBe('unknown')
    expect(updatedTime(items[0])).toBeNull()
    expect(updatedTime(design())).toBeNull()
  })

  it('uses a stable title and id tie-breaker for equal timestamps', () => {
    const items = [design({ id: 'z', title: 'A' }), design({ id: 'a', title: 'A' }), design({ id: 'b', title: 'B' })]
    expect(sortDesigns(items, 'updated').map(d => d.id)).toEqual(['a', 'z', 'b'])
  })
})

describe('compact gallery cards', () => {
  it('keeps the preview inert, bounded, and separate from useful card metadata', () => {
    const { container } = mount(design())
    expect(screen.getByRole('link', { name: 'Open Checkout' }).getAttribute('href')).toBe('/designs/d1')
    expect(container.querySelector('.dcard-preview')?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    const frame = container.querySelector('[data-stage]')?.parentElement as HTMLElement
    expect(parseFloat(frame.style.height)).toBeLessThanOrEqual(180)
    expect(screen.getByText('On system')).toBeTruthy()
    expect(screen.queryByText('on-system')).toBeNull()
    expect(screen.getByText('Update time unavailable')).toBeTruthy()
  })

  it('shows systems as a palette and token count, never an email screen', () => {
    const { container } = mount(design({ title: 'System · Moss', template_kind: 'system', surface: 'email' }))
    expect(screen.getByText('Design system')).toBeTruthy()
    expect(screen.getByText('1 token')).toBeTruthy()
    expect(screen.queryByText(/1 screen|email/i)).toBeNull()
    expect(container.querySelector('[data-stage]')).toBeNull()
    expect(container.querySelector('.dcard-swatches > span')?.getAttribute('style')).toContain('rgb(0, 119, 102)')
  })

  it('uses the server update timestamp and exposes the exact date', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-22T12:00:00Z'))
    mount(design({ updated_at: '2026-09-22T10:00:00Z' }))
    const time = screen.getByText('Updated 2h ago')
    expect(time.getAttribute('datetime')).toBe('2026-09-22T10:00:00Z')
    expect(time.getAttribute('title')).toBeTruthy()
  })

  it('shows an honest empty preview and safely encodes the design route', () => {
    mount(design({ id: 'design/with spaces', spec: { screens: [] } }))
    expect(screen.getByText('No screens yet')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe('/designs/design%2Fwith%20spaces')
  })
})
