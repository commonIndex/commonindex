import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { deleteVideo, getVideo, renderVideo, saveVideo, videoBlob, videoTools, type WireVideo, type VideoTools, type VideoSuggestion } from '../data/gateway'
import { duplicate, move, parse, remove, setDuration, setText } from '../data/composition'
import { ShareButton } from '../components/ShareButton'
import { ProjectsButton } from '../components/ProjectChips'
import { VideoPreview, type PreviewHandle } from '../components/VideoPreview'
import { VideoAssistant } from '../components/VideoAssistant'
import { useToast } from '../components/Shell'
import './videos.css'

type Tab = 'scenes' | 'details' | 'code'
type Draft = { title: string; brief: string; composition: string; selected: number }
const snapshot = (v: WireVideo): Draft => ({ title: v.title, brief: v.brief ?? '', composition: v.composition ?? '', selected: 0 })
const empty: Draft = { title: '', brief: '', composition: '', selected: 0 }
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const into = (s: { start: number; duration: number }) => s.start + Math.min(1.6, s.duration * 0.45)
const STATE: Record<string, string> = { draft: 'Draft', rendering: 'Rendering', ready: 'Ready', failed: 'Failed' }

/** A route change gets a fresh editor, so late responses cannot mix videos. */
export function VideoDetail() {
  const { id = '' } = useParams()
  return <VideoEditor key={id} id={id} />
}

