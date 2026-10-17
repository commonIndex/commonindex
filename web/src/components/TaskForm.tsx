import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { assignTask, listAgentsLive, listMembers, tagProject, type ProjectTag, type WireTask } from '../data/gateway'
import { ProjectChips } from './ProjectChips'

// ── the task form: filing a new one, and editing one ──────────────────────

export interface Fields { title: string; criteria: string; person: boolean; reason: string; detail: string
  /** Who works it, by actor id; '' for nobody. */
  assignee: string
  /** The projects a new task is filed into. An existing task's are its own chips. */
  projects: ProjectTag[] }

export const fieldsOf = (t?: WireTask): Fields => ({
  title: t?.title ?? '',
  criteria: (t?.criteria ?? []).map(c => c.text).join('\n'),
  person: !!t?.human_only, reason: t?.human_only ?? '', detail: t?.detail ?? '',
  assignee: t?.assignee?.id ?? '',
  projects: t?.projects ?? [],
})
/** What a task ticked "only a person" says, when nobody wrote more. Asking for
 *  a reason made the box a form to fill; ticking it is the whole decision. A
 *  task that already carries a reason keeps it. */
export const PERSON_ONLY = 'only a person can do it'
export const humanOnly = (f: Fields) => (f.person ? f.reason.trim() || PERSON_ONLY : null)
/** A task just filed, given to whoever the form named. Filed either way: an
 *  assignment refused leaves it unassigned on the board, not lost. */
export async function assigned(task: WireTask, who: string): Promise<WireTask> {
  if (!who) return task
  return assignTask(task.id, task.rev, who).then(r => r.task, () => task)
}
/** A task just filed, into each project the form named. Filed either way. */
export async function filedInto(task: WireTask, projects: ProjectTag[]): Promise<WireTask> {
  await Promise.all(projects.map(p => tagProject(p.id, task.id).catch(() => null)))
  return projects.length ? { ...task, projects: [...(task.projects ?? []), ...projects] } : task
}
export const lines = (s: string) => s.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)

interface Who { id: string; name: string
  /** An agent with no propose grant here could never file the work. */
  cannot?: string }

/** People who can work here, and agents — read once, for the picker. Either
 *  list failing leaves the other: a member who may not list members can still
 *  hand work to an agent. */
function useAssignees() {
  const [people, setPeople] = useState<Who[] | null>(null)
  const [agents, setAgents] = useState<Who[] | null>(null)
  useEffect(() => {
    let alive = true
    listMembers().then(r => alive && setPeople((r?.members ?? [])
      .filter(m => m.role !== 'viewer').map(m => ({ id: m.id, name: m.name }))), () => alive && setPeople([]))
    listAgentsLive().then(r => alive && setAgents((r?.agents ?? [])
      .map(a => ({ id: a.id, name: a.display,
        cannot: (a.may ?? []).some(m => ['propose', 'merge', 'admin'].includes(m)) ? undefined
          : 'no access here' }))), () => alive && setAgents([]))
    return () => { alive = false }
  }, [])
  return { people, agents }
}

