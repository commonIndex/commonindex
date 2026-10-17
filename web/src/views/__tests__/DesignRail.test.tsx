/**
 * The inspector beside the artboard.
 *
 * The page used to be one column with the history above the drawing, so moving
 * a button meant scrolling past every revision that moving a button had already
 * written. These are the parts of the rail that carry information rather than
 * layout — a capped history, and the marker that says a reference has moved.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesignDetail } from '../Designs'

const tokens = {
  'color.accent': { $value: '#2f6bed', $type: 'color' },
  'color.text': { $value: '#15181d', $type: 'color' },
  'color.surface': { $value: '#f3f6f9', $type: 'color' },
}

const specWith = (cites: string | null, two = false, color?: string) => ({
  tokens,
  screens: [{ id: 's1', name: 'Home', w: 390, h: 844, elements: [
    { id: 'b1', role: 'button', text: 'Start free', tone: 'accent', cites, color,
      x: 20, y: 60, w: 200, h: 44 },
    ...(two ? [{ id: 'b2', role: 'button', text: 'Book a demo', cites,
                 x: 20, y: 120, w: 200, h: 44 }] : []),
  ] }],
})

const spec = specWith('color.accent')

const revision = (rev: number) => ({
  rev, at: new Date().toISOString(), by: 'Alex',
  note: `move b1 to ${rev},${rev} on home`, screens: 1, spec,
})

function mount(over: { revisions?: unknown[]; references?: unknown[]; stale?: boolean
                       elementCites?: string | null; twoElements?: boolean
                       container?: boolean; noScreens?: boolean
                       elementColor?: string; twoScreens?: boolean
                       goto?: string; manyScreens?: number } = {}) {
  const shown = over.manyScreens
      ? { tokens, screens: Array.from({ length: over.manyScreens }, (_, i) => ({
          id: `s${i + 1}`, name: `Step ${i + 1}`, w: 390, h: 844,
          elements: [{ id: `b${i + 1}`, role: 'button', text: 'Next step',
                       cites: 'color.accent', goto: `s${i + 2}`,
                       x: 20, y: 60, w: 200, h: 44 }] })) }
    : over.twoScreens
      ? { tokens, screens: [
          { id: 's1', name: 'Home', w: 390, h: 844, elements: [
            { id: 'b1', role: 'button', text: 'Start free', tone: 'accent',
              cites: 'color.accent', goto: over.goto ?? 's2',
              x: 20, y: 60, w: 200, h: 44 }] },
          { id: 's2', name: 'Pricing', w: 390, h: 844, elements: [
            { id: 'h2', role: 'heading', text: 'Pricing', cites: 'color.text',
              x: 20, y: 60, w: 200, h: 44 }] }] }
    : over.elementColor
      ? specWith('color.accent', false, over.elementColor)
    : over.noScreens ? { tokens, screens: [] }
    : over.container
      ? { tokens, screens: [{ id: 's1', name: 'Home', w: 390, h: 844, elements: [
          { id: 'box', role: 'card', x: 0, y: 0, w: 300, h: 120, layout: 'column',
            cites: 'color.accent',
            children: [{ id: 'k', role: 'body', text: 'Inside', cites: 'color.text' }] }] }] }
    : over.twoElements
      ? specWith(over.elementCites ?? 'color.accent', true)
      : over.elementCites === undefined ? spec : specWith(over.elementCites)
  const revised: unknown[] = []
  // The stored spec, which changes when something is written to it. A mock that
  // always hands back the original cannot show a delete or a reorder at all —
  // the page re-reads and the element it just removed is back.
  let stored: unknown = shown
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    if (op === 'designs.revise') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.spec) { revised.push(body.spec); stored = body.spec }
    }
    const body =
      op === 'designs.get' ? { design: { id: 'd1', key: 'DES-1', title: 'T', surface: 'mobile',
                                         state: 'draft', cites: [], sources: [],
                                         current_rev: 1 + revised.length,
                                         spec: stored } }
      : op === 'designs.history' ? { design_id: 'd1', revisions: (() => {
          // As the gateway answers now: no specs in the list, one by `rev`.
          const asked = JSON.parse(String(init?.body ?? '{}')).rev
          const all = (over.revisions ?? []) as { rev: number; spec?: unknown }[]
          return asked === undefined
            ? all.map(({ spec, ...r }) => ({ ...r, has_spec: spec !== undefined }))
            : all.filter(r => r.rev === asked)
        })() }
      : op === 'designs.references' ? { design_id: 'd1', references: over.references ?? [],
                                        stale: over.stale ?? false }
      : op === 'designs.list' ? { designs: [], total: 0 }
      : {}
    return { ok: true, status: 200, json: async () => body } as Response
  }))
  return {
    ...render(<RouterProvider router={createMemoryRouter([
      { path: '/designs/:id', element: <DesignDetail /> },
    ], { initialEntries: ['/designs/d1'] })} />),
    revised,
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('the history', () => {
  it('shows the recent few and offers the rest', async () => {
    const u = userEvent.setup()
    mount({ revisions: [9, 8, 7, 6, 5, 4, 3, 2].map(revision) })
    await waitFor(() => expect(screen.getByText(/Show all 8 revisions/)).toBeTruthy())
    expect(document.querySelectorAll('.hrow')).toHaveLength(6)

    await u.click(screen.getByText(/Show all 8 revisions/))
    expect(document.querySelectorAll('.hrow')).toHaveLength(8)
    await u.click(screen.getByText(/Show recent only/))
    expect(document.querySelectorAll('.hrow')).toHaveLength(6)
  })

  it('says nothing about showing more when there is nothing more', async () => {
    mount({ revisions: [3, 2].map(revision) })
    await waitFor(() => expect(document.querySelectorAll('.hrow')).toHaveLength(2))
    expect(screen.queryByText(/Show all/)).toBeNull()
  })

  it('offers no way back to the state you are already in', async () => {
    // The newest revision IS the current spec, so restoring it does nothing.
    mount({ revisions: [9, 8, 7].map(revision) })
    await waitFor(() => expect(document.querySelectorAll('.hrow')).toHaveLength(3))
    expect(screen.getAllByText('Restore')).toHaveLength(2)
  })
})

describe('restoring a revision', () => {
  it('fetches only the spec it restores, since the list carries none', async () => {
    const u = userEvent.setup()
    const { revised } = mount({ revisions: [9, 8].map(revision) })
    await waitFor(() => expect(document.querySelectorAll('.hrow')).toHaveLength(2))
    await u.click(screen.getByText('Restore'))
    await waitFor(() => expect(revised).toHaveLength(1))
    expect(revised[0]).toEqual(revision(8).spec)
  })
})

describe('references', () => {
  it('marks the design when something it was drawn from has moved', async () => {
    mount({ stale: true, references: [
      { id: 'task-9', type: 'task', key: 'T-9', title: 'Cancel a refund', changed_since: true }] })
    await waitFor(() => expect(screen.getByText(/one has moved/)).toBeTruthy())
  })

  it('says nothing when none of them has', async () => {
    mount({ stale: false, references: [
      { id: 'task-9', type: 'task', key: 'T-9', title: 'Cancel a refund' }] })
    await waitFor(() => expect(screen.getByText('Cancel a refund')).toBeTruthy())
    expect(screen.queryByText(/one has moved/)).toBeNull()
  })
})

describe('the element panel', () => {
  it('invites a click rather than sitting empty', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/Click any box on a screen/)).toBeTruthy())
  })
})

describe('editing before saving', () => {
  const el = () => document.querySelector('[data-path="0"]') as HTMLElement
  const pick = (tone: string) => screen.getByRole('button', { name: new RegExp(`^${tone}$`, 'i') })

  it('shows the colour on the screen the moment it is picked', async () => {
    // The whole report: picking a colour changed nothing until Save, so the
    // reasonable conclusion from watching it was that picking a colour does
    // not work.
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(el()).toBeTruthy())
    await u.click(el())
    const before = el().style.cssText
    await u.click(pick('danger'))
    expect(el().style.cssText).not.toBe(before)
  })

  it('has not written anything yet', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(el()).toBeTruthy())
    await u.click(el())
    await u.click(pick('danger'))
    expect(vi.mocked(fetch).mock.calls.map(c => String(c[0]).split('/api/v1/')[1]))
      .not.toContain('designs.revise')
    expect(screen.getByText('Save change')).toBeTruthy()
  })

  it('offers nothing to save until something changes', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(el()).toBeTruthy())
    await u.click(el())
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('puts it back when the change is undone', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(el()).toBeTruthy())
    await u.click(el())
    const before = el().style.cssText
    await u.click(pick('danger'))
    await u.click(screen.getByText('Undo'))
    expect(el().style.cssText).toBe(before)
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('previews text as it is typed', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(el()).toBeTruthy())
    await u.click(el())
    const field = screen.getByDisplayValue('Start free')
    await u.clear(field)
    await u.type(field, 'Get going')
    await waitFor(() => expect(el().textContent).toBe('Get going'))
  })
})

describe('what a citation is, said where it is set', () => {
  it('offers the palette this design actually has', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(document.querySelector('[data-path="0"]')).toBeTruthy())
    await u.click(document.querySelector('[data-path="0"]') as HTMLElement)
    await u.click(screen.getByText(/^Provenance/))
    const paths = [...document.querySelectorAll('datalist option')].map(o => o.getAttribute('value'))
    expect(paths).toEqual(['color.accent', 'color.surface', 'color.text'])
  })

  it('says so when the citation names nothing the palette defines', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(document.querySelector('[data-path="0"]')).toBeTruthy())
    await u.click(document.querySelector('[data-path="0"]') as HTMLElement)
    await u.click(screen.getByText(/^Provenance/))
    const field = screen.getByLabelText('Cites')
    await u.clear(field)
    await u.type(field, 'color.acent')
    expect(screen.getByText(/Not defined in this palette/)).toBeTruthy()
  })

  it('confirms provenance without claiming it controls the paint', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(document.querySelector('[data-path="0"]')).toBeTruthy())
    await u.click(document.querySelector('[data-path="0"]') as HTMLElement)
    await u.click(screen.getByText(/^Provenance/))
    expect(screen.getByText(/This citation resolves in the palette/)).toBeTruthy()
    expect(screen.getByText(/This does not set colour or typography/)).toBeTruthy()
  })

  it('does not count an unresolvable citation as approved', async () => {
    mount({ elementCites: 'color.acent' })
    // The type has always said a citation that resolves is on-system. Counting
    // the field being non-empty made a typo indistinguishable from approval.
    await waitFor(() =>
      expect(screen.getByText(/cite something it does not/)).toBeTruthy())
  })

  it('nor as drift, which is a different thing it is not', async () => {
    mount({ elementCites: 'cmp-heading-lg' })
    await waitFor(() =>
      expect(screen.getByText(/cite something it does not/)).toBeTruthy())
    expect(screen.queryByText(/cite nothing, and are drawn dashed/)).toBeNull()
  })
})

describe('an edit you have not saved', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('is held when you select something else, not thrown away', async () => {
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const field = screen.getByDisplayValue('Start free')
    await u.clear(field)
    await u.type(field, 'Get going')

    await u.click(at('1'))
    // The live preview made losing it worse: the change was on the screen
    // right up until it silently was not.
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    expect(screen.getByText('Save it')).toBeTruthy()
  })

  it('goes when you say it goes', async () => {
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const field = screen.getByDisplayValue('Start free')
    await u.clear(field)
    await u.type(field, 'Get going')
    await u.click(at('1'))
    await u.click(screen.getByText('Discard'))
    expect(screen.queryByText(/Unsaved change to/)).toBeNull()
  })

  it('is not raised when the same element is re-selected', async () => {
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const field = screen.getByDisplayValue('Start free')
    await u.clear(field)
    await u.type(field, 'Get going')
    await u.click(at('0'))
    expect(screen.queryByText(/Unsaved change to/)).toBeNull()
  })
})

describe('every way of leaving an element', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement
  const edit = async (u: ReturnType<typeof userEvent.setup>, from: string, to: string) => {
    const field = screen.getByDisplayValue(from)
    await u.clear(field)
    await u.type(field, to)
  }

  it('holds the edit when Escape clears the selection', async () => {
    // Escape called setSel directly, straight past the guard.
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    await edit(u, 'Start free', 'Get going')
    // On the window, not into the field: Escape while typing means "leave this
    // field" and is deliberately ignored.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
  })

  it('holds it when you click past the artboard', async () => {
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    await edit(u, 'Start free', 'Get going')
    await u.click(document.querySelector('.dedit-canvas') as HTMLElement)
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
  })

  it('holds more than one, rather than the second replacing the first', async () => {
    const u = userEvent.setup()
    mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    await edit(u, 'Start free', 'Get going')
    await u.click(at('1'))
    await edit(u, 'Book a demo', 'Talk to us')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getAllByText(/Unsaved change to/)).toHaveLength(2)
  })
})

/** The toolbar, scoped: its chips are role names, and role names also appear
 *  in the rail's description of whatever is selected. */
