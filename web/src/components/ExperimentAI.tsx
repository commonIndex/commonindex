import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { explainExperiment, GatewayError, writeUpExperiment, type WireExplanation } from '../data/gateway'
import { Icon } from './doc/Icons'

export const RECOMMEND: Record<WireExplanation['recommendation'], { label: string; tone: string }> = {
  ship: { label: 'Ship it', tone: 'good' },
  kill: { label: 'Kill it', tone: 'bad' },
  iterate: { label: 'Iterate', tone: 'warn' },
  keep_running: { label: 'Keep running', tone: 'quiet' },
}

const isSummary = (s: unknown): s is WireExplanation => !!s && typeof s === 'object'
  && typeof (s as WireExplanation).headline === 'string' && typeof (s as WireExplanation).summary === 'string'
  && (s as WireExplanation).recommendation in RECOMMEND && Array.isArray((s as WireExplanation).reasons)

const message = (e: unknown) => e instanceof GatewayError ? e.message : 'The gateway could not be reached.'

/** AI on the readout, as the other collections have it: a summary that loads
 *  with the page, and the experiment written up as a doc. `readAt` is when
 *  the readout last arrived: the summary is asked for then, so it follows a
 *  Refresh too. The gateway keeps one per readout, so only the first visit
 *  after the numbers change waits for the model. */
export function useExperimentAI(id: string, readAt: number | null = null) {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<WireExplanation | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setSummary(null); setError('') }, [id])

  const run = async (fresh: boolean, alive: () => boolean = () => true) => {
    setExplaining(true); setError('')
    // Only a whole summary is shown: anything else from the gateway is
    // nothing to show, not a page that falls over reading `reasons`.
    try { const s = await explainExperiment(id, fresh); if (alive()) setSummary(isSummary(s) ? s : null) }
    catch (e) { if (alive()) setError(message(e)) }
    finally { if (alive()) setExplaining(false) }
  }
  useEffect(() => {
    if (readAt === null) return
    let on = true
    void run(false, () => on)
    return () => { on = false }
  }, [id, readAt])
  const explain = () => run(true)
  const writeUp = async () => {
    setWriting(true); setError('')
    try {
      const r = await writeUpExperiment(id, summary)
      navigate(`/docs/edit/${r.doc_id}`)
    } catch (e) { setError(message(e)); setWriting(false) }
  }
  return { summary, explaining, writing, error, explain, writeUp, dismiss: () => setSummary(null) }
}

export function ExperimentAIButtons({ ai }: { ai: ReturnType<typeof useExperimentAI> }) {
  return (
    <span className="xai-actions">
      <button type="button" className="btn xai-btn" disabled={ai.explaining} onClick={() => void ai.explain()}
        title={ai.summary ? 'Write a new summary of this readout' : 'A plain-language summary and a recommendation, checked against this readout'}>
        <Icon name="sparkle" size={14} /> {ai.explaining ? 'Explaining…' : ai.summary ? 'Explain again' : 'Explain with AI'}
      </button>
      <button type="button" className="btn xai-doc" disabled={ai.writing} onClick={() => void ai.writeUp()}
        title="A doc with the hypothesis, setup, results table and decision — filed in this experiment's projects">
        <Icon name="text" size={14} /> {ai.writing ? 'Writing…' : 'Write up as doc'}
      </button>
    </span>
  )
}

/** The summary in one quiet card: what it recommends, the advice as a
 *  headline, why in a sentence, and the two things to do with it — inside the
 *  card, so the readout's own header carries no AI controls. With no summary
 *  yet it is one line offering to write one. */
export function ExperimentAICard({ ai }: { ai: ReturnType<typeof useExperimentAI> }) {
  const actions = <span className="xai-links">
    <button type="button" className="linkbtn" disabled={ai.explaining} onClick={() => void ai.explain()}
      title="A plain-language summary and a recommendation, checked against this readout">
      {ai.explaining ? 'Explaining…' : ai.summary ? 'Explain again' : 'Explain with AI'}</button>
    <span aria-hidden="true">·</span>
    <button type="button" className="linkbtn" disabled={ai.writing} onClick={() => void ai.writeUp()}
      title="A doc with the hypothesis, setup, results table and decision — filed in this experiment's projects">
      {ai.writing ? 'Writing…' : 'Write up as doc'}</button>
  </span>
  if (ai.error) return <div className="xai-card xai-err"><span role="alert">{ai.error}</span>{actions}</div>
  if (ai.explaining && !ai.summary) {
    return <div className="xai-card xai-wait" role="status"><Icon name="sparkle" size={14} />
      AI is reading the results — a summary and a recommendation, checked against the numbers below.</div>
  }
  const s = ai.summary
  if (!s) return <div className="xai-card xai-idle"><span className="xai-tag"><Icon name="sparkle" size={13} /> AI summary</span>{actions}</div>
  const rec = RECOMMEND[s.recommendation]
  return (
    <section className="xai-card" aria-label="AI summary">
      <div className="xai-top">
        <span className="xai-tag"><Icon name="sparkle" size={13} /> AI summary</span>
        <span className={`xai-rec tone-${rec.tone}`}>Recommends: {rec.label}</span>
        <button type="button" className="linkbtn xai-close" onClick={ai.dismiss} aria-label="Dismiss the AI summary">Dismiss</button>
      </div>
      <p className="xai-head">{s.headline}</p>
      <p className="xai-body">{s.summary}</p>
      {(s.reasons.length > 0 || (s.next_steps?.length ?? 0) > 0) && <div className="xai-lists">
        {s.reasons.length > 0 && <div><div className="xai-sub">Why</div>
          <ul>{s.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
        {(s.next_steps?.length ?? 0) > 0 && <div><div className="xai-sub">Next</div>
          <ul>{s.next_steps!.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
      </div>}
      <div className="xai-foot">
        {actions}
        <span className="hint">Every number and the recommendation were checked against this readout. The decision is yours.
          {s.model && <span className="mono"> · {s.model}</span>}</span>
      </div>
    </section>
  )
}