export function TaskForm({ start, busy, submitLabel, onSubmit, onCancel, assignable = true, current, keepAssigned = false, withProjects = false }: {
  start: Fields
  busy: boolean
  submitLabel: string
  onSubmit: (f: Fields) => void
  onCancel: () => void
  /** Whether the caller may say who works it (the task's `you.may_assign`). */
  assignable?: boolean
  /** Who has it now, named even when they are not in the lists. */
  current?: Who | null
  /** In progress: it changes hands, but is given back rather than unassigned. */
  keepAssigned?: boolean
  /** A new task: say which projects it is filed into. */
  withProjects?: boolean
}) {
  const [f, setF] = useState(start)
  const id = useId()
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF(v => ({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }))
  const checks = lines(f.criteria)
  const bad = !f.title.trim()
  const { people, agents } = useAssignees()
  // The gateway's rule: an agent checks its work against what done means. A
  // people-only task is not a dead end — picking an agent unticks the box, and
  // says so — but nothing to check against is.
  const noAgent = !checks.length ? 'write what done means first' : null
  const isAgent = !!agents?.some(a => a.id === f.assignee)
  const [unticked, setUnticked] = useState(false)
  const pick = (assignee: string) => {
    const agent = !!agents?.some(a => a.id === assignee)
    setUnticked(agent && f.person)
    setF(v => ({ ...v, assignee, person: agent ? false : v.person }))
  }
  return (
    <form className="tp-form" onSubmit={e => { e.preventDefault(); if (!bad) onSubmit(f) }}>
      <label className="tp-field">
        <span>Title</span>
        <input autoFocus value={f.title} onChange={set('title')} maxLength={200}
          placeholder="Document the retry policy for webhooks" />
      </label>
      {/* The hint describes the field rather than naming it, so a screen reader
          announces "What done means" and then what the checks are for. */}
      <div className="tp-field">
        <label htmlFor={`${id}-done`}>What done means</label>
        <textarea id={`${id}-done`} aria-describedby={`${id}-done-hint`} rows={4} value={f.criteria}
          onChange={set('criteria')}
          placeholder={'One check per line, e.g.\nEvery spec states the same retry number\nEach edit cites the PR that changed it'} />
        <small id={`${id}-done-hint`}>{checks.length
          ? `${checks.length} ${checks.length === 1 ? 'check' : 'checks'}. Whoever takes it checks the work against these before filing it for review.`
          : 'Without these, no agent can take it — there would be nothing for it to check its work against.'}</small>
      </div>
      <label className="tp-check">
        <input type="checkbox" checked={f.person} onChange={set('person')} />
        Only a person can do this
      </label>
      {assignable && (
        <div className="tp-field">
          <span id={`${id}-who`}>Assignee</span>
          <AssigneePicker labelledBy={`${id}-who`} describedBy={`${id}-who-hint`} value={f.assignee} onPick={pick}
            people={people} agents={agents} current={current ?? null} noAgent={noAgent}
            allowNone={!(keepAssigned && start.assignee)} />
          <small id={`${id}-who-hint`}>{unticked && isAgent
            ? '“Only a person can do this” was unticked — an agent is doing it. It goes to the agent’s inbox when you save.'
            : isAgent && f.assignee !== start.assignee
            ? 'Handed over when you save: it goes to the agent’s inbox and moves to In progress.'
            : f.assignee && f.assignee !== start.assignee ? 'It is theirs to start.' : 'Who works it. Anyone can still start an unassigned task.'}</small>
        </div>
      )}
      {withProjects && <div className="tp-field">
        <span>Projects <em>optional</em></span>
        <ProjectChips value={f.projects} onChange={projects => setF(v => ({ ...v, projects }))} />
      </div>}
      <label className="tp-field">
        <span>Detail <em>optional</em></span>
        <textarea rows={3} value={f.detail} onChange={set('detail')}
          placeholder="Context the title cannot carry" />
      </label>
      <div className="tp-actions">
        <button className="btn primary" disabled={busy || bad}>{busy ? 'Saving…' : submitLabel}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}


/** Pick who works a task: a search over the workspace's people and its
 *  agents, an agent marked as one, and why one cannot be picked when it cannot. */
function AssigneePicker({ value, onPick, people, agents, current, noAgent, allowNone, labelledBy, describedBy }: {
  value: string
  onPick: (id: string) => void
  people: Who[] | null
  agents: Who[] | null
  current: Who | null
  noAgent: string | null
  allowNone: boolean
  labelledBy: string
  describedBy: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  type Row = { id: string; name: string; agent: boolean; why?: string }
  const known = [...(people ?? []), ...(agents ?? [])]
  const extra: Row[] = current && !known.some(w => w.id === current.id) ? [{ ...current, agent: false }] : []
  const needle = q.trim().toLowerCase()
  const match = (w: { name: string; id: string }) => !needle || w.name.toLowerCase().includes(needle) || w.id.toLowerCase().includes(needle)
  const personRows: Row[] = [...extra, ...(people ?? []).map(p => ({ ...p, agent: false }))].filter(match)
  const agentRows: Row[] = (agents ?? []).map(a => ({ id: a.id, name: a.name, agent: true,
    why: a.id === value ? undefined : a.cannot ?? noAgent ?? undefined })).filter(match)
  const rows: Row[] = [...(allowNone && !needle ? [{ id: '', name: 'Unassigned', agent: false }] : []), ...personRows, ...agentRows]
  const pickable = rows.filter(r => !r.why)
  const chosen = rows.find(r => r.id === value) ?? [...extra, ...known.map(w => ({ ...w, agent: !!agents?.some(a => a.id === w.id) }))]
    .find(r => r.id === value)

  const choose = (r: Row) => { if (r.why) return; onPick(r.id); setOpen(false); setQ('') }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, pickable.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (pickable[active]) choose(pickable[active]) }
  }
  const option = (r: Row) => {
    const i = pickable.indexOf(r)
    return <li key={r.id || 'none'} id={`${listId}-${r.id || 'none'}`} role="option" aria-selected={r.id === value}
      aria-disabled={!!r.why} className={`apick-row${i === active && !r.why ? ' active' : ''}${r.why ? ' off' : ''}`}
      onMouseEnter={() => i >= 0 && setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => choose(r)}>
      {r.id ? <span className={`apick-face${r.agent ? ' agent' : ''}`} aria-hidden="true">{r.name.slice(0, 1).toUpperCase()}</span>
        : <span className="apick-face none" aria-hidden="true">–</span>}
      <span className="apick-name">{r.name}</span>
      {r.agent && <span className="apick-tag">Agent</span>}
      {r.why && <span className="apick-why">{r.why}</span>}
      {r.agent && r.why === 'no access here' && <Link className="apick-fix" to={`/agents/${r.id}`}
        onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>Give access</Link>}
      {r.id === value && <span className="apick-check" aria-hidden="true">✓</span>}
    </li>
  }

  return (
    <div className="apick" ref={box}>
      <button type="button" className="apick-btn" aria-haspopup="listbox" aria-expanded={open}
        aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={people === null && agents === null}
        onClick={() => { setOpen(o => !o); setActive(0) }}>
        {chosen?.id ? <>
          <span className={`apick-face${chosen.agent ? ' agent' : ''}`} aria-hidden="true">{chosen.name.slice(0, 1).toUpperCase()}</span>
          <span className="apick-name">{chosen.name}</span>{chosen.agent && <span className="apick-tag">Agent</span>}
        </> : <span className="apick-name placeholder">{people === null && agents === null ? 'Loading…' : 'Unassigned'}</span>}
        <svg className="apick-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="apick-pop">
          <input autoFocus className="apick-q" role="combobox" aria-expanded="true" aria-controls={listId}
            aria-activedescendant={pickable[active] ? `${listId}-${pickable[active].id || 'none'}` : undefined}
            aria-label="Search people and agents" placeholder="Search people and agents…" value={q}
            onChange={e => { setQ(e.target.value); setActive(0) }} onKeyDown={onKey} />
          <ul className="apick-list" id={listId} role="listbox" aria-label="Assignee">
            {allowNone && !needle && option(rows[0])}
            {personRows.length > 0 && <li className="apick-group" role="presentation">People</li>}
            {personRows.map(option)}
            {agentRows.length > 0 && <li className="apick-group" role="presentation">Agents</li>}
            {agentRows.map(option)}
            {!personRows.length && !agentRows.length && <li className="apick-empty" role="presentation">No one matches “{q.trim()}”.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
