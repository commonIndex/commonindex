import { DetailHead } from '../../components/DetailHead'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { agentInbox, askAgent, getAgentLive, type WireAgent, type WireAsk } from '../../data/gateway'
import { pageFor } from '../../data/links'
import { Avatar, Pill } from '../../components/ui'
import { ago } from '../../components/AgentGalleryCard'
import { CommentsButton } from '../../components/discussion/Thread'
import { ACCESS, connectionLabel, currentGrants, dateLabel, hasWorkspaceAccess, RunnerInstructions, runnerSeen } from './shared'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function AgentDetail() {
  const { id = '' } = useParams()
  // A route change remounts requests and drafts, preventing an old agent's inbox
  // or an in-flight response from being displayed under a different identity.
  return <AgentPage key={id} id={id} />
}

function AgentPage({ id }: { id: string }) {
  const [agent, setAgent] = useState<WireAgent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true, request = 0
    const refresh = async () => {
      const version = ++request
      try {
        const result = await getAgentLive(id)
        if (alive && request === version) { setAgent(result.agent); setErr(null) }
      } catch (e) { if (alive && request === version) setErr(message(e)) }
    }
    void refresh()
    const timer = setInterval(refresh, 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [id, attempt])
  if (!agent) return <div className="detail agent-detail"><Link className="agent-back" to="/agents">← Agents</Link>
    {err ? <div className="agent-notice" role="alert"><span><b>Could not read this agent.</b> {err}</span>
      <button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>
      : <p className="agent-empty" role="status">Loading agent…</p>}</div>

  const grants = currentGrants(agent)
  const made = Object.entries(agent.authored).sort((a, b) => b[1] - a[1])
  const recentlyConnected = runnerSeen(agent.tokens.last_used) !== null && agent.tokens.count > 0
  return <div className="detail agent-detail">
    <DetailHead back={{ to: '/agents', label: 'Agents' }} keyId={`@${agent.id}`}
      title={<span className="agent-head-name"><Avatar name={agent.display} agent />{agent.display}</span>}
      dot={recentlyConnected ? 'green' : 'gray'}
      status={[<span>{connectionLabel(agent)}</span>, <span>{grants.length ? 'has workspace access' : 'no workspace access'}</span>]}
      actions={<CommentsButton subjectId={agent.id} title={agent.display} />}
      lede={<p className="xhead-lede">Send a request, follow its queue, and see what this agent has created.</p>} />
    {err && <div className="agent-notice" role="alert"><span>Could not refresh agent details. Showing the last loaded information. {err}</span>
      <button className="tool" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
    <div className="agent-detail-grid">
      <div className="agent-workspace">
        <AskPanel agent={agent} />
        <section className="agent-section" aria-labelledby="agent-work-title">
          <header className="agent-section-head"><div><h2 id="agent-work-title">Created work</h2><p>Recent items authored by this agent in this workspace.</p></div>
            <span className="agent-count">{Object.values(agent.authored).reduce((sum, count) => sum + count, 0)} total</span></header>
          {(agent.recent ?? []).length ? <ul className="agent-work-list">{agent.recent!.map(item => <li key={item.id}>
            <Link to={item.type === 'video' ? `/videos/${item.id}` : item.type === 'artifact' ? `/artifacts/${item.id}` : pageFor(item)}>
              <div><b>{item.title}</b><span>{item.type.replaceAll('_', ' ')} · {ago(item.created_at)}</span></div><span aria-hidden="true">↗</span>
            </Link></li>)}</ul> : <div className="agent-empty"><b>No work created yet</b><p>Items will appear here when the agent creates them. A queued request is not a completed result.</p></div>}
          {made.length > 0 && <p className="agent-work-summary">{made.map(([type, count]) => `${count} ${type.replaceAll('_', ' ')}${count === 1 ? '' : 's'}`).join(' · ')}</p>}
        </section>
      </div>
      <aside className="agent-sidebar" aria-label="Agent details and connection">
        <section className="agent-section agent-connection" aria-labelledby="agent-connection-title">
          <h2 id="agent-connection-title">Connection & setup</h2>
          <p>{recentlyConnected ? 'A token was used within the last minute. This confirms recent activity, not that a task is running.'
            : 'Requests wait until a runner connects and reads this agent’s inbox. This page does not start a runner.'}</p>
          <dl className="agent-info-list"><div><dt>Tokens</dt><dd>{agent.tokens.count}</dd></div>
            <div><dt>Last token use</dt><dd>{agent.tokens.last_used ? <time dateTime={agent.tokens.last_used} title={new Date(agent.tokens.last_used).toLocaleString()}>{ago(agent.tokens.last_used)}</time> : 'Never'}</dd></div>
            {agent.tokens.next_expiry && <div><dt>{Date.parse(agent.tokens.next_expiry) <= Date.now() ? 'Recorded token expiry' : 'Next token expiry'}</dt>
              <dd>{dateLabel(agent.tokens.next_expiry)}{Date.parse(agent.tokens.next_expiry) <= Date.now() ? ' (expired)' : ''}</dd></div>}
          </dl>
          {!agent.tokens.count && <p className="agent-warning">No token is available. Ask an admin to issue one, or use the local runner setup below.</p>}
          {grants.length ? <RunnerInstructions id={agent.id} /> : <p className="agent-warning">Ask an admin to grant workspace access before connecting a runner.</p>}
        </section>
        <section className="agent-section" aria-labelledby="agent-access-title"><h2 id="agent-access-title">Access & review</h2>
          <div className="agent-setting"><span>Workspace access</span><b>{grants.length ? [...new Set(grants.map(g => ACCESS[g.relation] ?? g.relation))].join(', ') : 'No current access'}</b>
            <p>Private items need to be shared with this agent separately.</p></div>
          <div className="agent-setting"><span>Metric definitions</span><b>{agent.may_ratify_own_work ? 'Published without review' : 'Require human approval'}</b>
            <p>{agent.may_ratify_own_work ? 'Its metric definitions can be used in dashboards immediately.' : 'A person must approve its metric definitions before dashboards can use them.'} This setting does not govern every doc, task or answer.</p>
            {agent.defined.metrics > 0 && <p>{agent.defined.ratified} of {agent.defined.metrics} definitions approved.</p>}</div>
          <details className="agent-technical"><summary>Permission details</summary>
            {!agent.grants.length ? <p>No workspace permissions have been granted.</p> : <ul className="agent-grant-list">{agent.grants.map(g => <li key={`${g.relation}:${g.resource}`}>
              <b>{ACCESS[g.relation] ?? g.relation}</b><code>{g.resource}</code>
              <span>{g.expires_at ? `${Date.parse(g.expires_at) <= Date.now() ? 'Expired' : 'Expires'} ${dateLabel(g.expires_at)}` : 'No expiry'}</span>
              <span>{g.last_used ? `Last used ${ago(g.last_used)}` : 'Never used'}</span>
            </li>)}</ul>}
          </details>
        </section>
        <section className="agent-section" aria-labelledby="agent-owner-title"><h2 id="agent-owner-title">Owner</h2>
          {agent.owner ? <div className="agent-owner-identity"><Avatar name={agent.owner.display} /><div><b>{agent.owner.display}</b><p>Responsible for this agent’s work.</p></div></div>
            : <div className="agent-warning"><b>Owner needed</b><p>Ask a workspace admin to assign a person responsible for this agent.</p></div>}
          <p className="agent-help">Added {dateLabel(agent.created_at)}</p>
        </section>
      </aside>
    </div>
  </div>
}

function AskPanel({ agent }: { agent: WireAgent }) {
  const [asks, setAsks] = useState<WireAsk[] | null>(null)
  const [inboxError, setInboxError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const sending = useRef(false)
  const request = useRef(0)
  const alive = useRef(true)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const reload = useCallback(async () => {
    const version = ++request.current
    setRefreshing(true)
    try {
      const result = await agentInbox(agent.id)
      if (alive.current && version === request.current) { setAsks(result.asks); setInboxError(null) }
    } catch (e) {
      if (alive.current && version === request.current) setInboxError(message(e))
    } finally { if (alive.current && version === request.current) setRefreshing(false) }
  }, [agent.id])
  useEffect(() => {
    alive.current = true
    void reload()
    const timer = setInterval(reload, 15000)
    return () => { alive.current = false; request.current++; clearInterval(timer) }
  }, [reload])
  const canAct = hasWorkspaceAccess(agent)
  const submit = async () => {
    if (!note.trim() || sending.current || !canAct) return
    sending.current = true; setBusy(true); setFeedback(null); setSendError(null)
    try {
      const result = await askAgent({ agent_id: agent.id, note: note.trim() })
      if (!alive.current) return
      setFeedback(result.repeat ? 'This request was already recorded. No duplicate was added.' : 'Request queued. It will be picked up when a runner reads the inbox.')
      setNote(''); void reload()
    } catch (e) { if (alive.current) setSendError(message(e)) }
    finally { sending.current = false; if (alive.current) setBusy(false) }
  }
  return <>
    <section className="agent-section agent-composer" aria-labelledby="agent-request-title">
      <header className="agent-section-head"><div><h2 id="agent-request-title">Ask {agent.display}</h2><p>Describe the outcome you need and any context it should use.</p></div></header>
      {!canAct ? <p className="agent-warning">This agent has no current workspace access. Ask an admin to grant or renew access before sending a request.</p>
        : runnerSeen(agent.tokens.last_used) === null || !agent.tokens.count ? <p className="agent-queue-note">You can queue a request now. It won’t start until a runner connects.</p> : null}
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        <label className="dash-sr-only" htmlFor="agent-request">Request for {agent.display}</label>
        <textarea id="agent-request" ref={textarea} value={note} disabled={!canAct || busy} rows={4}
          placeholder="e.g. Summarize this week’s work and flag anything that needs my review."
          onChange={e => { setNote(e.target.value); setFeedback(null); setSendError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }} />
        {!note && <div className="agent-prompt-examples"><span>Try a request</span>{[
          ['Weekly summary', 'Summarize this week’s work in the workspace and flag anything that needs my review.'],
          ['Find open questions', 'Find unresolved questions in the shared workspace and link to the relevant sources.'],
        ].map(([label, prompt]) => <button type="button" className="tool" disabled={!canAct || busy} key={label} onClick={() => { setNote(prompt); setFeedback(null); textarea.current?.focus() }}>{label}</button>)}</div>}
        <footer className="agent-composer-footer"><span>⌘ / Ctrl + Enter to send</span><button className="btn action" disabled={!canAct || !note.trim() || busy} type="submit">{busy ? 'Queuing…' : 'Queue request'}</button></footer>
        {feedback && <p className="agent-send-success" role="status">{feedback}</p>}
        {sendError && <p className="agent-form-error" role="alert">Could not queue the request. {sendError} Your text has been kept.</p>}
      </form>
      <p className="agent-help">For a specific doc, dashboard or task, use <b>Ask an agent</b> on that item to include its context.</p>
    </section>
    <section className="agent-section" aria-labelledby="agent-queue-title">
      <header className="agent-section-head"><div><h2 id="agent-queue-title">Queued requests {asks && <span className="agent-count">{asks.length}</span>}</h2><p>Waiting to be picked up by a runner. Refreshes every 15 seconds.</p></div>
        <button className="tool" disabled={refreshing} onClick={() => void reload()}>{refreshing ? 'Refreshing…' : 'Refresh queue'}</button></header>
      {inboxError && <div className="agent-notice" role="alert"><span><b>Could not refresh the request queue.</b> {inboxError}{asks ? ' Showing the last loaded requests.' : ''}</span>
        <button className="tool" disabled={refreshing} onClick={() => void reload()}>Retry queue</button></div>}
      {asks === null ? !inboxError && <p className="agent-empty" role="status">Loading requests…</p>
        : asks.length === 0 ? !inboxError && <div className="agent-empty"><b>No requests waiting</b><p>Send a request above to add it to the queue. Requests leave this list when claimed, not necessarily when completed.</p></div>
        : <ul className="agent-request-list">{asks.map(ask => <li key={ask.seq}>
          <div className="agent-request-top"><b>{ask.note}</b><Pill tone="gray">Queued</Pill></div>
          <p>{ask.asked_by} · {ago(ask.asked_at)}{ask.object && <> · <Link to={ask.object.type === 'video' ? `/videos/${ask.object.id}` : ask.object.type === 'artifact' ? `/artifacts/${ask.object.id}` : pageFor(ask.object)}>{ask.object.title}</Link></>}</p>
        </li>)}</ul>}
    </section>
  </>
}
