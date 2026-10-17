import { useContext, useEffect, useRef, useState } from 'react'
import { UNSAFE_DataRouterContext, useBlocker, useNavigate } from 'react-router-dom'
import { createAgent, GatewayError } from '../../data/gateway'
import { NavIcon } from '../../components/NavIcon'
import { Pick } from '../../components/ShareButton'
import { ACCESS, CopyButton, HANDLE, RunnerInstructions } from './shared'

export type CreatedAgent = { agent_id: string; token: string; token_note: string }
const choices = [
  { id: 'read', title: 'Read only', text: 'Search and read shared workspace content.' },
  { id: 'propose', title: 'Can draft', text: 'Read content and write proposals for review.' },
  { id: 'merge', title: 'Can approve', text: 'Draft work and approve metric definitions.' },
]
const suggestedHandle = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40).replace(/[-_]+$/, '')

function Steps({ connected = false }: { connected?: boolean }) {
  return <ol className="agent-setup-steps" aria-label="Agent setup">
    <li aria-current={!connected ? 'step' : undefined}><span>{connected ? '✓' : '1'}</span>Create agent</li>
    <li aria-current={connected ? 'step' : undefined}><span>2</span>Connect agent</li>
  </ol>
}

export function AgentSetup({ onDone, onCancel }: { onDone: (made: CreatedAgent) => void; onCancel: () => void }) {
  const [id, setId] = useState('')
  const [customHandle, setCustomHandle] = useState(false)
  const [display, setDisplay] = useState('')
  const [tier, setTier] = useState('propose-only')
  const [relation, setRelation] = useState('propose')
  const [days, setDays] = useState('90')
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null)
  const sending = useRef(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const handleInput = useRef<HTMLInputElement>(null)
  useEffect(() => { nameInput.current?.focus() }, [])
  // Wait for the input to be enabled again before focusing a server error.
  useEffect(() => { if (!busy && err?.field === 'agent_id') handleInput.current?.focus() }, [busy, err])
  const valid = HANDLE.test(id.trim())
  const invalidHandle = (touched && !!id && !valid) || err?.field === 'agent_id'

  const submit = async () => {
    if (sending.current || !valid) return
    sending.current = true; setBusy(true); setErr(null)
    try {
      onDone(await createAgent({ agent_id: id.trim(), display: display.trim() || undefined,
        trust_tier: tier, grant: { relation, resource: 'space:pay', days: Number(days) || undefined },
        expires_days: Number(days) || undefined }))
    } catch (e) {
      setErr(e instanceof GatewayError ? { message: e.message, field: e.field } : { message: e instanceof Error ? e.message : String(e) })
    } finally { sending.current = false; setBusy(false) }
  }

  return <section className="agent-setup" aria-labelledby="agent-create-title">
    <div className="agent-setup-head"><div><Steps /><h2 id="agent-create-title">Add an agent</h2>
      <p>Give it an identity and choose what it can do. You’ll connect its runner next.</p></div>
      <button className="tool" disabled={busy} onClick={onCancel}>Cancel</button></div>
    <form onSubmit={e => { e.preventDefault(); void submit() }} noValidate>
      <div className="agent-setup-grid">
        <div className="agent-setup-fields">
          <section className="agent-form-section" aria-labelledby="agent-identity-title">
            <h3 id="agent-identity-title">Identity</h3>
            <div className="agent-field-row">
              <label className="agent-field"><span>Name <small>Optional</small></span>
                <input ref={nameInput} value={display} autoComplete="off" placeholder="e.g. Readout writer" disabled={busy}
                  onChange={e => { setDisplay(e.target.value); if (!customHandle) setId(suggestedHandle(e.target.value)) }} />
                <small>The name people see in your workspace.</small>
              </label>
              <div className="agent-field"><label htmlFor="agent-handle">Handle <small>Required</small></label>
                <div className={`agent-handle${invalidHandle ? ' invalid' : ''}`}><span aria-hidden="true">@</span>
                  <input id="agent-handle" ref={handleInput} value={id} disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false}
                    placeholder="readout-writer" maxLength={40} aria-required="true" aria-invalid={!!invalidHandle} aria-describedby="agent-handle-help"
                    onBlur={() => setTouched(true)} onChange={e => { setCustomHandle(true); setId(e.target.value); setErr(null) }} /></div>
                <small id="agent-handle-help" role={err?.field === 'agent_id' ? 'alert' : undefined} className={invalidHandle ? 'agent-field-error' : ''}>
                  {err?.field === 'agent_id' ? err.message : invalidHandle
                    ? 'Use 3–40 lowercase letters, digits, hyphens or underscores. Start with a letter and end with a letter or digit.'
                    : 'Used for @mentions. 3–40 lowercase letters, digits, hyphens or underscores. Cannot be changed later.'}
                </small>
              </div>
            </div>
            <div className="agent-owner-note"><NavIcon name="members" /><span><b>You’ll be the owner.</b> Admins can manage the agent. Workspace members can @mention it or assign work.</span></div>
          </section>
          <section className="agent-form-section" aria-labelledby="agent-permissions-title">
            <h3 id="agent-permissions-title">Permissions</h3>
            <fieldset className="agent-access-options" disabled={busy}>
              <legend>Workspace access</legend>
              <div>{choices.map(choice => <label className={`agent-access-option${relation === choice.id ? ' selected' : ''}`} key={choice.id}>
                <input type="radio" name="agent-access" value={choice.id} checked={relation === choice.id} onChange={() => {
                  setRelation(choice.id); if (choice.id === 'read') setTier('propose-only')
                }} />
                <span><b>{choice.title}</b><span>{choice.text}</span>{choice.id === 'propose' && <small>Recommended</small>}</span>
              </label>)}</div>
            </fieldset>
            <p className="agent-help">Applies to shared workspace content. Private docs stay private unless someone shares them with it.</p>
            <div className="agent-field-row">
              <div className="agent-field"><span>Metric approval</span>
                <Pick label="Metric approval" value={tier} onChange={setTier} disabled={busy || relation === 'read'}
                  options={[["propose-only", 'Require human approval'], ["autonomous", 'Publish without review']]} />
                <small>{relation === 'read' ? 'Read-only agents cannot create metric definitions.' : 'Controls new metric definitions, not all docs, tasks or answers.'}</small>
              </div>
              <div className="agent-field"><span>Access expires</span>
                <Pick label="Access expires" value={days} onChange={setDays} disabled={busy}
                  options={[["30", 'In 30 days'], ["90", 'In 90 days (recommended)'], ["365", 'In 1 year'], ["0", 'Never']]} />
                <small>{days === '0' ? 'Access and token never expire. Revoke them when no longer needed.' : `Workspace access and the token expire together after ${days} days.`}</small>
              </div>
            </div>
            {tier === 'autonomous' && <p className="agent-warning" role="status">Metric definitions from this agent can be used in dashboards immediately, without a person approving them.</p>}
          </section>
        </div>
        <aside className="agent-setup-summary" aria-label="Agent setup summary">
          <span className="agent-large-icon"><NavIcon name="agents" /></span>
          <h3>{display.trim() || id.trim() || 'Your new agent'}</h3>
          <p className="mono">@{id.trim() || 'agent-handle'}</p>
          <dl><div><dt>Owner</dt><dd>You</dd></div><div><dt>Workspace access</dt><dd>{ACCESS[relation]}</dd></div>
            <div><dt>Metric definitions</dt><dd>{relation === 'read' ? 'Cannot create' : tier === 'autonomous' ? 'Published directly' : 'Human approval'}</dd></div>
            <div><dt>Access duration</dt><dd>{days === '0' ? 'No expiry' : `${days} days`}</dd></div></dl>
          <div className="agent-next-step"><b>Next: connect a runner</b><p>Creating an agent does not start an AI process. Use its token with a runner and the model of your choice.</p></div>
        </aside>
      </div>
      {err && err.field !== 'agent_id' && <div className="agent-form-error" role="alert">{err.message}</div>}
      <footer className="agent-setup-footer"><span>No agent is created until you submit.</span><div>
        <button type="button" className="tool" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn action" disabled={busy || !valid}>{busy ? 'Creating…' : 'Create agent'}</button>
      </div></footer>
    </form>
  </section>
}

