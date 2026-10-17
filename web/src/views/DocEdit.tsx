import { ShareButton } from '../components/ShareButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CommentsButton } from '../components/discussion/Thread'
import { TasksButton } from '../components/TaskLinks'
import { ProjectsButton } from '../components/ProjectChips'
import { Link, useLocation } from 'react-router-dom'
import type { Editor } from '@tiptap/react'
import { docHistory, docSharing, EMPTY_DOC, exportDoc, getLiveDoc, GatewayError, reviseDoc, takeDoc,
         createArtifact, saveArtifact, shareDoc, unshareDoc, type DocNode, type DocRevision, type ShareLink,
         type WireDoc } from '../data/gateway'
import { forgetLiveDocs } from '../data/api'
import { DocEditor } from '../components/doc/DocEditor'
import { DocPageBody, PageExpanded, pageRef, useDocPage } from '../components/doc/DocAsPage'
import { ArtifactEditor } from '../components/doc/EmbedBlock'
import { PAGE_STARTER } from '../data/starters'
import { Icon } from '../components/doc/Icons'

/** How long typing has to pause before it is saved. Every save is a full
 *  snapshot in the history, so this is also how fine-grained the history is. */
const SAVE_AFTER_MS = 1200

type Save = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

/** A doc written here: the editor, the title above it, and a save loop that
 *  never runs two writes at once and never overwrites somebody else's. */
