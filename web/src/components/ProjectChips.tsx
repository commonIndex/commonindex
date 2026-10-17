import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createProject, listProjects, PROJECT_COLORS, projectsOf, tagProject, untagProject,
  type ProjectTag, type WireProject,
} from '../data/gateway'

// A project is a tag with a page: the chip names it in its color, links to the
// page, and the same picker files a task, a doc, a design or a video into it.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** One project, as a chip. */
export function ProjectChip({ p, onRemove, link = true }: { p: ProjectTag; onRemove?: () => void; link?: boolean }) {
  const body = <><span className="pchip-dot" aria-hidden="true" /><span className="pchip-name">{p.title}</span></>
  return (
    <span className={`pchip pchip-${p.color}`} title={p.status === 'active' ? p.title : `${p.title} · ${p.status}`}>
      {link ? <Link to={`/projects/${p.id}`} className="pchip-link">{body}</Link> : body}
      {onRemove && <button type="button" className="pchip-x" aria-label={`Remove from ${p.title}`} onClick={onRemove}>×</button>}
    </span>
  )
}

/** The active projects, read once and shared by every picker on the page. */
let cached: Promise<WireProject[]> | null = null
export const activeProjects = (fresh = false) => {
  if (fresh || !cached) cached = listProjects('active').then(r => r.projects, e => { cached = null; throw e })
  return cached
}

/** Pick a project, or name a new one. */
function Picker({ taken, onPick, onClose }: {
  taken: string[]
  onPick: (p: ProjectTag) => void | Promise<void>
  onClose: () => void
}) {
  const [all, setAll] = useState<WireProject[] | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    let alive = true
    activeProjects().then(r => alive && setAll(r), e => alive && (setAll([]), setErr(message(e))))
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [onClose])

  const needle = q.trim().toLowerCase()
  const rows = useMemo(() => (all ?? []).filter(p => !taken.includes(p.id)
    && (!needle || p.title.toLowerCase().includes(needle))), [all, taken, needle])
  const exact = (all ?? []).some(p => p.title.trim().toLowerCase() === needle)

  const pick = async (p: ProjectTag) => {
    setBusy(true); setErr(null)
    try { await onPick(p); onClose() } catch (e) { setErr(message(e)) } finally { setBusy(false) }
  }
  const create = async () => {
    setBusy(true); setErr(null)
    try {
      // A new project takes the next color along, so two made in a row differ.
      const color = PROJECT_COLORS[(all?.length ?? 0) % PROJECT_COLORS.length]
      const made = await createProject({ title: q.trim(), color })
      await activeProjects(true)
      await onPick({ id: made.id, key: null, title: q.trim(), color, status: 'active' })
      onClose()
    } catch (e) { setErr(message(e)) } finally { setBusy(false) }
  }

  return (
    <div className="ppick" ref={box} role="dialog" aria-label="Add to a project">
      <input autoFocus className="ppick-q" aria-label="Find or name a project" placeholder="Find or name a project…"
        value={q} onChange={e => setQ(e.target.value)} disabled={busy} aria-controls={`${id}-list`}
        onKeyDown={e => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (rows[0]) void pick(rows[0])
          else if (needle && !exact) void create()
        }} />
      <ul className="ppick-list" id={`${id}-list`}>
        {all === null ? <li className="ppick-empty">Loading…</li> : rows.map(p => (
          <li key={p.id}><button type="button" disabled={busy} onClick={() => void pick(p)}>
            <ProjectChip p={p} link={false} />
            <span className="ppick-meta">{p.tasks.total ? `${p.tasks.done}/${p.tasks.total} tasks done` : `${p.items} in it`}</span>
          </button></li>
        ))}
        {all !== null && !rows.length && !needle && <li className="ppick-empty">No other projects yet — type a name to start one.</li>}
        {needle && !exact && <li><button type="button" className="ppick-new" disabled={busy} onClick={() => void create()}>
          + New project “{q.trim()}”</button></li>}
      </ul>
      {err && <p className="p-warn" role="alert">{err}</p>}
    </div>
  )
}

/** The projects an item is in, and a way to add it to another. Bound to an
 *  item (`about`), every change is saved as it is made; without one it is a
 *  form field — a task not yet filed — and `onChange` is told instead. */