const tools = () => within(document.querySelector('.dtools') as HTMLElement)

describe('adding an element', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('is not offered inside a role that cannot lay one out', async () => {
    // It saved a child a button never renders: no box, no handles, nothing to
    // click, and counted against the on-system total forever.
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(screen.queryByText('Add inside')).toBeNull()
  })

  it('is offered inside one that can', async () => {
    const u = userEvent.setup()
    mount({ container: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(screen.getByText('Add inside')).toBeTruthy()
  })

  it('cannot be armed on a design with no screens', async () => {
    mount({ noScreens: true })
    await waitFor(() => expect(tools().getByRole('button', { name: 'Text' })).toBeTruthy())
    expect((tools().getByRole('button', { name: 'Text' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/no screens to draw on/)).toBeTruthy()
  })
})

describe('drawing a new element', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement
  const layer = () => document.querySelector('[style*="crosshair"]') as HTMLElement

  it('puts nothing on the artboard until a tool is armed', async () => {
    mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    expect(layer()).toBeNull()
  })

  it('arms a tool and offers a surface to draw on', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(tools().getByRole('button', { name: 'Controls' })).toBeTruthy())
    await u.click(tools().getByRole('button', { name: 'Controls' }))
    await u.click(tools().getByRole('button', { name: 'Button' }))
    expect(layer()).toBeTruthy()
    expect(screen.getByText(/Click a screen to place a Button/)).toBeTruthy()
  })

  it('puts the tool down on Escape without clearing the selection', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    await u.click(tools().getByRole('button', { name: 'Text' }))
    await u.click(tools().getByRole('button', { name: 'Heading' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(layer()).toBeNull()
    // Still selected: Escape with a tool armed means "stop drawing".
    expect(screen.getByDisplayValue('Start free')).toBeTruthy()
  })

  it('draws it where it was drawn, at the size it was drawn', async () => {
    const u = userEvent.setup()
    const sent = mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: '100%' }))
    await u.click(tools().getByRole('button', { name: 'Layout' }))
    await u.click(tools().getByRole('button', { name: 'Card' }))

    const el = layer()
    el.setPointerCapture = () => {}
    el.releasePointerCapture = () => {}
    vi.spyOn(document.querySelector('[data-stage]')!, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 390, height: 844,
                         right: 390, bottom: 844, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    fireEvent.pointerDown(el, { clientX: 40, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 240, clientY: 260, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 240, clientY: 260, pointerId: 1 })

    // The pointer moves in screen pixels and the element lives in spec units,
    // so what is drawn has to be divided by the preview's scale and shifted
    // past the device chrome, at the 100% zoom chosen above.
    const scale = 1
    const spec = (px: number) => Math.round(px / scale)
    await waitFor(() => {
      const wrote = sent.revised.at(-1) as { screens: { elements: unknown[] }[] }
      expect(wrote).toBeTruthy()
      const made = wrote.screens[0].elements.at(-1) as Record<string, number | string>
      expect(made.role).toBe('card')
      expect([made.x, made.y, made.w, made.h])
        .toEqual([spec(40) - 13, spec(100) - 13 - 30, spec(200), spec(160)])
    })
  })
})