export function DocEdit({ id }: { id: string }) {
  const [doc, setDoc] = useState<WireDoc | null | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const [title, setTitle] = useState('')
  const [save, setSave] = useState<Save>('saved')
  const [saveError, setSaveError] = useState('')
  const [rev, setRev] = useState(1)
  const [historyOpen, setHistoryOpen] = useState(false)
  const editorRef = useRef<Editor | null>(null)
  // A doc that is one whole HTML page opens as that page, and nothing of the
  // doc is drawn first; Edit builds the editor from the body as it now is.
  const [pageBody, setPageBody] = useState<DocNode | null>(null)
  const { page, pending } = useDocPage(pageBody)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // A new page (Docs → New page) lands in its editor, ready to write or ask AI.
  const location = useLocation()
  const [pageEditing, setPageEditing] = useState<boolean>(!!(location.state as { editPage?: boolean } | null)?.editPage)
  const [pageSaving, setPageSaving] = useState(false)
  const [pageError, setPageError] = useState('')
  const [making, setMaking] = useState<'ask' | 'busy' | null>(null)

  // The save loop's state lives in refs: it is read by a timer and by the
  // previous save's completion, neither of which sees a fresh render.
  const s = useRef({ rev: 1, body: null as DocNode | null, title: '', notes: [] as string[],
                     timer: 0, inflight: false, again: false, dirty: false })

  useEffect(() => {
    let live = true
    setDoc(undefined)
    takeDoc(id).then(r => {
      if (!live) return
      // A doc filed before the editor existed has no body; it starts empty
      // and gets one on its first save.
      const d = { ...r.doc, body: r.doc.body ?? EMPTY_DOC }
      s.current.rev = d.current_rev ?? 1
      s.current.body = d.body
      s.current.title = d.title
      setRev(s.current.rev)
      setTitle(d.title === 'Untitled' ? '' : d.title)
      setPageBody(d.body)
      setDoc(d)
    }).catch(e => {
      if (!live) return
      setLoadError(e instanceof GatewayError ? e.message : 'The gateway could not be reached.')
      setDoc(null)
    })
    return () => { live = false }
  }, [id])

  const flush = useCallback(async () => {
    const st = s.current
    window.clearTimeout(st.timer)
    if (!st.dirty) return
    if (st.inflight) { st.again = true; return }
    st.inflight = true
    st.dirty = false
    const notes = st.notes.splice(0)
    setSave('saving')
    try {
      const r = await reviseDoc({ doc_id: id, if_rev: st.rev, body: st.body ?? undefined,
                                  title: st.title.trim() || 'Untitled',
                                  note: notes.join('; ') || undefined })
      st.rev = r.rev
      setRev(r.rev)
      setSave(st.dirty ? 'dirty' : 'saved')
      forgetLiveDocs()
    } catch (e) {
      // Put back what did not land, so a retry still carries it.
      st.dirty = true
      st.notes.unshift(...notes)
      if (e instanceof GatewayError && e.code === 'stale_revision') {
        setSave('conflict')
      } else {
        setSave('error')
        setSaveError(e instanceof GatewayError ? e.message : 'The gateway could not be reached.')
      }
      st.inflight = false
      return
    }
    st.inflight = false
    if (st.again) { st.again = false; flush() }
  }, [id])

  const touch = useCallback(() => {
    const st = s.current
    st.dirty = true
    setSave(v => v === 'conflict' ? v : 'dirty')
    window.clearTimeout(st.timer)
    st.timer = window.setTimeout(flush, SAVE_AFTER_MS)
  }, [flush])

  // Leaving the page saves what is pending, and closing the tab with an
  // unsaved edit asks first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (s.current.dirty) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); flush() }
  }, [flush])

  const onBody = useCallback((body: DocNode) => { s.current.body = body; touch() }, [touch])
  const onAiEdit = useCallback((note: string) => { s.current.notes.push(note) }, [])
  const onReady = useCallback((e: Editor) => { editorRef.current = e }, [])

  function restore(r: DocRevision) {
    const e = editorRef.current
    if (!e || !r.body) return
    // An ordinary edit: it goes through the editor, so ⌘Z undoes it, and it
    // saves as a new revision, so going back is itself on the record.
    e.chain().focus().insertContentAt({ from: 0, to: e.state.doc.content.size }, r.body.content ?? []).run()
    s.current.notes.push(`restore rev ${r.rev}`)
    setHistoryOpen(false)
  }

  if (doc === undefined) return <div className="detail"><div className="empty">Loading…</div></div>
  if (doc === null) {
    return (
      <div className="detail">
        <div className="empty">
          This doc could not be opened — {loadError} <Link to="/docs">Back to docs.</Link>
        </div>
      </div>
    )
  }

  /** Turn this doc into a full page: a page artifact from the page template,
   *  the doc's body only that, and into the page's editor. What the doc held
   *  is a revision like any other, so History can bring it back. */
  async function makePage() {
    setMaking('busy')
    try {
      // The page starts as THIS doc, rendered — not a stock template. Starting
      // from PAGE_STARTER replaced "Support macros" with a stranger's landing
      // page, which is not turning the doc into anything. Empty, there is
      // nothing to carry, so the starter is still the place to begin.
      const e = editorRef.current
      const empty = e ? e.isEmpty : !(s.current.body?.content ?? []).length
      let html = PAGE_STARTER
      if (!empty) {
        await flush()
        html = (await exportDoc(id, { for_page: true })).html
      }
      const art = await createArtifact(s.current.title.trim() || 'New page', html)
      const body: DocNode = { type: 'doc', content: [{ type: 'embed', attrs: { ref: art.id } }] }
      s.current.body = body
      s.current.notes.push('made a full page')
      touch()
      void flush()
      setPageBody(body)
      setEditing(false)
      setPageEditing(true)
      setMaking(null)
    } catch (e) {
      setMaking(null)
      setSaveError(e instanceof GatewayError ? e.message : 'The gateway could not be reached, so the page was not made.')
      setSave('error')
    }
  }

  /** Empty, it simply becomes a page; with something in it, ask first. */
  function askMakePage() {
    const e = editorRef.current
    const empty = e ? e.isEmpty : !(s.current.body?.content ?? []).some(n => (n.content ?? []).length || n.type !== 'paragraph')
    if (empty) void makePage(); else setMaking('ask')
  }

  function viewAsPage() {
    void flush()
    // A new object, so the page is fetched again: its HTML may have been
    // edited from the embed without the doc's body changing.
    setPageBody(s.current.body ? { ...s.current.body } : null)
    setEditing(false)
  }

  async function savePage(v: { title: string; html: string; height: number }) {
    if (!page) return
    setPageSaving(true); setPageError('')
    try {
      await saveArtifact(page.id, { title: v.title, html: v.html })
      // The doc is the page, so it is listed under the page's name.
      if (v.title && v.title !== s.current.title) { s.current.title = v.title; setTitle(v.title); touch() }
      setPageEditing(false)
      setPageBody(s.current.body ? { ...s.current.body } : null)   // fetched again: shows what was saved
    } catch (e) {
      setPageError(e instanceof GatewayError ? e.message : 'The gateway could not be reached, so the page was not saved.')
    } finally {
      setPageSaving(false)
    }
  }

  if (!editing && page && pageEditing) {
    // Editing a page is editing its HTML — there is nothing else in the doc.
    return (
      <div className="doc-page is-page">
        <div className="doc-head">
          <div className="crumb"><Link to="/docs">← Docs</Link><span className="doc-page-key"> / <span className="mono">{doc.key}</span></span>
            <span className="doc-page-name">Editing {page.title}</span></div>
          <div className="doc-head-right">
            <button type="button" className="btn ghost" onClick={() => { setPageEditing(false); setEditing(true) }}>Edit as doc</button>
          </div>
        </div>
        {pageError && <p className="share-err" role="alert">{pageError}</p>}
        <div className="doc-page-editor">
          <ArtifactEditor initial={{ title: page.title, html: page.html ?? '', height: page.height ?? 420 }}
            busy={pageSaving} saveLabel="Save page" onSave={v => void savePage(v)} onCancel={() => setPageEditing(false)} />
        </div>
      </div>
    )
  }

  if (!editing && (pending || page)) {
    // The doc is a page: the page fills the doc, under the doc's own header.
    return (
      <div className="doc-page is-page">
        <div className="doc-head">
          <div className="crumb"><Link to="/docs">← Docs</Link><span className="doc-page-key"> / <span className="mono">{doc.key}</span></span>
            <span className="doc-page-name">{page?.title ?? doc.title}</span></div>
          <div className="doc-head-right">
            <ShareButton id={id} title={doc.title || 'Untitled'} />
            <CommentsButton subjectId={id} title={doc.title || 'Untitled'} />
            <button type="button" className="btn keep" disabled={!page} onClick={() => setExpanded(true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="ico-expand">
                <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg> Expand
            </button>
            <button type="button" className="btn keep" disabled={!page} onClick={() => setPageEditing(true)}>Edit</button>
          </div>
        </div>
        <DocPageBody page={page} />
        {expanded && page && <PageExpanded page={page} onClose={() => setExpanded(false)} />}
      </div>
    )
  }

  return (
    <div className="doc-page">
      <div className="doc-head">
        <div className="crumb"><Link to="/docs">← Docs</Link> / <span className="mono">{doc.key}</span></div>
        <div className="doc-head-right">
          {editing && pageRef(s.current.body) && (
            <button type="button" className="btn" onClick={viewAsPage}>View as page</button>
          )}
          <SaveState state={save} rev={rev} error={saveError} onRetry={flush} />
          <ProjectsButton about={{ id, type: 'doc' }} />
          <TasksButton about={{ id, type: 'doc', title: doc.title || 'Untitled' }} />
          <DownloadHtml docId={id} beforeExport={flush} />
          {!pageRef(s.current.body) && (
            <span className="make-page">
              <button type="button" className="btn" disabled={making === 'busy'} onClick={askMakePage}
                title="Turn this doc into a complete web page — landing page, dashboard, report">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="ico-expand">
                  <rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 5.5h12" /></svg>
                {making === 'busy' ? 'Making page…' : 'Make full page'}
              </button>
              {making === 'ask' && (
                <span className="make-page-ask" role="dialog" aria-label="Make full page">
                  <span>Turn this doc into a full page? Its content becomes an editable web page; this version stays in History.</span>
                  <span className="make-page-act">
                    <button type="button" className="btn ghost" onClick={() => setMaking(null)}>Cancel</button>
                    <button type="button" className="btn primary" onClick={() => void makePage()}>Make full page</button>
                  </span>
                </span>
              )}
            </span>
          )}
          <Publish docId={id} />
          <ShareButton id={id} title={doc.title || 'Untitled'} />
          <CommentsButton subjectId={id} title={doc.title || 'Untitled'} />
          <button type="button" className={`btn ghost${historyOpen ? ' on' : ''}`} onClick={() => setHistoryOpen(o => !o)}>
            <Icon name="history" size={14} /> History
          </button>
        </div>
      </div>

      <div className="doc-body">
        <div className="doc-column">
          <textarea className="doc-title" rows={1} value={title} placeholder="Untitled" aria-label="Title"
            onChange={e => { setTitle(e.target.value); s.current.title = e.target.value; touch() }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); editorRef.current?.commands.focus('start') }
            }} />
          <DocEditor content={s.current.body ?? doc.body} title={title} onChange={onBody} onAiEdit={onAiEdit} onReady={onReady} />
        </div>
        {historyOpen && <History docId={id} rev={rev} onRestore={restore} onClose={() => setHistoryOpen(false)} />}
      </div>
    </div>
  )
}

