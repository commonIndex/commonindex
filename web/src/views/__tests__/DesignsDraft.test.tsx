/**
 * The draft that survives the tab.
 *
 * Driven through the real panel rather than the storage module, because the bug
 * this is guarding against is an ordering one: the save effect running before
 * the load effect clears the key it was about to read, and every unit test of
 * the storage passes while the draft still disappears.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesignsView } from '../Designs'
import { saveDraft } from '../../data/drafts'

const TEMPLATE = {
  id: 'design-tmpl', key: 'DES-1', title: 'Starter · Marketing site',
  surface: 'email', state: 'approved', cites: [],
  spec: { tokens: { color: { accent: { $value: '#1a5bd0', $type: 'color' } } },
          screens: [{ id: 's1', name: 'Home', w: 600, h: 720, elements: [] }] },
}

const GENERATED = {
  title: 'Settings', surface: 'mobile',
  spec: { screens: [{ id: 's1', name: 'Settings', w: 390, h: 844,
                      elements: [{ id: 'h1', role: 'heading', text: 'Settings',
                                   x: 20, y: 60, w: 350, h: 40 }] }] },
  cites: [], sources: [], grounded_in: null, rationale: 'One screen, one job.',
  generated_by: 'claude-opus-5',
  usage: { input_tokens: 900, output_tokens: 1200, model: 'claude-opus-5' },
  note: 'nothing was filed. Review it, then propose it.',
}

function mount() {
  return render(<MemoryRouter><DesignsView /></MemoryRouter>)
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const body = op === 'designs.list' ? { designs: [TEMPLATE], total: 1 }
               : op === 'designs.generate' ? GENERATED
               : {}
    return { ok: true, status: 200, json: async () => body } as Response
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

const open = async (u: ReturnType<typeof userEvent.setup>) =>
  u.click(await screen.findByText('+ New design'))

describe('an unfiled draft', () => {
  it('creates every template screen while keeping styles linked, without calling a model', async () => {
    const u = userEvent.setup()
    const template = { ...TEMPLATE, spec: { ...TEMPLATE.spec,
      screens: [...TEMPLATE.spec.screens,
        { id: 's2', name: 'Pricing', w: 600, h: 720, elements: [] }],
    } }
    const fetcher = vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const body = op === 'designs.list' ? { designs: [template], total: 1 }
        : op === 'designs.propose' ? { id: 'new-layout', created: true } : {}
      return { ok: true, status: 200, json: async () => body } as Response
    })
    vi.stubGlobal('fetch', fetcher)
    mount()
    await open(u)
    await u.click(screen.getByText('From a template'))
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    await u.type(screen.getByRole('textbox', { name: 'Design name' }), 'My launch')
    await u.click(screen.getByRole('button', { name: '2. Pricing' }))
    expect(screen.getByRole('textbox', { name: 'Design name' })).toHaveProperty('value', 'My launch')
    await u.click(screen.getByRole('button', { name: 'Create' }))
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('designs.propose'))
    expect(call).toBeTruthy()
    const sent = JSON.parse(call![1]!.body as string)
    expect(sent).toMatchObject({ title: 'My launch', state: 'draft', cites: [TEMPLATE.id],
      spec: { screens: template.spec.screens }, generated_by: null })
    expect(sent.spec.tokens).toBeUndefined()
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('designs.generate'))).toBe(false)
    await waitFor(() => expect(localStorage.getItem('commonindex.designs.draft.v1')).toBeNull())
  })

  it('does not create a palette specimen restored from an older template-mode draft', async () => {
    const u = userEvent.setup()
    const system = { ...TEMPLATE, id: 'system-paper', title: 'System · Paper' }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ designs: [system], total: 1 }) }) as Response))
    saveDraft({ mode: 'template', brief: '', title: 'A real layout', surface: 'email',
      screens: 1, pickId: system.id, turns: [], generated: null })
    mount()
    await open(u)
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/Choose a starter layout above to continue/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Create' }))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.propose'))).toBe(false)
  })

  it('is still there after the panel is closed and reopened', async () => {
    const u = userEvent.setup()
    mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a pricing page')

    await u.click(screen.getByText('Cancel'))
    await open(u)

    const box = screen.getByPlaceholderText(/A settings screen/) as HTMLTextAreaElement
    expect(box.value).toBe('a pricing page')
    expect(screen.getByText(/Picked up where you left off/)).toBeTruthy()
  })

  it('is still there after the tab is reloaded', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a pricing page')
    first.unmount()

    mount()
    await open(u)
    expect((screen.getByPlaceholderText(/A settings screen/) as HTMLTextAreaElement).value)
      .toBe('a pricing page')
  })

  it('brings back the generated screens, not just the brief', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a settings screen')
    await u.click(screen.getByText('Generate'))
    await waitFor(() => expect(screen.getByText('One screen, one job.')).toBeTruthy())
    first.unmount()

    mount()
    await open(u)
    // The tokens were spent; this is the part that would have cost money to lose.
    await waitFor(() => expect(screen.getByText('One screen, one job.')).toBeTruthy())
    expect(screen.getByText('Save this design')).toBeTruthy()
  })

  it('keeps the turns, so the conversation reads as one', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a settings screen')
    await u.click(screen.getByText('Generate'))
    await waitFor(() => expect(screen.getByText('One screen, one job.')).toBeTruthy())
    first.unmount()

    mount()
    await open(u)
    await waitFor(() => {
      const turns = [...document.querySelectorAll('.dturn')].map(t => t.textContent)
      expect(turns).toEqual(['1a settings screen'])
    })
  })

  it('re-resolves the cited template instead of restoring a copy of it', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.click(await screen.findByText('Starter · Marketing site'))
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a pricing page')
    first.unmount()

    // The stored draft names the template; it does not carry it. A stored copy
    // would be a template frozen at the moment it was picked, which is the
    // drift the citation exists to prevent.
    const raw = JSON.parse(localStorage.getItem('commonindex.designs.draft.v1')!)
    expect(raw.pickId).toBe('design-tmpl')
    expect(JSON.stringify(raw)).not.toContain('#1a5bd0')

    mount()
    await open(u)
    await waitFor(() =>
      expect(screen.getByText('Starter · Marketing site').closest('.dpick')?.className)
        .toContain('on'))
  })

  it('comes back into the half of the panel it was typed in', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.click(screen.getByText('From a template'))
    await u.click(await screen.findByText('Starter · Marketing site'))
    await u.type(screen.getByPlaceholderText(/name it/), 'Refunds flow')
    first.unmount()

    mount()
    await open(u)
    // Restored into "Describe it" the name field does not exist, so the draft
    // would look empty while the storage held it.
    expect((screen.getByPlaceholderText(/name it/) as HTMLInputElement).value)
      .toBe('Refunds flow')
    await waitFor(() =>
      expect(screen.getByText('Starter · Marketing site').closest('.dpick')?.className)
        .toContain('on'))
  })

  it('is gone once it has been filed', async () => {
    const u = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const body = op === 'designs.list' ? { designs: [TEMPLATE], total: 1 }
                 : op === 'designs.generate' ? GENERATED
                 : op === 'designs.propose' ? { id: 'design-new', created: true }
                 : {}
      return { ok: true, status: 200, json: async () => body } as Response
    }))
    mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a settings screen')
    await u.click(screen.getByText('Generate'))
    await waitFor(() => expect(screen.getByText('Save this design')).toBeTruthy())
    await u.click(screen.getByText('Save this design'))

    await waitFor(() =>
      expect(localStorage.getItem('commonindex.designs.draft.v1')).toBeNull())
  })

  it('does not offer to resume a panel nobody has typed in', async () => {
    const u = userEvent.setup()
    mount()
    await open(u)
    expect(screen.queryByText(/Picked up where you left off/)).toBeNull()
    expect(localStorage.getItem('commonindex.designs.draft.v1')).toBeNull()
  })

  it('stops claiming when it was saved once you carry on typing', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a pricing page')
    first.unmount()

    mount()
    await open(u)
    expect(screen.getByText(/Picked up where you left off/)).toBeTruthy()
    await u.type(screen.getByPlaceholderText(/A settings screen/), ' with three tiers')
    // "last saved 3d ago" stops being true the moment anything changes, and a
    // banner that is confidently wrong about the time is worse than no banner.
    expect(screen.queryByText(/Picked up where you left off/)).toBeNull()
  })

  it('throws it away when Start over is pressed', async () => {
    const u = userEvent.setup()
    const first = mount()
    await open(u)
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'a pricing page')
    first.unmount()

    mount()
    await open(u)
    await u.click(screen.getByText('Start over'))
    expect((screen.getByPlaceholderText(/A settings screen/) as HTMLTextAreaElement).value)
      .toBe('')
    expect(localStorage.getItem('commonindex.designs.draft.v1')).toBeNull()
  })
})

describe('the Describe it form', () => {
  it('asks brief, frame and style before Generate, not after it', async () => {
    const u = userEvent.setup()
    mount()
    await open(u)
    const brief = screen.getByLabelText('What should it show?')
    const surface = screen.getByRole('button', { name: 'web' })
    const style = screen.getByText('Or match a starter’s palette')
    const go = screen.getByRole('button', { name: 'Generate' })
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(brief, surface)).toBe(true)
    expect(follows(surface, style)).toBe(true)
    expect(follows(style, go)).toBe(true)
  })

  it('folds starter palettes under the systems, and opens them when one is chosen', async () => {
    const u = userEvent.setup()
    mount()
    await open(u)
    const more = screen.getByText('Or match a starter’s palette').closest('details')!
    expect(more.open).toBe(false)
    more.open = true
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    expect(screen.getByText('Or match a starter’s palette').closest('details')!.open).toBe(true)
  })
})
