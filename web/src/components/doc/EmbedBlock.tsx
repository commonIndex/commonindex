import { useEffect, useState } from 'react'
import { createAtomBlockMarkdownSpec, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { Link } from 'react-router-dom'
import { createArtifact, draftArtifact, GatewayError, getArtifact, saveArtifact,
         type ArtifactKind, type WireArtifact } from '../../data/gateway'
import { HtmlFrame, HtmlFullscreen, HtmlPage, isPage } from '../HtmlFrame'
import { ARTIFACT_STARTER, PAGE_STARTER } from '../../data/starters'

export { ARTIFACT_STARTER, PAGE_STARTER }



const DEFAULT_HEIGHT = 420
/** Waits before each retry of a load that got no answer, in ms. */
const RETRIES = [800, 2000, 4000]
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Writing an artifact: its HTML, a live preview of exactly that HTML, and
 *  the workspace's model to write or change it. Used inside a doc and on the
 *  artifact's own page; it saves nothing itself. */
export function ArtifactEditor({ initial, busy, onSave, onCancel, saveLabel = 'Save', chooseKind = false }: {
  initial: { title: string; html: string; height: number }
  busy?: boolean
  onSave: (v: { title: string; html: string; height: number }) => void
  onCancel?: () => void
  saveLabel?: string
  /** Offer "Block in this doc" or "Full page" — for a new artifact. */
  chooseKind?: boolean
}) {
  const [title, setTitle] = useState(initial.title)
  const [html, setHtml] = useState(initial.html)
  // A page is a whole HTML document; the HTML says which this is, so a pasted
  // page is a page however it got here.
  const kind: ArtifactKind = isPage(html) ? 'page' : 'block'
  function choose(k: ArtifactKind) {
    if (k === kind) return
    // Swap the starter for the other one; anything written by hand is kept.
    const untouched = !html.trim() || html === ARTIFACT_STARTER || html === PAGE_STARTER
    if (untouched) { const next = k === 'page' ? PAGE_STARTER : ARTIFACT_STARTER; setHtml(next); setShown(next) }
    else setAi({ phase: 'error', message: k === 'page'
      ? 'This HTML is a block. Start it with <!doctype html> to make it a page, or clear it to start from the page template.'
      : 'This HTML is a whole page. Clear it to start from the block template.' })
  }
  const [height, setHeight] = useState(initial.height)
  // The preview follows the source a moment behind, so a half-typed tag does
  // not restart a script on every keystroke.
  const [shown, setShown] = useState(initial.html)
  useEffect(() => { const t = setTimeout(() => setShown(html), 400); return () => clearTimeout(t) }, [html])
  const [ask, setAsk] = useState('')
  const [ai, setAi] = useState<{ phase: 'idle' | 'running' } | { phase: 'error'; message: string }>({ phase: 'idle' })

  async function draft() {
    if (!ask.trim()) return
    setAi({ phase: 'running' })
    try {
      const untouched = html === ARTIFACT_STARTER || html === PAGE_STARTER
      const r = await draftArtifact(ask.trim(), html.trim() && !untouched ? html : undefined, kind)
      setHtml(r.html); setShown(r.html); setAsk(''); setAi({ phase: 'idle' })
    } catch (e) {
      setAi({ phase: 'error', message: message(e) })
    }
  }

  return (
    <div className="art-editor">
      {chooseKind && (
        <div className="art-kind" role="radiogroup" aria-label="What to make">
          <button type="button" role="radio" aria-checked={kind === 'block'} className={kind === 'block' ? 'on' : ''}
            onClick={() => choose('block')}><b>Block in this doc</b><span>A chart, table or widget among the doc’s text</span></button>
          <button type="button" role="radio" aria-checked={kind === 'page'} className={kind === 'page' ? 'on' : ''}
            onClick={() => choose('page')}><b>Full page</b><span>A complete web page — landing page, dashboard, report</span></button>
        </div>
      )}
      <div className="art-editor-row">
        <label className="art-field grow">Title
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What it shows" />
        </label>
{kind === 'block' && (
                <label className="art-field" title="It grows to fit its content, up to this">Max height
          <input type="number" min={120} max={1600} step={20} value={height}
            onChange={e => setHeight(Number(e.target.value) || DEFAULT_HEIGHT)} />
        </label>)}
      </div>
      <form className="art-ask" onSubmit={e => { e.preventDefault(); void draft() }}>
        <input value={ask} onChange={e => setAsk(e.target.value)} aria-label="Ask AI"
          placeholder={kind === 'page'
            ? 'Describe the page — “a landing page for Refund Desk with pricing”'
            : html.trim() && html !== ARTIFACT_STARTER ? 'Ask AI to change it — “make the bars blue”' : 'Describe it — “a bar chart of refunds by week”'} />
        <button type="submit" className="btn" disabled={ai.phase === 'running' || !ask.trim()}>
          {ai.phase === 'running' ? 'Writing…' : 'Ask AI'}
        </button>
      </form>
      {ai.phase === 'error' && <p className="art-error" role="alert">{ai.message}</p>}
      <div className="art-split">
        <label className="art-field art-source">HTML
          <textarea value={html} onChange={e => setHtml(e.target.value)} spellCheck={false} />
        </label>
        <div className="art-preview">
          <span className="eyebrow">Preview</span>
          {isPage(shown)
            ? <HtmlPage html={shown} title="Artifact preview" />
            : <HtmlFrame html={shown} height={Math.min(height, 520)} title="Artifact preview" fit />}
        </div>
      </div>
      <p className="art-hint">Runs in a sandbox with no network: inline style, script, SVG and data: images only.</p>
      <div className="art-actions">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn primary" disabled={busy || !html.trim() || !title.trim()}
          onClick={() => onSave({ title: title.trim(), html, height: Math.max(120, Math.min(1600, height)) })}>
          {busy ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  )
}

/** The artifact id in a pasted link or id, or null. */
export function existingId(raw: unknown): string | null {
  return String(raw ?? '').match(/\bartifact-[a-z0-9]+\b/i)?.[0] ?? null
}

type Loaded = { phase: 'loading' } | { phase: 'none' } | { phase: 'error'; message: string }
  | { phase: 'ready'; artifact: WireArtifact }

function EmbedView({ node, editor, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const ref: string | null = node.attrs.ref || null
  const editable = editor.isEditable
  const [state, setState] = useState<Loaded>({ phase: 'loading' })
  const [editing, setEditing] = useState(false)
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!ref) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ phase: 'loading' })
    const load = (tries: number) => getArtifact(ref)
      .then(r => { if (alive) setState({ phase: 'ready', artifact: r.artifact }) })
      .catch(e => {
        if (!alive) return
        // Not seeing it reads as not existing: the gateway says the same for both.
        if (e instanceof GatewayError) {
          setState(/unknown|not_found|http_404/.test(e.code) ? { phase: 'none' } : { phase: 'error', message: e.message })
          return
        }
        // No answer at all — the gateway restarting, a dropped connection:
        // try again a few times before saying anything.
        if (tries < RETRIES.length) timer = setTimeout(() => load(tries + 1), RETRIES[tries])
        else setState({ phase: 'error', message: 'Couldn’t reach the server.' })
      })
    void load(0)
    return () => { alive = false; clearTimeout(timer) }
  }, [ref, attempt])

  async function create(v: { title: string; html: string; height: number }) {
    setBusy(true); setError(null)
    try {
      const { id } = await createArtifact(v.title, v.html)
      if (v.height !== DEFAULT_HEIGHT) await saveArtifact(id, { height: v.height })
      updateAttributes({ ref: id })
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  async function save(artifact: WireArtifact, v: { title: string; html: string; height: number }) {
    setBusy(true); setError(null)
    try {
      await saveArtifact(artifact.id, v)
      setState({ phase: 'ready', artifact: { ...artifact, ...v } })
      setEditing(false)
    } catch (e) {
      setError(e instanceof GatewayError && e.code === 'not_allowed'
        ? 'You can view this artifact but not edit it — ask its owner to share it with you to edit.'
        : message(e))
    } finally {
      setBusy(false)
    }
  }

  let inner
  if (!ref) {
    inner = editable ? (
      <>
        <div className="doc-embed-bar"><span className="eyebrow">New artifact</span>
          <span className="grow" />
          <form className="doc-embed-existing" onSubmit={e => {
            e.preventDefault()
            const id = existingId(new FormData(e.currentTarget).get('existing'))
            if (id) updateAttributes({ ref: id }); else setError('Paste an artifact’s link or its id (artifact-…).')
          }}>
            <input name="existing" aria-label="Embed an existing one" placeholder="Embed an existing one — paste its link" />
            <button type="submit" className="btn">Embed</button>
          </form>
        </div>
        <ArtifactEditor initial={{ title: '', html: ARTIFACT_STARTER, height: DEFAULT_HEIGHT }} busy={busy} chooseKind
          saveLabel="Create artifact" onSave={v => void create(v)} onCancel={() => deleteNode()} />
      </>
    ) : null
  } else if (state.phase === 'loading') {
    inner = <div className="doc-embed-empty">Loading artifact…</div>
  } else if (state.phase === 'none') {
    inner = (
      <div className="doc-embed-empty">
        An embedded artifact that isn’t shared with you, or no longer exists.
        {editable && <button type="button" className="doc-link" onClick={() => deleteNode()}>Remove</button>}
      </div>
    )
  } else if (state.phase === 'error') {
    inner = (
      <div className="doc-embed-empty" role="alert">
        Couldn’t load the artifact. {state.message}
        <button type="button" className="doc-link" onClick={() => setAttempt(n => n + 1)}>Retry</button>
      </div>
    )
  } else {
    const a = state.artifact
    const height = a.height ?? DEFAULT_HEIGHT
    inner = editing ? (
      <>
        <div className="doc-embed-bar"><span className="eyebrow">Editing artifact</span>
          <span className="doc-embed-note">Changes show everywhere it is embedded</span></div>
        <ArtifactEditor initial={{ title: a.title, html: a.html ?? '', height }} busy={busy}
          onSave={v => void save(a, v)} onCancel={() => { setEditing(false); setError(null) }} />
      </>
    ) : (
      <>
        {isPage(a.html ?? '')
          ? <HtmlPage html={a.html ?? ''} title={a.title} />
          : <HtmlFrame html={a.html ?? ''} height={height} title={a.title} fit />}
        {/* A caption, not a header: the artifact speaks first. Always there —
            hover can't be relied on over a sandboxed frame, nor on a phone. */}
        <div className="doc-embed-foot">
          <span className="doc-embed-title" title={a.title}>{a.title}</span>
          <button type="button" onClick={() => setFull(true)}>Full screen</button>
          {editable && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
          <Link to={`/artifacts/${a.id}`}>Open</Link>
        </div>
        {full && <HtmlFullscreen html={a.html ?? ''} title={a.title} onClose={() => setFull(false)} />}
      </>
    )
  }

  return (
    <NodeViewWrapper className={`doc-embed${selected ? ' is-selected' : ''}${state.phase === 'ready' && !editing && ref ? ' is-live' : ''}`} contentEditable={false} data-drag-handle>
      {inner}
      {error && <p className="art-error" role="alert">{error}</p>}
    </NodeViewWrapper>
  )
}

const ATOM = createAtomBlockMarkdownSpec({ nodeName: 'embed', requiredAttributes: ['ref'], allowedAttributes: ['ref'] })

/** `:::embed {ref="artifact-…"} :::` both ways — and read without the closing
 *  `:::` too, because that is how a model writes it back half the time, and a
 *  line read as text is an embed silently deleted. */
const EMBED_MARKDOWN: typeof ATOM = {
  ...ATOM,
  markdownTokenizer: {
    ...ATOM.markdownTokenizer,
    tokenize(src) {
      const m = /^:::embed\s*\{[^}\n]*\bref="([^"\n]+)"[^}\n]*\}(?:[ \t]*:::)?[ \t]*(?:\n|$)/.exec(src)
      return m ? { type: 'embed', raw: m[0], attributes: { ref: m[1] } } : undefined
    },
  },
}

/** An embedded artifact. The doc holds its id and nothing else — never HTML —
 *  so the type's allow-list stays a block tree, sharing the doc never shares
 *  the artifact, and one artifact can sit in many docs. In markdown, which is
 *  what the AI reads and writes, it is the line `:::embed {ref="artifact-…"} :::`. */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { ref: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'div[data-embed]', getAttrs: el => ({ ref: (el as HTMLElement).getAttribute('data-embed') }) }]
  },
  renderHTML({ node }) {
    return ['div', { 'data-embed': node.attrs.ref ?? '' }]
  },
  ...EMBED_MARKDOWN,
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView, {
      // Typing in the artifact's own fields is not typing in the doc.
      stopEvent: ({ event }) => {
        const t = event.target as HTMLElement | null
        return !!t?.closest?.('input, textarea, button, select, iframe, form')
      },
    })
  },
})