/** Only mounted in the app's data router; isolated component tests use MemoryRouter. */
function SecretRouteGuard({ pending }: { pending: boolean }) {
  const blocker = useBlocker(pending)
  const stay = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (blocker.state === 'blocked') stay.current?.focus() }, [blocker.state])
  return blocker.state === 'blocked' ? <div className="agent-notice" role="alert">
    <span><b>Save your token before leaving.</b> It cannot be shown again.</span>
    <button ref={stay} className="tool" onClick={() => blocker.reset()}>Stay and save token</button>
    <button className="tool" onClick={() => blocker.proceed()}>Leave without token</button>
  </div> : null
}

export function AgentCreated({ made, onDone }: { made: CreatedAgent; onDone: () => void }) {
  const [revealed, setRevealed] = useState(false)
  const [saved, setSaved] = useState(false)
  const navigate = useNavigate()
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    if (saved) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saved])
  return <section className="agent-setup agent-created" aria-labelledby="agent-created-title">
    {dataRouter && <SecretRouteGuard pending={!saved} />}
    <div className="agent-setup-head"><div><Steps connected /><h2 id="agent-created-title" ref={heading} tabIndex={-1}>Agent created. Now connect it.</h2>
      <p><b>@{made.agent_id}</b> is ready to connect. No runner has been started by this setup.</p></div></div>
    <div className="agent-created-body">
      <section className="agent-token-section" aria-labelledby="agent-token-title"><h3 id="agent-token-title">Save your agent token</h3>
        <p>This is the only time it’s shown. Store it securely and give it only to the process running this agent. Don’t paste it into a chat or commit it to code.</p>
        <div className="agent-token-control"><input type={revealed ? 'text' : 'password'} value={made.token} readOnly aria-label="Agent token" autoComplete="off" spellCheck={false} />
          <button type="button" className="tool" aria-pressed={revealed} onClick={() => setRevealed(r => !r)}>{revealed ? 'Hide token' : 'Show token'}</button><CopyButton text={made.token} label="Copy token" /></div>
        <label className="agent-token-ack"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I have saved this token or no longer need it.</label>
      </section>
      <section className="agent-connect-section"><h3>Connect your runner</h3><p>Configure your agent process with this token and your platform’s gateway URL. It must read the agent inbox to pick up requests. A token alone does not run a model.</p>
        <RunnerInstructions id={made.agent_id} /></section>
    </div>
    <footer className="agent-setup-footer"><span>Once connected, send a request from the agent’s page.</span><div>
      <button className="tool" disabled={!saved} onClick={onDone}>Back to agents</button>
      <button className="btn action" disabled={!saved} onClick={() => { onDone(); navigate(`/agents/${made.agent_id}`) }}>Open agent →</button>
    </div></footer>
  </section>
}
