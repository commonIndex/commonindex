/**
 * Embedded artifacts, as the doc editor holds and shows them.
 *
 * Defended: the doc stores an artifact's id, never its HTML; an AI rewrite
 * round-trips an embed through markdown instead of deleting it; the artifact
 * runs in a frame sandboxed without same-origin, under a no-network policy;
 * an artifact the reader can't see says so without saying what it is; a new
 * one is created only when somebody writes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Editor } from '@tiptap/core'
import { DocEditor, docExtensions } from '../doc/DocEditor'
import { applyAssist, assistTarget } from '../doc/assist'
import { filterBlocks } from '../doc/blocks'
import { ARTIFACT_STARTER, existingId, PAGE_STARTER } from '../doc/EmbedBlock'
import { FRAME_POLICY, framePage, isPage, PAGE_H, PAGE_W } from '../HtmlFrame'
import type { DocNode } from '../../data/gateway'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.destroy()); cleanup(); vi.unstubAllGlobals() })

function make(content: DocNode) {
  const e = new Editor({ extensions: docExtensions(), content })
  editors.push(e)
  return e
}

const para = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const embed = (ref: string | null): DocNode => ({ type: 'embed', attrs: { ref } })

function gateway(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    calls.push({ op, body: JSON.parse(String(init?.body ?? '{}')) })
    const a = answers[op] ?? { body: {} }
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body } as Response
  }))
  return calls
}

describe('in the doc', () => {
  it('stores an id and nothing else', () => {
    const e = make({ type: 'doc', content: [para('Refunds'), embed('artifact-abc123')] })
    expect(e.getJSON().content?.[1]).toEqual({ type: 'embed', attrs: { ref: 'artifact-abc123' } })
  })

  it('is one line of markdown, and an AI rewrite keeps it', () => {
    const e = make({ type: 'doc', content: [para('Refunds by week'), embed('artifact-abc123'), para('the end')] })
    const t = assistTarget(e)
    expect(t.markdown).toContain(':::embed {ref="artifact-abc123"} :::')
    // The model rewrote the prose and left the embed line where it was.
    applyAssist(e, t, '# Refunds by week\n\n:::embed {ref="artifact-abc123"} :::\n\nThat is all.')
    expect(e.getJSON().content?.find(n => n.type === 'embed')).toMatchObject({ type: 'embed', attrs: { ref: 'artifact-abc123' } })
  })

  it('reads the line back without its closing colons, which models drop', () => {
    const e = make({ type: 'doc', content: [para('Refunds'), embed('artifact-abc123')] })
    applyAssist(e, assistTarget(e), 'Refunds, rewritten.\n\n:::embed {ref="artifact-abc123"}\n\nMore.')
    expect(e.getJSON().content?.filter(n => n.type === 'embed')).toHaveLength(1)
    expect(e.getText()).not.toContain(':::embed')
  })

  it('is offered by the slash menu for /html and /artifact', () => {
    expect(filterBlocks('html').map(b => b.id)).toContain('artifact')
    expect(filterBlocks('artif')[0].id).toBe('artifact')
  })

  it('finds the artifact in a pasted link', () => {
    expect(existingId('http://localhost:5173/artifacts/artifact-9fc1be9f1de3')).toBe('artifact-9fc1be9f1de3')
    expect(existingId('artifact-9fc1')).toBe('artifact-9fc1')
    expect(existingId('https://example.com/doc-1')).toBeNull()
  })
})

describe('the frame', () => {
  it('has no network and no way into the app', () => {
    expect(FRAME_POLICY).toContain("default-src 'none'")
    expect(FRAME_POLICY).not.toMatch(/connect-src|https?:/)
    expect(framePage('<b>hi</b>')).toContain(`content="${FRAME_POLICY}"`)
  })
})

const view = (content: DocNode) => render(<MemoryRouter>
  <DocEditor content={content} title="" onChange={() => {}} /></MemoryRouter>)

describe('the block', () => {
  it('runs the artifact sandboxed, without same-origin', async () => {
    gateway({ 'artifacts.get': { body: { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Refund chart',
      html: '<svg></svg><script>1</script>', height: 300, updated_at: null } } } })
    view({ type: 'doc', content: [embed('artifact-1')] })
    const frame = (await screen.findAllByTitle('Refund chart')).find(e => e.tagName === 'IFRAME') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.style.height).toBe('300px')
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/artifacts/artifact-1')
  })

  it('fits its content when the frame says so, and believes only the frame', async () => {
    gateway({ 'artifacts.get': { body: { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Chart',
      html: '<b>1</b>', height: 420, updated_at: null } } } })
    view({ type: 'doc', content: [embed('artifact-1')] })
    const frame = (await screen.findAllByTitle('Chart')).find(e => e.tagName === 'IFRAME') as HTMLIFrameElement
    expect(framePage('<b>1</b>', true)).toContain("htmlFrame:'size'")
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { htmlFrame: 'size', h: 90 } })) })
    expect(frame.style.height).toBe('420px')                         // not from the frame: ignored
    await act(async () => { window.dispatchEvent(new MessageEvent('message',
      { data: { htmlFrame: 'size', h: 90 }, source: frame.contentWindow })) })
    expect(frame.style.height).toBe('90px')
    await act(async () => { window.dispatchEvent(new MessageEvent('message',
      { data: { htmlFrame: 'size', h: 99999 }, source: frame.contentWindow })) })
    expect(frame.style.height).toBe('420px')                         // never past its max height
  })

  it('rides out a dropped connection, and offers Retry when it persists', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let fail = 5
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail-- > 0) throw new TypeError('Load failed')
      return { ok: true, status: 200, json: async () => ({ artifact: { id: 'artifact-1', key: 'ART-1', title: 'Back',
        html: '<b>1</b>', updated_at: null } }) } as Response
    }))
    view({ type: 'doc', content: [embed('artifact-1')] })
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(await screen.findByText(/Couldn’t reach the server/)).toBeTruthy()   // 4 tries, all failed
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect((await screen.findAllByTitle('Back')).some(e => e.tagName === 'IFRAME')).toBe(true)
    vi.useRealTimers()
  })

  it('opens full screen at the size of the window, sandboxed the same way', async () => {
    gateway({ 'artifacts.get': { body: { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Landing',
      html: '<nav style="position:fixed">n</nav>', height: 600, updated_at: null } } } })
    view({ type: 'doc', content: [embed('artifact-1')] })
    await screen.findAllByTitle('Landing')
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Full screen' })) })
    const sheet = screen.getByRole('dialog', { name: 'Landing' })
    const frame = sheet.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.style.height).toBe('100%')
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a whole HTML document as a page: in a window, laid out at desktop size', async () => {
    expect(isPage('<!DOCTYPE html><html><body>x</body></html>')).toBe(true)
    expect(isPage('<!-- by AI -->\n<html lang="en">')).toBe(true)
    expect(isPage('<div>a chart</div>')).toBe(false)
    gateway({ 'artifacts.get': { body: { artifact: { id: 'artifact-1', key: 'ART-1', title: 'Landing',
      html: '<!doctype html><html><body><nav>n</nav></body></html>', height: 1600, updated_at: null } } } })
    view({ type: 'doc', content: [embed('artifact-1')] })
    const frame = (await screen.findAllByTitle('Landing')).find(e => e.tagName === 'IFRAME') as HTMLIFrameElement
    expect(frame.closest('.html-page')).toBeTruthy()
    expect([frame.style.width, frame.style.height]).toEqual([`${PAGE_W}px`, `${PAGE_H}px`])
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('says an artifact is not shared, and not what it is', async () => {
    gateway({ 'artifacts.get': { status: 404, body: { error: { code: 'unknown_item', message: 'no item' } } } })
    view({ type: 'doc', content: [embed('artifact-secret')] })
    expect(await screen.findByText(/isn’t shared with you, or no longer exists/)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('offers a block or a full page, and asks AI for the one chosen', async () => {
    const calls = gateway({ 'artifacts.draft': { body: { html: '<!doctype html><html><body>AI page</body></html>', kind: 'page', model: 'm' } } })
    view({ type: 'doc', content: [embed(null)] })
    const source = await screen.findByRole('textbox', { name: 'HTML' }) as HTMLTextAreaElement
    expect(source.value).toBe(ARTIFACT_STARTER)
    expect(screen.getByRole('radio', { name: /Block in this doc/ }).getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /Full page/ })) })
    expect(source.value).toBe(PAGE_STARTER)                                            // the page template
    expect(isPage(source.value)).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), { target: { value: 'a landing page for Refund Desk' } })
    await act(async () => { fireEvent.click(within(document.querySelector('.art-ask') as HTMLElement).getByRole('button', { name: 'Ask AI' })) })
    expect(calls.find(c => c.op === 'artifacts.draft')!.body).toMatchObject({ kind: 'page', instruction: 'a landing page for Refund Desk' })
    expect(calls.find(c => c.op === 'artifacts.draft')!.body.html).toBeUndefined()      // the template is not "current"
    expect(source.value).toContain('AI page')
    // Hand-written HTML is never thrown away by switching.
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /Block in this doc/ })) })
    expect(source.value).toContain('AI page')
    expect(screen.getByRole('alert').textContent).toMatch(/whole page/)
  })

  it('creates the artifact only when somebody writes one, then holds its id', async () => {
    const calls = gateway({ 'artifacts.propose': { body: { id: 'artifact-new' } },
                            'artifacts.get': { body: { artifact: { id: 'artifact-new', key: 'ART-2', title: 'Counter',
                              html: '<b>1</b>', updated_at: null } } } })
    let editor: Editor | null = null
    render(<MemoryRouter><DocEditor content={{ type: 'doc', content: [embed(null)] }} title="" onChange={() => {}}
      onReady={e => { editor = e }} /></MemoryRouter>)
    expect(calls.filter(c => c.op === 'artifacts.propose')).toHaveLength(0)
    fireEvent.change(await screen.findByPlaceholderText('What it shows'), { target: { value: 'Counter' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create artifact' })) })
    await waitFor(() => expect(editor!.getJSON().content?.[0]).toEqual({ type: 'embed', attrs: { ref: 'artifact-new' } }))
    expect(calls.find(c => c.op === 'artifacts.propose')!.body).toMatchObject({ title: 'Counter' })
  })
})
