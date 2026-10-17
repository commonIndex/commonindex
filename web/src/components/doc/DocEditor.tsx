import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { Markdown } from '@tiptap/markdown'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { assistDoc, GatewayError, type DocAssist, type DocNode } from '../../data/gateway'
import { applyAssist, assistTarget } from './assist'
import { BLOCKS, type Block } from './blocks'
import { AiTrigger, Slash, type SlashBridge } from './extensions'
import { DiagramCodeBlock } from './DiagramBlock'
import { TableMenu } from './TableMenu'
import { Embed } from './EmbedBlock'
import { Icon, type IconName } from './Icons'

type Assist = (a: { instruction: string; markdown: string; selection?: string
                    title?: string }) => Promise<DocAssist>

/** Every node and mark these extensions can produce is one the doc type
 *  declares (types/doc.json), so whatever this editor writes, `docs.revise`
 *  accepts — and nothing here renders HTML it was handed. */
export function docExtensions(opts: { slash?: SlashBridge | null; onAi?: () => void } = {}) {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      // Replaced by the same node with a view that draws ```mermaid blocks.
      codeBlock: false,
    }),
    DiagramCodeBlock,
    Placeholder.configure({
      placeholder: ({ node }) => node.type.name === 'heading'
        ? 'Heading'
        : 'Write, type / for blocks, or @ai to ask AI',
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false }),
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    Embed,
    Markdown,
    Slash.configure({ bridge: opts.slash ?? null }),
    AiTrigger.configure({ onTrigger: opts.onAi ?? (() => {}) }),
  ]
}

/** http(s) and mailto only. A `javascript:` href is refused by the link
 *  extension anyway; this is where a bare `example.com` gets its scheme. */
