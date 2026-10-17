import { useEffect, useState } from 'react'
import type { WireAgent } from '../../data/gateway'

export const ACCESS: Record<string, string> = { read: 'Read only', propose: 'Can draft', merge: 'Can approve', admin: 'Admin' }
export const HANDLE = /^[a-z][a-z0-9_-]{1,38}[a-z0-9]$/

/** Token activity is evidence of a connection, not proof that a runner is alive. */
export function runnerSeen(lastUsed: string | null, now = Date.now()): number | null {
  if (!lastUsed) return null
  const seconds = (now - Date.parse(lastUsed)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 && seconds < 60 ? Math.floor(seconds) : null
}

export function currentGrants(agent: WireAgent) {
  return agent.grants.filter(g => !g.expires_at || Date.parse(g.expires_at) > Date.now())
}
export const hasWorkspaceAccess = (agent: WireAgent) => currentGrants(agent).length > 0
export function connectionLabel(agent: WireAgent) {
  if (!agent.tokens.count) return 'Token needed'
  if (runnerSeen(agent.tokens.last_used) !== null) return 'Recently connected'
  return agent.tokens.last_used ? 'No recent connection' : 'Not connected yet'
}
export const dateLabel = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function CopyButton({ text, label = 'Copy command' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => { setState('idle') }, [text])
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), 2500)
    return () => clearTimeout(timer)
  }, [state])
  return <div className="agent-copy">
    <button type="button" className="tool" onClick={async () => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(text); setState('copied')
      } catch { setState('failed') }
    }}>{state === 'copied' ? 'Copied' : label}</button>
    <span role="status" className="agent-copy-message">{state === 'failed' ? 'Could not copy. Select and copy the text manually.' : state === 'copied' ? 'Copied to clipboard.' : ''}</span>
  </div>
}

export function RunnerInstructions({ id }: { id: string }) {
  return <details className="agent-technical">
    <summary>Run locally from the repository</summary>
    <p>On the machine hosting the local platform, configure your model in <code>.env.local</code>, then run:</p>
    {HANDLE.test(id) ? <div className="agent-command"><code>make agent-run AGENT={id}</code><CopyButton text={`make agent-run AGENT=${id}`} /></div>
      : <p>Ask your workspace admin to configure a runner for this agent.</p>}
    <p>This helper connects to localhost:8000 and creates or reuses a local token. Keep the process running to handle requests. For a remote runner, use the platform URL and an agent token instead.</p>
  </details>
}
