import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  fileTask, linkedTasks, linkTask, projectsOf, searchWorkspace, type ProjectTag,
  type TaskRel, type WireLinkedTask, type WireTask,
} from '../data/gateway'
import { useDebounced } from '../hooks'
import { useToast } from './Shell'
import { StateGlyph } from './TaskCard'
import { assigned, fieldsOf, filedInto, humanOnly, lines, TaskForm } from './TaskForm'

// Work used to start only on the Board: a comment, a failing panel or an
// experiment's decision could not become a task where it was noticed, and a
// task could not point back at what it was about. These are the pieces that
// let it — from the thing, to the task, and back.

/** Anything that changes which tasks are linked to what says so, and the
 *  Tasks buttons re-read. */
export const TASKS_CHANGED = 'tasks:changed'
const tasksChanged = () => window.dispatchEvent(new Event(TASKS_CHANGED))

/** What a task comes from, or is about. */
export interface About { id: string; type: string; title: string; key?: string | null }

/** Objects in the space can be linked; a skill or an agent is not one. */
export const linkable = (type: string) => type !== 'skill' && type !== 'agent'

/** How a task relates to the thing whose page lists it. */
const REL_HERE: Record<TaskRel, string> = { caused: 'came from this', touches: 'touches this', depends: 'waits on this' }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** File a task from where it was noticed, linked back to it. */
export function MakeTaskDialog({ about, prefill, rel = 'caused', onClose, onMade }: {
  about: About
  prefill?: { title?: string; detail?: string }
  /** `caused` when the task came from it; `touches` when the work changes it. */
  rel?: TaskRel
  onClose: () => void
  onMade?: (t: WireTask) => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toast = useToast()
  // A task made from a doc in a project starts in that project too.
  const [projects, setProjects] = useState<ProjectTag[] | null>(linkable(about.type) ? null : [])
  useEffect(() => {
    if (!linkable(about.type)) return
    let alive = true
    projectsOf([about.id]).then(r => alive && setProjects(r?.projects?.[about.id] ?? []), () => alive && setProjects([]))
    return () => { alive = false }
  }, [about.id, about.type])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="overlay mtask-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mtask" role="dialog" aria-label="Make a task">
        <div className="mtask-head">
          <div><b>Make a task</b><span>{rel === 'touches' ? 'about' : 'from'} {about.title}</span></div>
          <button type="button" className="tp-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {projects === null ? <p className="tasks-empty">Loading…</p> :
        <TaskForm start={{ ...fieldsOf(), title: prefill?.title ?? '', detail: prefill?.detail ?? '', projects }}
          withProjects busy={busy} submitLabel="Make the task" onCancel={onClose}
          onSubmit={async f => {
            setBusy(true); setErr(null)
            try {
              const r = await fileTask({ title: f.title.trim(), criteria: lines(f.criteria),
                human_only: humanOnly(f), detail: f.detail.trim() || null })
              // Assigned before it is linked: the link is a revision, and assigning names the one it read.
              const task = await filedInto(await assigned(r.task, f.assignee), f.projects)
              let linked = false
              if (linkable(about.type)) {
                // Made either way: a link that fails is said, not a reason to lose the task.
                linked = await linkTask(r.task.id, about.id, rel).then(() => true, () => false)
              }
              tasksChanged()
              toast(`Made ${task.key} — it is on the board${linked ? `, linked to ${about.title}` : ''}`)
              await onMade?.(task)
              onClose()
            } catch (e) { setErr(message(e)) } finally { setBusy(false) }
          }} />}
        {err && <p className="p-warn" role="alert">{err}</p>}
      </div>
    </div>,
    document.body)
}

/** The Tasks button an object's header carries, beside Comments: the work
 *  linked to this thing, and a way to add to it. */
export function TasksButton({ about }: { about: About }) {
  const [tasks, setTasks] = useState<WireLinkedTask[] | null>(null)
  const [open, setOpen] = useState(false)
  const [making, setMaking] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const load = useCallback(() => linkedTasks(about.id)
    .then(r => setTasks(Array.isArray(r?.tasks) ? r.tasks : []))
    .catch(() => setTasks([])), [about.id])

  useEffect(() => {
    load()
    window.addEventListener(TASKS_CHANGED, load)
    return () => window.removeEventListener(TASKS_CHANGED, load)
  }, [load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const n = tasks?.length ?? 0
  return (
    <div className="tasksbtn" ref={box}>
      <button type="button" className={`btn tasks-btn${open ? ' on' : ''}`} aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 2.5h10v11H3zM5.5 6l1.5 1.5L10 4.5M5.5 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Tasks{n ? <>{' '}<span className="comments-n">{n}</span></> : null}
      </button>
      {open && (
        <div className="tasks-pop" role="dialog" aria-label={`Tasks about ${about.title}`}>
          {tasks === null ? <p className="tasks-empty">Loading…</p>
            : tasks.length === 0 ? <p className="tasks-empty">No task is linked to this yet.</p>
            : (
              <ul>
                {tasks.map(t => (
                  <li key={t.id}>
                    <Link to={`/board?task=${t.id}`} onClick={() => setOpen(false)}>
                      <StateGlyph state={t.state} />
                      <span className="tp-okey">{t.key}</span>
                      <span className="tasks-title">{t.title}</span>
                      <span className="tasks-rel">{REL_HERE[t.rel[0]] ?? ''}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          <button type="button" className="btn action" onClick={() => { setOpen(false); setMaking(true) }}>
            Make a task
          </button>
        </div>
      )}
      {making && <MakeTaskDialog about={about} onClose={() => setMaking(false)} />}
    </div>
  )
}

/** Find something in the workspace to link a task to, and say how it relates. */
export function LinkPicker({ exclude, onPick, onCancel }: {
  exclude: string
  onPick: (o: About, rel: TaskRel) => void
  onCancel: () => void
}) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 150)
  const [rel, setRel] = useState<TaskRel>('touches')
  const [hits, setHits] = useState<About[] | null>(null)

  useEffect(() => {
    if (!dq.trim()) { setHits(null); return }
    let live = true
    searchWorkspace(dq.trim())
      .then(r => {
        if (!live) return
        setHits((r.hits ?? []).filter(h => h.kind === 'object' && h.id !== exclude)
          .map(h => ({ id: h.id, type: h.type, title: h.title, key: h.key })))
      })
      .catch(() => { if (live) setHits([]) })
    return () => { live = false }
  }, [dq, exclude])

  return (
    <div className="linkpick">
      <div className="linkpick-row">
        <select aria-label="How it relates" value={rel} onChange={e => setRel(e.target.value as TaskRel)}>
          <option value="caused">Came from</option>
          <option value="touches">Touches</option>
          <option value="depends">Depends on</option>
        </select>
        <input autoFocus aria-label="Find what to link" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search dashboards, docs, experiments…" />
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {hits !== null && (hits.length === 0
        ? <p className="linkpick-none">Nothing in the workspace matches “{dq}”.</p>
        : (
          <ul aria-label="Matches">
            {hits.map(h => (
              <li key={h.id}>
                <button type="button" onClick={() => onPick(h, rel)}>
                  <span className="tp-okey">{h.key ?? h.type}</span>{h.title}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}
