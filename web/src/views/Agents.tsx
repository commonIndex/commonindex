import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listAgentsLive, type WireAgent } from '../data/gateway'
import { Avatar } from '../components/ui'
import { AgentGalleryCard } from '../components/AgentGalleryCard'
import { GalleryResults } from '../components/Gallery'
import { AgentSetup, AgentCreated, type CreatedAgent } from './agents/AgentSetup'
import { ACCESS, connectionLabel, currentGrants, hasWorkspaceAccess } from './agents/shared'
import './agents.css'

export { AgentDetail } from './agents/AgentDetail'
export { runnerSeen } from './agents/shared'

export function AgentsView() {
  const [agents, setAgents] = useState<WireAgent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [attempt, setAttempt] = useState(0)
  // The token stays in memory only and is shown once, during connection setup.
  const [minted, setMinted] = useState<CreatedAgent | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    if (!adding && !minted && restoreFocus.current) {
      addButton.current?.focus(); restoreFocus.current = false
    }
  }, [adding, minted])
  useEffect(() => {
    let alive = true
    setErr(null)
    listAgentsLive()
      .then(r => { if (alive) setAgents(r.agents) })
      .catch(e => { if (alive) { setAgents([]); setErr(e instanceof Error ? e.message : String(e)) } })
    return () => { alive = false }
  }, [attempt])

  const unowned = (agents ?? []).filter(a => !a.owner).length
  const rows = (agents ?? []).filter(a =>
    `${a.display} ${a.id} ${a.owner?.display ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())
    && (filter === 'all' || (filter === 'autonomous' ? a.may_ratify_own_work : !a.owner || !a.tokens.count || !hasWorkspaceAccess(a))))
  const reset = () => { setQ(''); setFilter('all') }
  const close = () => { restoreFocus.current = true; setAdding(false); setMinted(null) }

  return (
    <div className="collection dashboard-collection workspace-collection agents-collection">
      <div className="dash-gallery-scroll">
        <header className="dash-collection-header dash-collection-shell">
          <div>
            <h1 className="coll-title">Agents <span className="total">{agents === null ? 'Loading…' : err ? 'Unavailable' : `${agents.length} in this space`}</span></h1>
            <p className="coll-sub">Your AI collaborators. Set their access, connect a runner, and send work their way.</p>
          </div>
          {!adding && !minted && <button ref={addButton} className="btn action" onClick={() => setAdding(true)}>+ Add an agent</button>}
        </header>
        <div className="dash-collection-shell">
          {adding ? <AgentSetup onCancel={close} onDone={made => {
            setAdding(false); setMinted(made); setAttempt(a => a + 1)
          }} /> : minted ? <AgentCreated made={minted} onDone={close} /> : <>
            <div className="coll-tools dash-gallery-tools">
              <div className="dash-gallery-filters" role="group" aria-label="Filter agents">
                {[['all', 'All'], ['attention', 'Needs attention'], ['autonomous', 'Autonomous']].map(([value, label]) =>
                  <button key={value} className={`chip${filter === value ? ' on' : ''}`} aria-pressed={filter === value}
                    onClick={() => setFilter(value)}>{label}</button>)}
              </div>
              <input className="dash-search" type="search" aria-label="Search agents" placeholder="Search agents or owners…"
                value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <GalleryResults loading={agents === null} error={err ? new Error(err) : null} count={rows.length}
              total={agents?.length ?? 0} label="agents" filtered={!!q || filter !== 'all'} onReset={reset} />
            {filter === 'attention' && <p className="gallery-selection">Missing an owner, a token, or unexpired workspace access.</p>}
            {err && <div className="dash-load-error" role="alert"><span><b>Could not read the agents.</b> {err}</span>
              <button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
            {unowned > 0 && <div className="agent-notice">
              <span><b>{unowned} of {agents!.length} agents have no owner.</b> Ask a workspace admin to assign someone responsible for their work.</span>
              {filter !== 'attention' && <button className="tool" onClick={() => { setQ(''); setFilter('attention') }}>Review agents</button>}
            </div>}
            {agents === null ? <div className="dash-gallery-grid" aria-hidden="true">
              {Array.from({ length: 3 }, (_, i) => <div key={i} className="dash-card-skeleton"><div /><span /><span /></div>)}
            </div> : rows.length > 0 ? <div className="dash-gallery-grid" role="list" aria-label="Agents">
              {rows.map(a => <div role="listitem" key={a.id}><AgentGalleryCard agent={a} /></div>)}
            </div> : !err && <div className="dash-gallery-empty">
              <h2>{q || filter !== 'all' ? 'No agents match' : 'Add your first agent'}</h2>
              <p>{q || filter !== 'all' ? 'Try another name or clear the filters.' : 'Create an identity and choose its permissions. Then connect the process that runs it.'}</p>
              {q || filter !== 'all' ? <button className="tool" onClick={reset}>Show all agents</button>
                : <button className="btn action" onClick={() => setAdding(true)}>Add an agent</button>}
            </div>}
            {!!agents?.length && <details className="agent-register">
              <summary>AI usage register <span className="hint">Ownership, access and connection activity</span></summary>
              <div className="card agent-register-table" role="region" aria-label="AI usage register" tabIndex={0}>
                <div className="reg-grid reg-head"><span>Agent</span><span>Owner</span><span>Workspace access</span><span>Connection</span><span>Metric approval</span></div>
                {agents.map(a => <Link className="reg-grid" key={a.id} to={`/agents/${a.id}`}>
                  <span className="agent-register-name"><Avatar name={a.display} agent />{a.display}</span>
                  <span>{a.owner?.display ?? <span className="p-warn">Owner needed</span>}</span>
                  <span>{hasWorkspaceAccess(a) ? currentGrants(a).map(g => ACCESS[g.relation] ?? g.relation).join(', ') : 'No current access'}</span>
                  <span className="sub-inline">{connectionLabel(a)}</span>
                  <span className="sub-inline">{a.may_ratify_own_work ? 'Published directly' : 'Human approval'}</span>
                </Link>)}
                <p className="agent-register-note">Connection activity is based on token use, not a live task status. Metric approval applies to metric definitions, not every action an agent takes.</p>
              </div>
            </details>}
          </>}
        </div>
      </div>
    </div>
  )
}
