import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen, DesignTokens } from '../../data/gateway'
import { DesignChecks, citationIssues, revealCanvasElement } from '../DesignChecks'

const screens: DesignScreen[] = [{ id: 'home', name: 'Home', w: 600, h: 900, elements: [
  { id: 'repeat', role: 'card', cites: 'color.bg', children: [
    { id: 'repeat', role: 'body', text: 'Child', cites: 'color.missing' },
  ] },
  { id: 'repeat', role: 'heading', text: 'Headline' },
] }]
const tokens: DesignTokens = { 'color.bg': { $value: '#ffffff', $type: 'color' } }

describe('actionable design checks', () => {
  it('identifies nested problems by path even when element IDs repeat', () => {
    expect(citationIssues(screens, tokens).map(issue => issue.path)).toEqual([[0, 0], [1]])
  })

  it('starts compact and selects the exact element when expanded', async () => {
    const u = userEvent.setup(), onSelect = vi.fn()
    render(<DesignChecks screens={screens} tokens={tokens} ready disabled={false} onSelect={onSelect} />)
    expect(screen.getByText('2 issues')).toBeTruthy()
    expect(document.querySelector('details')).toHaveProperty('open', false)
    await u.click(screen.getByText('Design checks'))
    await u.click(screen.getByRole('button', { name: 'Inspect Child on Home' }))
    expect(onSelect).toHaveBeenCalledWith({ screen: 'home', path: [0, 0] })
    expect(screen.getByText('Unverified citation: color.missing', { exact: false })).toBeTruthy()
    expect(screen.getByText('Missing citation', { exact: false })).toBeTruthy()
  })

  it('does not claim success until the palette has resolved and disables selection while locked', async () => {
    const u = userEvent.setup(), onSelect = vi.fn()
    const { rerender } = render(<DesignChecks screens={screens} ready={false} disabled onSelect={onSelect} />)
    expect(screen.getByText('Checking…')).toBeTruthy()
    expect(screen.queryByText('No unresolved or missing token citations.')).toBeNull()
    rerender(<DesignChecks screens={screens} tokens={tokens} ready disabled onSelect={onSelect} />)
    await u.click(screen.getByText('Design checks'))
    await u.click(screen.getByRole('button', { name: 'Inspect Child on Home' }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('revealing a selected layer', () => {
  function canvas(box: { left: number; top: number; width: number; height: number }) {
    const { container } = render(<div data-testid="viewport"><div className="dscreen" data-screen-id={'screen["special"]'}>
      <div data-path="0.1">Target</div>
    </div></div>)
    const viewport = container.firstElementChild as HTMLElement
    const rect = (value: typeof box) => ({ ...value, x: value.left, y: value.top,
      right: value.left + value.width, bottom: value.top + value.height, toJSON() {} })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ left: 100, top: 100, width: 500, height: 400 }))
    vi.spyOn(viewport.querySelector('[data-path]')!, 'getBoundingClientRect').mockReturnValue(rect(box))
    viewport.scrollLeft = 100; viewport.scrollTop = 300; viewport.scrollTo = vi.fn()
    return viewport
  }

  it('scrolls only the canvas axes needed to reveal an off-screen element', () => {
    const viewport = canvas({ left: 200, top: 700, width: 100, height: 50 })
    revealCanvasElement(viewport, { screen: 'screen["special"]', path: [0, 1] })
    expect(viewport.scrollTo).toHaveBeenCalledWith({ left: 100, top: 725, behavior: 'smooth' })
  })

  it('leaves the viewport untouched when the element is already visible or missing', () => {
    const viewport = canvas({ left: 200, top: 200, width: 100, height: 50 })
    revealCanvasElement(viewport, { screen: 'screen["special"]', path: [0, 1] })
    revealCanvasElement(viewport, { screen: 'missing', path: [0, 1] })
    expect(viewport.scrollTo).not.toHaveBeenCalled()
  })

  it('reveals the leading edge of an oversized element without negative scrolling', () => {
    const viewport = canvas({ left: -300, top: -400, width: 800, height: 900 })
    revealCanvasElement(viewport, { screen: 'screen["special"]', path: [0, 1] })
    expect(viewport.scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'smooth' })
  })
})
