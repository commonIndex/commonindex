/**
 * The renderer.
 *
 * It drew SVG: an input was a rectangle with a caption, an image was a drawn
 * placeholder, and nothing could be typed in, focused or clicked. It now
 * renders real DOM from the same spec — "spec, never markup" governs what the
 * MODEL emits so the result stays diffable and reviewable, and never required
 * the renderer to avoid the DOM.
 *
 * These assert on rendered markup because both bugs a review found here were a
 * non-number reaching a style or attribute: nothing threw, and the drawing came
 * out wrong while the record said a design was there.
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DesignScreenView, onSystem } from '../DesignCanvas'
import type { DesignElement, DesignScreen, DesignTokens, WireDesign } from '../../data/gateway'

const el = (over: Partial<DesignElement> = {}): DesignElement => ({
  id: 'e', role: 'button', text: 'Go', cites: 'color.accent',
  x: 16, y: 16, w: 200, h: 48, ...over,
})

const scr = (over: Partial<DesignScreen> = {}): DesignScreen => ({
  id: 's', name: 'Cart', w: 390, h: 844, elements: [el()], ...over,
})

describe('DesignScreenView', () => {
  it('emits no NaN for a screen with no size', () => {
    // `email` on purpose: the only surface with no chrome, so the only one
    // where padding does not quietly rescue the divisor. Written against
    // `mobile` first, this passed with the bug still in place.
    const { container } = render(
      <DesignScreenView screen={scr({ w: 0, h: 0 })} surface="email" />)
    expect(container.innerHTML).not.toMatch(/NaN/)
  })

  it('accepts a DTCG dimension written the canonical way', () => {
    // A DTCG dimension is a string with a unit, and Number('12px') is NaN.
    const { container } = render(
      <DesignScreenView screen={scr()} tokens={{ 'radius.md': { $value: '12px' } }} />)
    expect(container.innerHTML).not.toMatch(/NaN/)
    expect(container.querySelector('button')!.style.borderRadius).toBe('12px')
  })

  it('falls back rather than drawing nothing when a token is nonsense', () => {
    const { container } = render(
      <DesignScreenView screen={scr()} tokens={{ 'radius.md': { $value: 'chartreuse' } }} />)
    expect(container.innerHTML).not.toMatch(/NaN/)
  })

  it('takes its palette from the tokens rather than a built-in', () => {
    const { container } = render(
      <DesignScreenView screen={scr()} tokens={{ 'color.accent': { $value: '#0f766e' } }} />)
    expect(container.querySelector('button')!.style.background).toContain('rgb(15, 118, 110)')
  })

  it('fills a muted container with the surface, keeping the border as its edge', () => {
    // A sidebar, a selected tile, a callout: panels a mock-up of real product
    // UI needs, and every container used to paint the page colour.
    const tokens: DesignTokens = {
      'color.bg': { $type: 'color', $value: '#ffffff' }, 'color.surface': { $type: 'color', $value: '#f4f4f5' },
      'color.border': { $type: 'color', $value: '#ececef' }, 'color.muted': { $type: 'color', $value: '#8b8b95' },
    }
    const panel = (over: Partial<DesignElement>) => el({ id: 'p', role: 'card', text: '', cites: 'color.surface', ...over })
    const { container } = render(<DesignScreenView surface="web" tokens={tokens} screen={scr({ elements: [
      panel({ id: 'side', tone: 'muted' }),
      panel({ id: 'plain' }),
      panel({ id: 'rail', tone: 'muted', children: [el({ id: 'c', x: undefined, y: undefined })] }),
    ] })} />)
    const style = (id: string) => (container.querySelector(`[data-el="${id}"]`) as HTMLElement).style
    expect(style('side').background).toBe('rgb(244, 244, 245)')
    expect(style('side').border).toContain('rgb(236, 236, 239)')
    expect(style('plain').background).toBe('rgb(255, 255, 255)')
    expect(style('rail').background).toBe('rgb(244, 244, 245)')
  })

  it('draws a muted badge as a neutral pill rather than invisibly', () => {
    // "draft", a count, "No difference detected": tinted with the surface and
    // written in the surface, it vanished on every light palette.
    const tokens: DesignTokens = { 'color.surface': { $type: 'color', $value: '#f4f4f5' }, 'color.muted': { $type: 'color', $value: '#6b6b76' } }
    const { container } = render(<DesignScreenView surface="web" tokens={tokens} screen={scr({ elements: [
      el({ id: 'b', role: 'badge', text: 'draft', tone: 'muted', cites: 'color.surface' })] })} />)
    const style = (container.querySelector('[data-el="b"]') as HTMLElement).style
    expect(style.background).toBe('rgb(244, 244, 245)')
    expect(style.color).toBe('rgb(107, 107, 118)')
  })

  it('draws an element citing nothing as drift', () => {
    const on = render(<DesignScreenView screen={scr()} />).container
    const off = render(
      <DesignScreenView screen={scr({ elements: [el({ cites: null })] })} />).container
    expect(off.querySelector('button')!.style.outline).toContain('dashed')
    expect(on.querySelector('button')!.style.outline).not.toContain('dashed')
  })

  it('renders every role without throwing or emitting NaN', () => {
    const roles: DesignElement['role'][] = ['heading', 'body', 'button', 'input', 'image',
      'list', 'nav', 'card', 'divider', 'logo', 'avatar', 'badge', 'icon', 'tabbar',
      'field-label']
    const { container } = render(<DesignScreenView screen={scr({
      elements: roles.map((role, i) => el({ id: `e${i}`, role, y: i * 50 })),
    })} />)
    expect(container.innerHTML).not.toMatch(/NaN/)
  })

  it('survives a screen with no elements at all', () => {
    const { container } = render(<DesignScreenView screen={scr({ elements: undefined })} />)
    expect(container.innerHTML).not.toMatch(/NaN/)
  })

  // ── what the SVG renderer could not do ────────────────────────────────

  it('renders an input you could actually type in', () => {
    const { container } = render(
      <DesignScreenView screen={scr({ elements: [el({ role: 'input', text: 'you@co' })] })} />)
    const input = container.querySelector('input')
    expect(input).toBeTruthy()
    expect(input!.placeholder).toBe('you@co')
  })

  it('renders a real image when the spec names one, and a placeholder when it does not', () => {
    const withSrc = render(<DesignScreenView screen={scr({
      elements: [el({ role: 'image', src: 'https://example.com/a.png', text: 'Hero' })] })} />)
    const img = withSrc.container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
    expect(img.getAttribute('alt')).toBe('Hero')

    const without = render(<DesignScreenView screen={scr({
      elements: [el({ role: 'image', src: undefined })] })} />)
    expect(without.container.querySelector('img')).toBeNull()
  })

  it('lays a container out with flex instead of coordinates', () => {
    const { container } = render(<DesignScreenView screen={scr({ elements: [el({
      id: 'row', role: 'card', layout: 'row', gap: 12, pad: 16,
      children: [el({ id: 'a', x: undefined, y: undefined }),
                 el({ id: 'b', x: undefined, y: undefined })],
    })] })} />)
    const row = container.querySelector('[data-el="row"]') as HTMLElement
    expect(row.style.display).toBe('flex')
    expect(row.style.flexDirection).toBe('row')
    expect(row.style.gap).toBe('12px')
    // children are placed by the container, not by coordinates
    const child = container.querySelector('[data-el="a"]') as HTMLElement
    expect(child.style.position).not.toBe('absolute')
    expect(container.querySelectorAll('[data-el]').length).toBe(3)
  })

  it('navigates between screens without a line of model-written script', () => {
    const onNavigate = vi.fn()
    const { container } = render(<DesignScreenView interactive onNavigate={onNavigate}
      screen={scr({ elements: [el({ goto: 'checkout' })] })} />)
    fireEvent.click(container.querySelector('button')!)
    expect(onNavigate).toHaveBeenCalledWith('checkout')
  })

  it('reports which element was clicked, so one can be selected and edited', () => {
    const onSelect = vi.fn()
    const { container } = render(<DesignScreenView interactive onSelect={onSelect}
      screen={scr({ elements: [el({ id: 'cta' })] })} />)
    fireEvent.click(container.querySelector('button')!)
    expect(onSelect).toHaveBeenCalledWith([0])
  })

  it('marks the selected element', () => {
    const { container } = render(
      <DesignScreenView screen={scr({ elements: [el({ id: 'cta' })] })} selected={[0]} />)
    expect((container.querySelector('button') as HTMLElement).style.outline).toContain('solid')
  })
})

describe('onSystem', () => {
  const design = (elements: DesignElement[]): WireDesign => ({
    id: 'd', title: 'D', surface: 'mobile', spec: { screens: [scr({ elements })] },
  })

  it('counts an element citing nothing as off-system', () => {
    expect(onSystem(design([el(), el({ id: 'b', cites: null })])))
      .toEqual({ on: 1, total: 2, unverified: 0, ownColour: 0 })
  })

  it('counts elements inside a container too', () => {
    // They were invisible to the count while being visible on the artboard.
    expect(onSystem(design([el({ id: 'row', children: [el({ id: 'c', cites: null })] })])))
      .toEqual({ on: 1, total: 2, unverified: 0, ownColour: 0 })
  })

  it('reports nothing rather than dividing by zero on an empty design', () => {
    expect(onSystem({ id: 'd', title: 'D', surface: 'mobile', spec: { screens: [] } }))
      .toEqual({ on: 0, total: 0, unverified: 0, ownColour: 0 })
  })

  // A citation is a claim that this element instantiates something approved.
  // Counting the claim rather than checking it makes the whole measure a
  // formality: a typo reads as on-system, and so does a token nobody defined.
  const tokens: DesignTokens = {
    'color.accent': { $value: '#2f6bed', $type: 'color' },
    'color.surface': { $value: '#f4f5f7', $type: 'color' },
  }

  it('counts a citation that names a token in the palette', () => {
    expect(onSystem(design([el({ cites: 'color.accent' })]), tokens))
      .toEqual({ on: 1, total: 1, unverified: 0, ownColour: 0 })
  })

  it('reports one that names nothing in it as unverified, not as approved', () => {
    // And not as drift either: the type allows citing an approved COMPONENT,
    // and there is no registry here to check one against. A design in the dev
    // database cites `cmp-heading-lg`. Calling that off-system would be as
    // wrong as calling a typo approved.
    expect(onSystem(design([el({ cites: 'color.acent' })]), tokens))
      .toEqual({ on: 0, total: 1, unverified: 1, ownColour: 0 })
  })

  it('cannot verify anything when there is no palette to check against', () => {
    // Not "on-system by default": you cannot cite an approved token where
    // nothing has been approved.
    expect(onSystem(design([el({ cites: 'color.accent' })]), {}))
      .toEqual({ on: 0, total: 1, unverified: 1, ownColour: 0 })
  })
})
