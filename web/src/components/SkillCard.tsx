import { Link } from 'react-router-dom'
import type { Skill, SkillStatus } from '../data/types'
import { Avatar, Oid, Pill, type Tone } from './ui'

/** "1 dataset", "2 datasets". */
export const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export const skillTone = (s: SkillStatus): Tone =>
  s === 'installed' ? 'green' : s === 'proposed' ? 'agent' : s === 'deprecated' ? 'red' : s === 'draft' ? 'warn' : 'gray'

/** A title reduced to the form a slug takes, for comparing the two. */
export const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function Chips({ items, max = 1 }: { items: string[]; max?: number }) {
  if (!items.length) return <span className="skill-none">none</span>
  return <>
    {items.slice(0, max).map(x => <code key={x}>{x}</code>)}
    {items.length > max && <span className="skill-more" title={items.slice(max).join(', ')}>+{items.length - max}</span>}
  </>
}

/** A skill by its shape: what makes it fire, what it calls, what it needs to be
 *  granted — the three things that decide whether you want it installed — and
 *  how its work has gone here. */
export function SkillCard({ skill: s }: { skill: Skill }) {
  const g = s.generated
  return (
    <Link className="dash-card skill-card" to={`/skills/${s.id}`} aria-label={`Open skill ${s.name}`}>
      <div className={`dash-card-preview skill-card-preview`}>
        <div className="dash-card-preview-label">
          <span>{g ? 'Generated context' : s.source === 'workspace' ? 'Workspace skill' : `${s.source} skill`}</span>
          <Oid id={s.key} />
        </div>
        {g ? (
          <dl className="skill-shape">
            <div><dt>Read by</dt><dd>any agent that asks</dd></div>
            <div><dt>From</dt><dd>{count(g.from.datasets, 'dataset')}, {count(g.from.definitions, 'definition')}, {count(g.from.dashboards, 'dashboard')}</dd></div>
            <div><dt>Unratified</dt><dd className={g.unratified ? 'warn' : ''}>{g.unratified || 'none'}</dd></div>
          </dl>
        ) : (
          <dl className="skill-shape">
            {/* One line each, whatever the lengths: the rest is on hover and on
                the skill's page, and a preview that grows over the card is worse
                than one that stops. */}
            <div><dt>When</dt><dd className="one" title={s.triggers.join('\n')}>
              <span className="clip">{s.triggers[0] ?? 'asked directly'}</span>
              {s.triggers.length > 1 && <span className="skill-more">+{s.triggers.length - 1}</span>}</dd></div>
            <div><dt>Uses</dt><dd className="one" title={s.tools.join(', ')}><Chips items={s.tools} /></dd></div>
            <div><dt>Needs</dt><dd className="one" title={s.scopes.join(', ')}><Chips items={s.scopes} /></dd></div>
          </dl>
        )}
        <div className="skill-record">
          {s.acceptance === null
            ? <span>Has not run here yet</span>
            : <><b>{s.acceptance}%</b><span title="of its proposals merged unchanged">accepted</span><span className="sep" /><b>{s.runs7d}</b><span>runs in 7 days</span></>}
        </div>
      </div>
      <div className="dash-card-content">
        <h2>{s.title || s.name}</h2>
        {s.title !== s.name && <div className="skill-card-name">{s.name}</div>}
        <p className="skill-card-summary">{s.summary}</p>
        <div className="dash-card-facts">
          {g ? <Pill tone="blue">generated</Pill> : <Pill tone={skillTone(s.status)}>{s.status}</Pill>}
          {s.blocked && <Pill tone="warn">blocked</Pill>}
          {!g && s.status === 'installed' && s.installedOn.length > 0 && <span>on {s.installedOn.join(', ')}</span>}
          {!g && <><span>·</span><span>rev {s.rev}</span></>}
        </div>
        <div className="dash-card-footer">
          <span>{g ? <span className="muted">Read from the registry</span>
            : <><Avatar name={s.author} agent={s.agentAuthor} />{s.author}</>}</span>
        </div>
      </div>
    </Link>
  )
}
