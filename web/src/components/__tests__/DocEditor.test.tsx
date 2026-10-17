import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import docTypeRaw from '../../../../types/doc.json?raw'
import { DocEditor, docExtensions, normalizeUrl } from '../doc/DocEditor'
import { applyAssist, assistTarget, HERE, kept } from '../doc/assist'
import { BLOCKS, filterBlocks, today } from '../doc/blocks'
import type { DocAssist, DocNode } from '../../data/gateway'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.destroy()) })

function make(content: DocNode | string, onAi = () => {}) {
  const e = new Editor({ extensions: docExtensions({ onAi }), content })
  editors.push(e)
  return e
}

const para = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })

describe('the editor and the doc type agree', () => {
  it('every node and mark the editor can write is one the gateway accepts', () => {
    // If these drift, a save fails with "invalid_props" the first time
    // somebody uses the block that was added on one side only.
    const node = JSON.parse(docTypeRaw).schema.$defs.node
    const e = make('')
    expect(new Set(Object.keys(e.schema.nodes))).toEqual(new Set(node.properties.type.enum))
    expect(new Set(Object.keys(e.schema.marks))).toEqual(new Set(node.properties.marks.items.properties.type.enum))
  })
})

describe('the slash menu', () => {
  it('ranks label prefixes first, so /h finds the headings', () => {
    expect(filterBlocks('h').slice(0, 3).map(b => b.id)).toEqual(['h1', 'h2', 'h3'])
  })
  it('matches keywords', () => {
    expect(filterBlocks('todo').map(b => b.id)).toEqual(['check'])
  })
  it('offers every block with no query', () => {
    expect(filterBlocks('')).toHaveLength(BLOCKS.length)
  })
  it('every block runs', () => {
    for (const b of BLOCKS) {
      const e = make({ type: 'doc', content: [para('x')] })
      e.commands.setTextSelection(1)
      b.run(e)
      expect(e.getJSON().content?.length, b.id).toBeGreaterThan(0)
    }
  })
  it('a date is written the way a person writes one', () => {
    expect(today(new Date(2026, 8, 26))).toBe('26 Sep 2026')
  })
})

describe('typing @ai', () => {
  it('opens the prompt and leaves nothing behind in the doc', async () => {
    const onAi = vi.fn()
    const e = make({ type: 'doc', content: [para('Hello ')] }, onAi)
    e.commands.setTextSelection(7)
    for (const ch of '@ai') {
      const { from, to } = e.state.selection
      const handled = e.view.someProp('handleTextInput', f => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)))
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to))
    }
    await Promise.resolve()
    expect(onAi).toHaveBeenCalledOnce()
    expect(e.getText()).toBe('Hello ')
  })

  it('does not fire inside an email address', async () => {
    const onAi = vi.fn()
    const e = make({ type: 'doc', content: [para('maya')] }, onAi)
    e.commands.setTextSelection(5)
    for (const ch of '@ai') {
      const { from, to } = e.state.selection
      const handled = e.view.someProp('handleTextInput', f => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)))
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to))
    }
    await Promise.resolve()
    expect(onAi).not.toHaveBeenCalled()
    expect(e.getText()).toBe('maya@ai')
  })
})

describe('asking AI', () => {
  it('marks the cursor in what it sends, and never in the doc', () => {
    const e = make({ type: 'doc', content: [para('One'), para('Two')] })
    e.commands.setTextSelection(4)
    const t = assistTarget(e)
    expect(t.scope).toBe('document')
    expect(t.markdown).toContain(`One${HERE}`)
    expect(e.getText()).not.toContain(HERE)
  })

  it('sends only the selected passage when there is one', () => {
    const e = make({ type: 'doc', content: [para('Keep this. Change this.')] })
    e.commands.setTextSelection({ from: 12, to: 24 })
    const t = assistTarget(e)
    expect(t.scope).toBe('selection')
    expect(t.selection?.trim()).toBe('Change this.')
  })

  it('puts a rewritten sentence back inside its paragraph, not as a new one', () => {
    const e = make({ type: 'doc', content: [para('Keep this. Change this.')] })
    e.commands.setTextSelection({ from: 12, to: 24 })
    const t = assistTarget(e)
    expect(applyAssist(e, t, 'Changed **well**.')).toBe('selection')
    expect(e.getJSON().content).toHaveLength(1)
    expect(e.getText()).toBe('Keep this. Changed well.')
  })

  it('replaces the whole doc as one step that a single undo takes back', () => {
    const e = make({ type: 'doc', content: [para('Draft')] })
    const t = assistTarget(e)
    expect(applyAssist(e, t, '# Plan\n\n- [ ] ship it\n\nDraft\n\n| a | b |\n| - | - |\n| 1 | 2 |')).toBe('replaced')
    const types = e.getJSON().content?.map(n => n.type)
    // and the empty paragraph after a table, so there is somewhere to type
    expect(types).toEqual(['heading', 'taskList', 'paragraph', 'table', 'paragraph'])
    e.commands.undo()
    expect(e.getText()).toBe('Draft')
  })

  it('refuses an answer to a doc that changed while the model was writing', () => {
    const e = make({ type: 'doc', content: [para('Before')] })
    const t = assistTarget(e)
    e.commands.insertContentAt(1, 'typed meanwhile ')
    expect(applyAssist(e, t, 'Model text')).toBe(false)
    expect(e.getText()).toBe('typed meanwhile Before')
  })

  it('renders HTML in a model answer as text, never as markup', () => {
    const e = make({ type: 'doc', content: [para('x')] })
    applyAssist(e, assistTarget(e), '<img src=x onerror="alert(1)"><script>alert(2)</script>')
    const html = e.getHTML()
    expect(html).not.toMatch(/<img[^>]*onerror/)
    expect(html).not.toContain('<script')
  })
})

