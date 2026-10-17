import { useEffect, useState } from 'react'

export type Tone = 'agent' | 'green' | 'red' | 'warn' | 'blue' | 'gray'

/** Reserved for the exceptional — the state that wants a human. */
export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

/** The ordinary state: a quiet dot and a label, so pills keep their meaning. */
export function Stat({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className="stat"><i className={`dot dot-${tone}`} />{children}</span>
}

/** Object ids read as identifiers: the prefix recedes, the number is the name. */
export function Oid({ id }: { id: string }) {
  const [, prefix, rest] = /^(\D*)(.*)$/.exec(id) ?? ['', '', id]
  return <span className="oid"><span className="p">{prefix}</span>{rest}</span>
}

export function Avatar({ name, agent }: { name: string; agent?: boolean }) {
  return (
    <span className={`avatar ${agent ? 'av-a' : 'av-h'}`} title={agent ? `${name} · agent` : name}>
      {agent ? '⌁' : name.slice(0, 1)}
    </span>
  )
}

export function Glass() {
  return (
    <svg className="glass" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.3 10.3 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function statusTone(s: string): Tone {
  switch (s) {
    case 'running': case 'open': return 'blue'
    case 'readout': case 'stale': case 'watch': case 'running-check': return 'warn'
    case 'shipped': case 'merged': case 'passed': case 'verified': case 'clean': return 'green'
    case 'killed': case 'failed': case 'breach': return 'red'
    case 'iterated': return 'warn'
    default: return 'gray'
  }
}

/** When this page last asked the warehouse, and a way to ask again.
 *
 *  Both the dashboard and the readout recompute on every read and then sit
 *  there — so what you are looking at is a snapshot from whenever the page
 *  loaded, and nothing said so. Ten minutes into a conversation about a number,
 *  "is this current?" has no answer on screen.
 *
 *  The age is the point and the button is secondary: a page that is thirty
 *  seconds old rarely needs refreshing, and one that is an hour old does. */
export function Freshness({ at, busy, onRefresh, what = 'Read' }: {
  at: number | null
  busy?: boolean
  /** Without it the age is shown alone — for a page whose Refresh is elsewhere. */
  onRefresh?: () => void
  what?: string
}) {
  // Re-render on a timer so "just now" becomes "2 min ago" without the reader
  // having to touch anything. Half a minute is under the resolution of the
  // label it drives, so nothing visibly jumps.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <span className="fresh">
      {at !== null && (
        <span className="fresh-age" title={new Date(at).toLocaleString()}>
          {what} {ago(at)}
        </span>
      )}
      {onRefresh && <button className="fresh-btn" onClick={onRefresh} disabled={busy}
              title="Run it again against the warehouse">
        <i className={`fresh-i${busy ? ' spin' : ''}`} aria-hidden />
        {busy ? 'Reading…' : 'Refresh'}
      </button>}
    </span>
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`
}