function VideoEditor({ id }: { id: string }) {
  const navigate = useNavigate(), toast = useToast()
  const [video, setVideo] = useState<WireVideo | null>(null)
  const [saved, setSaved] = useState<Draft>(empty)
  const [history, setHistory] = useState({ entries: [empty], cursor: 0 })
  const draft = history.entries[history.cursor]
  const [tab, setTab] = useState<Tab>('scenes')
  const [view, setView] = useState<'live' | 'file'>('live')
  const [tools, setTools] = useState<VideoTools | null>(null)
  const [toolsError, setToolsError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiProposal, setAiProposal] = useState<VideoSuggestion | null>(null)
  const [aiComparison, setAiComparison] = useState<'before' | 'after'>('after')
  const pending = useRef(false), alive = useRef(true)
  const [reload, setReload] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [fileError, setFileError] = useState('')
  const [fileRetry, setFileRetry] = useState(0)
  const [now, setNow] = useState(0)
  const playhead = useRef(0)
  const preview = useRef<PreviewHandle>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    let active = true
    setLoadError('')
    getVideo(id).then(({ video: v }) => {
      if (!active) return
      const first = parse(v.composition ?? '')?.scenes[0]
      playhead.current = first ? into(first) : 0
      setNow(playhead.current)
      setVideo(v); setSaved(snapshot(v)); setHistory({ entries: [snapshot(v)], cursor: 0 })
      if (v.state === 'ready' && v.render?.finished_at) setView('file')
    }).catch(e => { if (active) setLoadError(message(e)) })
    return () => { active = false }
  }, [id, reload])
  useEffect(() => {
    let active = true
    videoTools().then(v => { if (active) setTools(v) }).catch(e => { if (active) setToolsError(message(e)) })
    return () => { active = false }
  }, [reload])
  useEffect(() => {
    if (video?.state !== 'rendering') return
    let active = true, polling = false
    const timer = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const { video: v } = await getVideo(id)
        if (active) { setVideo(v); setErr('') }
      } catch (e) {
        if (active) setErr('Could not refresh render status. Your edits are still here. ' + message(e))
      } finally { polling = false }
    }, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [id, video?.state])
  const finished = video?.state === 'ready' ? video.render?.finished_at : null
  useEffect(() => {
    setUrl(null); setFileError('')
    if (!finished) return
    let active = true, made: string | null = null
    videoBlob(id).then(blob => {
      if (active) { made = URL.createObjectURL(blob); setUrl(made) }
    }).catch(e => { if (active) setFileError(message(e)) })
    return () => { active = false; if (made) URL.revokeObjectURL(made) }
  }, [id, finished, fileRetry])

  const shownComposition = aiProposal && aiComparison === 'after' ? aiProposal.composition : draft.composition
  const parsed = useMemo(() => shownComposition ? parse(shownComposition) : null, [shownComposition])
  const selected = parsed?.scenes[Math.min(draft.selected, parsed.scenes.length - 1)]
  const changed = draft.composition !== saved.composition || draft.title !== saved.title || draft.brief !== saved.brief
  const state = video?.state ?? 'draft'
  const locked = busy || state === 'rendering' || aiBusy || !!aiProposal
  const validTitle = !!draft.title.trim()
  const canRender = !!tools?.ready && !!draft.composition.trim() && validTitle && !locked
  const showScene = (composition: string, index: number) => {
    const scenes = parse(composition)?.scenes
    const scene = scenes?.[Math.min(index, scenes.length - 1)]
    if (!scene) return
    playhead.current = into(scene); setNow(playhead.current)
    // seek also pauses, and is queued by the player while its HTML reloads.
    setView('live'); preview.current?.seek(playhead.current)
  }
  const edit = (changes: Partial<Draft>) => {
    if (locked) return
    if (changes.selected !== undefined || (changes.composition !== undefined && tab === 'scenes')) {
      showScene(changes.composition ?? draft.composition, changes.selected ?? draft.selected)
    }
    setHistory(h => {
      const next = { ...h.entries[h.cursor], ...changes }
      if (JSON.stringify(next) === JSON.stringify(h.entries[h.cursor])) return h
      const entries = [...h.entries.slice(0, h.cursor + 1), next].slice(-80)
      return { entries, cursor: entries.length - 1 }
    })
    if (changes.composition !== undefined) setView('live')
  }
  const select = (i: number) => {
    if (aiBusy) return
    const scene = parsed?.scenes[i]
    if (!scene) return
    setHistory(h => ({ ...h, entries: h.entries.map((d, n) => n === h.cursor ? { ...d, selected: i } : d) }))
    setTab('scenes'); showScene(shownComposition, i)
  }
  const restore = (cursor: number) => {
    if (locked) return
    const next = history.entries[cursor]
    setHistory(h => ({ ...h, cursor }))
    setView('live'); showScene(next.composition, next.selected)
  }
  const undo = () => restore(Math.max(0, history.cursor - 1))
  const redo = () => restore(Math.min(history.entries.length - 1, history.cursor + 1))
  const run = async (work: () => Promise<void>) => {
    if (pending.current || state === 'rendering') return
    pending.current = true; setBusy(true); setErr('')
    try { await work() } catch (e) { if (alive.current) setErr(message(e)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const persist = async () => {
    const next = { ...draft, title: draft.title.trim() }
    await saveVideo(id, { title: next.title, brief: next.brief,
      // A new video has no composition yet. Metadata-only saves must not
      // submit an empty composition, which the gateway correctly rejects.
      ...(next.composition !== saved.composition ? { composition: next.composition } : {}),
    })
    if (!alive.current) return
    setSaved(next)
    setView('live')
    setHistory(h => ({ ...h, entries: h.entries.map((d, i) => i === h.cursor ? next : d) }))
    setVideo(v => v ? { ...v, title: next.title, brief: next.brief, composition: next.composition, state: 'draft' } : v)
  }
  const save = () => { if (changed && validTitle && !locked) void run(async () => { await persist(); if (alive.current) toast('All changes saved — render to update the file') }) }
  const renderFile = (format: 'mp4' | 'webm') => {
    if (!canRender) return
    void run(async () => {
      if (changed) await persist()
      if (!alive.current) return
      await renderVideo(id, format)
      if (alive.current) { setVideo(v => v ? { ...v, state: 'rendering' } : v); setView('live'); toast('Rendering ' + format.toUpperCase()) }
    })
  }
  const discard = () => {
    if (locked || !window.confirm('Discard all unsaved changes to this video?')) return
    setHistory({ entries: [saved], cursor: 0 }); setView('live'); showScene(saved.composition, saved.selected)
  }
  const reviewAI = (suggestion: VideoSuggestion) => {
    setAiProposal(suggestion); setAiComparison('after'); showScene(suggestion.composition, draft.selected)
    setView('live')
  }
  const discardAI = () => {
    setAiProposal(null); showScene(draft.composition, draft.selected); setView('live')
  }
  const acceptAI = () => {
    if (!aiProposal) return
    const composition = aiProposal.composition
    // Editing is locked for generation + review. Acceptance is one history
    // entry, not a save; Undo restores the exact pre-request local draft.
    setHistory(h => {
      const next = { ...h.entries[h.cursor], composition }
      const entries = [...h.entries.slice(0, h.cursor + 1), next].slice(-80)
      return { entries, cursor: entries.length - 1 }
    })
    setAiProposal(null); showScene(composition, draft.selected); setView('live')
    toast('AI changes accepted — review and save when ready')
  }
  useEffect(() => {
    if (!changed && !busy && !aiBusy && !aiProposal) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [changed, busy, aiBusy, aiProposal])
  // Keep native text-field undo intact. Editor-level history has explicit buttons.
  const keys = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key.toLowerCase() === 's') { e.preventDefault(); save() }
    else if (!(e.target as HTMLElement).closest('input,textarea,[contenteditable="true"]') && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.shiftKey ? redo() : undo()
    }
  }

  if (!video) return <div className="detail">{loadError
    ? <div className="empty" role="alert"><b>Could not load this video</b><p>{loadError}</p><button className="btn" onClick={() => setReload(n => n + 1)}>Retry</button> <Link to="/videos">All videos</Link></div>
    : <p role="status">Loading video…</p>}</div>

  const activeScene = parsed?.scenes.findIndex(s => now >= s.start && now < s.start + s.duration) ?? -1
  return <div className="veditor" onKeyDown={keys}>
    <header className="ved-head">
      <div className="ved-title"><Link to="/videos" className="channel-back" onClick={e => {
        if ((changed || busy || aiBusy || aiProposal) && !window.confirm('Leave this video? Unsaved changes and AI suggestions will be lost.')) e.preventDefault()
      }}>← Videos</Link><h1>{draft.title.trim() || video.title}</h1><span className={'vbadge ' + state}>{STATE[state]}</span></div>
      <div className="ved-actions"><ProjectsButton about={{ id, type: 'video' }} /><ShareButton id={id} title={video.title} />
        <button className="btn" disabled={locked || history.cursor === 0} onClick={undo} title="Undo edit">Undo</button>
        <button className="btn" disabled={locked || history.cursor === history.entries.length - 1} onClick={redo} title="Redo edit">Redo</button>
        <button className="btn action" disabled={!canRender} onClick={() => renderFile('mp4')}>{state === 'rendering' ? 'Rendering…' : 'Render MP4'}</button>
      </div>
    </header>
    <div className="ved-savebar">
      <span role="status">{aiBusy ? 'AI request in progress…' : aiProposal ? 'Review AI suggestion · accept or discard to continue editing' : busy ? 'Working…' : state === 'rendering' ? 'Rendering in progress · editing resumes when it finishes' : changed ? 'Unsaved changes' : 'All changes saved'}</span>
      <span className="ved-savehint">⌘ / Ctrl + S to save · render to update your file</span>
      <div>{changed && <button className="btn" disabled={locked} onClick={discard}>Discard</button>}
        <button className="btn" disabled={locked || !changed || !validTitle} onClick={save}>Save</button></div>
    </div>
    {tools && !tools.ready && <p className="video-warn" role="status">This server can’t render yet: {[!tools.renderer && 'the renderer', !tools.ffmpeg && 'ffmpeg'].filter(Boolean).join(' and ')} not installed — see <code>docs/videos.md</code>. You can still edit and preview.</p>}
    {toolsError && <p className="video-warn" role="alert">Could not check rendering tools: {toolsError}. Editing and preview are still available.</p>}
    {err && <p className="video-error" role="alert">{err}</p>}
    {state === 'failed' && video.render?.error && <pre className="video-error" role="alert">{video.render.error}</pre>}
    <div className="ved-body">
      <section className="ved-stage" aria-label="Player">
        <div className="ved-preview-head">
        <div className="ved-views" role="group" aria-label="What to play">
          <button aria-pressed={view === 'live'} className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>Live preview{aiProposal ? ` · AI ${aiComparison}` : changed && ' · unsaved'}</button>
          <button aria-pressed={view === 'file'} className={view === 'file' ? 'on' : ''} disabled={!finished || !!aiProposal} onClick={() => setView('file')}>Rendered {video.render?.format?.toUpperCase() ?? 'file'}</button>
          {url && view === 'file' && <a className="ved-download" href={url} download={`${video.key ?? id}.${video.render?.format ?? 'mp4'}`}>Download</a>}
          {parsed && <span className="ved-resolution">{parsed.width} × {parsed.height} · {clock(parsed.duration)}</span>}
        </div>
        {aiProposal && <div className="ved-ai-banner" role="status">{aiComparison === 'after' ? 'AI suggestion' : 'Your original draft'} · Nothing saved. Review all affected scenes, then accept or discard in the inspector.</div>}
        {selected && <div className="ved-scene-context" aria-label="Selected scene">
          <div><span>Editing scene {selected.id + 1} of {parsed!.scenes.length}</span><strong title={selected.label}>{selected.label}</strong></div>
          <span className="ved-preview-context">{view === 'file' ? 'Rendered file' : activeScene >= 0 ? `Preview: scene ${activeScene + 1}` : 'Between scenes'}</span>
          <button className="btn" disabled={aiBusy} onClick={() => select(selected.id)}>Show selected scene</button>
        </div>}
        </div>
        {view === 'file' && finished ? <div className="ved-file">
          {fileError ? <div className="ved-empty" role="alert"><b>Could not load the rendered file</b><span>{fileError}</span><button className="btn" onClick={() => setFileRetry(n => n + 1)}>Retry file</button></div>
            : url ? <video src={url} controls playsInline onError={() => setFileError('Your browser could not play this file. Try downloading it or render again.')} />
            : <p role="status">Loading rendered file…</p>}
        </div> : parsed ? <VideoPreview ref={preview} html={shownComposition} width={parsed.width} height={parsed.height} initialTime={playhead.current}
          onTime={t => { playhead.current = t; setNow(t) }} />
          : <div className="ved-empty">
            <b>{draft.composition.trim() ? 'Composition needs attention' : 'No composition yet'}</b>
            <span className="ved-empty-help">{draft.composition.trim() ? 'Add a data-composition-id root to the HTML to preview this draft. Your code has not been discarded.' : 'Use Edit with AI to describe your video, or ask a connected agent to help with your brief.'}</span>
            {draft.brief.trim() && <blockquote className="ved-brief-preview">{draft.brief}</blockquote>}
            <div className="ved-empty-actions"><button className="btn action" onClick={() => setTab('details')}>{draft.brief.trim() ? 'Review brief' : 'Add a brief'}</button>
              <button className="btn" onClick={() => setTab('code')}>{draft.composition.trim() ? 'Review code' : 'Paste composition'}</button></div>
            <span className="vhint">Creating a draft does not start an agent.</span>
          </div>}
        {parsed && parsed.scenes.length > 0 && <div className="ved-timeline">
          <div className="ved-section-label"><b>Timeline</b><span>{parsed.scenes.length} scenes · select a scene to edit</span></div>
          <div className="ved-strip" aria-label="Scenes on the timeline">{parsed.scenes.map((s, i) => <button key={i} className={'ved-chip' + (i === activeScene ? ' now' : '') + (i === selected?.id ? ' open' : '')}
            aria-label={`Preview scene ${i + 1}: ${s.label}`} aria-pressed={i === selected?.id} disabled={aiBusy} style={{ flexGrow: s.duration }} title={`${s.label} · ${s.duration}s`} onClick={() => select(i)}>
            <span>{i + 1}</span><b>{s.label}</b><small>{s.duration}s</small></button>)}</div>
        </div>}
      </section>
      <aside className="ved-panel" aria-label="Video inspector">
        <VideoAssistant id={id} title={draft.title} brief={draft.brief} composition={draft.composition} selected={selected}
          modelConfigured={tools?.ai_configured}
          locked={locked} changed={changed} proposal={aiProposal} comparison={aiComparison}
          onBusy={setAiBusy} onProposal={reviewAI} onAccept={acceptAI} onDiscard={discardAI}
          onCompare={comparison => { setAiComparison(comparison); showScene(comparison === 'after' && aiProposal ? aiProposal.composition : draft.composition, draft.selected) }} />
        <div className="ved-tabs" role="group" aria-label="Edit">
          {(['scenes', 'details', 'code'] as Tab[]).map(t => <button key={t} aria-pressed={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'scenes' ? `Scenes${parsed ? ' · ' + parsed.scenes.length : ''}` : t === 'details' ? 'Details' : 'Code'}</button>)}
        </div>
        {tab === 'scenes' && <div className="ved-scene-editor">
          {parsed?.scenes.length ? <><ol className="ved-scenes" aria-label="Scene list">{parsed.scenes.map((s, i) => <li key={i} className={i === selected?.id ? 'open' : ''}>
            <button className="ved-scene-name" aria-pressed={i === selected?.id} disabled={aiBusy} onClick={() => select(i)} title={s.label}>
              <span className="ved-num">{i + 1}</span><b>{s.label}</b><span className="ved-when">{clock(s.start)}–{clock(s.start + s.duration)}</span>
            </button></li>)}</ol>
            {selected && <fieldset className="ved-scene-body" disabled={locked} aria-label={`Scene ${selected.id + 1} properties`}
              onFocusCapture={() => { if (!locked) showScene(draft.composition, selected.id) }}>
              <div className="ved-section-label"><b>Scene {selected.id + 1}</b><span>{selected.duration}s · {selected.texts.length} text fields</span></div>
              <label className="ved-len">Duration <span className="ved-step"><button aria-label="Shorter" onClick={() => edit({ composition: setDuration(draft.composition, selected.id, selected.duration - .5) })}>−</button>
                <input type="number" min={.5} max={60} step={.5} value={selected.duration} aria-label={`Length of scene ${selected.id + 1} in seconds`} onChange={e => e.target.value && edit({ composition: setDuration(draft.composition, selected.id, Number(e.target.value)) })} />
                <button aria-label="Longer" onClick={() => edit({ composition: setDuration(draft.composition, selected.id, selected.duration + .5) })}>+</button></span> seconds</label>
              <div className="ved-tools"><button className="tool" disabled={selected.id === 0} aria-label="Move earlier" onClick={() => edit({ composition: move(draft.composition, selected.id, -1), selected: selected.id - 1 })}>↑</button>
                <button className="tool" disabled={selected.id === parsed.scenes.length - 1} aria-label="Move later" onClick={() => edit({ composition: move(draft.composition, selected.id, 1), selected: selected.id + 1 })}>↓</button>
                <button className="tool" onClick={() => edit({ composition: duplicate(draft.composition, selected.id), selected: selected.id + 1 })}>Duplicate</button>
                <button className="tool danger" disabled={parsed.scenes.length <= 1} onClick={() => edit({ composition: remove(draft.composition, selected.id), selected: Math.max(0, selected.id - 1) })}>Delete scene</button></div>
              {selected.texts.length ? selected.texts.map((t, i) => <label key={`${selected.id}-${t.index}-${t.node ?? 'element'}`} className="ved-text"><span>{t.heading ? 'Heading' : 'Text'} {i + 1}</span>
                <textarea rows={t.heading ? 2 : 3} value={t.text} onChange={e => edit({ composition: setText(draft.composition, selected.id, t.index, e.target.value, t.node) })} /></label>) : <p className="share-note">No editable text. Use Code for this scene’s visuals.</p>}
            </fieldset>}</> : <p className="share-note">{parsed ? 'No timed scenes found. Use Code to edit this composition.' : 'Scenes appear once there’s a composition.'}</p>}
        </div>}
        {tab === 'details' && <div className="ved-details">
          <fieldset disabled={locked} className="ved-fields"><label className="invite-field">Title<input value={draft.title} onChange={e => edit({ title: e.target.value })} /></label>
            <label className="invite-field">Brief<textarea rows={6} value={draft.brief} onChange={e => edit({ brief: e.target.value })} /></label></fieldset>
          {!validTitle && <p className="share-err" role="alert">Add a title before saving or rendering.</p>}
          <p className="share-note">Title, brief, and scene edits are saved together with Save.</p>
          <dl className="ved-facts"><dt>Format</dt><dd>{video.format ?? 'landscape'}</dd>{parsed && <><dt>Length</dt><dd>{clock(parsed.duration)}</dd></>}
            {video.render?.bytes != null && <><dt>Last file</dt><dd>{video.render.format?.toUpperCase()} · {(video.render.bytes / 1e6).toFixed(1)} MB</dd></>}</dl>
          <button className="btn" disabled={!canRender} onClick={() => renderFile('webm')}>Render WebM (royalty-free)</button>
          <div className="channel-danger"><div><b>Delete this video</b><span>The video and its rendered files go for good.</span></div><button className="btn" disabled={locked} onClick={() => {
            if (window.confirm(`Delete “${video.title}” and its rendered files?`)) void run(async () => { await deleteVideo(id); if (alive.current) { navigate('/videos', { replace: true }); toast('Video deleted') } })
          }}>Delete</button></div>
        </div>}
        {tab === 'code' && <div className="ved-code"><p className="share-note">Self-contained HTML with CSS animation. No outside scripts, links, or GSAP. Check the rendered file before sharing.</p>
          <textarea className="video-editor" disabled={locked} spellCheck={false} aria-label="Composition HTML" value={shownComposition} onChange={e => edit({ composition: e.target.value })} /></div>}
      </aside>
    </div>
  </div>
}
