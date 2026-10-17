import { DetailHead } from '../components/DetailHead'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  createProject, listProjects, PROJECT_COLORS, projectItems, searchWorkspace, tagProject, untagProject, updateProject,
  type ProjectColor, type ProjectContents, type ProjectItem, type ProjectStatus, type WireProject,
} from '../data/gateway'
import { pageFor } from '../data/links'
import { useDebounced } from '../hooks'
import { NavIcon } from '../components/NavIcon'
import { activeProjects } from '../components/ProjectChips'
import { useToast } from '../components/Shell'
import { TaskNew } from '../components/TaskPanel'

// A project is a tag with a page: everything filed into it — the tasks for
// each service in a migration, the plan doc, the cut-over dashboard — in one
// place, with the tasks counted by state so how far it has got reads at once.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: [string, string, string][] = [
  ['doc', 'Docs', 'docs'], ['design', 'Designs', 'designs'], ['video', 'Videos', 'videos'],
  ['experiment', 'Experiments', 'experiments'], ['dashboard', 'Dashboards', 'dashboards'],
]
const KIND_LABEL: Record<string, [string, string, string]> = {
  task: ['task', 'tasks', 'board'], doc: ['doc', 'docs', 'docs'], design: ['design', 'designs', 'designs'],
  video: ['video', 'videos', 'videos'], experiment: ['experiment', 'experiments', 'experiments'],
  dashboard: ['dashboard', 'dashboards', 'dashboards'],
}
const kindName = (type: string, n: number) => {
  const [one, many] = KIND_LABEL[type] ?? [type.replace('_', ' '), `${type.replace('_', ' ')}s`]
  return `${n} ${n === 1 ? one : many}`
}
const since = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

const LANE: Record<string, string> = { ready: 'Ready', flight: 'In progress', review: 'In review', done: 'Done' }

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return <div className="proj-progress" role="img" aria-label={total ? `${done} of ${total} tasks done` : 'No tasks yet'}>
    <span className="proj-bar"><i style={{ width: `${pct}%` }} /></span>
    <span className="proj-progress-n">{total ? <><b>{pct}%</b> · {done}/{total} tasks done</> : 'No tasks yet'}</span>
  </div>
}

function NewProject({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<ProjectColor>('blue')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form className="proj-new" onSubmit={async e => {
      e.preventDefault()
      if (!title.trim()) return
      setBusy(true); setErr(null)
      try {
        const r = await createProject({ title: title.trim(), description: description.trim() || null, color })
        await activeProjects(true)
        onCreated(r.id)
      } catch (x) { setErr(message(x)) } finally { setBusy(false) }
    }}>
      <label className="tp-field"><span>Name</span>
        <input autoFocus value={title} maxLength={120} onChange={e => setTitle(e.target.value)}
          placeholder="Legacy billing → new services" /></label>
      <label className="tp-field"><span>What it is for <em>optional</em></span>
        <textarea rows={2} value={description} maxLength={2000} onChange={e => setDescription(e.target.value)}
          placeholder="Move billing off the monolith, one service at a time, without a freeze." /></label>
      <fieldset className="proj-colors"><legend>Color</legend>
        {PROJECT_COLORS.map(c => <label key={c} className={`proj-color pchip-${c}${c === color ? ' on' : ''}`} title={c}>
          <input type="radio" name="color" value={c} checked={c === color} onChange={() => setColor(c)} />
          <span className="pchip-dot" aria-hidden="true" /><span className="dash-sr-only">{c}</span></label>)}
      </fieldset>
      <div className="tp-actions">
        <button className="btn action" disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {err && <p className="p-warn" role="alert">{err}</p>}
    </form>
  )
}