function SaveState({ state, rev, error, onRetry }: { state: Save; rev: number; error: string; onRetry: () => void }) {
  if (state === 'conflict') {
    return (
      <span className="doc-save warn" role="status">
        Changed elsewhere since you opened it — your edits are not saved.{' '}
        <button type="button" className="doc-link" onClick={() => window.location.reload()}>Reload</button>
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="doc-save warn" role="status" title={error}>
        Not saved. <button type="button" className="doc-link" onClick={onRetry}>Retry</button>
      </span>
    )
  }
  const text = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Editing…' : `Saved · rev ${rev}`
  return <span className="doc-save" role="status">{text}</span>
}

function History({ docId, rev, onRestore, onClose }: {
  docId: string; rev: number; onRestore: (r: DocRevision) => void; onClose: () => void
}) {
  const [rows, setRows] = useState<DocRevision[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    docHistory(docId).then(r => setRows(r.revisions))
      .catch(e => setError(e instanceof GatewayError ? e.message : 'The gateway could not be reached.'))
  }, [docId, rev])

  return (
    <aside className="doc-history" aria-label="History">
      <div className="doc-history-head">
        <span className="eyebrow">History</span>
        <button type="button" className="btn ghost" onClick={onClose} aria-label="Close history"><Icon name="close" size={14} /></button>
      </div>
      {error && <div className="doc-history-empty">{error}</div>}
      {!error && rows === null && <div className="doc-history-empty">Loading…</div>}
      {rows?.length === 0 && <div className="doc-history-empty">No edits yet. Each save lands here.</div>}
      {rows?.map(r => (
        <div key={r.rev} className="doc-rev">
          <div className="doc-rev-top">
            <span className="mono">rev {r.rev}</span>
            <span className="doc-rev-by">{r.by} · {new Date(r.at).toLocaleString()}</span>
          </div>
          {r.note && <div className={`doc-rev-note${r.note.startsWith('@ai') ? ' ai' : ''}`}>{r.note}</div>}
          {r.rev === rev
            ? <span className="doc-rev-current">current</span>
            : <button type="button" className="doc-link" onClick={() => onRestore(r)}>Restore this version</button>}
        </div>
      ))}
    </aside>
  )
}

