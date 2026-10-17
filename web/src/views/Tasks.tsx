import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  acceptTask, listBoard, releaseTask, startTask, submitTask,
  type TaskState, type WireBoard, type WireTask,
} from '../data/gateway'
import { ProjectFilter } from '../components/ProjectChips'
import { Glass } from '../components/ui'
import { useToast } from '../components/Shell'
import { ago, LANES, StateGlyph, TaskCard } from '../components/TaskCard'
import { TaskNew, TaskPanel, type Intent } from '../components/TaskPanel'

// Four lanes, and the one that matters is review. Agents do not procrastinate,
// so work does not pool in progress — it pools in front of the person who has
// to say yes, and the board's job is to show that.
//
// Every move is a verb the gateway checks. Dragging is a shortcut to the same
// verbs the panel offers; a drop that needs words — filing for review against
// the criteria, sending work back — opens the panel on that form instead of
// guessing them.

type Filter = 'all' | 'mine' | 'agents' | 'people'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'agents', label: 'With agents' },
  { id: 'people', label: 'Waiting on a person' },
]

type Verb = 'start' | 'release' | 'submit' | 'accept' | 'send_back'

/** The verb a drop from one lane to another means, if the caller may make it. */
export function moveOf(t: WireTask, to: TaskState): Verb | null {
  const y = t.you
  if (t.state === 'ready' && to === 'flight' && y.may_start) return 'start'
  if (t.state === 'flight' && to === 'ready' && y.may_release) return 'release'
  if (t.state === 'flight' && to === 'review' && y.may_submit) return 'submit'
  if (t.state === 'review' && to === 'done' && (y.may_accept || y.may_self_accept)) return 'accept'
  if (t.state === 'review' && to === 'flight' && y.may_send_back) return 'send_back'
  return null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TasksView() {
  const [board, setBoard] = useState<WireBoard | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [params, setParams] = useSearchParams()
  const open = params.get('task')
  const fullPage = !!open && open !== 'new' && params.get('view') === 'full'
  const [intent, setIntent] = useState<Intent>(null)
  const [drag, setDrag] = useState<WireTask | null>(null)
  const [over, setOver] = useState<TaskState | null>(null)
  const toast = useToast()

  const load = useCallback(() => listBoard()
    .then(b => { setBoard(b); setErr(null) })
    .catch(e => setErr(message(e))), [])

  // Agents work on their own clock, so a run that started elsewhere shows up
  // without a reload — quietly, and not while the tab is hidden.
  useEffect(() => {
    load()
    const tick = setInterval(() => { if (!document.hidden) load() }, 20_000)
    return () => clearInterval(tick)
  }, [load])

  const show = (id: string | null, why: Intent = null) => {
    setIntent(why)
    setParams(p => {
      const n = new URLSearchParams(p)
      if (id) n.set('task', id); else n.delete('task')
      if (!id || id === 'new') n.delete('view')
      return n
    })
  }

  // A URL-backed view of the same mounted task: expanding must not discard
  // an unsent comment, review note, or task edit. It is also safe to refresh.
  const resizeTask = () => setParams(p => {
    const n = new URLSearchParams(p)
    if (fullPage) n.delete('view'); else n.set('view', 'full')
    return n
  })

  useEffect(() => {
    if (!open || fullPage) return
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to an input's mention menu/editor while typing.
      if (e.key === 'Escape' && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]'))) show(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, fullPage])  // eslint-disable-line react-hooks/exhaustive-deps

  /** The task as the gateway now has it, in place — then the counts. */
  const changed = (t: WireTask) => {
    setBoard(b => b && { ...b, tasks: b.tasks.some(x => x.id === t.id)
      ? b.tasks.map(x => (x.id === t.id ? t : x)) : [t, ...b.tasks] })
    load()
  }

  const act = async (fn: () => Promise<{ task: WireTask }>, done: string) => {
    try { changed((await fn()).task); toast(done) }
    catch (e) { toast(message(e)); load() }
  }

  const drop = (to: TaskState) => {
    const t = drag
    setDrag(null); setOver(null)
    if (!t || t.state === to) return
    const verb = moveOf(t, to)
    if (!verb) {
      toast(t.state === 'review'
        ? 'Work in review is accepted or sent back — open it to decide'
        : `${t.key} can’t move there from ${LANES.find(l => l.id === t.state)!.label}`)
      return
    }
    if (verb === 'start') act(() => startTask(t.id, t.rev), `${t.key} is yours now`)
    else if (verb === 'release') act(() => releaseTask(t.id, t.rev), `${t.key} is back in Ready`)
    else if (verb === 'submit') {
      if (t.criteria.length) show(t.id, 'submit')
      else act(() => submitTask(t.id, t.rev, { criteria_met: [] }), `${t.key} filed for review`)
    } else if (verb === 'accept') {
      if (t.you.may_accept) act(() => acceptTask(t.id, t.rev), `${t.key} accepted`)
      else show(t.id, 'self_accept')
    } else show(t.id, 'send_back')
  }

  const me = board?.you.id
  const passes = useCallback((f: Filter, t: WireTask) =>
    f === 'all' ? true
      : f === 'mine' ? t.assignee?.id === me
      : f === 'agents' ? t.assignee?.kind === 'agent'
      : !!t.question || t.state === 'review', [me])
  // Filtered to one project: kept in the URL, so a project's board can be linked.
  const project = params.get('project') ?? ''
  const setProject = (id: string) => setParams(p => { const n = new URLSearchParams(p); if (id) n.set('project', id); else n.delete('project'); return n }, { replace: true })
  const onBoard = useMemo(() => {
    const seen = new Map<string, NonNullable<WireTask['projects']>[number]>()
    for (const t of board?.tasks ?? []) for (const p of t.projects ?? []) seen.set(p.id, p)
    return [...seen.values()].sort((a, b) => a.title.localeCompare(b.title))
  }, [board])
  const perProject = useMemo(() => {
    const n: Record<string, number> = {}
    for (const t of board?.tasks ?? []) for (const p of t.projects ?? []) n[p.id] = (n[p.id] ?? 0) + 1
    return n
  }, [board])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (board?.tasks ?? []).filter(t =>
      passes(filter, t) && (!needle || `${t.key} ${t.title}`.toLowerCase().includes(needle))
      && (!project || (t.projects ?? []).some(p => p.id === project)))
  }, [board, filter, q, passes, project])

  const inLane = (s: TaskState) => shown.filter(t => t.state === s)
    // What has waited longest first in review; newest first elsewhere.
    .sort((a, b) => (s === 'review' ? b.in_state_s - a.in_state_s : a.in_state_s - b.in_state_s))

  return (
    <div className={`board-page${open ? ' with-panel' : ''}${fullPage ? ' task-full-page' : ''}`}>
      <div className="bp-main" hidden={fullPage}>
      <div className="bp-head">
        <div>
          <h1 className="coll-title">Board {board && <span className="total">{board.tasks.length}</span>}</h1>
          <p className="coll-sub">Work for people and agents. An agent takes a task only once what done means is
            written down, and everything it finishes waits here for a person to accept.</p>
        </div>
        {board?.you.may.propose && <button className="btn action bp-new" onClick={() => show('new')}>+ New task</button>}
      </div>

      <div className="bp-tools">
        <div className="seg" role="tablist" aria-label="Show">
          {FILTERS.map(f => (
            <button key={f.id} role="tab" aria-selected={filter === f.id}
              className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
              {/* a real space, so it is read as "Waiting on a person 5" */}
              {board && <>{' '}<span className="seg-n">{board.tasks.filter(t => passes(f.id, t)).length}</span></>}
            </button>
          ))}
        </div>
        {(onBoard.length > 0 || project) && <ProjectFilter projects={onBoard} counts={perProject}
          value={project} onChange={setProject} />}
        <label className="bp-search">
          <Glass />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by title or key" aria-label="Filter tasks" />
        </label>
      </div>

      {err && !board ? (
        <div className="bp-error notice" role="alert">
          The board could not be loaded: {err} <button className="linkbtn" onClick={load}>Try again</button>
        </div>
      ) : !board ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="lanes">
          {LANES.map(lane => {
            const cards = inLane(lane.id)
            const legal = drag ? moveOf(drag, lane.id) !== null : false
            const stale = lane.id === 'review' && board.review_oldest_s >= 2 * 86400
            return (
              <section key={lane.id} aria-label={lane.label}
                className={`lane lane-${lane.id}${over === lane.id && legal ? ' over' : ''}${drag && !legal && drag.state !== lane.id ? ' shut' : ''}${stale ? ' stale' : ''}`}
                onDragOver={e => { if (legal) { e.preventDefault(); setOver(lane.id) } }}
                onDragLeave={() => setOver(o => (o === lane.id ? null : o))}
                onDrop={e => { e.preventDefault(); drop(lane.id) }}>
                <header className="lane-head">
                  <StateGlyph state={lane.id} />
                  <span className="lane-name">{lane.label}</span>
                  <span className="lane-n">{cards.length}</span>
                  {lane.id === 'flight' && board.running > 0 && (
                    <span className="lane-x" title="Agent runs live right now">{board.running} running</span>
                  )}
                  {lane.id === 'review' && board.counts.review > 0 && (
                    <span className={`lane-x${stale ? ' hot' : ''}`} title="The oldest thing waiting on a person">
                      oldest {ago(board.review_oldest_s)}
                    </span>
                  )}
                  {lane.id === 'ready' && board.you.may.propose && (
                    <button className="lane-add" aria-label="Add a task to Ready" title="Add a task"
                      onClick={() => show('new')}>
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </button>
                  )}
                </header>
                <div className="lane-cards">
                  {cards.map(t => (
                    <TaskCard key={t.id} t={t} selected={open === t.id}
                      onOpen={() => show(t.id)}
                      onDragStart={LANES.some(l => moveOf(t, l.id)) ? () => setDrag(t) : undefined}
                      onDragEnd={() => { setDrag(null); setOver(null) }} />
                  ))}
                  {cards.length === 0 && (
                    <div className="lane-empty">
                      {board.tasks.length === 0 && lane.id === 'ready'
                        ? <>Nothing on the board yet.{board.you.may.propose && <> <button className="linkbtn" onClick={() => show('new')}>File the first task</button></>}</>
                        : q || filter !== 'all' || project ? 'Nothing here matches.' : lane.empty}
                    </div>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
      </div>

      {open === 'new' && (
        <TaskNew onClose={() => show(null)}
          onCreated={t => { changed(t); toast(`${t.key} filed`); show(t.id) }} />
      )}
      {open && open !== 'new' && (
        <TaskPanel key={open} taskId={open} intent={intent} toast={toast}
          fullPage={fullPage} onToggleFullPage={resizeTask}
          onClose={() => show(null)} onChanged={changed}
          onGone={id => { setBoard(b => b && { ...b, tasks: b.tasks.filter(x => x.id !== id) }); show(null); load() }} />
      )}
    </div>
  )
}
