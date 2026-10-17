import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { askAgent, assistVideo, listAgentsLive, type VideoSuggestion, type WireAgent } from '../data/gateway'
import type { Scene } from '../data/composition'
import { Pick } from './ShareButton'

type Props = {
  id: string; title: string; brief: string; composition: string; selected?: Scene
  modelConfigured?: boolean
  locked: boolean; changed: boolean; proposal: VideoSuggestion | null; comparison: 'before' | 'after'
  onBusy: (busy: boolean) => void; onProposal: (proposal: VideoSuggestion) => void
  onCompare: (view: 'before' | 'after') => void; onAccept: () => void; onDiscard: () => void
}

/** Model previews stay local. Agent requests use the existing inbox, not a fake run. */
export function VideoAssistant(p: Props) {
  const [mode, setMode] = useState<'model' | 'agent'>('model')
  const [instruction, setInstruction] = useState('')
  const [context, setContext] = useState('scene')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [reply, setReply] = useState('')
  const [agents, setAgents] = useState<WireAgent[] | null>(null)
  const [agent, setAgent] = useState('')
  const [agentError, setAgentError] = useState('')
  const [retry, setRetry] = useState(0)
  const pending = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (mode !== 'agent') return
    let active = true
    setAgentError('')
    listAgentsLive().then(r => { if (active) setAgents(r.agents ?? []) })
      .catch(e => { if (active) setAgentError(e instanceof Error ? e.message : String(e)) })
    return () => { active = false }
  }, [mode, retry])
  const scene = context === 'scene' ? p.selected : undefined
  const attached = scene ? `Scene ${scene.id + 1}: ${scene.label} (${scene.start}s–${scene.start + scene.duration}s)` : 'Whole video'
  const unavailable = p.locked || working || !instruction.trim() ||
    (mode === 'model' && p.modelConfigured === false) ||
    (mode === 'agent' && (!agent || p.changed || !!agentError))
  const send = async () => {
    if (pending.current || unavailable) return
    pending.current = true; setWorking(true); p.onBusy(true); setError(''); setReply('')
    try {
      if (mode === 'agent') {
        const result = await askAgent({ agent_id: agent, object_id: p.id,
          note: `Video edit request. Context: ${attached}.\n${instruction.trim()}\n\nRead the saved video with videos.get. Suggest changes for the author to review; do not save or render without approval.` })
        if (alive.current) setReply(`${result.repeat ? 'Already queued' : 'Request queued'} for ${agents?.find(a => a.id === agent)?.display ?? agent}. It will be picked up when the agent connects. No edit has been applied here.`)
      } else {
        const result = await assistVideo({ video_id: p.id, instruction: instruction.trim(),
          composition: p.composition, title: p.title, brief: p.brief, context: attached })
        if (alive.current) {
          if (typeof result.composition !== 'string') throw new Error('The model returned no composition. Your draft is unchanged.')
          if (result.composition === p.composition) setReply(result.summary || 'No changes suggested. Try a more specific request.')
          else p.onProposal(result)
        }
      }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; if (alive.current) { setWorking(false); p.onBusy(false) } }
  }

  return <section className="ved-ai" aria-label="Edit video with AI">
    <div className="ved-ai-heading"><strong>Edit with AI</strong>
      <Pick label="AI editing method" value={mode} disabled={p.locked || working}
        options={[["model", "LLM preview"], ["agent", "Ask an agent"]]}
        onChange={value => { setMode(value); setError(''); setReply('') }} /></div>
    {p.proposal ? <div className="ved-ai-review" aria-label="Review AI suggestion">
      <strong>Review suggested changes</strong>
      <p>{p.proposal.summary || 'Preview the suggested video before accepting.'}</p>
      <div className="ved-ai-compare" role="group" aria-label="Compare AI suggestion">
        <button className="btn" aria-pressed={p.comparison === 'before'} onClick={() => p.onCompare('before')}>Before</button>
        <button className="btn" aria-pressed={p.comparison === 'after'} onClick={() => p.onCompare('after')}>After</button>
      </div>
      <p className="ved-ai-note">{p.proposal.model && <>{p.proposal.model} · </>}Not saved. Accept adds one undoable edit.</p>
      <div className="ved-ai-actions"><button className="btn" onClick={p.onDiscard}>Discard suggestion</button>
        <button className="btn action" onClick={p.onAccept}>Accept changes</button></div>
    </div> : <>
      <div className="ved-ai-context"><span>Context</span>
        <Pick label="AI context" value={scene ? 'scene' : 'video'} disabled={p.locked || working} onChange={setContext}
          options={p.selected ? [['scene', `Selected scene · ${p.selected.id + 1}`], ['video', 'Whole video']] : [['video', 'Whole video']]} />
      </div>
      {mode === 'agent' && <div className="ved-ai-agent">
        <Pick label="Agent to ask" value={agent} disabled={p.locked || working || !agents?.length} onChange={setAgent}
          options={[
            ['', agents === null ? 'Loading agents…' : agents.length ? 'Choose an agent' : 'No agents available'],
            ...(agents ?? []).map(a => [a.id, a.display] as [string, string]),
          ]} />
        {agentError && <p role="alert">Could not load agents. <button className="linkbtn" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
        {agents?.length === 0 && <Link to="/agents">Set up an agent →</Link>}
      </div>}
      <textarea rows={3} aria-label="Describe a video change" aria-describedby="video-ai-help" maxLength={4000}
        value={instruction} disabled={p.locked || working} onChange={e => { setInstruction(e.target.value); setReply('') }}
        placeholder="Describe a change or ask a question… e.g. make the heading larger and slow the reveal."
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && !e.repeat) { e.preventDefault(); void send() }
        }} />
      <p id="video-ai-help" className="ved-ai-note">{mode === 'model' ? 'Your current draft and scene context go to the configured model. Nothing is saved automatically.' : 'Sends a request about the saved video. The agent needs access and must connect to pick it up.'}</p>
      {mode === 'model' && p.modelConfigured === false && <div className="ved-ai-setup" role="status">
        <p>No LLM is configured on this server. <button className="linkbtn" disabled={p.locked} onClick={() => { setMode('agent'); setError(''); setReply('') }}>Ask an agent instead</button></p>
        <details><summary>Model setup</summary><p>Configure the Docs model (<code>COMMONINDEX_LLM_BASE_URL</code> and <code>COMMONINDEX_LLM_MODEL</code>), or the Designs model (<code>COMMONINDEX_MODEL_PROVIDER</code> and <code>COMMONINDEX_MODEL_API_KEY</code>) on the gateway. Reload after setup. See <code>docs/videos.md</code>.</p></details>
      </div>}
      {mode === 'agent' && p.changed && <p className="ved-ai-note warning">Save or discard your edits before asking an agent, so it sees the same video.</p>}
      <div className="ved-ai-actions"><span>⌘ / Ctrl + Enter</span><button className="btn action" disabled={unavailable} onClick={() => void send()}>
        {working ? (mode === 'model' ? 'Thinking…' : 'Sending…') : mode === 'model' ? 'Preview changes' : 'Send request'}</button></div>
      {working && <p role="status" className="ved-ai-note">{mode === 'model' ? 'Preparing a suggestion. Your draft is unchanged.' : 'Adding the request to the agent’s inbox…'}</p>}
      {reply && <p role="status" className="ved-ai-reply">{reply}</p>}
      {error && <p role="alert" className="ved-ai-error">{error}</p>}
    </>}
  </section>
}