describe('deleting', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('happens on the Delete key, which is where people reach first', async () => {
    const u = userEvent.setup()
    const sent = mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    fireEvent.keyDown(window, { key: 'Delete' })
    await waitFor(() => {
      const wrote = sent.revised.at(-1) as { screens: { elements: unknown[] }[] }
      expect(wrote.screens[0].elements).toHaveLength(1)
    })
  })

  it('happens on Backspace too', async () => {
    const u = userEvent.setup()
    const sent = mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    fireEvent.keyDown(window, { key: 'Backspace' })
    await waitFor(() => expect(sent.revised.at(-1)).toBeTruthy())
  })

  it('does not fire while you are typing in the panel', async () => {
    // Backspace in a text field means backspace.
    const u = userEvent.setup()
    const sent = mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const field = screen.getByDisplayValue('Start free')
    await u.type(field, '{backspace}')
    expect(sent.revised).toHaveLength(0)
    expect((field as HTMLInputElement).value).toBe('Start fre')
  })
})

describe('an element inside a container', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('offers the way up to the box that holds it', async () => {
    // A container whose children fill it has no pixel left to click, so its
    // layout, padding and alignment — and Delete — could not be reached at all.
    const u = userEvent.setup()
    mount({ container: true })
    await waitFor(() => expect(at('0.0')).toBeTruthy())
    await u.click(at('0.0'))
    const up = screen.getByText(/in card/)
    expect(up).toBeTruthy()
    await u.click(up)
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Layout' })).toBeTruthy())
  })
})

