import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, Outlet, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignsView, DesignDetail } from '../Designs'
import { saveDraft } from '../../data/drafts'
import type { WireDesign } from '../../data/gateway'

const layout: WireDesign = {
  id: 'layout', title: 'Starter · Review', surface: 'web', state: 'approved',
  template_kind: 'layout', cites: [],
  spec: { tokens: { 'color.accent': { $type: 'color', $value: '#008866' } }, screens: [
    { id: 'request', name: 'Request', w: 1280, h: 900, elements: [
      { id: 'approve', role: 'button', text: 'Approve', x: 64, y: 100, w: 200, h: 44,
        cites: 'color.accent', goto: 'done' },
    ] },
    { id: 'done', name: 'Decision', w: 1280, h: 900, elements: [] },
  ] },
}
const system: WireDesign = {
  id: 'ink', title: 'System · Ink', template_kind: 'system', surface: 'email',
  state: 'approved', cites: [],
  spec: { tokens: { 'color.accent': { $type: 'color', $value: '#9966ff' },
    'color.bg': { $type: 'color', $value: '#101316' } }, screens: [] },
}
const response = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

let designs: WireDesign[]
let created: WireDesign | undefined
let failCreate: boolean
beforeEach(() => {
  localStorage.clear()
  designs = [layout, system]
  created = undefined
  failCreate = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const args = JSON.parse(String(init?.body ?? '{}'))
    if (op === 'designs.list') return response({ designs, total: designs.length })
    if (op === 'designs.get') return response({ design: designs.find(d => d.id === args.id) })
    if (op === 'designs.history') return response({ revisions: [] })
    if (op === 'designs.references') return response({ references: [], stale: false })
    if (op === 'designs.propose') {
      if (failCreate) return response({ error: { code: 'unavailable', message: 'Create failed. Try again.' } }, 503)
      created = { ...args, id: 'created-review', current_rev: 1 }
      designs.push(created!)
      return response({ id: created!.id, created: true })
    }
    return response({})
  }))
})
afterEach(() => vi.unstubAllGlobals())

function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function mount() {
  return render(<RouterProvider router={createMemoryRouter([{
    element: <><Location /><Outlet /></>, children: [
      { path: '/designs', element: <DesignsView /> },
      { path: '/designs/:id', element: <DesignDetail /> },
    ],
  }], { initialEntries: ['/designs'] })} />)
}
async function choose(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole('button', { name: '+ New design' }))
  await u.click(screen.getByRole('button', { name: 'From a template' }))
  await u.click(screen.getByRole('button', { name: 'Choose Starter · Review' }))
  await u.click(screen.getByRole('button', { name: 'System · Ink' }))
  await u.type(screen.getByRole('textbox', { name: 'Design name' }), 'Launch review')
}

describe('creating a styled layout', () => {
  it('opens the new editor, retaining layout provenance and the selected live system', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByRole('tab', { name: 'Starters' }))
    await screen.findByText('Starter · Review')
    // These gallery filters must not hide the new draft after creation.
    await u.selectOptions(screen.getByRole('combobox', { name: 'Design status' }), 'approved')
    await u.type(screen.getByRole('searchbox', { name: 'Search starters' }), 'Starter')
    await choose(u)
    const button = document.querySelector('.dtemplate-stage [data-el="approve"]') as HTMLElement
    expect(button.style.background).toBe('rgb(153, 102, 255)')
    await u.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/designs/created-review'))
    await screen.findByRole('button', { name: 'Preview' })
    expect(created).toMatchObject({ title: 'Launch review', surface: 'web', state: 'draft',
      cites: [system.id, layout.id], spec: { screens: layout.spec.screens } })
    expect(created!.spec.tokens).toBeUndefined()
    await waitFor(() => expect((document.querySelector('[data-el="approve"]') as HTMLElement)
      .style.background).toBe('rgb(153, 102, 255)'))
    expect(localStorage.getItem('commonindex.designs.draft.v1')).toBeNull()
  })

  it('restores the independent style, layout and name after reload', async () => {
    const u = userEvent.setup()
    const first = mount()
    await choose(u)
    first.unmount()
    const stored = JSON.parse(localStorage.getItem('commonindex.designs.draft.v1')!)
    expect(stored).toMatchObject({ pickId: layout.id, styleId: system.id, title: 'Launch review' })
    expect(JSON.stringify(stored)).not.toContain('#9966ff')
    mount()
    await u.click(await screen.findByRole('button', { name: '+ New design' }))
    expect(screen.getByRole('textbox', { name: 'Design name' })).toHaveProperty('value', 'Launch review')
    expect(screen.getByRole('button', { name: 'System · Ink' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Choose Starter · Review' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('can return to the original palette without copying tokens or retaining the override citation', async () => {
    const u = userEvent.setup()
    mount()
    await choose(u)
    await u.click(screen.getByRole('button', { name: /Original style/ }))
    expect((document.querySelector('.dtemplate-stage [data-el="approve"]') as HTMLElement)
      .style.background).toBe('rgb(0, 136, 102)')
    await u.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Preview' })
    expect(created!.cites).toEqual([layout.id])
    expect(created!.spec.tokens).toBeUndefined()
  })

  it('requires an explicit replacement if a restored style is no longer available', async () => {
    const u = userEvent.setup()
    saveDraft({ mode: 'template', brief: '', title: 'Saved review', surface: 'web',
      screens: 2, pickId: layout.id, styleId: 'deleted-system', turns: [], generated: null })
    mount()
    await u.click(await screen.findByRole('button', { name: '+ New design' }))
    expect(screen.getByRole('alert').textContent).toContain('saved style is no longer available')
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
    await u.click(screen.getByRole('button', { name: /Original style/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', false)
  })

  it('keeps the chosen layout, style and name if creation fails', async () => {
    const u = userEvent.setup()
    mount()
    await choose(u)
    failCreate = true
    await u.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText('Create failed. Try again.')
    expect(screen.getByTestId('location').textContent).toBe('/designs')
    expect(screen.getByRole('textbox', { name: 'Design name' })).toHaveProperty('value', 'Launch review')
    expect(screen.getByRole('button', { name: 'System · Ink' }).getAttribute('aria-pressed')).toBe('true')
    expect(created).toBeUndefined()
    failCreate = false
    await u.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: 'Preview' })
  })
})
