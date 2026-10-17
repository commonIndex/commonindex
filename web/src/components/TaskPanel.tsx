import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  acceptTask, answerTask, assignTask, deleteTask, fileTask, getTask, handTask, linkTask, releaseTask, reviseTask,
  sendBackTask, startTask, submitTask, unlinkTask,
  type ProjectTag, type WireTask, type WireTaskRoute, type WireTaskStep,
} from '../data/gateway'
import { ago, agoText, Face, LANES, span, StateGlyph } from './TaskCard'
import { Thread } from './discussion/Thread'
import { assigned, fieldsOf, filedInto, humanOnly, lines, PERSON_ONLY, TaskForm } from './TaskForm'
import { ProjectChips } from './ProjectChips'
import { LinkPicker } from './TaskLinks'
import { pageFor } from '../data/links'
import { NavIcon } from './NavIcon'

type Detail = WireTask & { history: WireTaskStep[]; routes: WireTaskRoute[] }
/** What the board asked the panel to open on — a drop that needs words. */
export type Intent = 'submit' | 'send_back' | 'self_accept' | null
type Mode = Intent | 'hand' | 'edit' | 'delete'

const LANE = Object.fromEntries(LANES.map(l => [l.id, l.label])) as Record<WireTask['state'], string>
const REL: Record<string, string> = { caused: 'Came from', touches: 'Touches', depends: 'Depends on' }
const since = (at: string) => agoText(Math.max(0, (Date.now() - Date.parse(at)) / 1000))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function ObjectRef({ o }: { o: { id: string; type: string; key: string | null; title: string | null; available?: false } }) {
  const icon = { doc: 'docs', dashboard: 'dashboards', experiment: 'experiments', design: 'designs',
    video: 'videos', task: 'board', code_file: 'code', channel: 'channel' }[o.type] ?? 'docs'
  // Linked, but not shared with this reader: that it is there, not what it is.
  if (o.available === false) return <span className="tp-obj tp-obj-locked">
    <span className="tp-object-icon"><NavIcon name={icon} /></span>
    <span className="tp-object-copy"><span className="tp-okey">{o.type.replace('_', ' ')}</span><span>A {o.type.replace('_', ' ')} you don’t have access to</span></span>
  </span>
  return <Link className="tp-obj" to={pageFor(o)}>
    <span className="tp-object-icon"><NavIcon name={icon} /></span>
    <span className="tp-object-copy"><span className="tp-okey">{o.key ?? o.type}</span><span>{o.title}</span></span>
    <span className="tp-object-arrow" aria-hidden="true">↗</span>
  </Link>
}

/** Filing a new task. It lands in Ready, unassigned unless the form names someone. */
export function TaskNew({ onCreated, onClose, project }: {
  onCreated: (t: WireTask) => void; onClose: () => void
  /** Filed from a project's page: into it, unless the form takes it out. */
  project?: ProjectTag
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <aside className="tpanel" role="dialog" aria-label="New task">
      <div className="tp-bar">
        <span className="tp-crumb">New task</span>
        <button className="tp-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="tp-body">
        <h2 className="tp-title">File a task</h2>
        <p className="tp-lede">It starts in Ready. Anyone can start it; an agent can take it once what done means is written down.</p>
        <TaskForm start={{ ...fieldsOf(), projects: project ? [project] : [] }} withProjects busy={busy} submitLabel="File task" onCancel={onClose}
          onSubmit={async f => {
            setBusy(true); setErr(null)
            try {
              const r = await fileTask({ title: f.title.trim(), criteria: lines(f.criteria),
                human_only: humanOnly(f), detail: f.detail.trim() || null })
              onCreated(await filedInto(await assigned(r.task, f.assignee), f.projects))
            } catch (e) { setErr(message(e)) } finally { setBusy(false) }
          }} />
        {err && <p className="p-warn" role="alert">{err}</p>}
      </div>
    </aside>
  )
}

// ── one task ──────────────────────────────────────────────────────────────

/** Updates first: how the work is going, by day. Then the conversation, then what moved. */
const TABS = ['updates', 'comments', 'activity'] as const
const TAB_LABEL: Record<(typeof TABS)[number], string> = { updates: 'Updates', comments: 'Comments', activity: 'Activity' }

