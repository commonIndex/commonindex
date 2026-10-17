import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { Markdown } from '../components/Markdown'
import {
  askCode, getCodeFile, indexCodeRepo, listCodeRepos,
  type CodeAnswer, type CodeContext, type CodeFile, type CodeIndexJob, type CodeRepo,
} from '../data/gateway'

/** ⌘ on a Mac, Ctrl elsewhere — the hint should name the key the reader has. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

/** Questions that work on any codebase, for a page that has not been asked anything yet. */
const EXAMPLES = [
  'Trace a request from its API route to the database',
  'Where are permissions checked, and what happens when one fails?',
  'Which parts of the code read configuration from the environment?',
]

type Excerpt = CodeContext['context'][number]
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Ask about code without naming a repository.
 *
 *  The page shows how the answer was reached, not only the answer. A reader
 *  cannot tell from prose whether it came from one repository or six, or
 *  whether the precise index was even available — and a confident paragraph
 *  built on a degraded search reads exactly like one built on a complete one.
 *
 *  The answer arrives as a markdown document and is rendered as one: a heading
 *  per section, the flow as a diagram, the sources as a list, the routing as a
 *  table. `Markdown source` shows the same bytes unrendered, because the
 *  document is the deliverable here — it is what the MCP path returns and what
 *  `Download .md` writes, and a reader who is about to paste it into a PR should
 *  be able to see exactly what they are pasting.
 *
 *  A citation opens the file it names, at the lines it names: an answer is
 *  only as good as a reader's ability to check it.
 */