export function normalizeUrl(raw: string, kind: 'link' | 'image'): string | null {
  const v = raw.trim()
  if (!v) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`
  try {
    const u = new URL(withScheme)
    const ok = kind === 'image' ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:']
    return ok.includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

type AiState =
  | { phase: 'idle' }
  | { phase: 'running'; scope: 'document' | 'selection' }
  | { phase: 'done'; model: string; applied: 'replaced' | 'inserted' | 'selection' }
  | { phase: 'error'; message: string }

interface SlashMenu { items: Block[]; index: number; rect: DOMRect | null; pick: (b: Block) => void }

export function DocEditor({ content, title, onChange, onAiEdit, onReady, assist = assistDoc, readOnly = false }: {
  content: DocNode
  title: string
  onChange: (body: DocNode) => void
  /** The same page, to read: no toolbar, no menus, no assistant — for a doc
   *  that is not yours to change, like a sample. */
  readOnly?: boolean
  /** Called once an AI answer is in the doc, with a note for the revision. */
  onAiEdit?: (note: string) => void
  onReady?: (editor: Editor) => void
  assist?: Assist
}) {
  const composer = useRef<HTMLTextAreaElement>(null)
  const [prompt, setPrompt] = useState('')
  const [ai, setAi] = useState<AiState>({ phase: 'idle' })
  const ticket = useRef(0)
  const [slash, setSlash] = useState<SlashMenu | null>(null)
  const slashRef = useRef<SlashMenu | null>(null)
  slashRef.current = slash

  // Handlers the editor calls, held in refs: the editor is built once, and a
  // callback captured at that moment would read the props of the first render
  // forever.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const bridge = useMemo<SlashBridge>(() => {
    const show = (p: SuggestionProps<Block, Block>, index: number) => setSlash({
      items: p.items, index: Math.min(index, Math.max(0, p.items.length - 1)),
      rect: p.clientRect?.() ?? null, pick: b => p.command(b),
    })
    return {
      open: p => show(p, 0),
      update: p => show(p, slashRef.current?.index ?? 0),
      close: () => setSlash(null),
      keydown: ({ event }: SuggestionKeyDownProps) => {
        const m = slashRef.current
        if (!m) return false
        if (event.key === 'Escape') { setSlash(null); return true }
        if (!m.items.length) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1
          setSlash({ ...m, index: (m.index + step + m.items.length) % m.items.length })
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') { m.pick(m.items[m.index]); return true }
        return false
      },
    }
  }, [])

  const openAi = () => composer.current?.focus()

  const editor = useEditor({
    extensions: docExtensions({ slash: bridge, onAi: openAi }),
    content,
    editable: !readOnly,
    editorProps: {
      attributes: { class: 'doc-prose', 'aria-label': 'Document body' },
      handleKeyDown: (_view, e) => {
        // ⌘J, as in most editors with an assistant: ask about the selection
        // without taking a hand off the keyboard.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
          openAi()
          return true
        }
        return false
      },
    },
    // Only a change to the text. `setEditable` emits an update too, and
    // passing that on would save an identical revision around every AI call.
    onUpdate: ({ editor: e, transaction }) => {
      if (transaction.docChanged) onChangeRef.current(e.getJSON() as DocNode)
    },
  })

  useEffect(() => { if (editor) onReady?.(editor) }, [editor, onReady])

  const sel = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null
      const { from, to, empty } = e.state.selection
      const words = empty ? 0 : e.state.doc.textBetween(from, to, ' ').split(/\s+/).filter(Boolean).length
      return { empty, words }
    },
  })

  async function runAi(e?: FormEvent) {
    e?.preventDefault()
    const instruction = prompt.trim()
    if (!editor || !instruction || ai.phase === 'running') return
    const target = assistTarget(editor)
    const mine = ++ticket.current
    setAi({ phase: 'running', scope: target.scope })
    // Read-only while the model writes. The answer is built against the text
    // as it was sent; typing meanwhile would be overwritten or refused.
    editor.setEditable(false)
    try {
      const r = await assist({ instruction, markdown: target.markdown, selection: target.selection,
                               title: title || undefined })
      if (mine !== ticket.current) return
      editor.setEditable(true)
      const applied = applyAssist(editor, target, r.markdown)
      if (!applied) {
        setAi({ phase: 'error', message: 'The doc changed while AI was writing, so nothing was applied. Ask again.' })
        return
      }
      onAiEdit?.(`@ai (${r.model}): ${instruction}`)
      setPrompt('')
      setAi({ phase: 'done', model: r.model, applied })
    } catch (err) {
      if (mine !== ticket.current) return
      setAi({ phase: 'error', message: err instanceof GatewayError ? err.message
        : 'The gateway could not be reached, so AI is unavailable.' })
    } finally {
      if (mine === ticket.current) editor.setEditable(true)
    }
  }

  function stopAi() {
    ticket.current++
    editor?.setEditable(true)
    setAi({ phase: 'idle' })
  }

  if (!editor) return null

  const scopeHint = ai.phase === 'running'
    ? (ai.scope === 'selection' ? 'Rewriting the selection…' : 'Writing…')
    : sel && !sel.empty && sel.words > 0
      ? `Edits the ${sel.words} selected word${sel.words === 1 ? '' : 's'}`
      : 'Writes at your cursor, or edits the whole doc'

  if (readOnly) {
    return <div className="doc-editor read-only"><EditorContent editor={editor} className="doc-surface" /></div>
  }

  return (
    <div className="doc-editor">
      <Toolbar editor={editor} onAskAi={openAi} />

      <TableMenu editor={editor} />
      <BubbleMenu editor={editor} className="doc-bubble"
        shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable
          && !e.isActive('codeBlock') && !e.isActive('image') && !e.isActive('embed')}>
        <MarkButtons editor={editor} />
        <span className="doc-sep" />
        <button type="button" className="doc-tb ai" onMouseDown={ev => ev.preventDefault()} onClick={openAi}>
          <Icon name="sparkle" /> Ask AI
        </button>
      </BubbleMenu>

      <EditorContent editor={editor} className="doc-surface" />

      {slash && <SlashMenuView menu={slash} onHover={i => setSlash({ ...slash, index: i })} />}

      <form className={`doc-ai${ai.phase === 'running' ? ' busy' : ''}`} onSubmit={runAi}>
        <div className="doc-ai-row">
          <span className="doc-ai-chip">@AI</span>
          <textarea ref={composer} rows={1} value={prompt} aria-label="Tell AI what to write or edit"
            placeholder="Tell AI what to write or edit"
            onChange={ev => setPrompt(ev.target.value)}
            onKeyDown={ev => {
              if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); runAi() }
              if (ev.key === 'Escape') { ev.preventDefault(); editor.commands.focus() }
            }} />
        </div>
        <div className="doc-ai-foot">
          <span className="doc-ai-hint">{scopeHint}</span>
          {ai.phase === 'running'
            ? <button type="button" className="doc-ai-send" onClick={stopAi} title="Stop"><Icon name="stop" /></button>
            : <button type="submit" className="doc-ai-send" disabled={!prompt.trim()} title="Send (Enter)"><Icon name="send" /></button>}
        </div>
        {ai.phase === 'error' && <div className="doc-ai-status err" role="alert">{ai.message}</div>}
        {ai.phase === 'done' && (
          <div className="doc-ai-status">
            {ai.applied === 'inserted' ? 'Inserted at your cursor' : 'Edited'} by <span className="mono">{ai.model}</span>
            {ai.applied === 'selection' ? ' — the selection.' : ai.applied === 'replaced' ? ' — the doc.' : '.'}
            <button type="button" className="doc-link" onClick={() => { editor.chain().focus().undo().run(); setAi({ phase: 'idle' }) }}>Undo</button>
          </div>
        )}
      </form>
    </div>
  )
}

function SlashMenuView({ menu, onHover }: { menu: SlashMenu; onHover: (i: number) => void }) {
  const r = menu.rect
  if (!r) return null
  // Below the caret unless that runs off the window, then above it.
  const below = r.bottom + 340 < window.innerHeight
  const style = below ? { top: r.bottom + 6, left: r.left } : { bottom: window.innerHeight - r.top + 6, left: r.left }
  return (
    <div className="doc-menu floating" style={style} role="listbox" aria-label="Insert block">
      {menu.items.length === 0 && <div className="doc-menu-empty">No block matches</div>}
      {menu.items.map((b, i) => (
        <button key={b.id} type="button" role="option" aria-selected={i === menu.index}
          className={`doc-menu-item${i === menu.index ? ' on' : ''}`}
          onMouseEnter={() => onHover(i)} onMouseDown={e => e.preventDefault()} onClick={() => menu.pick(b)}>
          <Icon name={b.icon} /> {b.label}
        </button>
      ))}
    </div>
  )
}

function TB({ icon, label, on, disabled, onClick, children }: {
  icon?: IconName; label: string; on?: boolean; disabled?: boolean; onClick: () => void; children?: ReactNode
}) {
  return (
    <button type="button" className={`doc-tb${on ? ' on' : ''}`} title={label} aria-label={label}
      aria-pressed={on} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      {icon && <Icon name={icon} />}{children}
    </button>
  )
}

function MarkButtons({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'),
      strike: e.isActive('strike'), code: e.isActive('code'),
    }),
  })
  return (
    <>
      <TB icon="bold" label="Bold (⌘B)" on={s.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
      <TB icon="italic" label="Italic (⌘I)" on={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <TB icon="underline" label="Underline (⌘U)" on={s.underline} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <TB icon="strike" label="Strikethrough" on={s.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <TB icon="inlineCode" label="Inline code" on={s.code} onClick={() => editor.chain().focus().toggleCode().run()} />
    </>
  )
}

const STYLES = [
  { label: 'Text', active: (e: Editor) => e.isActive('paragraph'), run: (e: Editor) => e.chain().focus().setParagraph().run() },
  ...([1, 2, 3] as const).map(level => ({
    label: `Heading ${level}`,
    active: (e: Editor) => e.isActive('heading', { level }),
    run: (e: Editor) => e.chain().focus().toggleHeading({ level }).run(),
  })),
]

type Pop = null | 'style' | 'insert' | 'link' | 'image'

function Toolbar({ editor, onAskAi }: { editor: Editor; onAskAi: () => void }) {
  const [pop, setPop] = useState<Pop>(null)
  const [url, setUrl] = useState('')
  const [bad, setBad] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: STYLES.find(x => x.active(e))?.label ?? 'Text',
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      link: e.isActive('link'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  })

  useEffect(() => {
    if (!pop) return
    const close = (ev: MouseEvent) => { if (!bar.current?.contains(ev.target as Node)) setPop(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [pop])

  function openUrl(kind: 'link' | 'image') {
    setBad(false)
    setUrl(kind === 'link' ? String(editor.getAttributes('link').href ?? '') : '')
    setPop(pop === kind ? null : kind)
  }

  function applyUrl(e: FormEvent) {
    e.preventDefault()
    const kind = pop as 'link' | 'image'
    if (kind === 'link' && !url.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setPop(null)
      return
    }
    const href = normalizeUrl(url, kind)
    if (!href) { setBad(true); return }
    if (kind === 'link') editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    else editor.chain().focus().setImage({ src: href }).run()
    setPop(null)
  }

  return (
    <div className="doc-toolbar" ref={bar} role="toolbar" aria-label="Formatting">
      <TB icon="undo" label="Undo (⌘Z)" disabled={!s.undo} onClick={() => editor.chain().focus().undo().run()} />
      <TB icon="redo" label="Redo (⇧⌘Z)" disabled={!s.redo} onClick={() => editor.chain().focus().redo().run()} />
      <span className="doc-sep" />

      <div className="doc-pop-anchor">
        <TB label="Text style" on={pop === 'style'} onClick={() => setPop(pop === 'style' ? null : 'style')}>
          <span className="doc-style-label">{s.style}</span><Icon name="chevron" size={12} />
        </TB>
        {pop === 'style' && (
          <div className="doc-menu" role="menu">
            {STYLES.map(x => (
              <button key={x.label} type="button" role="menuitem" className={`doc-menu-item${s.style === x.label ? ' on' : ''}`}
                onMouseDown={e => e.preventDefault()} onClick={() => { x.run(editor); setPop(null) }}>
                {x.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="doc-sep" />

      <MarkButtons editor={editor} />
      <TB icon="link" label="Link" on={s.link || pop === 'link'} onClick={() => openUrl('link')} />
      <span className="doc-sep" />

      <TB icon="list" label="Bulleted list" on={s.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <TB icon="numbered" label="Numbered list" on={s.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <TB icon="checklist" label="Checklist" on={s.task} onClick={() => editor.chain().focus().toggleTaskList().run()} />
      <span className="doc-sep" />

      <TB icon="table" label="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      <TB icon="image" label="Insert image" on={pop === 'image'} onClick={() => openUrl('image')} />
      <div className="doc-pop-anchor">
        <TB icon="plus" label="Insert block" on={pop === 'insert'} onClick={() => setPop(pop === 'insert' ? null : 'insert')}>
          <Icon name="chevron" size={12} />
        </TB>
        {pop === 'insert' && (
          <div className="doc-menu" role="menu">
            {BLOCKS.map(b => (
              <button key={b.id} type="button" role="menuitem" className="doc-menu-item"
                onMouseDown={e => e.preventDefault()} onClick={() => { b.run(editor); setPop(null) }}>
                <Icon name={b.icon} /> {b.label}
              </button>
            ))}
            <div className="doc-menu-foot">Type / in the document for more</div>
          </div>
        )}
      </div>

      <span className="doc-spacer" />
      <button type="button" className="doc-tb ai" title="Ask AI (⌘J)" onMouseDown={e => e.preventDefault()} onClick={onAskAi}>
        <Icon name="sparkle" /> Ask AI
      </button>

      {(pop === 'link' || pop === 'image') && (
        <form className="doc-url" onSubmit={applyUrl}>
          <input autoFocus value={url} placeholder={pop === 'link' ? 'Paste a link — empty removes it' : 'Image URL (https://…)'}
            aria-label={pop === 'link' ? 'Link URL' : 'Image URL'} aria-invalid={bad}
            onChange={e => { setUrl(e.target.value); setBad(false) }}
            onKeyDown={e => { if (e.key === 'Escape') { setPop(null); editor.commands.focus() } }} />
          <button type="submit" className="btn">{pop === 'link' ? 'Apply' : 'Insert'}</button>
          {bad && <span className="doc-url-err">Only http(s){pop === 'link' ? ' and mailto' : ''} links</span>}
        </form>
      )}
    </div>
  )
}