export function TaskPanel({ taskId, intent, onClose, onChanged, onGone, toast, fullPage = false, onToggleFullPage }: {
  taskId: string
  intent: Intent
  onClose: () => void
  /** The task as the gateway now has it, so the board can move its card. */
  onChanged: (t: WireTask) => void
  onGone: (id: string) => void
  toast: (msg: string) => void
  fullPage?: boolean
  onToggleFullPage?: () => void
}) {
  const [t, setT] = useState<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>(intent)
  const [linking, setLinking] = useState(false)
  const [conversation, setConversation] = useState<'updates' | 'comments' | 'activity'>('updates')
  const tabsId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const request = useRef(0)

  const load = useCallback(async () => {
    const current = ++request.current
    try {
      const r = await getTask(taskId)
      if (current === request.current) { setT(r.task); setErr(null) }
    } catch (e) { if (current === request.current) setErr(message(e)) }
  }, [taskId])

  useEffect(() => {
    setT(null); setMode(intent); load()
    return () => { request.current++ }
  }, [taskId, intent, load])
  useEffect(() => { if (t) heading.current?.focus() }, [t?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<{ task: WireTask }>, done: string) => {
    setBusy(true); setErr(null)
    try {
      const r = await fn()
      onChanged(r.task); toast(done); setMode(null)
      await load()
    } catch (e) { setErr(message(e)) } finally { setBusy(false) }
  }

  if (!t) {
    return (
      <section className={`tpanel task-detail${fullPage ? ' is-full-page' : ''}`} role={fullPage ? 'region' : 'dialog'} aria-label="Task">
        <div className="tp-bar"><span className="tp-crumb">Task</span>
          <button className={fullPage ? 'btn' : 'tp-x'} aria-label={fullPage ? 'Back to board' : 'Close'} onClick={onClose}>{fullPage ? '← Back to board' : '×'}</button></div>
        <div className="tp-body">{err ? <div className="tp-load-error" role="alert"><h2>Could not load this task</h2>
          <p>{err}</p><button className="btn" onClick={load}>Try again</button></div>
          : <p className="tp-lede" role="status">Loading task…</p>}</div>
      </section>
    )
  }

  const you = t.you
  const names = Object.fromEntries(t.routes.map(r => [r.agent.id, r.agent.name]))
  const met = t.criteria.filter(c => c.met === true).length
  const Title = fullPage ? 'h1' : 'h2'
  return (
    <section className={`tpanel task-detail${fullPage ? ' is-full-page' : ''}`} role={fullPage ? 'region' : 'dialog'} aria-label={`${t.key} ${t.title}`}>
      <div className="tp-bar">
        {fullPage && <button className="btn ghost tp-back" aria-label="Back to board" onClick={onClose}>← Back to board</button>}
        <span className="tp-crumb"><span className={`tp-state state-${t.state}`}><StateGlyph state={t.state} />{LANE[t.state]}</span><span className="tp-key">{t.key}</span></span>
        {you.may_edit && mode !== 'edit' && <button className="btn ghost tp-edit" onClick={() => setMode('edit')}>Edit</button>}
        {onToggleFullPage && <button className="btn ghost tp-expand" onClick={onToggleFullPage}
          aria-label={fullPage ? 'Show side panel' : 'Open full page'} title={fullPage ? 'Show side panel' : 'Open full page'}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {fullPage ? <><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M12 3v14" /></>
              : <><path d="M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6" /></>}
          </svg><span>{fullPage ? 'Side panel' : 'Full page'}</span>
        </button>}
        {!fullPage && <button className="tp-x" aria-label="Close" onClick={onClose}>×</button>}
      </div>

      <div className="tp-body">
        {err && <p className="p-warn" role="alert">{err}</p>}
        {mode === 'edit' ? (
          <TaskForm start={fieldsOf(t)} busy={busy} submitLabel="Save changes" onCancel={() => setMode(null)}
            assignable={t.you.may_assign ?? false} keepAssigned={t.state === 'flight'}
            current={t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null}
            onSubmit={f => run(async () => {
              const saved = await reviseTask(t.id, t.rev, {
                title: f.title.trim(), criteria: lines(f.criteria), detail: f.detail.trim() || null,
                human_only: humanOnly(f) })
              // After the edit: an agent is checked against what done means as saved.
              return f.assignee === (t.assignee?.id ?? '') ? saved
                : assignTask(t.id, saved.task.rev, f.assignee || null)
            }, `${t.key} saved`)} />
        ) : <>
          <header className="tp-heading">
            <Title className="tp-title" tabIndex={-1} ref={heading}>{t.title}</Title>
            <p className="tp-lede">Created by {t.created_by.name} · <time dateTime={t.created_at} title={new Date(t.created_at).toLocaleString()}>{since(t.created_at)}</time></p>
            <ProjectChips key={t.id} about={{ id: t.id, type: 'task' }} initial={t.projects ?? []}
              readOnly={!t.you.may_edit} onChange={projects => onChanged({ ...t, projects })} />
          </header>

          <Now t={t} names={names} mode={mode} setMode={setMode} busy={busy} run={run} />

          <div className="tp-content-grid">
          <div className="tp-main-sections">
          {t.detail && <section className="tp-sec tp-card"><h3>Description</h3><p className="tp-text">{t.detail}</p></section>}
          <section className="tp-sec tp-card">
            <div className="tp-section-heading"><h3>What done means</h3>
              {t.criteria.length > 0 && <span>{met} of {t.criteria.length} met</span>}</div>
            {t.criteria.length > 0 && <progress className="tp-progress" aria-label="Criteria met" value={met} max={t.criteria.length} />}
            {t.criteria.length ? (
              <ul className="tp-crit">
                {t.criteria.map((c, i) => (
                  <li key={i} className={c.met === true ? 'met' : c.met === false ? 'missed' : ''}>
                    <i aria-hidden="true" /><span className="tp-criterion-text">{c.text}</span>
                    <span className="tp-criterion-state">{c.met === true ? 'Met' : c.met === false ? 'Not met' : 'Not checked'}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="tp-muted">Not written down yet{t.human_only ? '.' : ' — so no agent can take it.'}</p>}
            {t.human_only && <p className="tp-person"><b>Needs a person.</b>{t.human_only !== PERSON_ONLY && <> {t.human_only}</>}</p>}
          </section>

          {t.produced && (
            <section className="tp-sec tp-card">
              <h3>What it produced</h3>
              <p className="tp-text">
                {t.produced.url
                  ? <a href={t.produced.url} target="_blank" rel="noreferrer">{t.produced.label}</a>
                  : t.produced.label}
              </p>
            </section>
          )}
          </div>

          <div className="tp-context">
            <section className="tp-sec tp-card">
              <h3>Task details</h3>
              <dl className="tp-properties">
                <div><dt>Assignee</dt><dd>{t.assignee ? <><Face who={t.assignee} size={24} />{t.assignee.name}</> : <span className="tp-muted">Unassigned</span>}</dd></div>
                <div><dt>Created by</dt><dd><Face who={t.created_by} size={24} />{t.created_by.name}</dd></div>
                <div><dt>Updated</dt><dd><time dateTime={t.updated_at} title={new Date(t.updated_at).toLocaleString()}>{since(t.updated_at)}</time></dd></div>
              </dl>
            </section>

          {(t.links.length > 0 || you.may_edit) && (
            <section className="tp-sec tp-card">
              <div className="tp-section-heading"><h3>Linked work</h3><span>{t.links.length}</span></div>
              {t.links.length > 0 && (
                <dl className="tp-links">
                  {(['caused', 'touches', 'depends'] as const).map(rel => {
                    const rows = t.links.filter(l => l.rel === rel)
                    return rows.length ? <div key={rel}><dt>{REL[rel]}</dt>
                      <dd>{rows.map(l => (
                        <span className="tp-linked" key={l.object.id}>
                          <ObjectRef o={l.object} />
                          {you.may_edit && <button type="button" className="tp-unlink" disabled={busy}
                            aria-label={`Remove the link to ${l.object.key ?? l.object.title ?? `a ${l.object.type}`}`}
                            onClick={() => run(() => unlinkTask(t.id, l.object.id, l.rel), 'Link removed')}>×</button>}
                        </span>
                      ))}</dd></div> : null
                  })}
                </dl>
              )}
              {!t.links.length && <p className="tp-muted">Connect a doc, dashboard, or other work to give this task context.</p>}
              {you.may_edit && (linking
                ? <LinkPicker exclude={t.id} onCancel={() => setLinking(false)}
                    onPick={(o, rel) => { setLinking(false); run(() => linkTask(t.id, o.id, rel), `Linked ${o.key ?? o.title}`) }} />
                : <button type="button" className="linkbtn" onClick={() => setLinking(true)}>Link to…</button>)}
            </section>
          )}
          </div>

          <section className="tp-sec tp-card tp-conversation">
            <div className="tp-tabs" role="tablist" aria-label="Task conversation">
              {TABS.map((tab, i) => <button key={tab} type="button" role="tab"
                id={`${tabsId}-${tab}-tab`} aria-controls={`${tabsId}-${tab}`} aria-selected={conversation === tab}
                tabIndex={conversation === tab ? 0 : -1} onClick={() => setConversation(tab)}
                onKeyDown={e => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault()
                    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1
                      : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
                    setConversation(TABS[n]); document.getElementById(`${tabsId}-${TABS[n]}-tab`)?.focus()
                  }
                }}>{TAB_LABEL[tab]}{tab === 'activity' && <>{' '}<span>{t.history.length}</span></>}</button>)}
            </div>
            <div role="tabpanel" id={`${tabsId}-updates`} aria-labelledby={`${tabsId}-updates-tab`} hidden={conversation !== 'updates'}>
            <Thread key={`${t.id}-updates`} subjectId={t.id} embedded kind="update" active={conversation === 'updates'}
              placeholder="Post an update — @ to tag a person or an agent" />
            </div>
            <div role="tabpanel" id={`${tabsId}-comments`} aria-labelledby={`${tabsId}-comments-tab`} hidden={conversation !== 'comments'}>
            <Thread key={t.id} subjectId={t.id} embedded active={conversation === 'comments'}
              placeholder="Comment on this task — @ to mention a person or an agent" />
            </div>
            <div role="tabpanel" id={`${tabsId}-activity`} aria-labelledby={`${tabsId}-activity-tab`} hidden={conversation !== 'activity'}>
            {!t.history.length && <p className="tp-muted">No activity recorded yet.</p>}
            <ol className="tp-log">
              {t.history.map(h => (
                <li key={h.rev}>
                  <Face who={h.by} size={18} />
                  <div>
                    <p><b>{h.by.name}</b> {phrase(h, names)} <time dateTime={h.at} title={new Date(h.at).toLocaleString()}>{since(h.at)}</time></p>
                    {h.kind === 'answer' && h.question && <p className="tp-q">“{h.question}”</p>}
                    {h.note && h.kind !== 'edit' && h.kind !== 'question' && <blockquote>{h.note}</blockquote>}
                    {h.kind === 'question' && h.note && <blockquote>{h.note}</blockquote>}
                  </div>
                </li>
              ))}
            </ol>
            </div>
          </section>
          </div>

          {you.may_delete && (
            <div className="tp-danger">
              {mode === 'delete' ? <>
                <span>Take {t.key} off the board? Its history is kept.</span>
                <button className="btn" disabled={busy} onClick={async () => {
                  setBusy(true)
                  try { await deleteTask(t.id); toast(`${t.key} taken off the board`); onGone(t.id) }
                  catch (e) { setErr(message(e)); setBusy(false) }
                }}>Delete</button>
                <button className="btn ghost" onClick={() => setMode(null)}>Keep it</button>
              </> : <button className="linkbtn" onClick={() => setMode('delete')}>Delete task</button>}
            </div>
          )}
        </>}
      </div>
    </section>
  )
}

function phrase(h: WireTaskStep, names: Record<string, string>): string {
  switch (h.kind) {
    case 'create': return 'filed it'
    case 'edit': return `changed the ${h.note ?? 'task'}`
    case 'start': return 'started it'
    case 'hand': return `handed it to ${names[h.to ?? ''] ?? h.to}`
    case 'release': return 'gave it back'
    case 'submit': return 'filed it for review'
    case 'accept': return 'accepted it'
    case 'send_back': return 'sent it back'
    case 'question': return 'stopped to ask'
    case 'answer': return 'answered'
    case 'link': return `linked it — ${(REL[h.rel ?? ''] ?? '').toLowerCase()} ${h.object?.key ?? h.object?.title ?? ''}`
    case 'unlink': return `removed the link to ${h.object?.key ?? h.object?.title ?? 'an object'}`
    default: return 'changed it'
  }
}

// ── what can happen next ─────────────────────────────────────────────────

function Now({ t, names, mode, setMode, busy, run }: {
  t: Detail
  names: Record<string, string>
  mode: Mode
  setMode: (m: Mode) => void
  busy: boolean
  run: (fn: () => Promise<{ task: WireTask }>, done: string) => Promise<void>
}) {
  const you = t.you
  const [note, setNote] = useState('')
  useEffect(() => setNote(''), [mode])

  if (t.state === 'ready') {
    return (
      <div className="tp-now">
        <h3>Ready to start</h3>
        <div className="tp-actions">
          {you.may_start && <button className="btn primary" disabled={busy}
            onClick={() => run(() => startTask(t.id, t.rev), `${t.key} is yours now`)}>Start it myself</button>}
          <button className="btn" disabled={!t.agent_ready} aria-expanded={mode === 'hand'}
            onClick={() => setMode(mode === 'hand' ? null : 'hand')}>Hand to an agent</button>
        </div>
        {!t.agent_ready && <p className="tp-muted">No agent can take this: {t.not_agent_ready}.</p>}
        {mode === 'hand' && (
          <div className="tp-hand">
            <input className="tp-input" value={note} onChange={e => setNote(e.target.value)}
              placeholder="Anything it should know beyond the task (optional)" />
            <ul>
              {t.routes.map(r => (
                <li key={r.agent.id} className={r.can ? '' : 'cannot'}>
                  <Face who={r.agent} size={22} />
                  <div><b>{r.agent.name}</b><span>{r.why}</span></div>
                  {r.can
                    ? <button className="btn" disabled={busy}
                        onClick={() => run(() => handTask(t.id, t.rev, r.agent.id, note.trim() || undefined),
                          `${t.key} handed to ${r.agent.name} — it lands in its inbox`)}>Hand over</button>
                    : r.needs && <span className="tp-needs">needs {r.needs} here</span>}
                </li>
              ))}
              {t.routes.length === 0 && <li className="cannot"><div><span>No agents in this workspace yet.</span></div></li>}
            </ul>
          </div>
        )}
      </div>
    )
  }

  if (t.state === 'flight') {
    const a = t.assignee
    return (
      <div className="tp-now">
        <h3>{t.question ? 'Answer needed' : 'Work in progress'}</h3>
        {a && a.kind === 'agent' && <p className="tp-run">
          <i className={t.run?.status === 'running' ? 'live' : ''} />
          {t.run
            ? t.run.status === 'running'
              ? <>{a.name} is working on it — {span(t.run.seconds)}{t.run.cost_usd > 0 && <>, ${t.run.cost_usd.toFixed(2)}</>}</>
              : <>{a.name}'s last run ended {t.run.status} after {span(t.run.seconds)}</>
            : <>Waiting for {a.name} to pick it up. It reads its inbox when it next connects.</>}
        </p>}
        {a && a.kind === 'human' && <p className="tp-run">{you.own ? 'You are' : `${a.name} is`} working on it — started {since(t.moved_at)}</p>}

        {t.question && (
          <div className="tp-ask">
            <p><Face who={t.question.by} size={18} /><b>{t.question.by.name} asks</b> <time>{since(t.question.at)}</time></p>
            <blockquote>{t.question.text}</blockquote>
            {you.may_answer && <form onSubmit={e => { e.preventDefault(); if (note.trim()) run(() => answerTask(t.id, note.trim()), `Answered — ${t.question!.by.name} is asked again with it`) }}>
              <textarea rows={2} className="tp-input" value={note} onChange={e => setNote(e.target.value)}
                aria-label="Your answer" placeholder="Your answer" />
              <button className="btn primary" disabled={busy || !note.trim()}>Answer — the run resumes</button>
            </form>}
          </div>
        )}

        {mode === 'submit'
          ? <SubmitForm t={t} busy={busy} onCancel={() => setMode(null)}
              onSubmit={s => run(() => submitTask(t.id, t.rev, s), `${t.key} filed for review`)} />
          : <div className="tp-actions">
              {you.may_submit && <button className="btn primary" disabled={busy} onClick={() => t.criteria.length
                ? setMode('submit')
                : run(() => submitTask(t.id, t.rev, { criteria_met: [] }), `${t.key} filed for review`)}>File for review</button>}
              {you.may_release && <button className="btn ghost" disabled={busy}
                onClick={() => run(() => releaseTask(t.id, t.rev), `${t.key} is back in Ready`)}>Give it back</button>}
            </div>}
      </div>
    )
  }

  if (t.state === 'review') {
    const r = t.review
    return (
      <div className="tp-now tp-review">
        <div className="tp-section-heading"><h3>Review requested</h3>
          <span>{t.criteria.length ? `${t.criteria.filter(c => c.met === true).length} of ${t.criteria.length} checks met` : 'No checks defined'}</span></div>
        {t.criteria.some(c => c.met !== true) && <p className="tp-review-warning">Some checks are incomplete. Review the criteria below before accepting.</p>}
        {r?.submitted_by && <p className="tp-run">
          {r.submitted_by.name} filed it for review {r.submitted_at ? `${since(r.submitted_at)}` : ''}
          {r.note && <>: “{r.note}”</>}
        </p>}
        {mode === 'send_back' || mode === 'self_accept' ? (
          <form className="tp-form" onSubmit={e => {
            e.preventDefault()
            if (!note.trim()) return
            if (mode === 'send_back') run(() => sendBackTask(t.id, t.rev, note.trim()), `${t.key} sent back to ${t.assignee?.name ?? 'its assignee'}`)
            else run(() => acceptTask(t.id, t.rev, { note: note.trim() }), `${t.key} accepted`)
          }}>
            <label className="tp-field">
              <span>{mode === 'send_back' ? 'What should change?' : 'Why are you accepting your own work?'}</span>
              <textarea autoFocus rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder={mode === 'send_back' ? 'Two specs still say 3 retries.' : 'Recorded on the task, where anyone can read it.'} />
            </label>
            <div className="tp-actions">
              <button className="btn primary" disabled={busy || !note.trim()}>{mode === 'send_back' ? 'Send back' : 'Accept'}</button>
              <button type="button" className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="tp-actions">
            {you.may_accept && <button className="btn primary" disabled={busy}
              onClick={() => run(() => acceptTask(t.id, t.rev), `${t.key} accepted`)}>Accept</button>}
            {you.may_self_accept && <button className="btn" onClick={() => setMode('self_accept')}>Accept my own work…</button>}
            {you.may_send_back && <button className="btn" onClick={() => setMode('send_back')}>Send back…</button>}
          </div>
        )}
        {you.own && !you.may_self_accept && <p className="tp-muted">You did this work, so someone else accepts it.</p>}
      </div>
    )
  }

  const r = t.review
  return (
    <div className="tp-now">
      <h3>Completed</h3>
      {r?.decided_by && <p className="tp-run done">
        Accepted by {r.decided_by.name}{r.self_accepted ? ', their own work' : ''} {r.decided_at ? `${since(r.decided_at)}` : ''}
        {r.decision_note && <>: “{r.decision_note}”</>}
      </p>}
    </div>
  )
}

/** Filing for review: every criterion answered, because the reviewer judges
 *  against them and one nobody checked reads as one that passed. */
function SubmitForm({ t, busy, onSubmit, onCancel }: {
  t: Detail
  busy: boolean
  onSubmit: (s: { criteria_met: boolean[]; produced?: { label: string; url?: string } | null; note?: string }) => void
  onCancel: () => void
}) {
  const [met, setMet] = useState<boolean[]>(t.criteria.map(c => c.met === true))
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const badUrl = !!url.trim() && !/^https?:\/\//.test(url.trim())
  return (
    <form className="tp-form" onSubmit={e => {
      e.preventDefault()
      if (badUrl) return
      onSubmit({ criteria_met: met, note: note.trim() || undefined,
        produced: label.trim() ? { label: label.trim(), ...(url.trim() ? { url: url.trim() } : {}) } : null })
    }}>
      <fieldset className="tp-field">
        <legend>Tick each check the work meets</legend>
        {t.criteria.map((c, i) => (
          <label key={c.text} className="tp-check">
            <input type="checkbox" checked={met[i]} onChange={e => setMet(m => m.map((v, j) => (j === i ? e.target.checked : v)))} />
            {c.text}
          </label>
        ))}
        <small>{met.filter(Boolean).length} of {met.length} met. The reviewer sees exactly this.</small>
      </fieldset>
      <label className="tp-field">
        <span>What it produced <em>optional</em></span>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="9 spec edits" />
      </label>
      {label.trim() && <label className="tp-field">
        <span>Link <em>optional</em></span>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/example/specs/pull/88" />
        {badUrl && <small className="bad">A link starts with https://</small>}
      </label>}
      <label className="tp-field">
        <span>Note for the reviewer <em>optional</em></span>
        <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      <div className="tp-actions">
        <button className="btn primary" disabled={busy || badUrl}>File for review</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