describe('links and images', () => {
  it('gives a bare domain a scheme', () => {
    expect(normalizeUrl('example.com/a', 'link')).toBe('https://example.com/a')
  })
  it('refuses script and data urls', () => {
    expect(normalizeUrl('javascript:alert(1)', 'link')).toBeNull()
    expect(normalizeUrl('data:text/html,hi', 'image')).toBeNull()
    expect(normalizeUrl('mailto:a@b.co', 'image')).toBeNull()
    expect(normalizeUrl('mailto:a@b.co', 'link')).toBe('mailto:a@b.co')
  })
})

describe('the AI prompt', () => {
  it('sends the instruction with the doc and applies the answer', async () => {
    const assist = vi.fn(async (): Promise<DocAssist> => ({
      markdown: '# Launch plan\n\nShip on Friday.', scope: 'document', model: 'stub-writer', note: '' }))
    const onAiEdit = vi.fn()
    const onChange = vi.fn()
    render(<DocEditor content={{ type: 'doc', content: [para('notes')] }} title="Plan"
      onChange={onChange} onAiEdit={onAiEdit} assist={assist} />)

    const box = await screen.findByLabelText('Tell AI what to write or edit')
    fireEvent.change(box, { target: { value: 'turn this into a launch plan' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })

    expect(assist).toHaveBeenCalledWith(expect.objectContaining({
      instruction: 'turn this into a launch plan', title: 'Plan' }))
    await waitFor(() => expect(screen.getByText(/Edited by/)).toBeTruthy())
    expect(onAiEdit).toHaveBeenCalledWith('@ai (stub-writer): turn this into a launch plan')
    const last = onChange.mock.calls.at(-1)?.[0] as DocNode
    expect(last.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
  })

  it('says what went wrong and changes nothing when the model is not configured', async () => {
    const { GatewayError } = await import('../../data/gateway')
    const assist = vi.fn(async (): Promise<DocAssist> => {
      throw new GatewayError('llm_unconfigured', 'no model is configured for this workspace.')
    })
    const onChange = vi.fn()
    render(<DocEditor content={{ type: 'doc', content: [para('notes')] }} title=""
      onChange={onChange} assist={assist} />)
    const box = await screen.findByLabelText('Tell AI what to write or edit')
    fireEvent.change(box, { target: { value: 'write more' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect((await screen.findByRole('alert')).textContent).toContain('no model is configured')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('diagrams', () => {
  const FLOW = '```mermaid\nflowchart TD\n  A[Rectangle 1] --> B[Rectangle 2]\n```'

  it('a mermaid answer becomes a diagram block, not prose and not a plain code block', () => {
    const e = make({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(applyAssist(e, assistTarget(e), FLOW)).toBe('replaced')
    expect(e.getJSON().content?.[0]).toMatchObject({ type: 'codeBlock', attrs: { language: 'mermaid' } })
  })

  it('an answer that is only the diagram goes in at the cursor and keeps the doc', () => {
    // The screenshot case: a small model asked for "the complete revised
    // document" returned the diagram alone.
    const e = make({ type: 'doc', content: [para('Refunds need finance approval.'), para('Then money is sent.')] })
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    expect(applyAssist(e, assistTarget(e), FLOW)).toBe('inserted')
    expect(e.getText()).toContain('Refunds need finance approval.')
    expect(e.getText()).toContain('Then money is sent.')
    expect(e.getJSON().content?.some(n => n.type === 'codeBlock')).toBe(true)
  })

  it('counts how much of the doc an answer kept', () => {
    const before = { type: 'doc', content: [para('the first line, long enough to count'),
                                            para('the second line, long enough to count')] }
    expect(kept(before, { type: 'doc', content: [para('the first line, long enough to count')] })).toBe(0.5)
    expect(kept({ type: 'doc', content: [para('notes')] }, { type: 'doc', content: [] })).toBe(1)
    expect(kept({ type: 'doc', content: [] }, { type: 'doc', content: [] })).toBe(1)
  })

  it('expands to show the whole flow, and Escape closes it', async () => {
    // A paragraph first: the cursor starts there, so the diagram is drawn.
    render(<DocEditor content={{ type: 'doc', content: [para('Intro'), {
      type: 'codeBlock', attrs: { language: 'mermaid' },
      content: [{ type: 'text', text: 'flowchart LR\n  A[Ask] --> B[Review]\n  B --> C[Pay]\n  C --> D[Done]' }] }] }}
      title="" onChange={() => {}} />)
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Expand' })) })
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.mermaid-flow.fit svg')).toBeTruthy()
    expect(dialog.textContent).toContain('Close')
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the slash menu offers a diagram for /flow', () => {
    expect(filterBlocks('flow').map(b => b.id)).toContain('diagram')
  })

  it('draws the flow in the editor and shows its source only while the cursor is in it', async () => {
    render(<DocEditor content={{ type: 'doc', content: [para('Intro'), {
      type: 'codeBlock', attrs: { language: 'mermaid' },
      content: [{ type: 'text', text: 'flowchart LR\n  A[Rectangle 1] --> B[Rectangle 2]' }] }] }}
      title="" onChange={() => {}} />)
    expect(await screen.findByText('Rectangle 1')).toBeTruthy()
    expect(document.querySelector('.doc-diagram svg')).toBeTruthy()
    expect((document.querySelector('.doc-code pre') as HTMLElement).hidden).toBe(true)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit source' })) })
    expect((document.querySelector('.doc-code pre') as HTMLElement).hidden).toBe(false)
    expect(document.querySelector('.doc-diagram svg')).toBeNull()
  })

  it('a block that is not a flowchart stays readable source', async () => {
    render(<DocEditor content={{ type: 'doc', content: [{
      type: 'codeBlock', attrs: { language: 'mermaid' },
      content: [{ type: 'text', text: 'sequenceDiagram\n  A->>B: hi' }] }] }}
      title="" onChange={() => {}} />)
    expect(await screen.findByText(/mermaid flowcharts only/)).toBeTruthy()
    expect((document.querySelector('.doc-code pre') as HTMLElement).hidden).toBe(false)
  })
})

describe('tables', () => {
  const cell = (t: string, header = false): DocNode => ({ type: header ? 'tableHeader' : 'tableCell',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
  const table: DocNode = { type: 'table', content: [
    { type: 'tableRow', content: [cell('Amount', true), cell('Action', true)] },
    { type: 'tableRow', content: [cell('Under $100'), cell('Approve')] }] }

  it('offers rows, columns and headers on the table the cursor is in, and they change it', async () => {
    let editor: Editor | null = null
    const changes: DocNode[] = []
    render(<DocEditor content={{ type: 'doc', content: [para('Rules'), table] }} title="" onChange={b => changes.push(b)}
      onReady={e => { editor = e }} />)
    await waitFor(() => expect(editor).toBeTruthy())
    expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull()               // not in a table yet
    await act(async () => {
      let at = 0
      editor!.state.doc.descendants((n, pos) => { if (!at && n.isText && n.text === 'Under $100') at = pos })
      editor!.commands.setTextSelection(at + 1)
    })
    const menu = await screen.findByRole('toolbar', { name: 'Table' })
    type Tree = { type: string; content?: Tree[] }
    const tableOf = () => (editor!.getJSON() as unknown as Tree).content!.find(n => n.type === 'table')!
    const shape = () => { const t = tableOf(); return [t.content!.length, t.content![0].content!.length] }
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: '↓ Below' })) })
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Right →' })) })
    expect(shape()).toEqual([3, 3])
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Header row' })) })
    const first = tableOf().content![0]
    expect(first.content!.every(c => c.type === 'tableCell')).toBe(true)              // header row off
    expect(changes.length).toBeGreaterThan(0)                                         // and the doc saves it
  })
})