export function CodeQueryView() {
  const [question, setQuestion] = useState('')
  const [diagram, setDiagram] = useState(true)
  const [answer, setAnswer] = useState<CodeAnswer | null>(null)
  const [answeredQuestion, setAnsweredQuestion] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const answerId = useId()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  // null until the list arrives, so "nothing is indexed" is never flashed at
  // someone whose repositories are simply still loading.
  const [repos, setRepos] = useState<CodeRepo[] | null>(null)
  const [jobs, setJobs] = useState<CodeIndexJob[]>([])
  const [mayIndex, setMayIndex] = useState(false)
  const [mayIndexPaths, setMayIndexPaths] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reading, setReading] = useState<Excerpt | null>(null)
  const body = useRef<HTMLDivElement>(null)

  // A link to one file — a search result — opens it here, at its lines.
  const [params, setParams] = useSearchParams()
  const linked = params.get('file')
  useEffect(() => {
    if (!linked) return
    const [from, to] = (params.get('lines') ?? '').split('-').map(n => Number(n) || null)
    setReading({ object_id: linked, path: params.get('path') ?? '', repo: params.get('repo') ?? '',
                 citation: '', snippet: '', start_line: from ?? null, end_line: to ?? from ?? null })
  }, [linked, params])
  // Closed, the link goes too — so following it again opens the file again.
  const closeFile = useCallback(() => {
    setReading(null)
    if (params.get('file')) setParams({}, { replace: true })
  }, [params, setParams])

  // What is searchable, shown before anyone asks — "no results" and "nothing
  // indexed" look identical in an answer, and only one of them is about the
  // question.
  const loadRepos = useCallback(() => listCodeRepos()
    .then(r => { setRepoError(null); setRepos(r.repos ?? []); setJobs(r.indexing ?? []); setMayIndex(!!r.may_index); setMayIndexPaths(!!r.may_index_paths) })
    .catch(e => setRepoError(message(e))), [])
  useEffect(() => { loadRepos() }, [loadRepos])
  // While something is indexing, check back until it is searchable or has failed.
  const indexing = jobs.some(j => j.state === 'indexing')
  useEffect(() => {
    if (!indexing) return
    const tick = setInterval(loadRepos, 2000)
    return () => clearInterval(tick)
  }, [indexing, loadRepos])

  async function ask(q = question) {
    if (!q.trim() || loading || repos?.length === 0) return
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      setAnswer(await askCode(q.trim(), diagram))
      setAnsweredQuestion(q.trim()); setRaw(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  const ctx = answer?.context
  // The unformatted `answer` is the fallback rather than the other way round: a
  // response with no document still has prose to show.
  const doc = answer?.markdown ?? answer?.answer ?? ''
  const excerpts = ctx?.context ?? []

  // Citations in the rendered answer are the excerpts' own strings; each one
  // that names a file the answer was built from becomes a way to open it.
  const cited = useCallback((text: string) => excerpts.find(x => x.object_id && x.citation === text.trim()),
    [excerpts])
  useLayoutEffect(() => {
    if (raw || !body.current) return
    for (const el of body.current.querySelectorAll('code')) {
      if (el.closest('pre') || !cited(el.textContent ?? '')) continue
      el.setAttribute('data-cite', '')
      el.setAttribute('role', 'button')
      el.setAttribute('tabindex', '0')
      el.setAttribute('title', 'Open the file at these lines')
    }
  }, [doc, raw, cited])
  const openCited = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest('code[data-cite]') : null
    const hit = el && cited(el.textContent ?? '')
    if (hit) setReading(hit)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(doc)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // A denied clipboard is not an error worth a banner — the source view is
      // right there to select from.
      setCopied(false)
    }
  }

  /** Named after the question, so a folder of these is readable. */
  function download() {
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/markdown' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${(answeredQuestion || 'code-query')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  const nothing = repos !== null && repos.length === 0
  return <div className="detail code-query">
    <div className="cq-col">
      <h1 className="page-title">Code query</h1>
      <p className="page-sub">Understand your codebase with answers, flow diagrams, and sources you can verify.</p>

      <Repos repos={repos} jobs={jobs} mayIndex={mayIndex} mayIndexPaths={mayIndexPaths} onStarted={loadRepos} />
      {repoError && <div className="dash-load-error" role="alert"><span>Could not load repositories. {repoError}</span>
        <button className="tool" onClick={loadRepos}>Retry</button></div>}
      {repos === null && !repoError && <p className="cq-repo-loading" role="status">Loading searchable repositories…</p>}

      <form className="cq-composer" onSubmit={event => { event.preventDefault(); ask() }}>
        <label className="cq-prompt-label" htmlFor={`${answerId}-question`}>What would you like to understand?</label>
        <textarea id={`${answerId}-question`} aria-label="Question" value={question} rows={3}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ask() }
          }}
          placeholder="Trace the order placement flow from the UI through to the database" />
        <div className="cq-bar">
          <label className="cq-toggle">
            <input type="checkbox" checked={diagram} onChange={event => setDiagram(event.target.checked)} />
            Include a flow diagram
          </label>
          <span className="cq-hint" aria-hidden="true"><kbd>{MOD}</kbd><kbd>↵</kbd></span>
          <button className="btn primary" disabled={loading || !question.trim() || nothing}>
            {loading ? 'Reading code…' : 'Ask'}
          </button>
        </div>
      </form>

      {!answer && !loading && !nothing && repos !== null && (
        <div className="cq-examples" aria-label="Questions to start with">
          <span>Explore your codebase</span>
          {EXAMPLES.map(q => (
            <button key={q} type="button" className="chip" onClick={() => { setQuestion(q); ask(q) }}>{q}</button>
          ))}
        </div>
      )}

      {error && <div className="notice cq-error" role="alert">{error}</div>}

      {loading && <div className="cq-pending" role="status">
        Searching {repos?.length ? `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}` : 'your repositories'}
        {' '}and reading what matched…
      </div>}

      {answer && !loading && <section className="code-answer" aria-label="Answer">
        <div className="cq-question"><span>Answer to</span><p>{answeredQuestion}</p></div>
        <div className="cq-answer-bar">
          <div className="seg" role="tablist" aria-label="Answer format" onKeyDown={e => {
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : ['ArrowLeft', 'ArrowRight'].includes(e.key) ? Number(!raw) : null
            if (next === null) return
            e.preventDefault(); setRaw(!!next); tabs.current[next]?.focus()
          }}>
            {['Rendered', 'Markdown source'].map((label, i) => <button key={label} type="button" role="tab"
              id={`${answerId}-tab-${i}`} aria-controls={`${answerId}-panel`} aria-selected={Number(raw) === i}
              tabIndex={Number(raw) === i ? 0 : -1} ref={node => { tabs.current[i] = node }}
              className={Number(raw) === i ? 'on' : ''} onClick={() => setRaw(!!i)}>{label}</button>)}
          </div>
          <div className="cq-actions">
            <button type="button" className="btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="btn ghost" onClick={download}>Download .md</button>
          </div>
        </div>

        {/* A degraded index is not warned about twice: the document leads with a
            `[!WARNING]` callout for it, which is the same warning in the place a
            reader is already looking. */}
        <div className="cq-answer-body" role="tabpanel" id={`${answerId}-panel`} aria-labelledby={`${answerId}-tab-${Number(raw)}`}
          tabIndex={0} ref={body} onClick={e => openCited(e.target)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openCited(e.target) }}>
          {raw ? <pre className="code-answer-source"><code>{doc}</code></pre>
               : <Markdown source={doc} className="code-answer-doc" />}
        </div>

        {/* The excerpts the answer was built from. The document cites them and
            does not quote them, and a reader checking a citation should not have
            to search for the lines it names. */}
        {excerpts.length > 0 && <details className="code-excerpts">
          <summary>{excerpts.length} {excerpts.length === 1 ? 'excerpt' : 'excerpts'} the answer was built from</summary>
          {excerpts.map(item => <figure key={item.citation}>
            <figcaption>
              {item.object_id
                ? <button type="button" className="cq-cite" onClick={() => setReading(item)}
                    title="Open the file at these lines"><code>{item.citation}</code></button>
                : <code>{item.citation}</code>}
              {item.stale && <b title="the index and the file disagree on the revision">stale</b>}
            </figcaption>
            <pre><code>{item.snippet}</code></pre>
          </figure>)}
        </details>}
      </section>}
    </div>
    {reading?.object_id && <FileView excerpt={reading} onClose={closeFile} />}
  </div>
}

