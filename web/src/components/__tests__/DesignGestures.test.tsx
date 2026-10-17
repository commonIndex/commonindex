/**
 * Grabbing a box and changing it.
 *
 * Driven through the real renderer with real pointer events, because the whole
 * feature is the arithmetic between a pointer and a spec: how far the cursor
 * travelled, what the preview is scaled by, and which element was under it.
 * A test that called `gesturePatch` directly would check the half that was
 * never in doubt.
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DesignScreenView, onSystem } from '../DesignCanvas'
import type { DesignElement, DesignScreen, WireDesign } from '../../data/gateway'

// `email` has no device chrome, so at width = screen width the preview is
// drawn 1:1 and a pixel of pointer travel is a pixel of spec.
const W = 400
const H = 600
const scr = (elements: DesignElement[]): DesignScreen =>
  ({ id: 's1', name: 'S', w: W, h: H, elements })

const box = (over: Partial<DesignElement> = {}): DesignElement =>
  ({ id: 'b1', role: 'button', text: 'Go', x: 20, y: 30, w: 100, h: 40, ...over })

function mount(elements: DesignElement[], opts: {
  width?: number; selected?: number[]
} = {}) {
  const onEdit = vi.fn()
  const onReorder = vi.fn()
  const onSelect = vi.fn()
  const onNavigate = vi.fn()
  const r = render(
    <DesignScreenView screen={scr(elements)} surface="email" interactive
                      width={opts.width ?? W} selected={opts.selected}
                      onSelect={onSelect} onNavigate={onNavigate}
                      onEdit={onEdit} onReorder={onReorder} />)
  return { ...r, onEdit, onReorder, onSelect, onNavigate }
}

const drag = (node: Element, from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(node, { clientX: from[0], clientY: from[1], button: 0 })
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1], buttons: 1 })
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] })
}

describe('dragging a placed element', () => {
  it('moves it by the distance the pointer travelled', () => {
    const { container, onEdit } = mount([box()])
    drag(container.querySelector('button')!, [0, 0], [60, 20])
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0][0]).toEqual([0])
    expect(onEdit.mock.calls[0][1]).toEqual({ x: 80, y: 50 })
    expect(onEdit.mock.calls[0][2]).toBe('move b1')
  })

  it('travels in spec units, not screen pixels, when the preview is scaled', () => {
    // Drawn at half size: the box has to keep up with the cursor, so 60 screen
    // pixels is 120 of its own.
    const { container, onEdit } = mount([box()], { width: W / 2 })
    drag(container.querySelector('button')!, [0, 0], [60, 20])
    expect(onEdit.mock.calls[0][1]).toEqual({ x: 140, y: 70 })
  })

  it('writes nothing when it lands where it started', () => {
    const { container, onEdit } = mount([box()])
    fireEvent.pointerDown(container.querySelector('button')!, { clientX: 0, clientY: 0, button: 0 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40, buttons: 1 })
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0, buttons: 1 })
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('treats a hand that wobbles as a click, not a drag', () => {
    const { container, onEdit, onSelect } = mount([box()])
    drag(container.querySelector('button')!, [0, 0], [1, 1])
    fireEvent.click(container.querySelector('button')!)
    expect(onEdit).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith([0])
  })

  it('treats a few pixels of a real hand as a click — it moved and saved the tab bar', () => {
    const { container, onEdit } = mount([box()])
    drag(container.querySelector('button')!, [0, 0], [2, -2])
    expect(onEdit).not.toHaveBeenCalled()
    drag(container.querySelector('button')!, [0, 0], [4, 3])
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('still drags once the pointer has really travelled', () => {
    const { container, onEdit } = mount([box()])
    drag(container.querySelector('button')!, [0, 0], [8, 0])
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('keeps a corner of it on the screen, so it cannot be dragged away and lost', () => {
    const { container, onEdit } = mount([box()])
    drag(container.querySelector('button')!, [0, 0], [-9000, 9000])
    const { x, y } = onEdit.mock.calls[0][1]
    expect(x).toBeGreaterThan(-100)   // not off past its own width
    expect(y).toBeLessThan(H)         // still within the screen
  })

  it('does not follow a prototype link while it is being edited', () => {
    // Otherwise a nav button cannot be selected at all: touching it leaves.
    const { container, onNavigate, onSelect } = mount([box({ goto: 's2' })])
    fireEvent.click(container.querySelector('button')!)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith([0])
  })
})

describe('the resize handles', () => {
  it('appear only on the selected element', () => {
    const plain = mount([box()])
    expect(plain.container.querySelectorAll('[data-handle]')).toHaveLength(0)
    const picked = mount([box()], { selected: [0] })
    expect(picked.container.querySelectorAll('[data-handle]')).toHaveLength(4)
  })

  it('pull the corner they are on', () => {
    const { container, onEdit } = mount([box()], { selected: [0] })
    drag(container.querySelector('[data-handle="se"]')!, [0, 0], [30, 10])
    expect(onEdit.mock.calls[0][1]).toEqual({ x: 20, y: 30, w: 130, h: 50 })
    expect(onEdit.mock.calls[0][2]).toBe('resize b1')
  })

  it('move the box when the corner pulled is the top-left one', () => {
    const { container, onEdit } = mount([box()], { selected: [0] })
    drag(container.querySelector('[data-handle="nw"]')!, [0, 0], [10, 10])
    expect(onEdit.mock.calls[0][1]).toEqual({ x: 30, y: 40, w: 90, h: 30 })
  })

  it('stop rather than turning the box inside out', () => {
    const { container, onEdit } = mount([box()], { selected: [0] })
    drag(container.querySelector('[data-handle="se"]')!, [0, 0], [-500, -500])
    const { w, h } = onEdit.mock.calls[0][1]
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
  })

  it('are not part of the drawing, so they cannot be exported into the file', () => {
    const { container } = mount([box()], { selected: [0] })
    const stage = container.querySelector('[data-stage]')!.cloneNode(true) as HTMLElement
    stage.querySelectorAll('[data-editor]').forEach(n => n.remove())
    expect(stage.querySelectorAll('[data-handle]')).toHaveLength(0)
    expect(stage.querySelector('button')).toBeTruthy()
  })
})

describe('dragging a child of a container', () => {
  const stack = (): DesignElement[] => [{
    id: 'col', role: 'card', x: 0, y: 0, w: 200, h: 300, layout: 'column',
    children: [
      { id: 'one', role: 'button', text: 'One' },
      { id: 'two', role: 'button', text: 'Two' },
      { id: 'three', role: 'button', text: 'Three' },
    ],
  }]

  /** jsdom lays nothing out, so the rows are given the geometry a browser
   *  would have given them: three 40px-tall boxes stacked down the container. */
  const layOut = (container: HTMLElement) => {
    const at = (n: Element, top: number) => {
      vi.spyOn(n, 'getBoundingClientRect').mockReturnValue({
        left: 0, top, right: 200, bottom: top + 40, width: 200, height: 40,
        x: 0, y: top, toJSON: () => ({}),
      } as DOMRect)
    }
    const stage = container.querySelector('[data-stage]')!
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: W, bottom: H, width: W, height: H,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    ;['0.0', '0.1', '0.2'].forEach((p, i) =>
      at(container.querySelector(`[data-path="${p}"]`)!, i * 40))
  }

  it('reorders it rather than giving it coordinates the container owns', () => {
    const { container, onEdit, onReorder } = mount(stack())
    layOut(container)
    // The third row, dragged up past the middle of the first.
    drag(container.querySelector('[data-path="0.2"]')!, [100, 90], [100, 10])
    expect(onEdit).not.toHaveBeenCalled()
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0].slice(0, 3)).toEqual([[0], 2, 0])
  })

  it('drops it at the end when it is dragged past the last row', () => {
    const { container, onReorder } = mount(stack())
    layOut(container)
    drag(container.querySelector('[data-path="0.0"]')!, [100, 10], [100, 130])
    // Three rows, so "before index 3" is the end — one past the last, which is
    // what an insertion index has to be able to say.
    expect(onReorder.mock.calls[0].slice(0, 3)).toEqual([[0], 0, 3])
  })

  it('writes nothing when it is put back where it came from', () => {
    const { container, onReorder } = mount(stack())
    layOut(container)
    drag(container.querySelector('[data-path="0.1"]')!, [100, 50], [100, 55])
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('shows where it would land', () => {
    const { container } = mount(stack())
    layOut(container)
    const row = container.querySelector('[data-path="0.2"]')!
    fireEvent.pointerDown(row, { clientX: 100, clientY: 90, button: 0 })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 10, buttons: 1 })
    expect(container.querySelector('[data-editor]')).toBeTruthy()
    fireEvent.pointerUp(window, { clientX: 100, clientY: 10 })
  })

  it('shifts it in place when it is dragged a little, not past a neighbour', () => {
    const { container, onEdit, onReorder } = mount(stack())
    layOut(container)
    const row = container.querySelector('[data-path="0.2"]') as HTMLElement
    fireEvent.pointerDown(row, { clientX: 100, clientY: 90, button: 0 })
    fireEvent.pointerMove(window, { clientX: 88, clientY: 93, buttons: 1 })
    // It follows the pointer while held…
    expect(row.style.transform).toBe('translate(-12px, 3px)')
    fireEvent.pointerUp(window, { clientX: 88, clientY: 93 })
    // …and stays where it was put, still third in the column.
    expect(onReorder).not.toHaveBeenCalled()
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0].slice(0, 2)).toEqual([[0, 2], { dx: -12, dy: 3 }])
  })

  it('adds a further drag to the shift it already has', () => {
    const els = stack()
    els[0].children![2] = { ...els[0].children![2], dx: -12, dy: 3 }
    const { container, onEdit } = mount(els)
    layOut(container)
    drag(container.querySelector('[data-path="0.2"]')!, [100, 90], [92, 87])
    expect(onEdit.mock.calls[0][1]).toEqual({ dx: -20, dy: undefined })
  })

  it('lets go when no button is held, so a lost trackpad release cannot carry it', () => {
    const { container, onReorder } = mount(stack())
    layOut(container)
    const row = container.querySelector('[data-path="0.2"]') as HTMLElement
    fireEvent.pointerDown(row, { clientX: 100, clientY: 90, button: 0 })
    // The release never arrived; the finger glides with nothing pressed.
    fireEvent.pointerMove(window, { clientX: 100, clientY: 10, buttons: 0 })
    expect(row.style.transform).toBe('')
    // The next tap is a tap, not the drop of a drag nobody was making.
    fireEvent.pointerUp(window, { clientX: 100, clientY: 10 })
    expect(onReorder).not.toHaveBeenCalled()
  })
})