const message = (e: unknown) => e instanceof GatewayError ? e.message : 'The gateway could not be reached.'

/** Save first, then fetch the page: the file should be what is on screen, not
 *  the last autosave from a second ago. */
function DownloadHtml({ docId, beforeExport }: { docId: string; beforeExport: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function download() {
    setBusy(true)
    setError('')
    try {
      await beforeExport()
      const r = await exportDoc(docId)
      const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }))
      const a = document.createElement('a')
      a.href = url
      a.download = r.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="btn ghost" onClick={download} disabled={busy}
      title={error || 'Download as a self-contained HTML page'}>
      {busy ? 'Exporting…' : error ? 'Export failed' : 'Download HTML'}
    </button>
  )
}

/** Publish to the web, like an artifact link: one public link, always showing
 *  the latest version, that anyone can open without an account and that can
 *  be turned off. Beside Share, which gives named people access inside the
 *  workspace — the two answer different questions, so they are two buttons.
 *  Only owners may publish; everyone who can see the doc sees that it is. */
export function Publish({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState<ShareLink | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    docSharing(docId).then(r => setLink(r.link)).catch(() => setLink(null))
  }, [docId])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  async function act(f: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await f() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy — select the link and copy it by hand.')
    }
  }

  return (
    <div className="doc-share" ref={box}>
      <button type="button" className={`btn${link ? ' action' : ''}`} onClick={() => setOpen(o => !o)}
        aria-expanded={open}>
        {link ? 'Published' : 'Publish'}
      </button>
      {open && (
        <div className="doc-share-pop" role="dialog" aria-label="Publish">
          <div className="doc-share-title">{link ? 'Published — anyone with the link can view' : 'Publish to the web'}</div>
          <p className="doc-share-sub">
            {link
              ? 'They see the latest version, read-only, without signing in. Turn the link off to stop it working.'
              : 'Creates a public, read-only link to the latest version. No account is needed to open it.'}
          </p>
          {link ? (
            <>
              <div className="doc-share-row">
                <input readOnly value={link.url} aria-label="Share link" onFocus={e => e.currentTarget.select()} />
                <button type="button" className="btn" onClick={() => copy(link.url)}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="doc-share-row">
                <a className="doc-link" href={link.url} target="_blank" rel="noreferrer">Open the shared page ↗</a>
                <button type="button" className="btn ghost danger" disabled={busy}
                  onClick={() => act(async () => { await unshareDoc(docId); setLink(null) })}>
                  Turn off link
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn primary" disabled={busy || link === undefined}
              onClick={() => act(async () => {
                const r = await shareDoc(docId)
                setLink(r.link)
                await copy(r.link.url)
              })}>
              {busy ? 'Creating…' : 'Create link and copy'}
            </button>
          )}
          {error && <div className="doc-share-err" role="alert">{error}</div>}
        </div>
      )}
    </div>
  )
}