/** Whether what was typed names a clone's folder rather than a repository URL. */
const isFolder = (s: string) => /^(~|\/|\.)/.test(s.trim())

/** What is searchable, what is being indexed, and a way to add a repository. */
function Repos({ repos, jobs, mayIndex, mayIndexPaths, onStarted }: {
  repos: CodeRepo[] | null
  jobs: CodeIndexJob[]
  mayIndex: boolean
  mayIndexPaths: boolean
  onStarted: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState('')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (repos === null) return null
  const none = repos.length === 0
  const folder = mayIndexPaths && isFolder(source)

  async function start() {
    if (!source.trim() || busy) return
    setBusy(true); setErr(null)
    try {
      await indexCodeRepo(folder ? { path: source.trim() }
        : { url: source.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}),
            ...(token.trim() ? { token: token.trim() } : {}) })
      // The token is for this clone only; nothing keeps it, including this form.
      setSource(''); setBranch(''); setToken(''); setMore(false); setAdding(false); onStarted()
    } catch (e) { setErr(message(e)) } finally { setBusy(false) }
  }

  const form = (
    <form className="cq-add-form" onSubmit={e => { e.preventDefault(); start() }}>
      <div className="cq-add">
        <input aria-label="Repository URL" value={source} autoFocus={!none}
          onChange={e => setSource(e.target.value)}
          placeholder={mayIndexPaths ? 'https://github.com/org/repo — or a clone\'s folder on the gateway\'s machine'
                                     : 'https://github.com/org/repo'} />
        <button className="btn action" disabled={busy || !source.trim()}>{busy ? 'Starting…' : 'Index it'}</button>
        {!none && <button type="button" className="btn ghost" onClick={() => { setAdding(false); setErr(null) }}>Cancel</button>}
      </div>
      {!folder && (more ? (
        <div className="cq-add cq-add-more">
          <input aria-label="Branch" value={branch} onChange={e => setBranch(e.target.value)}
            placeholder="Branch — the default branch if empty" />
          <input aria-label="Access token" type="password" autoComplete="off" value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Access token — for a private repository; kept encrypted to re-index it" />
        </div>
      ) : (
        <button type="button" className="linkbtn cq-add-toggle" onClick={() => setMore(true)}>
          Private repository or another branch?</button>
      ))}
    </form>
  )

  return <>
    {!none && <div className="cq-repos" aria-label="Searchable repositories">
      <span>Searches</span>
      {repos.map(r => <span key={r.repo_id} className="cq-repo" title={
        r.last_indexed_at ? `${r.branch} · indexed ${new Date(r.last_indexed_at).toLocaleString()}`
                          : 'never indexed'}>
        <i className={`cq-health ${!r.last_indexed_at ? 'none' : r.health === 'ok' ? 'ok' : 'warn'}`} />
        {r.repo}
      </span>)}
      {mayIndex && !adding && <button type="button" className="linkbtn" onClick={() => setAdding(true)}>+ Add a repository</button>}
    </div>}

    {jobs.map(j => (
      <div key={j.path} className={`notice cq-job${j.state === 'failed' ? ' failed' : ''}`} role="status">
        {j.state === 'indexing'
          ? <><i className="cq-spin" aria-hidden="true" />Indexing <b>{j.repo}</b>{j.step && j.step !== 'queued' ? ` — ${j.step}` : ''} — it
              becomes searchable here when it finishes.</>
          : <><b>Could not index {j.repo}.</b> {j.error}</>}
      </div>
    ))}

    {none && (mayIndex ? (
      <div className="notice cq-note">
        <p>Nothing is indexed yet, so there is nothing to search. Add a repository by its URL — a public one, or a
          private one with an access token — and its code becomes searchable here.</p>
        {form}
      </div>
    ) : (
      <div className="notice cq-note">
        No repositories are indexed yet, so there is nothing to search. A workspace admin can add one here by its
        URL, or index a clone with <code>make code-index REPOS="path/to/clone"</code>.
      </div>
    ))}
    {!none && adding && form}
    {err && <div className="notice cq-error" role="alert">{err}</div>}
  </>
}

