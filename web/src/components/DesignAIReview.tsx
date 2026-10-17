import { useEffect, useRef, useState } from 'react'
import type { DesignTokens, GeneratedDesign, WireDesign } from '../data/gateway'
import { DesignScreenView } from './DesignCanvas'

type Spec = WireDesign['spec']
// Object key order is not a design change. Array order (paint order) is.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function designChangeSummary(before: Spec, after: Spec) {
  const added = after.screens.filter(screen => !before.screens.some(old => old.id === screen.id))
  const removed = before.screens.filter(screen => !after.screens.some(next => next.id === screen.id))
  const changed = after.screens.filter(screen => {
    const previous = before.screens.find(old => old.id === screen.id)
    return previous && canonical(previous) !== canonical(screen)
  })
  const tokensChanged = canonical(before.tokens ?? {}) !== canonical(after.tokens ?? {})
  const reordered = canonical(before.screens.map(screen => screen.id)) !== canonical(after.screens.map(screen => screen.id))
    && !added.length && !removed.length
  return { added, removed, changed, tokensChanged, reordered,
    hasChanges: !!(added.length || removed.length || changed.length || tokensChanged || reordered) }
}

export interface AIProposal {
  generated: GeneratedDesign
  base: Spec
  revision?: number
  brief: string
  scope: string
  element?: string
  beforeTokens?: DesignTokens
  afterTokens?: DesignTokens
}

export function DesignAIReview({ proposal, surface, tokens, busy, outdated, error, onAccept, onDiscard }: {
  proposal: AIProposal
  surface: WireDesign['surface']
  tokens?: DesignTokens
  busy: boolean
  outdated: boolean
  error: string | null
  onAccept: () => void
  onDiscard: () => void
}) {
  const { base, generated } = proposal
  const summary = designChangeSummary(base, generated.spec)
  const screens = [...generated.spec.screens, ...summary.removed]
  const initial = summary.changed[0] ?? summary.added[0] ?? summary.removed[0] ?? screens[0]
  const [screenId, setScreenId] = useState(initial?.id)
  const before = base.screens.find(screen => screen.id === screenId)
  const after = generated.spec.screens.find(screen => screen.id === screenId)
  const root = useRef<HTMLDivElement>(null)
  const review = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(300)
  useEffect(() => {
    if (!document.querySelector('.dleave-dialog')) review.current?.focus({ preventScroll: true })
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(120, entry.contentRect.width)))
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  return <section ref={review} tabIndex={-1} className="dai-review" aria-label="Review AI changes">
    <div className="dai-review-heading"><div><h2>Review AI changes</h2>
      <p>{proposal.scope} · Nothing is saved until you accept.</p></div>
      <span className="dai-draft-badge">Unsaved preview</span></div>
    <p className="dai-review-brief">{proposal.brief}</p>
    <div className="dai-summary" aria-label="Change summary">
      {summary.hasChanges ? <>
        <span>{summary.changed.length} {summary.changed.length === 1 ? 'screen' : 'screens'} changed</span><span>{summary.added.length} added</span><span>{summary.removed.length} removed</span>
        {summary.tokensChanged && <span>Design tokens changed</span>}{summary.reordered && <span>Screen order changed</span>}
      </> : <span>No changes were proposed.</span>}
    </div>
    {generated.rationale && <details><summary>AI explanation</summary><p>{generated.rationale}</p></details>}
    {screens.length > 0 && <label className="dai-review-screen">Compare screen
      <select value={screenId} onChange={event => setScreenId(event.target.value)}>
        {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}{summary.added.includes(screen) ? ' · added' : summary.removed.includes(screen) ? ' · removed' : summary.changed.includes(screen) ? ' · changed' : ''}</option>)}
      </select>
    </label>}
    <div className="dai-compare">
      <div><h3>Before</h3><div className="dai-compare-stage" ref={root} aria-hidden="true" inert>
        {before ? <DesignScreenView screen={before} surface={surface} width={width} maxHeight={410} tokens={proposal.beforeTokens ?? (base.tokens && Object.keys(base.tokens).length ? base.tokens : tokens)} />
          : <span>Screen not present</span>}
      </div></div>
      <div><h3>Proposed</h3><div className="dai-compare-stage" aria-hidden="true" inert>
        {after ? <DesignScreenView screen={after} surface={surface} width={width} maxHeight={410}
          tokens={proposal.afterTokens ?? (generated.spec.tokens && Object.keys(generated.spec.tokens).length ? generated.spec.tokens : tokens)} /> : <span>Screen removed</span>}
      </div></div>
    </div>
    <details className="dai-spec-diff"><summary>Read the exact specs</summary>
      <div><section aria-label="Before spec"><h3>Before</h3><pre>{JSON.stringify(base, null, 2)}</pre></section>
        <section aria-label="Proposed spec"><h3>Proposed</h3><pre>{JSON.stringify(generated.spec, null, 2)}</pre></section></div>
    </details>
    {outdated && <p className="p-warn">The saved design changed since this preview was generated. Discard this preview and generate again.</p>}
    {error && <p className="p-warn" role="alert">{error}</p>}
    <div className="dai-review-actions">
      <button className="tool" disabled={busy} onClick={onDiscard}>Discard AI changes</button>
      <button className="btn action" disabled={busy || outdated || !summary.hasChanges} onClick={onAccept}>
        {busy ? 'Saving…' : 'Accept AI changes'}</button>
    </div>
  </section>
}