describe('an element against the edge of the screen', () => {
  it('keeps its handles reachable', () => {
    // A nav is at 0,0 and as wide as the screen, so every handle sits on or
    // outside the boundary. Two things clip: the screen box and the stage
    // around it. Escaping only the first left the right-hand corners cut away
    // on a web surface, where there is no device padding between them — and my
    // test asserted against the screen box, so it passed while the stage went
    // on hiding them.
    const { container } = mount([box({ id: 'nav', role: 'nav', x: 0, y: 0, w: W, h: 66 })],
                                { selected: [0] })
    const handles = [...container.querySelectorAll('[data-handle]')]
    expect(handles).toHaveLength(4)
    for (const sel of ['[data-screen]', '[data-stage]']) {
      const clip = container.querySelector(sel)!
      expect(getComputedStyle(clip).overflow).toBe('hidden')
      for (const h of handles) expect(clip.contains(h)).toBe(false)
    }
  })

  it('does not let a corner drag carry the box off the artboard', () => {
    const { container, onEdit } = mount([box({ x: 20, y: 20, w: 100, h: 40 })],
                                        { selected: [0] })
    drag(container.querySelector('[data-handle="nw"]')!, [0, 0], [-4000, -4000])
    const { x, y } = onEdit.mock.calls[0][1]
    expect(x).toBeGreaterThan(-4000)
    expect(y).toBeGreaterThan(-4000)
  })

  it('lets an image with a picture in it be dragged', () => {
    // A native HTML5 image drag cancels the pointer stream, so an <img> could
    // not be moved while the placeholder div could.
    const { container, onEdit } = mount([box({ role: 'image', src: 'https://x/y.png' })])
    const img = container.querySelector('img')!
    expect(img.draggable).toBe(false)
    drag(img, [0, 0], [40, 20])
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('resizes from the left edge, moving the box as it shrinks', () => {
    const { container, onEdit } = mount([box({ x: 0, y: 0, w: 200, h: 60 })], { selected: [0] })
    drag(container.querySelector('[data-handle="nw"]')!, [0, 0], [30, 0])
    expect(onEdit.mock.calls[0][1]).toMatchObject({ x: 30, w: 170 })
  })
})

describe('tone', () => {
  const colourOf = (el: DesignElement) => {
    const { container } = mount([el])
    const node = container.querySelector('[data-path="0"]') as HTMLElement
    // The whole declaration, not three named properties: a divider colours
    // itself through the `border-top` shorthand and reading `borderColor`
    // reported nothing either way, which passes for the wrong reason.
    return node.style.cssText
      + '|' + [...node.querySelectorAll('*')].map(n => (n as HTMLElement).style.cssText).join(',')
  }

  // Tone is the only colour control an element has. It claimed to apply to
  // every role and applied to three.
  for (const role of ['heading', 'body', 'field-label', 'input', 'image', 'list',
                      'nav', 'tabbar', 'logo', 'avatar', 'icon', 'divider', 'card'] as const) {
    it(`changes how a ${role} is drawn`, () => {
      expect(colourOf(box({ role, tone: 'danger' })))
        .not.toBe(colourOf(box({ role, tone: 'default' })))
    })
  }
})

describe('a container that has been given real children', () => {
  const withChild = (role: DesignElement['role']): DesignElement => ({
    id: 'c', role, x: 0, y: 0, w: 300, h: 60, layout: 'row',
    children: [{ id: 'k', role: 'body', text: 'Link' }],
  })

  it('lays them out instead of painting its own furniture', () => {
    const { container } = mount([withChild('nav')])
    expect(container.querySelector('[data-path="0.0"]')?.textContent).toBe('Link')
  })

  for (const role of ['nav', 'tabbar', 'list', 'card'] as const) {
    it(`still looks like a ${role}`, () => {
      // Adding a link to a nav must not stop it being a bar with a rule under
      // it — what the role is does not depend on whether its contents are
      // painted or real.
      const { container } = mount([withChild(role)])
      const node = container.querySelector('[data-path="0"]') as HTMLElement
      expect(node.style.background).not.toBe('')
    })
  }

  it('carries its tone onto that chrome', () => {
    const plain = mount([withChild('nav')])
    const loud = mount([{ ...withChild('nav'), tone: 'danger' }])
    const style = (r: ReturnType<typeof mount>) =>
      (r.container.querySelector('[data-path="0"]') as HTMLElement).style.cssText
    expect(style(loud)).not.toBe(style(plain))
  })
})

describe('a role that paints its own contents', () => {
  it('is not turned into a bare box by being given a child', () => {
    // One click on "Add inside" made a button render as a plain div: no
    // background, no radius, and its own label gone from the screen while
    // still in the spec.
    const { container } = mount([{
      id: 'cta', role: 'button', text: 'Checkout', tone: 'accent',
      x: 0, y: 0, w: 200, h: 44,
      children: [{ id: 'k', role: 'body', text: 'Link' }],
    }])
    const node = container.querySelector('[data-path="0"]') as HTMLElement
    expect(node.tagName).toBe('BUTTON')
    expect(node.textContent).toContain('Checkout')
    expect(node.style.background).not.toBe('')
  })
})

describe('an element at exactly the origin', () => {
  it('is placed, not laid out in flow', () => {
    // `!e.x && !e.y` is true at 0,0, so the editor treated a placed element as
    // a flow child while `frame()` had already positioned it absolutely — and
    // the two disagreed about where it goes.
    const { container } = mount([box({ x: 0, y: 0 })], { selected: [0] })
    const node = container.querySelector('[data-path="0"]') as HTMLElement
    expect(node.style.position).toBe('absolute')
  })

  it('still has handles, which is how it is got off the origin', () => {
    const { container } = mount([box({ x: 0, y: 0 })], { selected: [0] })
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(4)
  })
})

describe('a colour named outright', () => {
  const tokens = {
    'color.accent': { $value: '#2f6bed', $type: 'color' as const },
    'color.surface': { $value: '#f4f5f7', $type: 'color' as const },
    'radius.md': { $value: '10px', $type: 'dimension' as const },
  }
  const draw = (el: DesignElement) => {
    const { container } = render(
      <DesignScreenView screen={scr([el])} surface="email" width={W} tokens={tokens} />)
    return (container.querySelector('[data-path="0"]') as HTMLElement).style.cssText
  }

  it('reaches a palette colour no role covers', () => {
    // Five roles reached four of a system's seven colours, so surface, bg and
    // border could not be chosen for anything.
    expect(draw(box({ role: 'heading', color: 'color.surface' })))
      .not.toBe(draw(box({ role: 'heading' })))
  })

  it('wins over the role when both are set', () => {
    expect(draw(box({ role: 'heading', tone: 'accent', color: 'color.surface' })))
      .toBe(draw(box({ role: 'heading', color: 'color.surface' })))
  })

  it('falls back rather than drawing nothing when the token is not in the palette', () => {
    expect(draw(box({ role: 'heading', color: 'color.nope' })))
      .toBe(draw(box({ role: 'heading' })))
  })

  it('colours a container is chrome too', () => {
    expect(draw(box({ role: 'card', color: 'color.accent' })))
      .not.toBe(draw(box({ role: 'card' })))
  })
})

describe('a role whose tone is not simply a colour', () => {
  const tokens = { 'color.accent': { $value: '#2f6bed', $type: 'color' as const } }
  const draw = (el: DesignElement) => {
    const { container } = render(
      <DesignScreenView screen={scr([el])} surface="email" width={W} tokens={tokens} />)
    return (container.querySelector('[data-path="0"]') as HTMLElement).style.background
  }

  it('keeps a muted button filled with the surface, not painted muted', () => {
    // `toned` answers the tone before any fallback is reached, so routing the
    // button through it turned the quiet secondary button dark grey.
    const muted = draw(box({ role: 'button', tone: 'muted' }))
    expect(muted).not.toBe(draw(box({ role: 'button', tone: 'default' })))
    expect(muted).toContain('rgb(')
  })

  it('still takes a colour it is given by name', () => {
    expect(draw(box({ role: 'button', tone: 'muted', color: 'color.accent' })))
      .not.toBe(draw(box({ role: 'button', tone: 'muted' })))
  })
})

describe('a colour of its own', () => {
  const tokens = { 'color.accent': { $value: '#2f6bed', $type: 'color' as const } }
  const draw = (el: DesignElement) => {
    const { container } = render(
      <DesignScreenView screen={scr([el])} surface="email" width={W} tokens={tokens} />)
    return (container.querySelector('[data-path="0"]') as HTMLElement).style.color
  }

  it('is drawn as written, not looked up and missed', () => {
    expect(draw(box({ role: 'heading', color: '#ff00cc' }))).toBe('rgb(255, 0, 204)')
  })

  it('takes the short form and the one with alpha', () => {
    expect(draw(box({ role: 'heading', color: '#f0c' }))).toBe('rgb(255, 0, 204)')
    expect(draw(box({ role: 'heading', color: '#ff00cc80' }))).not.toBe('')
  })

  it('is not mistaken for a token, nor a token for it', () => {
    expect(draw(box({ role: 'heading', color: 'color.accent' }))).toBe('rgb(47, 107, 237)')
    // Something that is neither resolves to neither, and falls back.
    expect(draw(box({ role: 'heading', color: 'nonsense' })))
      .toBe(draw(box({ role: 'heading' })))
  })
})

describe('counting a colour that cannot follow the palette', () => {
  const design = (elements: DesignElement[]): WireDesign => ({
    id: 'd', title: 'D', surface: 'mobile', spec: { screens: [scr(elements)] },
  })
  const tokens = { 'color.accent': { $value: '#2f6bed', $type: 'color' as const } }

  it('counts it apart from the citation, which is a different claim', () => {
    // An element can cite an approved component perfectly well and still be
    // painted a colour the palette has never heard of.
    const got = onSystem(design([
      box({ id: 'a', cites: 'color.accent', color: '#ff00cc' }),
      box({ id: 'b', cites: 'color.accent' }),
    ]), tokens)
    expect(got).toEqual({ on: 2, total: 2, unverified: 0, ownColour: 1 })
  })

  it('does not count a token as one', () => {
    expect(onSystem(design([box({ cites: 'color.accent', color: 'color.accent' })]), tokens))
      .toEqual({ on: 1, total: 1, unverified: 0, ownColour: 0 })
  })
})