export function ProjectChips({ about, value, onChange, initial, readOnly = false, compact = false }: {
  about?: { id: string; type: string }
  value?: ProjectTag[]
  onChange?: (v: ProjectTag[]) => void
  initial?: ProjectTag[]
  readOnly?: boolean
  compact?: boolean
}) {
  const [own, setOwn] = useState<ProjectTag[] | null>(initial ?? (about ? null : []))
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const tags = value ?? own ?? []

  const aboutId = about?.id
  const given = !!initial
  useEffect(() => {
    if (!aboutId || given) return
    let alive = true
    projectsOf([aboutId]).then(r => alive && setOwn(r?.projects?.[aboutId] ?? []), () => alive && setOwn([]))
    return () => { alive = false }
  }, [aboutId, given])

  const set = (next: ProjectTag[]) => { if (value === undefined) setOwn(next); onChange?.(next) }
  const add = async (p: ProjectTag) => {
    if (about) await tagProject(p.id, about.id)
    set([...tags, p])
  }
  const remove = async (p: ProjectTag) => {
    setErr(null)
    try {
      if (about) await untagProject(p.id, about.id)
      set(tags.filter(t => t.id !== p.id))
    } catch (e) { setErr(message(e)) }
  }

  if (about && own === null && value === undefined) return <span className="pchips pchips-loading" aria-hidden="true" />
  if (readOnly && !tags.length) return null
  return (
    <div className={`pchips${compact ? ' compact' : ''}`} role="group" aria-label="Projects">
      {tags.map(p => <ProjectChip key={p.id} p={p} onRemove={readOnly ? undefined : () => void remove(p)} />)}
      {!readOnly && <span className="pchips-add">
        <button type="button" className="pchip-add" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {tags.length ? '+' : '+ Project'}
        </button>
        {open && <Picker taken={tags.map(t => t.id)} onPick={add} onClose={() => setOpen(false)} />}
      </span>}
      {err && <span className="p-warn" role="alert">{err}</span>}
    </div>
  )
}

/** The Projects button an item's header carries, beside Tasks and Comments:
 *  its projects' colors at a glance, and the chips and picker on click. */
export function ProjectsButton({ about }: { about: { id: string; type: string } }) {
  const [tags, setTags] = useState<ProjectTag[] | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const id = about.id

  useEffect(() => {
    let alive = true
    projectsOf([id]).then(r => alive && setTags(r?.projects?.[id] ?? []), () => alive && setTags([]))
    return () => { alive = false }
  }, [id])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.ppick')) setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (box.current && !box.current.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const n = tags?.length ?? 0
  return (
    <div className="projbtn" ref={box}>
      <button type="button" className={`btn projects-btn${open ? ' on' : ''}`} aria-expanded={open}
        onClick={() => setOpen(o => !o)} title={n ? tags!.map(t => t.title).join(', ') : 'Add to a project'}>
        {n ? <span className="projbtn-dots" aria-hidden="true">{tags!.slice(0, 3).map(t =>
          <span key={t.id} className={`pchip-dot pchip-${t.color}`} />)}</span>
          : <NavGlyph />}
        {n === 1 ? <span className="projbtn-name">{tags![0].title}</span> : 'Projects'}
        {n > 1 && <span className="comments-n">{n}</span>}
      </button>
      {open && tags !== null && (
        <div className="tasks-pop projects-pop" role="dialog" aria-label="Projects">
          <p className="projects-pop-lede">{n ? 'In these projects' : 'Not in a project yet'}</p>
          <ProjectChips about={about} initial={tags} onChange={setTags} />
        </div>
      )}
    </div>
  )
}

function NavGlyph() {
  return <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15z" />
  </svg>
}

/** The board's project filter: a button drawn like the board's other
 *  controls, opening the projects on the board — each in its color, with how
 *  many of its tasks are there — and a search once there are more than a few. */
export function ProjectFilter({ projects, counts, value, onChange }: {
  projects: ProjectTag[]
  counts: Record<string, number>
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const chosen = projects.find(p => p.id === value)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const needle = q.trim().toLowerCase()
  const rows = projects.filter(p => !needle || p.title.toLowerCase().includes(needle))
  const pick = (id: string) => { onChange(id); setOpen(false); setQ('') }

  return (
    <div className="pfilter" ref={box}>
      <button type="button" className={`pfilter-btn${chosen ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={chosen ? `Project: ${chosen.title}` : 'Project: all'} onClick={() => setOpen(o => !o)}>
        {chosen ? <span className={`pchip-dot pchip-${chosen.color}`} aria-hidden="true" /> : <FolderGlyph />}
        <span className="pfilter-name">{chosen ? chosen.title : 'All projects'}</span>
        <svg className="pfilter-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="pfilter-pop" role="menu" aria-label="Show tasks in">
          {projects.length > 6 && <input autoFocus className="ppick-q" aria-label="Find a project" placeholder="Find a project…"
            value={q} onChange={e => setQ(e.target.value)} />}
          <button type="button" role="menuitemradio" aria-checked={!value} className="pfilter-item" onClick={() => pick('')}>
            <FolderGlyph /><span className="pfilter-name">All projects</span>
            {!value && <Check />}
          </button>
          {rows.map(p => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === value} className="pfilter-item" onClick={() => pick(p.id)}>
              <span className={`pchip-dot pchip-${p.color}`} aria-hidden="true" />
              <span className="pfilter-name">{p.title}</span>
              <span className="pfilter-n">{counts[p.id] ?? 0}</span>
              {p.id === value && <Check />}
            </button>
          ))}
          {!rows.length && <p className="ppick-empty">No project matches “{q.trim()}”.</p>}
          <Link to="/projects" className="pfilter-all" onClick={() => setOpen(false)}>All projects page →</Link>
        </div>
      )}
    </div>
  )
}

function FolderGlyph() {
  return <svg className="pfilter-glyph" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15z" />
  </svg>
}

function Check() {
  return <svg className="pfilter-check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
