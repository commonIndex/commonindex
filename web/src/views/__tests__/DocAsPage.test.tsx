/**
 * A doc that is one whole HTML page opens as that page.
 *
 * Defended: only a doc holding a single embed (and empty lines) is a page;
 * it opens as the page filling the doc under the doc's header, sandboxed like
 * any artifact, with no editor drawn first; Expand fills the screen and
 * Escape comes back; Edit shows the doc and View as page goes back; an artifact that is a piece of a page, or one the reader can't see,
 * leaves the doc a doc.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { pageRef } from '../../components/doc/DocAsPage'
import { DocEdit } from '../DocEdit'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const embed = (ref: string) => ({ type: 'embed', attrs: { ref } })
const empty = { type: 'paragraph' }
const para = { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }
const PAGE = '<!doctype html><html><head><title>t</title></head><body><nav>Refund Desk</nav></body></html>'

const calls: string[] = []
const sent: { op: string; body: Record<string, unknown> }[] = []
function gateway(artifact: { status?: number; html?: string }) {
  calls.length = 0; sent.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const name = String(url).split('/api/v1/')[1]
    calls.push(name)
    sent.push({ op: name, body: JSON.parse(String(init?.body ?? '{}')) })
    const body = name === 'docs.get'
      ? { doc: { id: 'doc-1', key: 'DOC-1', title: 'Landing', current_rev: 1,
                 body: { type: 'doc', content: [empty, embed('artifact-1'), empty] } } }
      : name === 'artifacts.get'
        ? (artifact.status ? { error: { code: 'unknown_item', message: 'no item' } }
          : { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Refund Desk', html: artifact.html, updated_at: null } })
        : {}
    return new Response(JSON.stringify(body), { status: name === 'artifacts.get' && artifact.status ? artifact.status : 200 })
  }))
}

const open = async () => {
  render(<MemoryRouter><DocEdit id="doc-1" /></MemoryRouter>)
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
}

describe('what a page doc is', () => {
  it('is one embed and nothing else but empty lines', () => {
    expect(pageRef({ type: 'doc', content: [empty, embed('artifact-1'), empty] })).toBe('artifact-1')
    expect(pageRef({ type: 'doc', content: [para, embed('artifact-1')] })).toBeNull()
    expect(pageRef({ type: 'doc', content: [embed('a'), embed('b')] })).toBeNull()
    expect(pageRef({ type: 'doc', content: [] })).toBeNull()
  })
})

const expand = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Expand/ })) })
}

describe('opening one', () => {
  it('shows the page filling the doc, under the doc header; Edit edits the page, Edit as doc the doc', async () => {
    gateway({ html: PAGE })
    await open()
    const frame = document.querySelector('.doc-page.is-page .doc-page-html iframe') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.style.height).toBe('100%')
    expect(document.querySelector('.doc-as-page')).toBeNull()                         // in the doc, not over the app
    expect(document.querySelector('.doc-prose')).toBeNull()                           // no editor built

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit' })) })
    expect(document.querySelector('.doc-page-html')).toBeNull()
    expect((screen.getByRole('textbox', { name: 'HTML' }) as HTMLTextAreaElement).value).toBe(PAGE)   // the page's own editor
    expect(screen.getByPlaceholderText(/Describe the page/)).toBeTruthy()                           // Ask AI writes pages

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit as doc' })) })
    expect(screen.getByLabelText('Title')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View as page' })) })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(document.querySelector('.doc-page-html iframe')).toBeTruthy()
    expect(calls.filter(c => c === 'artifacts.get').length).toBeGreaterThanOrEqual(2)  // fetched again: it may have changed
  })

  it('saves the page from its editor, and the doc takes the page’s name', async () => {
    gateway({ html: PAGE })
    await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit' })) })
    fireEvent.change(screen.getByPlaceholderText('What it shows'), { target: { value: 'Refund Desk home' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save page' })) })
    await act(async () => { await new Promise(r => setTimeout(r, 1400)) })            // the doc's autosave
    const saved = sent.find(c => c.op === 'artifacts.save')!.body
    expect(saved).toMatchObject({ artifact_id: 'artifact-1', title: 'Refund Desk home', html: PAGE })
    expect(sent.find(c => c.op === 'docs.revise')!.body).toMatchObject({ title: 'Refund Desk home' })
    expect(document.querySelector('.doc-page-html')).toBeTruthy()                     // back to the page
  }, 6000)

  it('draws nothing of the doc body while it finds out whether the doc is a page', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const name = String(url).split('/api/v1/')[1]
      if (name === 'artifacts.get') await gate
      const body = name === 'docs.get'
        ? { doc: { id: 'doc-1', key: 'DOC-1', title: 'Landing', current_rev: 1, body: { type: 'doc', content: [embed('artifact-1')] } } }
        : { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Refund Desk', html: PAGE, updated_at: null } }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    await open()
    expect(document.querySelector('.doc-page-html')).toBeTruthy()                     // a blank page area…
    expect(document.querySelector('.doc-page-html iframe, .doc-prose')).toBeNull()     // …and no editor
    await act(async () => { release(); await new Promise(r => setTimeout(r, 30)) })
    expect(document.querySelector('.doc-page-html iframe')).toBeTruthy()
  })

  it('expands to the whole screen, and Escape comes back to the doc', async () => {
    gateway({ html: PAGE })
    await open()
    await expand()
    const frame = document.querySelector('.doc-as-page iframe') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(document.title).toBe('Refund Desk')
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(document.querySelector('.doc-as-page')).toBeNull()
    expect(document.querySelector('.doc-page-html iframe')).toBeTruthy()
  })

  it('expanded, shows its control when the reader moves over the page, and fades it after', async () => {
    gateway({ html: PAGE })
    await open()
    await expand()
    const nav = () => screen.getByRole('navigation', { name: 'Page' })
    const frame = document.querySelector('.doc-as-page iframe') as HTMLIFrameElement
    expect(frame.srcdoc).toContain("htmlFrame:'activity'")
    expect(nav().classList.contains('is-shown')).toBe(true)                            // on arrival
    await act(async () => { await new Promise(r => setTimeout(r, 2700)) })
    expect(nav().classList.contains('is-shown')).toBe(false)                           // still: out of the way
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { htmlFrame: 'activity' } })) })
    expect(nav().classList.contains('is-shown')).toBe(false)                           // not from the frame: ignored
    await act(async () => { window.dispatchEvent(new MessageEvent('message',
      { data: { htmlFrame: 'activity' }, source: frame.contentWindow })) })
    expect(nav().classList.contains('is-shown')).toBe(true)                            // moved over the page: back
    await act(async () => { fireEvent.click(within(nav()).getByRole('button', { name: 'Exit full screen' })) })
    expect(document.querySelector('.doc-as-page')).toBeNull()
  }, 8000)

  it('leaves a doc a doc when the artifact is a piece of a page', async () => {
    gateway({ html: '<div>a chart</div>' })
    await open()
    expect(document.querySelector('.doc-page-html')).toBeNull()
    expect(screen.getByLabelText('Title')).toBeTruthy()
  })

  it('leaves a doc a doc when the reader cannot see the artifact', async () => {
    gateway({ status: 404 })
    await open()
    expect(document.querySelector('.doc-page-html')).toBeNull()
    expect(screen.getByLabelText('Title')).toBeTruthy()
  })
})

const RENDERED = '<!doctype html><html><body><h1>Launch</h1><p>The doc itself.</p></body></html>'

describe('making a doc a full page', () => {
  function stub(body: object) {
    const sent: { op: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const name = String(url).split('/api/v1/')[1]
      const req = JSON.parse(String(init?.body ?? '{}'))
      sent.push({ op: name, body: req })
      const out = name === 'docs.get' ? { doc: { id: 'doc-1', key: 'DOC-1', title: 'Launch', current_rev: 1, body } }
        : name === 'artifacts.propose' ? { id: 'artifact-new', created: true }
        : name === 'artifacts.get' ? { artifact: { id: 'artifact-new', key: 'ART-9', title: 'Launch', html: PAGE, updated_at: null } }
        : name === 'docs.revise' ? { doc_id: 'doc-1', rev: 2, excerpt: '' }
        : name === 'docs.export' ? { doc_id: 'doc-1', filename: 'launch.html', html: RENDERED } : {}
      return new Response(JSON.stringify(out), { status: 200 })
    }))
    return sent
  }

  it('asks first when the doc has content, then makes the page and opens its editor', async () => {
    const sent = stub({ type: 'doc', content: [para] })
    await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Make full page/ })) })
    const ask = screen.getByRole('dialog', { name: 'Make full page' })
    expect(ask.textContent).toMatch(/stays in History/)
    expect(sent.some(c => c.op === 'artifacts.propose')).toBe(false)                   // nothing made yet
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: 'Make full page' })) })
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    // The page starts as this doc, rendered — not a stock template, which
    // replaced the doc's words with somebody else's landing page.
    expect(sent.find(c => c.op === 'docs.export')!.body).toMatchObject({ doc_id: 'doc-1', for_page: true })
    expect(sent.find(c => c.op === 'artifacts.propose')!.body).toMatchObject({ title: 'Launch', html: RENDERED })
    expect(sent.find(c => c.op === 'docs.revise')!.body).toMatchObject({
      body: { type: 'doc', content: [{ type: 'embed', attrs: { ref: 'artifact-new' } }] }, note: 'made a full page' })
    expect(screen.getByRole('button', { name: 'Save page' })).toBeTruthy()            // in the page's editor
  })

  it('makes an empty doc a page without asking, and a page doc does not offer it', async () => {
    const sent = stub({ type: 'doc', content: [{ type: 'paragraph' }] })
    await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Make full page/ })) })
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(screen.queryByRole('dialog', { name: 'Make full page' })).toBeNull()
    expect(sent.some(c => c.op === 'artifacts.propose')).toBe(true)
    // Nothing to carry over, so it starts from the template and exports nothing.
    const { PAGE_STARTER } = await import('../../data/starters')
    expect(sent.find(c => c.op === 'artifacts.propose')!.body).toMatchObject({ html: PAGE_STARTER })
    expect(sent.some(c => c.op === 'docs.export')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit as doc' })) })
    expect(screen.queryByRole('button', { name: /Make full page/ })).toBeNull()        // it is one already
  })
})
