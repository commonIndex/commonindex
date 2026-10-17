import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesignDetail, DesignsView } from '../Designs'
import { downloadHtml, downloadJson } from '../../data/exportDesign'
import type { DesignTokens, GeneratedDesign, WireDesign } from '../../data/gateway'

vi.mock('../../data/exportDesign', async importOriginal => ({
  ...await importOriginal<typeof import('../../data/exportDesign')>(),
  downloadHtml: vi.fn(),
  downloadJson: vi.fn(),
}))

const tokens: DesignTokens = { 'color.accent': { $value: '#008866', $type: 'color' } }
const makeDesign = (over: Partial<WireDesign> = {}): WireDesign => ({
  id: 'd1', key: 'DES-1', title: 'Checkout', surface: 'mobile', state: 'draft',
  cites: [], sources: [], current_rev: 7,
  spec: { tokens, screens: [
    { id: 'home', name: 'Home', w: 390, h: 844, elements: [
      { id: 'start', role: 'button', text: 'Start', cites: 'color.accent',
        tone: 'accent', x: 20, y: 60, w: 200, h: 44, goto: 'done' },
      { id: 'cancel', role: 'button', text: 'Cancel order', cites: 'color.accent',
        x: 20, y: 120, w: 200, h: 44 },
    ] },
    { id: 'done', name: 'Done', w: 390, h: 844, elements: [] },
  ] },
  ...over,
})

const generated: GeneratedDesign = {
  title: 'Checkout', surface: 'mobile', spec: makeDesign().spec,
  cites: [], sources: [], grounded_in: null, rationale: 'Ready for review.',
  generated_by: 'test-model', usage: { input_tokens: 10, output_tokens: 20, model: 'test-model' },
  note: 'Not filed yet.',
}

const response = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

let designs: WireDesign[]
let rejectSave: boolean
let rejectGeneration: boolean
let saveErrorCode: string
let generatedSpec: WireDesign['spec'] | undefined

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  designs = [makeDesign()]
  rejectSave = false
  rejectGeneration = false
  saveErrorCode = 'unavailable'
  generatedSpec = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const args = JSON.parse(String(init?.body ?? '{}'))
    if (op === 'designs.list') return response({ designs, total: designs.length })
    if (op === 'designs.get') return response({ design: designs.find(d => d.id === args.id) })
    if (op === 'designs.history') return response({ revisions: [] })
    if (op === 'designs.references') return response({ references: [], stale: false })
    if (op === 'designs.generate') return rejectGeneration
      ? response({ error: { code: 'model_error', message: 'Model unavailable. Try again.' } }, 503)
      : response(args.base ? { ...generated, spec: generatedSpec ?? {
        ...args.base, screens: args.base.screens.map((value: WireDesign['spec']['screens'][number], index: number) =>
          index ? value : { ...value, elements: value.elements?.map((element, at) => at ? element : { ...element, text: 'AI suggested label' }) }),
      } } : generated)
    if (op === 'designs.revise') {
      if (rejectSave) return response({ error: { code: saveErrorCode, message: 'Save failed. Try again.' } }, 409)
      designs = designs.map(d => d.id === args.design_id
        ? { ...d, spec: args.spec ?? d.spec, current_rev: (d.current_rev ?? 0) + 1 } : d)
      return response({ revised: true })
    }
    return response({})
  }))
})
afterEach(() => vi.unstubAllGlobals())

function mount(detail = false) {
  const router = createMemoryRouter([
    { path: '/designs', element: <DesignsView /> },
    { path: '/designs/:id', element: <DesignDetail /> },
  ], { initialEntries: detail ? ['/designs', '/designs/d1'] : ['/designs'] })
  return { ...render(<RouterProvider router={router} />), router }
}

const at = (path: string) => document.querySelector(`[data-path="${path}"]`) as HTMLElement

async function openExport(u: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: 'Export' })
  if (button.getAttribute('aria-expanded') !== 'true') await u.click(button)
}

async function editStart(u: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(at('0')).toBeTruthy())
  await u.click(at('0'))
  const field = screen.getByLabelText('Text')
  await u.clear(field)
  await u.type(field, 'Continue checkout')
}

const revisionCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('designs.revise'))
async function previewAI(u: ReturnType<typeof userEvent.setup>) {
  const prompt = await screen.findByRole('textbox', { name: 'Describe a change' })
  fireEvent.change(prompt, { target: { value: 'Make this clearer' } })
  await u.click(screen.getByRole('button', { name: 'Preview AI changes' }))
  return screen.findByRole('region', { name: 'Review AI changes' })
}

