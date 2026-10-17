/**
 * The docs collection as a gallery: the docs written here, and nothing generated.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocsView } from '../Docs'
import { forgetLiveDocs } from '../../data/api'
import { docs } from '../../data/seed'

function mount() {
  forgetLiveDocs()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const out = op === 'docs.list'
      ? { docs: [{ id: 'doc-1', key: 'DOC-1', title: 'Written here', excerpt: 'Our first real doc.',
                   body: { type: 'doc', content: [] }, current_rev: 2 }], total: 1 }
      : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  render(<MemoryRouter><DocsView /></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the docs gallery', () => {
  it('offers a retry instead of claiming an unavailable collection is empty', async () => {
    forgetLiveDocs()
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail) throw new Error('offline')
      return { ok: true, status: 200, json: async () => ({ docs: [], total: 0 }) } as Response
    }))
    render(<MemoryRouter><DocsView /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('No docs yet')).toBeNull()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No docs yet')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows only the docs written here, with no sample switch', async () => {
    mount()
    await screen.findByRole('link', { name: 'Open doc Written here' })
    expect(document.querySelectorAll('.dash-gallery-grid [role=listitem]')).toHaveLength(1)
    expect(screen.queryByRole('checkbox', { name: /sample data/i })).toBeNull()
    expect(screen.queryByText('Sample doc')).toBeNull()
  })

  it('opens as cards, and keeps the dense list a click away', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByRole('link', { name: 'Open doc Written here' })
    expect(document.querySelector('.dash-gallery-grid')).not.toBeNull()
    await u.click(screen.getByRole('button', { name: 'List view' }))
    expect(document.querySelector('.dash-gallery-grid')).toBeNull()
    expect(document.querySelector('.list-doc')).not.toBeNull()
  })
})


describe('a doc made into a full page', () => {
  it('previews the page itself, not "Empty"', async () => {
    forgetLiveDocs()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const out = op === 'docs.list'
        ? { docs: [{ id: 'doc-9', key: 'DOC-9', title: 'Weekly payments review', excerpt: '',
                     body: { type: 'doc', content: [{ type: 'embed', attrs: { ref: 'artifact-9' } }] },
                     current_rev: 2 }], total: 1 }
        : op === 'artifacts.get'
          ? { artifact: { id: 'artifact-9', key: 'ART-9', title: 'Weekly payments review',
                          html: '<h1>Say what it does</h1>', updated_at: null } }
          : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    render(<MemoryRouter><DocsView /></MemoryRouter>)
    expect(await screen.findByText('Full page')).toBeTruthy()
    expect(screen.queryByText('Empty — open it to start writing.')).toBeNull()
    const frame = await screen.findByTitle('Weekly payments review preview')
    expect(frame.getAttribute('srcdoc')).toContain('Say what it does')
  })
})
