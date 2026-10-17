import { Link } from 'react-router-dom'
import type { WireAgent } from '../data/gateway'
import { Pill } from './ui'

const LADDER = ['read', 'propose', 'merge', 'admin'] as const

/** How long ago, in the words the rest of the product uses. */
export function ago(at: string | null): string {
  if (!at) return 'never'
  const d = Math.floor((Date.now() - Date.parse(at)) / 864e5)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
}

/** An agent by its standing: how far up the ladder its grant here reaches, who
 *  answers for it, and what the record says it has done. Everything on the card
 *  is read from actors, grants, tokens and objects — nothing is estimated. */
export function AgentGalleryCard({ agent: a }: { agent: WireAgent }) {
  const reach = Math.max(-1, ...a.may.map(m => LADDER.indexOf(m as typeof LADDER[number])))
  const made = Object.values(a.authored).reduce((x, y) => x + y, 0)
  return (
    <Link className="dash-card agent-gcard" to={`/agents/${a.id}`} aria-label={`Open agent ${a.display}`}>
      <div className="dash-card-preview agent-gcard-preview">
        <div className="dash-card-preview-label">
          <span>Agent</span>
          <span className="mono">{a.id}</span>
        </div>
        <div className="agent-gcard-who">
          <span className="agent-gcard-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22"><rect x="4" y="7.5" width="16" height="12" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M12 3.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="9.2" cy="13.4" r="1.2" fill="currentColor" /><circle cx="14.8" cy="13.4" r="1.2" fill="currentColor" /></svg>
          </span>
          <div>
            <b>{a.owner ? 'Accountable owner' : 'Owner needed'}</b>
            <span className={a.owner ? '' : 'warn'}>{a.owner ? `answerable to ${a.owner.display}` : 'nobody answers for this'}</span>
          </div>
        </div>
        {/* The grant, as a ladder: each relation includes the ones below it. */}
        <div className="agent-ladder" role="img"
          aria-label={reach < 0 ? 'No grant in this space' : `May ${LADDER[reach]} in this space`}>
          {LADDER.map((r, i) => <span key={r} className={i <= reach ? 'on' : ''}>{r}</span>)}
        </div>
        <p className="agent-gcard-note">{reach < 0
          ? 'No grant in this space — it can authenticate and do nothing.'
          : <>May {a.may.join(', ')} in this space. {a.may_ratify_own_work
            ? 'Its own work counts as ratified.' : 'Its work arrives proposed, for a person to accept.'}</>}</p>
      </div>
      <div className="dash-card-content">
        <h2>{a.display}</h2>
        <div className="dash-card-facts">
          <Pill tone={a.may_ratify_own_work ? 'green' : 'gray'}>{a.trust_tier}</Pill>
          {a.tokens.count === 0 && <Pill tone="warn">no token</Pill>}
        </div>
        <dl className="agent-gcard-stats">
          <div><dt>Token used</dt><dd>{ago(a.tokens.last_used)}</dd></div>
          <div><dt>Objects made</dt><dd>{made}</dd></div>
          <div><dt>Defs ratified</dt><dd title="metric definitions it proposed, and how many a person ratified">{a.defined.ratified}/{a.defined.metrics}</dd></div>
        </dl>
        <div className="dash-card-footer">
          <span className="muted">Added {ago(a.created_at)}</span>
        </div>
      </div>
    </Link>
  )
}