describe('reviewing AI changes before saving', () => {
  it('does not revise, export, or mutate the saved design until explicit acceptance', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    const review = await previewAI(u)
    expect(document.activeElement).toBe(review)
    expect(within(review).getByText('1 screen changed')).toBeTruthy()
    expect(designs[0].current_rev).toBe(7)
    expect(revisionCalls()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Save all changes' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('group', { name: 'Element properties' })).toHaveProperty('disabled', true)
    for (const name of ['Duplicate', 'Delete', 'Bring forward', 'Send backward', 'Preview']) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true)
    }
    expect(screen.queryByRole('region', { name: 'Design canvas' })).toBeNull()
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Delete' })
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(revisionCalls()).toHaveLength(0)
    await openExport(u)
    expect(screen.getByRole('button', { name: 'Download HTML' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Download spec' })).toHaveProperty('disabled', true)
    await u.click(within(review).getByRole('button', { name: 'Accept AI changes' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Review AI changes' })).toBeNull())
    expect(designs[0].current_rev).toBe(8)
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('AI suggested label')
    expect(revisionCalls()).toHaveLength(1)
    expect(JSON.parse(String(revisionCalls()[0][1]?.body))).toMatchObject({ if_rev: 7, note: 'start: Make this clearer' })
    expect(screen.getByRole('status').textContent).toBe('All changes saved')
  })

  it('discards a preview without writing and keeps the instruction for another try', async () => {
    const u = userEvent.setup()
    mount(true)
    await previewAI(u)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await u.click(screen.getByRole('button', { name: 'Discard AI changes' }))
    expect(screen.getByRole('textbox', { name: 'Describe a change' })).toHaveProperty('value', 'Make this clearer')
    expect(screen.getByRole('region', { name: 'Design canvas' })).toBeTruthy()
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Start')
    expect(designs[0].current_rev).toBe(7)
    expect(revisionCalls()).toHaveLength(0)
    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    expect(cleanUnload.defaultPrevented).toBe(false)
  })

  it('keeps a rejected proposal reviewable and retries only when asked', async () => {
    const u = userEvent.setup()
    mount(true)
    const review = await previewAI(u)
    rejectSave = true
    await u.click(within(review).getByRole('button', { name: 'Accept AI changes' }))
    expect(await within(review).findByRole('alert')).toHaveProperty('textContent', 'Save failed. Try again.')
    expect(designs[0].current_rev).toBe(7)
    expect(screen.getByRole('region', { name: 'Review AI changes' })).toBe(review)
    rejectSave = false
    await u.click(within(review).getByRole('button', { name: 'Accept AI changes' }))
    await waitFor(() => expect(designs[0].current_rev).toBe(8))
    expect(revisionCalls()).toHaveLength(2)
  })

  it('does not retry a stale preview against a newer revision', async () => {
    const u = userEvent.setup()
    mount(true)
    const review = await previewAI(u)
    designs[0] = { ...designs[0], current_rev: 8, spec: { ...designs[0].spec,
      screens: designs[0].spec.screens.map(s => ({ ...s, name: `${s.name} updated elsewhere` })) } }
    rejectSave = true; saveErrorCode = 'stale_revision'
    await u.click(within(review).getByRole('button', { name: 'Accept AI changes' }))
    await within(review).findByText(/saved design changed since this preview/)
    expect(within(review).getByRole('button', { name: 'Accept AI changes' })).toHaveProperty('disabled', true)
    rejectSave = false
    await u.click(within(review).getByRole('button', { name: 'Accept AI changes' }))
    expect(revisionCalls()).toHaveLength(1)
    expect(designs[0].spec.screens[0].name).toBe('Home updated elsewhere')
    await u.click(within(review).getByRole('button', { name: 'Discard AI changes' }))
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Home updated elsewhere')
  })

  it('blocks a no-op proposal from creating a revision', async () => {
    const u = userEvent.setup()
    generatedSpec = makeDesign().spec
    mount(true)
    const review = await previewAI(u)
    expect(within(review).getByText('No changes were proposed.')).toBeTruthy()
    expect(within(review).getByRole('button', { name: 'Accept AI changes' })).toHaveProperty('disabled', true)
    expect(revisionCalls()).toHaveLength(0)
  })

  it('lets the user return to review or discard on navigation, never save without review', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await previewAI(u)
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByRole('button', { name: 'Save and leave' })).toBeNull()
    await u.click(within(dialog).getByRole('button', { name: 'Review AI changes' }))
    expect(router.state.location.pathname).toBe('/designs/d1')
    expect(screen.getByRole('region', { name: 'Review AI changes' })).toBeTruthy()
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    dialog = await screen.findByRole('alertdialog')
    await u.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(revisionCalls()).toHaveLength(0)
  })

  it('supports multiline instructions and ignores composing or repeated keyboard submission', async () => {
    const u = userEvent.setup()
    mount(true)
    const prompt = await screen.findByRole('textbox', { name: 'Describe a change' })
    await u.type(prompt, 'Make it clearer{Enter}Keep the palette')
    expect(prompt).toHaveProperty('value', 'Make it clearer\nKeep the palette')
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true, isComposing: true })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true, repeat: true })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('designs.generate'))).toHaveLength(0)
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await screen.findByRole('region', { name: 'Review AI changes' })
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('designs.generate'))!
    expect(JSON.parse(String(request[1]?.body)).brief).toBe('Make it clearer\nKeep the palette')
    expect(revisionCalls()).toHaveLength(0)
  })

  it('retains the instruction and restores editing after generation fails', async () => {
    const u = userEvent.setup()
    rejectGeneration = true
    mount(true)
    const prompt = await screen.findByRole('textbox', { name: 'Describe a change' })
    fireEvent.change(prompt, { target: { value: 'Keep my instruction' } })
    await u.click(screen.getByRole('button', { name: 'Preview AI changes' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Model unavailable. Try again.')
    expect(prompt).toHaveProperty('value', 'Keep my instruction')
    expect(prompt).toHaveProperty('disabled', false)
    expect(screen.queryByRole('region', { name: 'Review AI changes' })).toBeNull()
    expect(revisionCalls()).toHaveLength(0)
  })

  it('previews removed owned tokens with the cited palette, not the removed tokens', async () => {
    const u = userEvent.setup()
    designs[0].cites = ['system']
    designs.push(makeDesign({ id: 'system', title: 'Brand system', spec: {
      tokens: { 'color.accent': { $type: 'color', $value: '#ff0000' } }, screens: [],
    } }))
    generatedSpec = { screens: makeDesign().spec.screens }
    mount(true)
    const review = await previewAI(u)
    const stages = review.querySelectorAll('.dai-compare-stage')
    expect(stages[0].querySelector('[data-path="0"]')).toHaveProperty('style.backgroundColor', 'rgb(0, 136, 102)')
    expect(stages[1].querySelector('[data-path="0"]')).toHaveProperty('style.backgroundColor', 'rgb(255, 0, 0)')
    expect(within(review).getByText('Design tokens changed')).toBeTruthy()
  })
})

describe('recoverable design work', () => {
  it('saves pending edits before completing the requested navigation', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await editStart(u)
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save and leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout')
    expect(await screen.findByRole('button', { name: '+ New design' })).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('stays in the editor when save-and-leave fails and allows retry', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await editStart(u)
    rejectSave = true
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    const dialog = await screen.findByRole('alertdialog')
    await u.click(within(dialog).getByRole('button', { name: 'Save and leave' }))
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Save failed. Try again.')
    expect(router.state.location.pathname).toBe('/designs/d1')
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Start')
    rejectSave = false
    await u.click(within(dialog).getByRole('button', { name: 'Save and leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout')
  })

  it('covers browser history navigation and leaves only after explicit discard', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await editStart(u)
    await act(async () => { await router.navigate(-1) })
    const dialog = await screen.findByRole('alertdialog')
    expect(router.state.location.pathname).toBe('/designs/d1')
    await u.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Start')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.revise'))).toBe(false)
  })

  it('traps keyboard focus and Escape returns to the invoking link without editing the canvas', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    const link = screen.getByRole('link', { name: '← Designs' })
    await u.click(link)
    const dialog = await screen.findByRole('alertdialog')
    const keep = within(dialog).getByRole('button', { name: 'Keep editing' })
    const save = within(dialog).getByRole('button', { name: 'Save and leave' })
    expect(document.activeElement).toBe(keep)
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull()
    await u.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement).toBe(save)
    await u.tab()
    expect(document.activeElement).toBe(keep)
    await u.keyboard('{Delete}')
    expect(designs[0].spec.screens[0].elements).toHaveLength(2)
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(link)
    expect(screen.getByLabelText('Text')).toHaveProperty('value', 'Continue checkout')
  })

  it('blocks departure during an in-flight write until the result is known', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await editStart(u)
    const send = vi.mocked(fetch).getMockImplementation()!
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    const request = vi.mocked(fetch).mock.calls.at(-1)!
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Discard and leave' })).toHaveProperty('disabled', true)
    expect(within(dialog).getByRole('button', { name: 'Save and leave' })).toHaveProperty('disabled', true)
    await act(async () => finish(await send(...request)))
    await u.click(await within(dialog).findByRole('button', { name: 'Leave design' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout')
  })

  it('does not carry held changes, screen selection or AI instructions into another design', async () => {
    const u = userEvent.setup()
    designs.push(makeDesign({ id: 'd2', title: 'Another design' }))
    const { router } = mount(true)
    await editStart(u)
    await u.type(screen.getByRole('textbox', { name: 'Describe a change' }), 'An instruction for the first design')
    await u.click(screen.getByRole('button', { name: 'Next screen' }))
    await act(async () => { await router.navigate('/designs/d2') })
    const dialog = await screen.findByRole('alertdialog')
    await u.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await screen.findByRole('heading', { name: 'Another design' })
    expect(screen.getByRole('status').textContent).toBe('All changes saved')
    expect(screen.getByRole('textbox', { name: 'Describe a change' })).toHaveProperty('value', '')
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Home')
    expect(screen.queryByText(/Unsaved change to/)).toBeNull()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.revise'))).toBe(false)
    await act(async () => { await router.navigate('/designs/d1') })
    await screen.findByRole('heading', { name: 'Checkout' })
    expect(screen.getByRole('status').textContent).toBe('All changes saved')
  })

  it('leaves a clean design without prompting', async () => {
    const u = userEvent.setup()
    const { router } = mount(true)
    await u.click(await screen.findByRole('link', { name: '← Designs' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/designs'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks before leaving the editor and can keep the pending edit', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(screen.getByRole('link', { name: '← Designs' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave this design?' })
    await u.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByLabelText('Text')).toHaveProperty('value', 'Continue checkout')
  })

  it('keeps the generated draft and conversation after a failed Try again, including after reopening', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByText('+ New design'))
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'Checkout with a confirmation')
    await u.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('Ready for review.')
    rejectGeneration = true
    await u.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Model unavailable. Try again.')
    expect(screen.getByText('Ready for review.')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('commonindex.designs.draft.v1')!).generated).toEqual(generated)
    await u.click(screen.getByRole('button', { name: 'Cancel' }))
    await u.click(await screen.findByText('+ New design'))
    expect(screen.getByText('Ready for review.')).toBeTruthy()
    expect(document.querySelector('.dturn')?.textContent).toContain('Checkout with a confirmation')
  })

  it('keeps a held edit when saving fails and lets it be retried', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    rejectSave = true
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await screen.findByText('Save failed. Try again.')
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    rejectSave = false
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await waitFor(() => expect(screen.queryByText(/Unsaved change to/)).toBeNull())
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout')
  })

  it('keeps the draft visible during regeneration without claiming to file it', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByText('+ New design'))
    await u.type(screen.getByPlaceholderText(/A settings screen/), 'Checkout')
    await u.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('Ready for review.')
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await u.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Ready for review.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Designing…' })).toBeTruthy()
    expect(screen.queryByText('Filing…')).toBeNull()
    expect(screen.queryByText('Applying…')).toBeNull()
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish(response({ ...generated, rationale: 'A new version.' })))
    expect(await screen.findByText('A new version.')).toBeTruthy()
  })

  it('holds the pending edit when duplicating changes the selection', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(await screen.findByText(/Unsaved change to/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout'))
  })

  it('preserves the pending edit when a revision conflict refreshes the inspector', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    // Another editor saved a new revision after this page loaded.
    designs = [makeDesign({ current_rev: 8 })]
    designs[0].spec.screens[0].elements![0].text = 'Another editor’s text'
    rejectSave = true
    saveErrorCode = 'stale_revision'
    await u.click(screen.getByRole('button', { name: 'Save change' }))
    await screen.findByText('Save failed. Try again.')
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    await waitFor(() => expect(at('0').textContent).toBe('Another editor’s text'))
    rejectSave = false
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout'))
    const writes = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('designs.revise'))
    expect(JSON.parse(String(writes.at(-1)?.[1]?.body)).if_rev).toBe(8)
  })

  it('holds the container edit when adding a child changes the selection', async () => {
    designs[0].spec.screens[0].elements = [
      { id: 'card', role: 'card', text: 'Summary', x: 0, y: 0, w: 300, h: 200, children: [] },
    ]
    const u = userEvent.setup()
    mount(true)
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    await u.clear(screen.getByLabelText('Text'))
    await u.type(screen.getByLabelText('Text'), 'Your order')
    await u.click(screen.getByRole('button', { name: 'Add inside' }))
    expect(await screen.findByText(/Unsaved change to/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Your order'))
    expect(designs[0].spec.screens[0].elements?.[0].children).toHaveLength(1)
  })

  it('warns before closing a tab with pending or held changes, but not a saved design', async () => {
    const u = userEvent.setup()
    mount(true)
    await screen.findByText('Preview')
    const leaving = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(leaving()).toBe(false)
    await editStart(u)
    expect(leaving()).toBe(true)
    await u.click(at('1'))
    expect(leaving()).toBe(true)
    await u.click(screen.getByRole('button', { name: 'Discard' }))
    expect(leaving()).toBe(false)
  })
})

