import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  createVideo, listVideos, videoBlob, type VideoFormat, type WireVideo,
} from '../data/gateway'
import { Pick } from '../components/ShareButton'
import { useToast } from '../components/Shell'
import { ago } from '../components/TaskCard'
import './videos.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const STATE: Record<string, string> = { draft: 'Draft', rendering: 'Rendering', ready: 'Ready', failed: 'Failed' }
const FORMATS: { id: VideoFormat; label: string; ratio: string; use: string }[] = [
  { id: 'landscape', label: 'Landscape', ratio: '16:9', use: 'Demos & presentations' },
  { id: 'portrait', label: 'Portrait', ratio: '9:16', use: 'Mobile & social stories' },
  { id: 'square', label: 'Square', ratio: '1:1', use: 'Social feeds' },
]
const BRIEF_EXAMPLES = [
  { label: 'Product launch', text: 'Create a 25-second product launch for new customers. Introduce the problem, show our three most useful features, and end with an invitation to try the product. Tone: clear and confident. Must show: [features and product screens].' },
  { label: 'Feature walkthrough', text: 'Create a 30-second walkthrough for existing customers. Show how to use [feature], from the first click to the result. Focus on one useful workflow. Tone: friendly and practical. End with: [next step].' },
  { label: 'Explainer', text: 'Create a 45-second explainer for [audience]. Explain [topic] with a simple example, show why it matters, and close with one takeaway. Tone: calm and approachable. Must include: [key facts].' },
]
type VideoDraft = { title: string; brief: string; format: VideoFormat }
const clock = (s?: number | null) => {
  if (s == null || !Number.isFinite(s)) return ''
  const seconds = Math.max(0, Math.round(s))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const since = (at: string | null) => {
  if (!at) return ''
  const a = ago(Math.max(0, (Date.now() - Date.parse(at)) / 1000))
  return a === 'now' ? 'just now' : `${a} ago`
}

/** A still from the rendered file, fetched with the same sign-in. */
function usePoster(video: WireVideo) {
  const [url, setUrl] = useState<string | null>(null)
  const key = video.render?.poster && video.state === 'ready' ? video.render.finished_at : null
  useEffect(() => {
    setUrl(null)
    if (!key) return
    let made: string | null = null, alive = true
    videoBlob(video.id, 'poster').then(b => { if (alive) { made = URL.createObjectURL(b); setUrl(made) } }).catch(() => {})
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [video.id, key])
  return url
}

function FormatShape({ format }: { format: VideoFormat }) {
  const [w, h] = format === 'portrait' ? [12, 20] : format === 'square' ? [16, 16] : [22, 13]
  return <span className="vf-shape" style={{ width: w, height: h }} aria-hidden="true" />
}

/** What a written but unrendered draft holds: its scenes, its length and the
 *  first heading — so a finished draft does not read "Your next story starts here". */
export function draftSummary(html: string | undefined): { scenes: number; seconds: number; first: string } | null {
  if (!html?.trim()) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const scenes = doc.querySelectorAll('[data-start]').length
  const seconds = Number(doc.querySelector('[data-composition-id]')?.getAttribute('data-duration')) || 0
  const first = (doc.querySelector('[data-start] h1, [data-start] h2, h1, h2')?.textContent ?? '').trim()
  return scenes || seconds ? { scenes, seconds, first } : null
}

function Card({ video }: { video: WireVideo }) {
  const poster = usePoster(video)
  const draft = !poster && video.state !== 'rendering' && video.state !== 'failed' ? draftSummary(video.composition) : null
  const format = video.format ?? 'landscape'
  const state = video.state ?? 'draft'
  return (
    <Link to={`/videos/${video.id}`} className="vcard" aria-label={`Open video: ${video.title}`}>
      <span className={`vcard-thumb ${format}`}>
        {poster ? <img src={poster} alt="" /> : draft ? <span className="vcard-empty vcard-draft">
          <span className="vcard-frame"><FormatShape format={format} /></span>
          {draft.first && <b>{draft.first}</b>}
          <span>{draft.scenes} {draft.scenes === 1 ? 'scene' : 'scenes'}{draft.seconds ? ` · ${clock(draft.seconds)}` : ''} · not rendered yet</span>
        </span> : <span className="vcard-empty">
          <span className="vcard-frame"><FormatShape format={format} /></span>
          <b>{state === 'rendering' ? 'Rendering your video' : state === 'failed' ? 'Render needs attention' : state === 'ready' ? 'Video ready' : 'Your next story starts here'}</b>
          <span>{state === 'draft' ? 'Open the editor to build your video' : state === 'ready' ? 'Open to watch the rendered file' : state === 'rendering' ? 'You can come back when it’s ready' : 'Open to review the render error'}</span>
        </span>}
        {state === 'ready' && <span className="vcard-play" aria-hidden="true"><svg viewBox="0 0 16 16" width="22" height="22"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" /></svg></span>}
        {video.render?.seconds != null && state === 'ready' && <span className="vcard-time">{clock(video.render.seconds)}</span>}
      </span>
      <span className="vcard-body">
        <span className="vcard-meta"><span>{FORMATS.find(f => f.id === format)?.label} · {FORMATS.find(f => f.id === format)?.ratio}</span>
          <span className={`vbadge ${state}`}>{STATE[state]}</span></span>
        <b className="vcard-title">{video.title}</b>
        <span className="vcard-brief">{video.brief?.trim() || 'Add a brief to give your video a clear direction.'}</span>
        <span className="vcard-footer"><span>{video.visibility === 'private' ? 'Private' : video.visibility === 'workspace' ? 'Workspace' : video.key}
          {video.updated_at && ` · ${since(video.updated_at)}`}</span><span className="vcard-open">{state === 'ready' ? 'Watch video' : 'Open editor'} <span aria-hidden="true">↗</span></span></span>
      </span>
    </Link>
  )
}

/** Videos: each one a composition an agent writes as code, rendered to a file. */
export function VideosView() {
  const [videos, setVideos] = useState<WireVideo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Keep an unsubmitted brief when returning to the gallery, without browser storage.
  const [draft, setDraft] = useState<VideoDraft>({ title: '', brief: '', format: 'landscape' })
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [format, setFormat] = useState<VideoFormat | 'all'>('all')
  const request = useRef(0)
  const newVideoButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const cancelCreate = () => { restoreFocus.current = true; setCreating(false) }
  useLayoutEffect(() => {
    if (!creating && restoreFocus.current) {
      newVideoButton.current?.focus()
      restoreFocus.current = false
    }
  }, [creating])
  const load = useCallback(async () => {
    const current = ++request.current
    try {
      const result = await listVideos()
      if (current === request.current) { setVideos(result.videos); setErr(null) }
    } catch (e) { if (current === request.current) setErr(message(e)) }
  }, [])
  useEffect(() => { load(); return () => { request.current++ } }, [load])
  const rendering = videos?.some(video => video.state === 'rendering') ?? false
  useEffect(() => {
    if (!rendering) return
    let alive = true
    const refresh = async () => {
      await load()
      if (alive) timer = setTimeout(refresh, 5000)
    }
    let timer = setTimeout(refresh, 5000)
    return () => { alive = false; clearTimeout(timer) }
  }, [rendering, load])
  const needle = query.trim().toLowerCase()
  const filtered = !!needle || status !== 'all' || format !== 'all'
  const visible = (videos ?? []).filter(video => (!needle || `${video.title} ${video.brief ?? ''} ${video.key ?? ''}`.toLowerCase().includes(needle))
    && (status === 'all' || (video.state ?? 'draft') === status) && (format === 'all' || (video.format ?? 'landscape') === format))
  const reset = () => { setQuery(''); setStatus('all'); setFormat('all') }
  return (
    <div className="collection workspace-collection videos-collection">
      <div className="dash-gallery-scroll">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Videos <span className="total">{videos?.length ?? ''}</span></h1>
          <p className="coll-sub">A home for your launches, walkthroughs, and explainers. Shape the story, review the scenes, and render.</p>
        </div>
        {!creating && <button ref={newVideoButton} className="btn action" onClick={() => setCreating(true)}>+ New video</button>}
      </header>
      {creating ? (
        <div className="dash-collection-shell"><NewVideo draft={draft} onChange={setDraft} onCancel={cancelCreate} /></div>
      ) : <>
      <div className="dash-collection-shell">
        {!!videos?.length && <div className="vtools" role="group" aria-label="Filter videos">
          <input className="dash-search" type="search" aria-label="Search videos" placeholder="Search titles, briefs, or IDs…" value={query} onChange={e => setQuery(e.target.value)} />
          <Pick label="Video status" value={status} onChange={setStatus} options={[["all", 'All statuses'], ...Object.entries(STATE)]} />
          <Pick<VideoFormat | 'all'> label="Video format" value={format} onChange={setFormat} options={[["all", 'All formats'], ...FORMATS.map(f => [f.id, `${f.label} · ${f.ratio}`] as [VideoFormat, string])]} />
        </div>}
        {err && <div className="dash-load-error" role="alert"><span>Could not load videos. {err}</span><button className="tool" onClick={load}>Retry</button></div>}
        {videos && <div className="vresults"><span role="status">{filtered ? `${visible.length} of ${videos.length} videos` : `${videos.length} ${videos.length === 1 ? 'video' : 'videos'}`}</span>
          {filtered && <button className="linkbtn" onClick={reset}>Clear filters</button>}</div>}
      </div>
      <div className="dash-collection-shell">
        {!videos ? !err && <p className="share-note" role="status">Loading videos…</p> : videos.length === 0 ? (
          <div className="dash-gallery-empty">
            <span className="vempty-icon" aria-hidden="true"><FormatShape format="landscape" /></span>
            <h2>Give your next idea a little motion</h2>
            <p>Start with a brief. Ask a connected agent to build the video, then refine the scenes and render it here.</p>
            <button className="btn action" onClick={() => setCreating(true)}>+ New video</button>
          </div>
        ) : !visible.length ? (
          <div className="dash-gallery-empty"><h2>No matching videos</h2><p>Try a different search, status, or format.</p><button className="btn" onClick={reset}>Show all videos</button></div>
        ) : (
          <ul className="vgrid" aria-label="Videos">{visible.map(v => <li key={v.id}><Card video={v} /></li>)}</ul>
        )}
      </div>
      </>}
      </div>
    </div>
  )
}

function NewVideo({ draft, onChange, onCancel }: { draft: VideoDraft; onChange: (draft: VideoDraft) => void; onCancel: () => void }) {
  const { title, brief, format } = draft
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const sending = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const alive = useRef(true)
  const titleInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const navigate = useNavigate()
  useLayoutEffect(() => {
    titleInput.current?.focus()
  }, [])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return (
      <form ref={form} className="card addpanel vnew" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy} tabIndex={-1}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!sending.current) form.current?.requestSubmit()
          }
        }} onSubmit={async e => {
        e.preventDefault()
        if (sending.current || !title.trim()) return
        sending.current = true
        form.current?.focus()
        setBusy(true); setErr(null)
        try {
          const result = await createVideo(title.trim(), brief.trim(), format)
          if (alive.current) navigate(`/videos/${result.id}`)
        } catch (x) {
          if (alive.current) { setErr(message(x)); sending.current = false; setBusy(false) }
        }
      }}>
        <header className="addpanel-head"><h2 id={`${id}-title`}>New video</h2>
          <span className="hint" id={`${id}-description`}>Start with a brief and a format. Nothing is created until you choose to.</span>
          <button type="button" className="tool" disabled={busy} onClick={() => { if (!sending.current) onCancel() }}>Cancel</button></header>
        <div className="vnew-body">
        <div className="vnew-story">
        <label className="invite-field">Title
          <input ref={titleInput} value={title} disabled={busy} required onChange={e => onChange({ ...draft, title: e.target.value })} placeholder="e.g. Meet our new workspace" />
        </label>
        <div className="vbrief-field"><label className="invite-field"><span className="vfield-label">Brief <span>Optional</span></span>
          <textarea rows={4} value={brief} disabled={busy} onChange={e => onChange({ ...draft, brief: e.target.value })} aria-describedby={`${id}-brief-help`}
            placeholder="Who is it for? What should it show? Include the length, tone, and a closing call to action." />
        </label><p className="vhint" id={`${id}-brief-help`}>Give your agent the audience, key moments, and desired length. You can refine this later.</p>
          <div className="vbrief-examples" role="group" aria-label="Brief examples"><span>Try an example</span>
            {BRIEF_EXAMPLES.map(example => <button key={example.label} type="button" disabled={busy || !!brief.trim()}
              title={brief.trim() ? 'Clear the brief to try an example. Your text will not be overwritten.' : `Use the ${example.label.toLowerCase()} brief`}
              onClick={() => onChange({ ...draft, brief: example.text })}>{example.label}</button>)}
          </div>
        </div>
        </div>
        <div className="vnew-options">
        <fieldset className="vformats" disabled={busy}><legend>Choose a format</legend>
          {FORMATS.map(f => (
            <label key={f.id} className={format === f.id ? 'on' : ''}>
              <input type="radio" name="format" checked={format === f.id} onChange={() => onChange({ ...draft, format: f.id })} />
              <span className="vformat-top"><FormatShape format={f.id} /><span className="vformat-ratio">{f.ratio}</span><span className="vformat-check" aria-hidden="true">{format === f.id ? '✓' : ''}</span></span>
              <b>{f.label}</b><span className="vformat-use">{f.use}</span>
            </label>
          ))}
        </fieldset>
        <div className="vnew-next"><span aria-hidden="true">↗</span><div><b>Next, build it with your agent</b><p>Creating saves a draft. Ask a connected agent to write the video, then review and render it in the editor.</p></div></div>
        </div>
        </div>
        {err && <p className="share-err" role="alert">Could not create video. {err} Your brief is still here; try again.</p>}
        <footer className="dbrief-go vnew-foot"><span className="hint">⌘ / Ctrl + Enter to create · you can edit the brief later</span>
          <button type="submit" className="btn action" disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create video'}</button>
        </footer>
      </form>
  )
}

export { VideoDetail } from './VideoEditor'