export function ProjectsView() {
  const [projects, setProjects] = useState<WireProject[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [show, setShow] = useState<ProjectStatus | 'all'>('active')
  const [q, setQ] = useState('')
  const [attempt, setAttempt] = useState(0)
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    setErr(null)
    listProjects().then(r => alive && setProjects(r.projects), e => alive && (setErr(message(e)), setProjects([])))
    return () => { alive = false }
  }, [attempt])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (projects ?? []).filter(p => (show === 'all' || p.status === show)
      && (!needle || `${p.title} ${p.description ?? ''}`.toLowerCase().includes(needle)))
  }, [projects, show, q])
  const count = (s: ProjectStatus) => (projects ?? []).filter(p => p.status === s).length

  return (
    <div className="collection dashboard-collection workspace-collection">
      <header className="dash-collection-header dash-collection-shell">
        <div>
          <h1 className="coll-title">Projects <span className="total">{projects === null ? 'Loading…' : err ? 'Unavailable' : projects.length}</span></h1>
          <p className="coll-sub">Group the work for one effort — tasks, docs, designs, videos, experiments and dashboards — and see how far it has got.</p>
        </div>
        <button className="btn action" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : '+ New project'}</button>
      </header>
      <div className="dash-collection-shell">
        {creating && <NewProject onCancel={() => setCreating(false)} onCreated={id => navigate(`/projects/${id}`)} />}
        {(projects?.length ?? 0) > 0 && <div className="coll-tools dash-gallery-tools">
          <div className="proj-tabs" role="tablist" aria-label="Show">
            {([['active', 'Active'], ['done', 'Done'], ['archived', 'Archived'], ['all', 'All']] as const).map(([v, label]) =>
              <button key={v} role="tab" aria-selected={show === v} className={`proj-tab${show === v ? ' on' : ''}`}
                onClick={() => setShow(v)}>{label}{v !== 'all' && <span className="proj-tab-n">{count(v)}</span>}</button>)}
          </div>
          <input type="search" className="dash-search" aria-label="Search projects" value={q}
            onChange={e => setQ(e.target.value)} placeholder="Search projects…" />
        </div>}
        {err && <div className="dash-load-error" role="alert"><span><b>Could not load projects.</b> {err}</span>
          <button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
      </div>
      <div className="dash-gallery-scroll">
        <div className="dash-collection-shell">
          {projects === null ? <div className="empty">Loading…</div>
            : err ? null : rows.length === 0 ? (
              <div className="dash-gallery-empty">
                <h2>{projects.length ? 'No project matches' : 'No projects yet'}</h2>
                <p>{projects.length ? 'Try another name or show all.' : 'Start one for a piece of work that spans tasks and docs — a migration, a launch, a rewrite.'}</p>
                {!projects.length && !creating && <button className="btn action" onClick={() => setCreating(true)}>+ New project</button>}
              </div>
            ) : (
              <ul className="proj-grid">
                {rows.map(p => (
                  <li key={p.id} className={`proj-card pchip-${p.color}`}>
                    <div className="proj-card-head">
                      <span className="pchip-dot" aria-hidden="true" />
                      {/* The title's link covers the card; the items below are links of their own. */}
                      <Link to={`/projects/${p.id}`} className="proj-card-link"><b>{p.title}</b></Link>
                      {p.status !== 'active' && <span className={`proj-status ${p.status}`}>{p.status === 'done' ? 'Done' : 'Archived'}</span>}
                      <time className="proj-card-time" dateTime={p.updated_at} title={new Date(p.updated_at).toLocaleString()}>{since(p.updated_at)}</time>
                    </div>
                    {p.description && <p className="proj-card-desc">{p.description}</p>}
                    <Progress done={p.tasks.done} total={p.tasks.total} />
                    {p.items === 0 ? <p className="proj-card-empty">Nothing in it yet — add tasks, docs or designs from the project.</p> : <>
                      <div className="proj-kinds" aria-label="What is in it">
                        {Object.entries(p.kinds ?? {}).sort((a, b) => b[1] - a[1]).map(([type, n]) =>
                          <span key={type} className="proj-kind"><NavIcon name={KIND_LABEL[type]?.[2] ?? 'docs'} />{kindName(type, n)}</span>)}
                      </div>
                      {!!p.recent?.length && <ul className="proj-recent" aria-label="Latest in it">
                        {p.recent.map(it => <li key={it.id}><Link to={pageFor(it)}>
                          <NavIcon name={KIND_LABEL[it.type]?.[2] ?? 'docs'} /><span>{it.title}</span></Link></li>)}
                      </ul>}
                    </>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>
  )
}

/** Find any item in the workspace and file it into this project. */
function AddExisting({ projectId, inIt, onAdded, onCancel }: {
  projectId: string; inIt: Set<string>; onAdded: () => void; onCancel: () => void
}) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 150)
  const [hits, setHits] = useState<{ id: string; type: string; title: string; key?: string | null }[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const toast = useToast()
  useEffect(() => {
    if (!dq.trim()) { setHits(null); return }
    let live = true
    searchWorkspace(dq.trim()).then(r => live && setHits((r.hits ?? [])
      .filter(h => h.kind === 'object' && h.type !== 'project' && !inIt.has(h.id))
      .map(h => ({ id: h.id, type: h.type, title: h.title, key: h.key }))), () => live && setHits([]))
    return () => { live = false }
  }, [dq, inIt])
  return (
    <div className="linkpick proj-add">
      <div className="linkpick-row">
        <input autoFocus aria-label="Find work to add" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search tasks, docs, designs, videos, experiments…" />
        <button type="button" className="btn ghost" onClick={onCancel}>Done</button>
      </div>
      {hits !== null && (hits.length === 0 ? <p className="linkpick-none">Nothing else matches “{dq}”.</p> : (
        <ul aria-label="Matches">
          {hits.map(h => <li key={h.id}><button type="button" onClick={async () => {
            setErr(null)
            try { await tagProject(projectId, h.id); toast(`Added ${h.key ?? h.title}`); setHits(x => x?.filter(y => y.id !== h.id) ?? x); onAdded() }
            catch (e) { setErr(message(e)) }
          }}><span className="tp-okey">{h.key ?? h.type}</span> {h.title}</button></li>)}
        </ul>))}
      {err && <p className="p-warn" role="alert">{err}</p>}
    </div>
  )
}

function ItemRow({ it, onRemove }: { it: ProjectItem; onRemove: () => void }) {
  return (
    <li className="proj-item">
      <Link to={pageFor(it)}><span className="tp-okey">{it.key ?? it.type}</span><span className="proj-item-title">{it.title}</span></Link>
      {it.assignee && <span className="proj-item-who">{it.assignee.name}</span>}
      {it.type !== 'task' && it.status && <span className="proj-item-status">{it.status}</span>}
      <button type="button" className="pchip-x" aria-label={`Remove ${it.title} from the project`} onClick={onRemove}>×</button>
    </li>
  )
}

export function ProjectDetail() {
  const { id = '' } = useParams()
  const [data, setData] = useState<ProjectContents | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [filing, setFiling] = useState(false)
  const [editing, setEditing] = useState(false)
  const toast = useToast()

  const load = useCallback(() => projectItems(id).then(setData, e => setErr(message(e))), [id])
  useEffect(() => { setData(null); setErr(null); void load() }, [load])

  if (err && !data) return <div className="collection"><div className="dash-collection-shell"><p className="p-warn" role="alert">{err}</p>
    <Link to="/projects">← All projects</Link></div></div>
  if (!data) return <div className="collection"><div className="empty">Loading…</div></div>

  const p = data.project
  const tasks = data.items.task ?? []
  const inIt = new Set(Object.values(data.items).flat().map(i => i.id))
  const remove = async (it: ProjectItem) => {
    try { await untagProject(p.id, it.id); toast(`Removed ${it.key ?? it.title}`); await load() }
    catch (e) { setErr(message(e)) }
  }
  const setStatus = async (status: ProjectStatus) => {
    try { await updateProject(p.id, { status }); await activeProjects(true); await load() } catch (e) { setErr(message(e)) }
  }

  return (
    <div className="collection proj-page">
      <div className="dash-gallery-scroll"><div className="dash-collection-shell">
        {editing
          ? <header className={`proj-head pchip-${p.color}`}>
              <EditProject p={p} onDone={async () => { setEditing(false); await activeProjects(true); await load() }} /></header>
          : <div className={`pchip-${p.color}`}><DetailHead back={{ to: '/projects', label: 'Projects' }}
              title={<span className="proj-head-title"><span className="pchip-dot" aria-hidden="true" />{p.title}</span>}
              dot={p.status === 'active' ? 'blue' : p.status === 'done' ? 'green' : 'gray'}
              status={[<span>{p.status === 'active' ? 'Active' : p.status === 'done' ? 'Done' : 'Archived'}</span>]}
              actions={<>
                <button className="btn" onClick={() => setEditing(true)}>Edit</button>
                {p.status === 'active' && <button className="btn" onClick={() => void setStatus('done')}>Mark done</button>}
                {p.status !== 'active' && <button className="btn" onClick={() => void setStatus('active')}>Reopen</button>}
                {p.status !== 'archived' && <button className="btn ghost" onClick={() => void setStatus('archived')}>Archive</button>}
              </>}
              lede={<>{p.description && <p className="xhead-lede">{p.description}</p>}
                <div className="proj-head-progress"><Progress done={data.tasks.done} total={data.tasks.total} /></div></>} /></div>}
        {err && <p className="p-warn" role="alert">{err}</p>}

        {p.status !== 'archived' && <div className="proj-actions">
          <button className="btn action" onClick={() => setFiling(true)}>+ New task in this project</button>
          <button className="btn" aria-expanded={adding} onClick={() => setAdding(a => !a)}>Add existing work</button>
        </div>}
        {adding && <AddExisting projectId={p.id} inIt={inIt} onAdded={() => void load()} onCancel={() => setAdding(false)} />}

        <section className="proj-section" aria-label="Tasks">
          <h2>Tasks <span className="total">{data.tasks.total}</span></h2>
          {tasks.length === 0 ? <p className="tp-muted">No tasks yet. File one for each piece of the work — a service to move, a check to pass.</p> : (
            <div className="proj-lanes">
              {(['ready', 'flight', 'review', 'done'] as const).map(s => {
                const lane = tasks.filter(t => (t.status ?? 'ready') === s)
                return <div key={s} className="proj-lane" aria-label={LANE[s]}>
                  <h3>{LANE[s]} <span>{data.tasks[s]}</span></h3>
                  <ul>{lane.map(t => <ItemRow key={t.id} it={t} onRemove={() => void remove(t)} />)}</ul>
                </div>
              })}
            </div>
          )}
        </section>

        {KINDS.filter(([k]) => data.items[k]?.length).map(([k, label, icon]) => (
          <section key={k} className="proj-section" aria-label={label}>
            <h2><NavIcon name={icon} /> {label} <span className="total">{data.items[k].length}</span></h2>
            <ul className="proj-list">{data.items[k].map(it => <ItemRow key={it.id} it={it} onRemove={() => void remove(it)} />)}</ul>
          </section>
        ))}
        {data.hidden > 0 && <p className="tp-muted proj-hidden">{data.hidden} more {data.hidden === 1 ? 'item is' : 'items are'} in this project but not shared with you.</p>}
      </div></div>
      {filing && <TaskNew project={p} onClose={() => setFiling(false)} onCreated={async () => { setFiling(false); toast('Task filed in this project'); await load() }} />}
    </div>
  )
}

function EditProject({ p, onDone }: { p: ProjectContents['project']; onDone: () => void }) {
  const [title, setTitle] = useState(p.title)
  const [description, setDescription] = useState(p.description ?? '')
  const [color, setColor] = useState<ProjectColor>(p.color)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form className="proj-new" onSubmit={async e => {
      e.preventDefault()
      try { await updateProject(p.id, { title: title.trim(), description: description.trim() || null, color }); onDone() }
      catch (x) { setErr(message(x)) }
    }}>
      <label className="tp-field"><span>Name</span><input autoFocus value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></label>
      <label className="tp-field"><span>What it is for</span><textarea rows={2} value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} /></label>
      <fieldset className="proj-colors"><legend>Color</legend>
        {PROJECT_COLORS.map(c => <label key={c} className={`proj-color pchip-${c}${c === color ? ' on' : ''}`} title={c}>
          <input type="radio" name="color" value={c} checked={c === color} onChange={() => setColor(c)} />
          <span className="pchip-dot" aria-hidden="true" /><span className="dash-sr-only">{c}</span></label>)}
      </fieldset>
      <div className="tp-actions"><button className="btn action" disabled={!title.trim()}>Save</button>
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button></div>
      {err && <p className="p-warn" role="alert">{err}</p>}
    </form>
  )
}