describe('the gallery palette', () => {
  const card = () => screen.getAllByRole('link').find(el => el.getAttribute('href') === '/designs/d1')!

  it('follows template citations through to the system, even when the gallery is filtered', async () => {
    designs = [makeDesign({ cites: ['template'], spec: { screens: makeDesign().spec.screens } }),
      makeDesign({ id: 'template', title: 'Template', surface: 'email', cites: ['system'],
        spec: { screens: [] } }),
      makeDesign({ id: 'system', title: 'System', surface: 'email', spec: { tokens, screens: [] } })]
    const u = userEvent.setup()
    mount()
    await screen.findByText('Checkout', { selector: 'b' })
    await u.click(screen.getByRole('button', { name: 'mobile' }))
    expect(within(card()).getByText('On system')).toBeTruthy()
    expect(card().querySelector('[data-path="0"]')?.getAttribute('style')).toContain('rgb(0, 136, 102)')
  })

  it('skips an empty palette and a cycle to find another cited system', async () => {
    designs = [makeDesign({ cites: ['empty', 'system'], spec: { screens: makeDesign().spec.screens } }),
      makeDesign({ id: 'empty', title: 'Empty', cites: ['d1'], spec: { tokens: {}, screens: [] } }),
      makeDesign({ id: 'system', title: 'System', spec: { tokens, screens: [] } })]
    mount()
    await screen.findByText('Checkout', { selector: 'b' })
    expect(within(card()).getByText('On system')).toBeTruthy()
  })

  it('marks unresolved citations consistently in the drawing and the count', async () => {
    designs = [makeDesign({ cites: ['d1'], spec: { screens: makeDesign().spec.screens } })]
    mount()
    await screen.findByText('Checkout', { selector: 'b' })
    expect(within(card()).getByText('2 of 2 off-system')).toBeTruthy()
    expect(card().querySelector('[data-path="0"]')?.getAttribute('style')).toContain('dashed')
  })
})