describe('a held edit when the tree moves under it', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('follows the element it was made on, not the index it was made at', async () => {
    // An index path is a position, not an identity. Delete something earlier
    // and the held edit landed on whatever slid into the slot — with a
    // revision note naming the element it had not touched.
    const u = userEvent.setup()
    const sent = mount({ twoElements: true })
    await waitFor(() => expect(at('1')).toBeTruthy())
    await u.click(at('1'))
    const field = screen.getByDisplayValue('Book a demo')
    await u.clear(field)
    await u.type(field, 'Talk to us')

    await u.click(at('0'))                       // hold the edit to b2
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Delete' }) // b1 goes; b2 is now index 0
    await waitFor(() => expect(sent.revised.at(-1)).toBeTruthy())

    await u.click(screen.getByText('Save it'))
    await waitFor(() => {
      const wrote = sent.revised.at(-1) as { screens: { elements: { id: string; text: string }[] }[] }
      const els = wrote.screens[0].elements
      expect(els).toHaveLength(1)
      expect(els[0].id).toBe('b2')
      expect(els[0].text).toBe('Talk to us')
    })
  })

  it('says so rather than writing it somewhere when the element is gone', async () => {
    const u = userEvent.setup()
    const sent = mount({ twoElements: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const field = screen.getByDisplayValue('Start free')
    await u.clear(field)
    await u.type(field, 'Get going')

    await u.click(at('1'))
    fireEvent.keyDown(window, { key: 'Delete' })  // deletes b2, the selected one
    await waitFor(() => expect(sent.revised).toHaveLength(1))
    await u.click(at('0'))                        // b1 is still there
    // now delete b1 too, with its edit held
    fireEvent.keyDown(window, { key: 'Delete' })
    await waitFor(() => expect(sent.revised.length).toBeGreaterThan(1))
    const before = sent.revised.length
    const save = screen.queryByText('Save it')
    if (save) await u.click(save)
    expect(sent.revised).toHaveLength(before)
  })
})

describe('the colour a saved element is actually drawn in', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('is the one the rail reports', async () => {
    const u = userEvent.setup()
    mount({ elementColor: 'color.surface' })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(within(screen.getByLabelText('Applied colour')).getByText('Linked')).toBeTruthy()
    expect(screen.getByLabelText('Colour token')).toHaveProperty('value', 'color.surface')
  })

  it('reports an explicit token without confusing it with the role default', async () => {
    // For a button the default is accent, not color.text. Do not conflate them.
    const u = userEvent.setup()
    mount({ elementColor: 'color.text' })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('Colour token')).toHaveProperty('value', 'color.text')
  })

  it('offers a colour of its own, and says what that costs', async () => {
    const u = userEvent.setup()
    mount({ elementColor: '#ff00cc' })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    // The hex field, not the colour input — both carry the value.
    expect((screen.getByLabelText('Hex colour') as HTMLInputElement).value).toBe('#ff00cc')
    expect(screen.getByText(/Custom colour does not follow palette changes/)).toBeTruthy()
    // and no role reads as chosen while it is in force
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows one row rather than three stacked pickers', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(document.querySelectorAll('.tones')).toHaveLength(1)
    expect(document.querySelectorAll('.sw')).toHaveLength(0)
  })

  it('does not invent an edit when you click the role already in force', async () => {
    const u = userEvent.setup()
    mount()
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    const saveButton = () => [...document.querySelectorAll('.dedit-rail button, .dedit-rail .delbar-saved')]
      .map(b => b.textContent?.trim()).find(t => t === 'Saved' || t === 'Save change')
    expect(saveButton()).toBe('Saved')
    // The one already in force — this element's role is `accent`. Clicking it
    // set `color: null` where the element had no colour at all, which counts
    // as a change and armed Save over nothing.
    await u.click(screen.getByRole('button', { name: 'Accent' }))
    expect(saveButton()).toBe('Saved')
  })
})