/** One file, open at the lines an answer cited. */
function FileView({ excerpt, onClose }: { excerpt: Excerpt; onClose: () => void }) {
  const [file, setFile] = useState<CodeFile | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const first = useRef<HTMLDivElement>(null)
  const from = excerpt.start_line ?? 0
  const to = excerpt.end_line ?? from

  useEffect(() => {
    let live = true
    setFile(null); setErr(null)
    getCodeFile(excerpt.object_id!).then(f => { if (live) setFile(f) }).catch(e => { if (live) setErr(message(e)) })
    return () => { live = false }
  }, [excerpt.object_id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  useLayoutEffect(() => { first.current?.scrollIntoView?.({ block: 'center' }) }, [file])

  const lines = file ? file.body.replace(/\n$/, '').split('\n') : []
  return createPortal(
    <aside className="cdrawer cq-file" role="dialog" aria-label={`${excerpt.path || file?.path || 'A file'}${from ? `, lines ${from}–${to}` : ''}`}>
      <div className="cdrawer-bar">
        <div><b>{excerpt.path || file?.path}</b><span>{excerpt.repo || file?.repo}{from ? ` · lines ${from}–${to}` : ''}</span></div>
        <button type="button" className="tp-x" aria-label="Close the file" onClick={onClose}>×</button>
      </div>
      <div className="cq-file-body">
        {err ? <p className="p-warn" role="alert">{err}</p>
          : !file ? <p className="thread-empty">Opening…</p>
          : <pre className="cq-lines">{lines.map((text, i) => {
              const n = file.start_line + i
              const hit = n >= from && n <= to
              return <div key={n} ref={n === from ? first : undefined} className={hit ? 'hit' : undefined}
                data-line={n}><span className="ln" aria-hidden="true">{n}</span><code>{text || ' '}</code></div>
            })}</pre>}
        {file?.truncated && <p className="cq-file-note">The file goes on past what the gateway sends in one read.</p>}
      </div>
    </aside>,
    document.body)
}