describe('safe handoff', () => {
  it('does not offer a partial HTML export while playing a single screen', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByText('Preview'))
    await openExport(u)
    expect((screen.getByRole('button', { name: 'Download HTML' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Stop preview to download all screens/)).toBeTruthy()
    // The spec does not depend on the visible DOM and still includes every screen.
    await u.click(screen.getByRole('button', { name: 'Download spec' }))
    expect(vi.mocked(downloadJson).mock.calls[0][1]).toMatchObject({ spec: designs[0].spec })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect((screen.getByRole('button', { name: 'Download HTML' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('includes the revision of the spec even when there is no readable history', async () => {
    const u = userEvent.setup()
    mount(true)
    await openExport(u)
    await u.click(screen.getByRole('button', { name: 'Download spec' }))
    expect(vi.mocked(downloadJson).mock.calls[0][1]).toMatchObject({ design: { rev: 7 } })
  })

  it('blocks both downloads while edits are held, then enables them after saving', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    await openExport(u)
    for (const name of ['Download HTML', 'Download spec']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    await openExport(u)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Download HTML' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('does not export a stale spec while a save is still being confirmed', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    const send = vi.mocked(fetch).getMockImplementation()!
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await u.click(screen.getByRole('button', { name: 'Save it' }))
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    await openExport(u)
    for (const name of ['Download HTML', 'Download spec', 'Save it']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    const call = vi.mocked(fetch).mock.calls.at(-1)!
    await act(async () => finish(await send(...call)))
    await waitFor(() => expect(screen.queryByText(/Unsaved change to/)).toBeNull())
    expect((screen.getByRole('button', { name: 'Download spec' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('everyday design editing', () => {
  it('focuses a newly added screen while retaining pending edits from the previous screen', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(screen.getByRole('button', { name: '+ Add a screen' }))
    await waitFor(() => expect(designs[0].spec.screens).toHaveLength(3))
    const added = designs[0].spec.screens[2]
    await waitFor(() => expect(screen.getByTitle('Choose a screen').textContent).toContain(added.name))
    expect(document.querySelector('.dscreen-frame:not([hidden]) .dscreen')?.getAttribute('data-screen-id')).toBe(added.id)
    expect(screen.getByRole('status').textContent).toBe('1 unsaved change')
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout'))
  })

  it('deselects on empty canvas space without discarding the edit', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(screen.getByRole('region', { name: 'Design canvas' }))
    expect(screen.queryByRole('group', { name: 'Element properties' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('1 unsaved change')
    expect(screen.getByRole('button', { name: 'Save it' })).toBeTruthy()
  })

  it('keeps AI above every sidebar tab, with whole-design editing available before selection', async () => {
    const u = userEvent.setup()
    mount(true)
    const ai = await screen.findByRole('region', { name: 'Edit with AI' })
    expect(screen.getByRole('combobox', { name: 'AI edit scope' })).toHaveProperty('value', 'design')
    expect(screen.getByRole('option', { name: 'Selected element' })).toHaveProperty('disabled', true)
    for (const tab of ['Design', 'Properties', 'Layers']) {
      await u.click(screen.getByRole('tab', { name: tab }))
      expect(screen.getByRole('region', { name: 'Edit with AI' })).toBe(ai)
    }
    await u.type(screen.getByRole('textbox', { name: 'Describe a change' }), 'Add a loading state')
    await u.click(screen.getByRole('button', { name: 'Preview AI changes' }))
    await screen.findByRole('region', { name: 'Review AI changes' })
    expect(designs[0].current_rev).toBe(7)
    await u.click(screen.getByRole('button', { name: 'Accept AI changes' }))
    await waitFor(() => expect(designs[0].current_rev).toBe(8))
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('designs.generate'))!
    const request = JSON.parse(String(call[1]?.body))
    expect(request.brief).toBe('Add a loading state')
    expect(request.element).toBeUndefined()
    expect(request.base.screens).toHaveLength(2)
  })

  it('keeps separate instructions for whole-design and selected-element scope', async () => {
    const u = userEvent.setup()
    mount(true)
    const prompt = await screen.findByRole('textbox', { name: 'Describe a change' })
    await u.type(prompt, 'Add a loading state')
    await u.click(at('0'))
    expect(screen.getByRole('combobox', { name: 'AI edit scope' })).toHaveProperty('value', 'element')
    expect(prompt).toHaveProperty('value', '')
    await u.type(prompt, 'Shorten this label')
    await u.selectOptions(screen.getByRole('combobox', { name: 'AI edit scope' }), 'design')
    expect(prompt).toHaveProperty('value', 'Add a loading state')
    await u.selectOptions(screen.getByRole('combobox', { name: 'AI edit scope' }), 'element')
    expect(prompt).toHaveProperty('value', 'Shorten this label')
  })

  it('blocks whole-design AI while manual changes are pending, including Enter', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.selectOptions(screen.getByRole('combobox', { name: 'AI edit scope' }), 'design')
    await u.type(screen.getByRole('textbox', { name: 'Describe a change' }), 'Redesign this{Control>}{Enter}{/Control}')
    expect(screen.getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', true)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.generate'))).toBe(false)
    expect(screen.getByLabelText('Text')).toHaveProperty('value', 'Continue checkout')
  })

  it('preserves the AI instruction when the generated change cannot be saved', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    rejectSave = true
    const prompt = screen.getByRole('textbox', { name: 'Describe a change' })
    await u.type(prompt, 'Make it secondary{Control>}{Enter}{/Control}')
    await u.click(await screen.findByRole('button', { name: 'Accept AI changes' }))
    await screen.findByRole('alert')
    expect(prompt).toHaveProperty('value', 'Make it secondary')
    expect(screen.getByRole('button', { name: 'Accept AI changes' })).toHaveProperty('disabled', false)
  })

  it('disables AI during preview without losing its whole-design prompt', async () => {
    const u = userEvent.setup()
    mount(true)
    const prompt = await screen.findByRole('textbox', { name: 'Describe a change' })
    await u.type(prompt, 'Add an empty state')
    await u.click(screen.getByRole('button', { name: 'Preview' }))
    expect(prompt).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(prompt).toHaveProperty('value', 'Add an empty state')
    expect(prompt).toHaveProperty('disabled', false)
  })

  it('navigates and zooms without revising the spec, and exports all screens at natural size', async () => {
    const u = userEvent.setup()
    mount(true)
    await screen.findByTitle('Choose a screen')
    await u.click(screen.getByRole('button', { name: 'Next screen' }))
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Done')
    expect(document.querySelector('.dscreen-frame:not([hidden]) .dscreen')?.getAttribute('data-screen-id')).toBe('done')
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: '100%' }))
    expect(document.querySelector('.dscreen-frame:not([hidden]) .dscreen')?.getAttribute('data-scale')).toBe('1')
    await u.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(document.querySelector('.dscreen-frame:not([hidden]) .dscreen')?.getAttribute('data-scale')).toBe('1.1')
    await openExport(u)
    await u.click(screen.getByRole('button', { name: 'Download HTML' }))
    const html = String(vi.mocked(downloadHtml).mock.calls.at(-1)?.[1])
    expect(html).toContain('screen-home')
    expect(html).toContain('screen-done')
    expect(html).toContain('Start')
    expect(html).toContain('transform: none')
    expect(html).not.toContain('data-editor')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.revise'))).toBe(false)
    await u.click(screen.getByRole('button', { name: 'Overview' }))
    expect(document.querySelectorAll('.dscreen-frame:not([hidden])')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true)
    await u.click(screen.getByRole('button', { name: 'Focus Home' }))
    expect(document.querySelectorAll('.dscreen-frame:not([hidden])')).toHaveLength(1)
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Home')
  })

  it('reveals the chosen layer within the canvas instead of resetting it to the top', async () => {
    const u = userEvent.setup()
    mount(true)
    const viewport = await screen.findByRole('region', { name: 'Design canvas' })
    viewport.scrollTop = 400; viewport.scrollTo = vi.fn()
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 100, left: 100, top: 100,
      width: 600, height: 500, right: 700, bottom: 600, toJSON() {} })
    vi.spyOn(at('1'), 'getBoundingClientRect').mockReturnValue({ x: 180, y: 1000, left: 180, top: 1000,
      width: 200, height: 44, right: 380, bottom: 1044, toJSON() {} })
    await u.click(screen.getByRole('button', { name: 'Select button: Cancel order on Home' }))
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveProperty('value', 'Cancel order')
    expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 1072, left: 0, behavior: 'smooth' })
    expect(revisionCalls()).toHaveLength(0)
  })

  it('uses a design-check issue to open the correct screen and properties without writing', async () => {
    const u = userEvent.setup()
    designs[0].spec.screens[1].elements = [{ id: 'uncited', role: 'body', text: 'Unstyled note', x: 20, y: 50, w: 200, h: 40 }]
    mount(true)
    await u.click(await screen.findByText('Design checks'))
    await u.click(screen.getByRole('button', { name: 'Inspect Unstyled note on Done' }))
    expect(screen.getByTitle('Choose a screen').textContent).toContain('Done')
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveProperty('value', 'Unstyled note')
    expect(screen.getByRole('tab', { name: 'Properties' }).getAttribute('aria-selected')).toBe('true')
    expect(revisionCalls()).toHaveLength(0)
  })

  it('resumes held text after screen navigation and merges a subsequent size edit', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(screen.getByRole('button', { name: 'Next screen' }))
    expect(screen.getByRole('status').textContent).toBe('1 unsaved change')
    await u.click(screen.getByRole('button', { name: 'Previous screen' }))
    await u.click(at('0'))
    expect(screen.getByLabelText('Text')).toHaveProperty('value', 'Continue checkout')
    expect(screen.getByRole('status').textContent).toBe('1 unsaved change')
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '24' } })
    await u.click(screen.getByRole('button', { name: 'Next screen' }))
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    expect(designs[0].spec.screens[0].elements?.[0]).toMatchObject({ text: 'Continue checkout', fontSize: 24 })
  })

  it('fits width and fits the whole screen with the displayed zoom matching the renderer', async () => {
    const u = userEvent.setup()
    mount(true)
    await screen.findByTitle('Canvas zoom')
    const scale = () => Number(document.querySelector('.dscreen-frame:not([hidden]) .dscreen')?.getAttribute('data-scale'))
    const fitted = scale()
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: 'Fit width' }))
    expect(scale()).toBeGreaterThan(fitted)
    expect(screen.getByTitle('Canvas zoom').textContent).toContain(`${Math.round(scale() * 100)}%`)
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: 'Fit screen' }))
    expect(scale()).toBe(fitted)
  })

  it('keeps the AI prompt at the foot of the rail, after the manual properties', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    const properties = screen.getByRole('group', { name: 'Element properties' })
    const ai = screen.getByRole('region', { name: 'Edit with AI' })
    const content = within(properties).getByRole('region', { name: 'Content' })
    // Below the tabs and outside the scrolling panel: always in reach, but no
    // longer pushing the selection's properties below the fold.
    expect(ai.compareDocumentPosition(screen.getByRole('tablist')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(ai.closest('.drail-scroll')).toBeNull()
    const actions = screen.getByRole('group', { name: 'Selection actions' })
    expect(actions.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(actions.closest('.drail-scroll')).toBeNull()
    expect(within(actions).getByRole('button', { name: 'Bring forward' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Send backward' })).toBeTruthy()
    expect(ai.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(within(ai).getByRole('textbox', { name: 'Describe a change' })).toBeTruthy()
    expect(within(ai).getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Change this' })).toBeNull()
  })

  it('previews an AI instruction with Ctrl+Enter and saves only on acceptance', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    const prompt = screen.getByRole('textbox', { name: 'Describe a change' })
    await u.type(prompt, 'Make this secondary')
    expect(screen.getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', false)
    await u.keyboard('{Control>}{Enter}{/Control}')
    await screen.findByRole('region', { name: 'Review AI changes' })
    expect(designs[0].current_rev).toBe(7)
    await u.click(screen.getByRole('button', { name: 'Accept AI changes' }))
    await waitFor(() => expect(designs[0].current_rev).toBe(8))
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('designs.generate'))
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ brief: 'Make this secondary', element: 'start' })
    expect(prompt).toHaveProperty('value', '')
  })

  it('requires pending manual edits to be resolved before running AI', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '28' } })
    await u.type(screen.getByRole('textbox', { name: 'Describe a change' }), 'Rewrite the label{Control>}{Enter}{/Control}')
    expect(screen.getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/Save or discard your pending changes before applying AI/)).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('designs.generate'))).toBe(false)
    expect(screen.getByLabelText('Size (px)')).toHaveProperty('value', '28')
    await u.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('button', { name: 'Preview AI changes' })).toHaveProperty('disabled', false)
  })

  it('saves multiline text and typography, reloads them, and includes them in the spec export', async () => {
    const u = userEvent.setup()
    designs[0].spec.tokens = { ...tokens, 'font.size.caption': { $value: '18px', $type: 'dimension' } }
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Review request\nWith full context' } })
    await u.selectOptions(screen.getByLabelText('Text style'), 'font.size.caption')
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '23' } })
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.7' } })
    await u.selectOptions(screen.getByLabelText('Weight'), '700')
    await u.selectOptions(screen.getByLabelText('Alignment'), 'left')
    expect(at('0').style.fontSize).toBe('23px')
    await u.click(screen.getByRole('tab', { name: 'Design' }))
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull()
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    expect(screen.getByLabelText('Text')).toHaveProperty('value', 'Review request\nWith full context')
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    expect(designs[0].spec.screens[0].elements![0]).toMatchObject({
      text: 'Review request\nWith full context', fontSize: 23, fontWeight: 700,
      lineHeight: 1.7, textAlign: 'left', cites: 'color.accent', textStyle: 'font.size.caption',
    })
    expect(screen.getByLabelText('Size (px)')).toHaveProperty('value', '23')
    await openExport(u)
    await u.click(screen.getByRole('button', { name: 'Download spec' }))
    expect(JSON.stringify(vi.mocked(downloadJson).mock.calls.at(-1))).toContain('"fontSize":23')
    await u.click(screen.getByRole('button', { name: 'Download HTML' }))
    const html = vi.mocked(downloadHtml).mock.calls.at(-1)?.[1]
    expect(html).toContain('font-size: 23px')
    expect(html).toContain('line-height: 1.7')
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('Review request\nWith full context')
    await u.click(screen.getByRole('button', { name: 'Reset typography' }))
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements![0].fontSize).toBeUndefined())
    expect(at('0').style.fontSize).toBe('14.5px')
  })

  it('keeps typography changes after a failed save and sends the current revision when retried', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '28' } })
    rejectSave = true
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Size (px)')).toHaveProperty('value', '28')
    expect(at('0').style.fontSize).toBe('28px')
    expect(designs[0].spec.screens[0].elements![0].fontSize).toBeUndefined()
    rejectSave = false
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements![0].fontSize).toBe(28))
    const writes = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('designs.revise'))
    expect(JSON.parse(String(writes.at(-1)?.[1]?.body)).if_rev).toBe(7)
  })

  const writes = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('designs.revise'))

  it('saves held and current edits together as one revision', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    await u.clear(screen.getByLabelText('Text'))
    await u.type(screen.getByLabelText('Text'), 'Go back')
    expect(screen.getByRole('status').textContent).toBe('2 unsaved changes')
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    expect(writes()).toHaveLength(1)
    expect(designs[0].spec.screens[0].elements?.map(el => el.text)).toEqual(['Continue checkout', 'Go back'])
    expect(screen.queryByText(/Unsaved change to/)).toBeNull()
  })

  it('keeps every pending edit after a failed batch save', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    await u.clear(screen.getByLabelText('Text'))
    await u.type(screen.getByLabelText('Text'), 'Go back')
    rejectSave = true
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('status').textContent).toBe('2 unsaved changes')
    expect(screen.getByDisplayValue('Go back')).toBeTruthy()
    rejectSave = false
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    expect(designs[0].spec.screens[0].elements?.map(el => el.text)).toEqual(['Continue checkout', 'Go back'])
  })

  it('refuses a batch with a deleted target instead of partially saving it', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    await u.click(at('1'))
    await u.click(at('0'))
    await u.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(designs[0].spec.screens[0].elements).toHaveLength(1))
    const before = writes().length
    await u.click(screen.getByRole('button', { name: 'Save all changes' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No changes were written.'))
    expect(writes()).toHaveLength(before)
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy()
  })

  it.each(['ctrlKey', 'metaKey'] as const)('saves from a focused input with %s + S', async modifier => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    const event = new KeyboardEvent('keydown', { key: 's', [modifier]: true, bubbles: true, cancelable: true })
    fireEvent(screen.getByLabelText('Text'), event)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    expect(designs[0].spec.screens[0].elements?.[0].text).toBe('Continue checkout')
  })

  it('nudges on the canvas in 1px or 10px steps without a revision per keystroke', async () => {
    const u = userEvent.setup()
    mount(true)
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    fireEvent.keyDown(at('0'), { key: 'ArrowRight' })
    fireEvent.keyDown(at('0'), { key: 'ArrowDown', shiftKey: true })
    expect(at('0').style.left).toBe('21px')
    expect(at('0').style.top).toBe('70px')
    expect(writes()).toHaveLength(0)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(designs[0].spec.screens[0].elements?.[0]).toMatchObject({ x: 21, y: 70 })
  })

  it('shifts an element in a row by a pixel with the arrows, and a place with Alt', async () => {
    designs[0].spec.screens[0].elements = [{ id: 'bar', role: 'nav', layout: 'row', x: 0, y: 0, w: 390, h: 56,
      children: [
        { id: 'home-tab', role: 'button', text: 'Home' },
        { id: 'profile', role: 'button', text: 'Profile' },
      ] }]
    const u = userEvent.setup()
    mount(true)
    await waitFor(() => expect(at('0.1')).toBeTruthy())
    await u.click(at('0.1'))
    // Slightly to the left: shifted where the row put it, still in the row.
    fireEvent.keyDown(at('0.1'), { key: 'ArrowLeft' })
    fireEvent.keyDown(at('0.1'), { key: 'ArrowLeft', shiftKey: true })
    expect(at('0.1').style.left).toBe('-11px')
    expect(at('0.1').style.position).toBe('relative')
    expect(writes()).toHaveLength(0)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const saved = designs[0].spec.screens[0].elements?.[0].children?.[1]
    expect(saved).toMatchObject({ id: 'profile', dx: -11 })
    expect(saved?.x).toBeUndefined()
    // Alt+arrow: one place along, as dragging does.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('All changes saved'))
    fireEvent.keyDown(at('0.1'), { key: 'ArrowLeft', altKey: true })
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(designs[0].spec.screens[0].elements?.[0].children?.map(c => c.id)).toEqual(['profile', 'home-tab'])
  })

  it('leaves arrow keys alone while typing', async () => {
    const u = userEvent.setup()
    mount(true)
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    fireEvent.keyDown(screen.getByLabelText('Text'), { key: 'ArrowRight' })
    expect(at('0').style.left).toBe('20px')
    expect(screen.getByRole('status').textContent).toBe('All changes saved')
  })

  it('keeps part of a nudged element on the artboard', async () => {
    designs[0].spec.screens[0].elements![0].x = 365
    const u = userEvent.setup()
    mount(true)
    await waitFor(() => expect(at('0')).toBeTruthy())
    await u.click(at('0'))
    fireEvent.keyDown(at('0'), { key: 'ArrowRight', shiftKey: true })
    expect(at('0').style.left).toBe('366px')
  })

  it('duplicates with a canvas shortcut without losing the pending edit', async () => {
    const u = userEvent.setup()
    mount(true)
    await editStart(u)
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    await waitFor(() => expect(designs[0].spec.screens[0].elements).toHaveLength(3))
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
  })

  it('selects through Layers and retains the edit when another layer is chosen', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    await u.clear(screen.getByLabelText('Text'))
    await u.type(screen.getByLabelText('Text'), 'Continue checkout')
    await u.click(screen.getByRole('tab', { name: 'Layers' }))
    await u.click(screen.getByRole('button', { name: 'Select button: Cancel order on Home' }))
    expect(screen.getByText(/Unsaved change to/)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Properties' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByDisplayValue('Cancel order')).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Layers' }))
    expect(screen.getByRole('button', { name: 'Select button: Cancel order on Home' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('gallery collections', () => {
  const cards = () => [...document.querySelectorAll('.dcard-meta > b')].map(node => node.textContent)
  const resources = () => [
    makeDesign({ id: 'starter', title: 'Starter · Review', template_kind: 'layout', state: 'approved', surface: 'web' }),
    makeDesign({ id: 'system', title: 'System · Moss', template_kind: 'system', state: 'approved', surface: 'email' }),
  ]

  it('separates ordinary work, starters and systems with independent counts', async () => {
    designs.push(makeDesign({ id: 'approved-design', title: 'Approved checkout', state: 'approved' }), ...resources())
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open Checkout' })
    expect(cards()).toEqual(['Approved checkout', 'Checkout'])
    expect(within(screen.getByRole('tab', { name: 'Designs' })).getByText('2')).toBeTruthy()
    expect(within(screen.getByRole('tab', { name: 'Starters' })).getByText('1')).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Starters' }))
    expect(cards()).toEqual(['Starter · Review'])
    await u.click(screen.getByRole('tab', { name: 'Design systems' }))
    expect(cards()).toEqual(['System · Moss'])
    expect(screen.getByText('Design system')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Design surface' })).toBeNull()
    const card = screen.getByRole('link', { name: 'Open System · Moss' })
    expect(within(card).queryByText(/email|screen/i)).toBeNull()
  })

  it('resets filters on collection changes without losing access to linked systems', async () => {
    designs = [makeDesign({ cites: ['system'], spec: { screens: makeDesign().spec.screens } }), ...resources()]
    const u = userEvent.setup()
    mount()
    const card = await screen.findByRole('link', { name: 'Open Checkout' })
    await u.click(screen.getByRole('button', { name: 'mobile' }))
    await u.selectOptions(screen.getByRole('combobox', { name: 'Design status' }), 'draft')
    await u.type(screen.getByRole('searchbox', { name: 'Search designs' }), 'checkout')
    expect(within(card).getByText('On system')).toBeTruthy()
    expect(card.querySelector('[data-path="0"]')?.getAttribute('style')).toContain('rgb(0, 136, 102)')
    await u.click(screen.getByRole('tab', { name: 'Design systems' }))
    expect(screen.getByRole('combobox', { name: 'Design status' })).toHaveProperty('value', 'all')
    expect(screen.getByRole('searchbox', { name: 'Search design systems' })).toHaveProperty('value', '')
    expect(cards()).toEqual(['System · Moss'])
    await u.type(screen.getByRole('searchbox', { name: 'Search design systems' }), 'missing')
    expect(screen.getByText(/No design systems match/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Show all design systems' }))
    expect(cards()).toEqual(['System · Moss'])
  })

  it('offers recently updated and alphabetical ordering, keeping unknown dates last', async () => {
    designs = [makeDesign({ id: 'a', title: 'Alpha', updated_at: '2026-09-20T10:00:00Z' }),
      makeDesign({ id: 'z', title: 'Zebra', updated_at: '2026-09-22T10:00:00Z' }),
      makeDesign({ id: 'b', title: 'Beta', updated_at: 'invalid' })]
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open Zebra' })
    expect(cards()).toEqual(['Zebra', 'Alpha', 'Beta'])
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T10:00:00Z')
    await u.selectOptions(screen.getByRole('combobox', { name: 'Sort designs' }), 'name')
    expect(cards()).toEqual(['Alpha', 'Beta', 'Zebra'])
  })

  it('makes an empty Designs collection actionable even when resources already exist', async () => {
    designs = resources()
    const u = userEvent.setup()
    mount()
    expect(await screen.findByText('No designs yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create a design' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Browse starters' }))
    expect(cards()).toEqual(['Starter · Review'])
  })

  it('supports keyboard collection navigation and keeps technical copy in expandable help', async () => {
    const u = userEvent.setup()
    designs.push(...resources())
    mount()
    await screen.findByRole('link', { name: 'Open Checkout' })
    const help = screen.getByText('How it works')
    expect(help.closest('details')).toHaveProperty('open', false)
    await u.click(help)
    expect(help.closest('details')).toHaveProperty('open', true)
    screen.getByRole('tab', { name: 'Designs' }).focus()
    await u.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Starters' }))
    expect(screen.getByRole('tabpanel', { name: 'Starters' })).toBeTruthy()
    await u.keyboard('{End}')
    expect(screen.getByRole('tabpanel', { name: 'Design systems' })).toBeTruthy()
    await u.keyboard('{Home}')
    expect(screen.getByRole('tabpanel', { name: 'Designs' })).toBeTruthy()
  })
})

describe('finding designs', () => {
  it('keeps the styled status selector accessible and clears its selected-state treatment', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByText('Checkout', { selector: '.dcard-meta b' })
    const filters = screen.getByRole('group', { name: 'Design filters' })
    const status = within(filters).getByRole('combobox', { name: 'Design status' })
    expect(within(filters).getByRole('searchbox', { name: 'Search designs' })).toBeTruthy()
    expect(status).toHaveProperty('value', 'all')
    expect(status.closest('.dgallery-status')?.getAttribute('data-state')).toBe('all')
    status.focus()
    expect(document.activeElement).toBe(status)
    await u.selectOptions(status, 'draft')
    expect(status.closest('.dgallery-status')?.getAttribute('data-state')).toBe('draft')
    expect(screen.getByText('1 of 1 designs')).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(status).toHaveProperty('value', 'all')
    expect(status.closest('.dgallery-status')?.getAttribute('data-state')).toBe('all')
  })

  it('combines search, surface, and status filters and clears an empty result', async () => {
    designs.push(makeDesign({ id: 'd2', title: 'Reports', surface: 'web', state: 'approved', spec: { screens: [] } }))
    const u = userEvent.setup()
    mount()
    await screen.findByText('Reports', { selector: '.dcard-meta b' })
    await u.type(screen.getByRole('searchbox', { name: 'Search designs' }), 'checkout')
    expect(screen.getByText('1 of 2 designs')).toBeTruthy()
    expect(screen.queryByText('Reports', { selector: '.dcard-meta b' })).toBeNull()
    await u.selectOptions(screen.getByRole('combobox', { name: 'Design status' }), 'approved')
    expect(screen.getByText(/No designs match/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Show all designs' }))
    // Cleared: the line goes back to naming the collection, and the tab
    // carries the count (the header's "N in this space" counted starters and
    // systems too, so it disagreed with the tab under it).
    expect(screen.getByText('Your team’s designs')).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'web' }))
    expect(screen.getByText('1 of 2 designs')).toBeTruthy()
    expect(screen.queryByText('Checkout', { selector: '.dcard-meta b' })).toBeNull()
  })

  it('finds a design by screen name, not just its title', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByText('Checkout', { selector: '.dcard-meta b' })
    await u.type(screen.getByRole('searchbox', { name: 'Search designs' }), 'done')
    expect(screen.getByText('1 of 1 designs')).toBeTruthy()
    expect(screen.getByText('Checkout', { selector: '.dcard-meta b' })).toBeTruthy()
  })

  it('can retry a failed gallery load without reloading the page', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: { code: 'unavailable', message: 'Try later.' } }, 503))
    const u = userEvent.setup()
    mount()
    await screen.findByRole('alert')
    await u.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Checkout', { selector: '.dcard-meta b' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('focus mode', () => {
  it('hides the app sidebar while editing, remembers it, and lets go on leaving', async () => {
    const u = userEvent.setup()
    localStorage.removeItem('designs.focus')
    const { unmount } = mount(true)
    const focus = await screen.findByRole('button', { name: 'Focus' })
    expect(document.body.classList.contains('design-focus')).toBe(false)
    await u.click(focus)
    expect(document.body.classList.contains('design-focus')).toBe(true)
    expect(screen.getByRole('button', { name: 'Exit focus' }).getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('designs.focus')).toBe('1')
    unmount()
    // The class belongs to the editor; the rest of the app keeps its sidebar.
    expect(document.body.classList.contains('design-focus')).toBe(false)
    mount(true)
    await screen.findByRole('button', { name: 'Exit focus' })
    expect(document.body.classList.contains('design-focus')).toBe(true)
    localStorage.removeItem('designs.focus')
  })
})

describe('the selection’s save state', () => {
  it('says Saved as a state, not as a disabled button among the actions', async () => {
    const u = userEvent.setup()
    mount(true)
    await u.click(await screen.findByRole('button', { name: 'Select button: Start on Home' }))
    const actions = screen.getByRole('group', { name: 'Selection actions' })
    expect(within(actions).getByText('Saved').tagName).not.toBe('BUTTON')
    expect(within(actions).queryByRole('button', { name: 'Saved' })).toBeNull()
  })
})