describe('preview', () => {
  const at = (p: string) => document.querySelector(`[data-path="${p}"]`) as HTMLElement

  it('plays one screen at a time and follows a link', async () => {
    // `goto` has described itself as "how a prototype is click-through" since
    // the first commit, and nothing in the product ever navigated.
    const u = userEvent.setup()
    mount({ twoScreens: true })
    await waitFor(() => expect(screen.getByText('Preview')).toBeTruthy())
    await u.click(screen.getByText('Preview'))

    expect(document.querySelectorAll('.dscreen')).toHaveLength(1)
    expect(screen.getByText('screen 1 of 2')).toBeTruthy()
    await u.click(at('0'))
    await waitFor(() => expect(screen.getByText('screen 2 of 2')).toBeTruthy())
  })

  it('goes back the way it came', async () => {
    const u = userEvent.setup()
    mount({ twoScreens: true })
    await waitFor(() => expect(screen.getByText('Preview')).toBeTruthy())
    await u.click(screen.getByText('Preview'))
    expect(screen.getByText('← Back').closest('button')!.disabled).toBe(true)
    await u.click(at('0'))
    await waitFor(() => expect(screen.getByText('screen 2 of 2')).toBeTruthy())
    await u.click(screen.getByText('← Back'))
    await waitFor(() => expect(screen.getByText('screen 1 of 2')).toBeTruthy())
  })

  it('says so when a link points at a screen that is gone', async () => {
    const u = userEvent.setup()
    mount({ twoScreens: true, goto: 'ghost' })
    await waitFor(() => expect(screen.getByText('Preview')).toBeTruthy())
    await u.click(screen.getByText('Preview'))
    await u.click(at('0'))
    expect(screen.getByText(/not a screen in this design/)).toBeTruthy()
    expect(screen.getByText('screen 1 of 2')).toBeTruthy()
  })

  it('does not follow links while you are editing', async () => {
    // A nav button that navigates the moment you touch it cannot be edited.
    const u = userEvent.setup()
    mount({ twoScreens: true })
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    expect(document.querySelectorAll('.dscreen')).toHaveLength(2)
    expect(screen.getByDisplayValue('Start free')).toBeTruthy()
  })
})

