import type { TaskState, WireTask } from '../data/gateway'

/** "3d", "4h", "12m" — how long something has sat, at a glance. */
export function ago(seconds: number): string {
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** "just now", "5m ago" — `ago` in a sentence. Appending " ago" to `ago`
 *  read "Updated now ago" for anything under a minute old. */
export function agoText(seconds: number): string {
  const a = ago(seconds)
  return a === 'now' ? 'just now' : `${a} ago`
}

/** A run's length at a glance, for a card: "45s", "4m", "8h", "2d". The panel
 *  has room for the precise one. */
export function glance(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** A run's length: "45s", "4m 12s", "1h 20m". */
export function span(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds / 60}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export const LANES: { id: TaskState; label: string; empty: string }[] = [
  { id: 'ready', label: 'Ready', empty: 'Nothing waiting to be picked up.' },
  { id: 'flight', label: 'In progress', empty: 'Nobody is working on anything.' },
  { id: 'review', label: 'In review', empty: 'Nothing is waiting on a reviewer.' },
  { id: 'done', label: 'Done', empty: 'Nothing accepted yet.' },
]

/** Where a task is, as a shape as well as a colour, so the lanes read in
 *  greyscale: open, half, held, closed. */
export function StateGlyph({ state }: { state: TaskState }) {
  return (
    <svg className={`sglyph sg-${state}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {state === 'ready' && <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" strokeDasharray="2.6 2.2" />}
      {state === 'flight' && <>
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
        <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" className="fill" />
      </>}
      {state === 'review' && <>
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="2.2" className="fill" />
      </>}
      {state === 'done' && <>
        <circle cx="8" cy="8" r="6.75" className="fill" />
        <path d="m5.2 8.2 1.9 1.9 3.8-4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>}
    </svg>
  )
}

type Signal = { tone: 'warn' | 'blue' | 'red' | 'gray' | 'agent'; label: string; title?: string; live?: boolean }

/** One signal per card, never two — the one that matters for where it sits. */
export function signalOf(t: WireTask): Signal | null {
  if (t.question) {
    return { tone: 'warn', label: 'Asking', title: `${t.question.by.name} asks: ${t.question.text}` }
  }
  if (t.state === 'flight' && t.assignee?.kind === 'agent') {
    if (t.run?.status === 'running') {
      return { tone: 'blue', label: `Working ${glance(t.run.seconds)}`, live: true,
        title: `${t.assignee.name} has been on this run for ${span(t.run.seconds)}` }
    }
    if (t.run?.status === 'blocked') return { tone: 'red', label: 'Blocked', title: `${t.assignee.name}'s run ended blocked` }
    if (t.asked) {
      return { tone: 'gray', label: 'Queued',
        title: `Handed to ${t.assignee.name}. It picks this up when it next reads its inbox.` }
    }
  }
  if (t.state === 'review') {
    return { tone: t.in_state_s >= 2 * 86400 ? 'warn' : 'gray', label: `Waiting ${ago(t.in_state_s)}`,
      title: 'How long this has waited on a reviewer' }
  }
  if (t.state === 'ready') {
    if (t.agent_ready) return { tone: 'agent', label: 'Agent-ready', title: 'Done is written down, so an agent can take it' }
    if (t.human_only) return { tone: 'gray', label: 'Needs a person', title: t.human_only }
  }
  return null
}

export function Face({ who, size = 20 }: { who: { name: string; kind: 'human' | 'agent' }; size?: number }) {
  return (
    <span className={`face ${who.kind === 'agent' ? 'face-agent' : ''}`} style={{ width: size, height: size }}
      title={who.kind === 'agent' ? `${who.name} · agent` : who.name}>
      {who.kind === 'agent' ? <AgentMark /> : who.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function AgentMark() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <rect x="1.5" y="3" width="9" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 1v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="4.3" cy="6.5" r=".8" fill="currentColor" /><circle cx="7.7" cy="6.5" r=".8" fill="currentColor" />
    </svg>
  )
}

export function TaskCard({ t, selected, onOpen, onDragStart, onDragEnd }: {
  t: WireTask
  selected: boolean
  onOpen: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const s = signalOf(t)
  const judged = t.state === 'review' || t.state === 'done'
  const met = t.criteria.filter(c => c.met === true).length
  const missed = t.criteria.some(c => c.met === false)
  return (
    <article
      className={`tcard${selected ? ' selected' : ''}${t.state === 'done' ? ' done' : ''}`}
      data-task={t.id}
      role="button" tabIndex={0} aria-label={`${t.key} ${t.title}`}
      draggable={!!onDragStart}
      onDragStart={e => { e.dataTransfer?.setData('text/plain', t.id); onDragStart?.() }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <div className="tcard-top">
        <span className="tcard-key">{t.key}</span>
        {judged && t.criteria.length > 0 && (
          <span className={`tcard-meta${missed ? ' missed' : ''}`}
            title={`${met} of ${t.criteria.length} criteria met, as filed`}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {met}/{t.criteria.length}
          </span>
        )}
        {t.links.length > 0 && (
          <span className="tcard-meta" title={`${t.links.length} linked ${t.links.length === 1 ? 'object' : 'objects'}`}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M5 7a2.3 2.3 0 0 0 3.3 0l1.6-1.6a2.3 2.3 0 0 0-3.3-3.3l-.5.5M7 5a2.3 2.3 0 0 0-3.3 0L2.1 6.6a2.3 2.3 0 0 0 3.3 3.3l.5-.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
            {t.links.length}
          </span>
        )}
      </div>
      <div className="tcard-title">{t.title}</div>
      {!!t.projects?.length && <div className="tcard-projects">{t.projects.map(p =>
        <span key={p.id} className={`pchip pchip-${p.color} tiny`} title={p.title}><span className="pchip-dot" aria-hidden="true" />
          <span className="pchip-name">{p.title}</span></span>)}</div>}
      {/* What is happening, and who with — the two things a glance at the lane
          is for. The name is spelled out: an agent's mark alone does not say
          which agent. */}
      {(s || t.assignee) && (
        <div className="tcard-foot">
          {s && <span className={`chip-s cs-${s.tone}`} title={s.title}>
            <i className={s.live ? 'live' : ''} />{s.label}</span>}
          {t.assignee && (
            <span className="tcard-who" title={t.assignee.kind === 'agent' ? `${t.assignee.name} · agent` : t.assignee.name}>
              <Face who={t.assignee} size={18} /><span>{t.assignee.name}</span>
            </span>
          )}
        </div>
      )}
    </article>
  )
}