describe('a history at its limit', () => {
  const revs = (n: number) => Array.from({ length: n }, (_, i) => ({
    rev: n - i, at: new Date().toISOString(), by: 'Alex',
    note: `change ${n - i}`, screens: 1, spec,
  }))

  it('says older changes are not kept', async () => {
    // Every revision is a full snapshot and every gesture writes one. Finding
    // out the cap exists by looking for something that is gone is the wrong
    // way to learn it.
    mount({ revisions: revs(100) })
    await waitFor(() =>
      expect(screen.getByText(/older ones are not kept/)).toBeTruthy())
  })

  it('does not say it when nothing has been dropped', async () => {
    mount({ revisions: revs(12) })
    await waitFor(() => expect(screen.getByText(/restoring is itself/)).toBeTruthy())
    expect(screen.queryByText(/not kept/)).toBeNull()
  })
})

describe('a design with more screens than fit on a page', () => {
  it('offers a searchable screen picker without a wall of chips', async () => {
    const u = userEvent.setup()
    mount({ manyScreens: 8 })
    await u.click(await screen.findByTitle('Choose a screen'))
    expect(document.querySelectorAll('.dscreen-option')).toHaveLength(8)
    await u.type(screen.getByRole('searchbox', { name: 'Search screens' }), 'Step 6')
    expect(document.querySelectorAll('.dscreen-option')).toHaveLength(1)
    await u.keyboard('{Enter}')
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Step 6')
    expect(document.querySelectorAll('.dscreen-frame:not([hidden])')).toHaveLength(1)
  })

  it('uses the same compact navigation for a two-screen design', async () => {
    mount({ twoScreens: true })
    await waitFor(() => expect(document.querySelectorAll('.dscreen').length).toBe(2))
    expect(screen.getByTitle('Choose a screen')).toBeTruthy()
    expect(document.querySelectorAll('.dscreen-frame:not([hidden])')).toHaveLength(1)
  })

  it('jumps straight to a screen while playing, rather than clicking through', async () => {
    const u = userEvent.setup()
    mount({ manyScreens: 8 })
    await waitFor(() => expect(screen.getByText('Preview')).toBeTruthy())
    await u.click(screen.getByText('Preview'))
    expect(screen.getByText('screen 1 of 8')).toBeTruthy()
    await u.click(screen.getByTitle('Choose a screen'))
    await u.click(screen.getByRole('button', { name: '6 Step 6' }))
    await waitFor(() => expect(screen.getByText('screen 6 of 8')).toBeTruthy())
    // and it is a step you can come back from
    await u.click(screen.getByText('← Back'))
    await waitFor(() => expect(screen.getByText('screen 1 of 8')).toBeTruthy())
  })
})
