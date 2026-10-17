import { useEffect, useRef, useState } from 'react'
import { generateDashboard, previewPanel, toPanel, type DashboardSuggestion, type DraftPanel, type WireDataset } from '../data/gateway'
import type { Panel } from '../data/types'
import { Pill } from '../components/ui'

export type StagedDashboardPanel = { draft: DraftPanel; panel: Panel; days: number }
const titleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x'
const measure = (p: DraftPanel) => p.agg === 'count' ? 'Row count'
  : p.agg === 'ratio' ? `Sum of ${p.column} ÷ sum of ${p.denominator}`
  : p.agg === 'share' ? `Share where ${p.column} equals ${String(p.value)}`
  : `${({ sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count_distinct: 'Distinct count' } as Record<string, string>)[p.agg]} of ${p.column}`

const EXAMPLES = [
  ['Overview', 'Create a concise overview with a total, a trend if time is available, and a useful category breakdown.'],
  ['Trends', 'Show how activity changes over time, using only the columns in this source. Explain what each panel measures.'],
  ['Top categories', 'Compare the top 10 categories by row count and include a total. Use the available categorical columns.'],
]

/** The same brief at the beginning of the wizard and in the panel workbench.
 * State belongs to the wizard, so source changes and Back never erase it. */
export function DashboardPrompt({ instruction, onInstructionChange, disabled, onSubmit, beforeSource = false }: {
  instruction: string; onInstructionChange: (value: string) => void
  disabled?: boolean; onSubmit?: () => void; beforeSource?: boolean
}) {
  return <>
    <div className="dashboard-assist-heading">
      <div><h2 id="dashboard-assist-title">Describe your dashboard</h2>
        <p>{beforeSource ? 'Start with the question. Choose your data below, then let AI suggest panels.'
          : 'Let AI suggest panels, then review and refine them in the builder.'}</p></div>
      <Pill tone="blue">AI assisted</Pill>
    </div>
    <label className="fld" htmlFor="dashboard-instruction"><span>What would you like to understand?</span></label>
    <textarea id="dashboard-instruction" rows={3} maxLength={4000} value={instruction}
      disabled={disabled} placeholder="e.g. Show weekly activity, the total volume, and a breakdown by category."
      aria-describedby="dashboard-ai-privacy"
      onChange={e => onInstructionChange(e.target.value)}
      onKeyDown={e => { if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit() } }} />
    <div className="dashboard-assist-examples"><span>Try a starting point</span>
      {EXAMPLES.map(([label, prompt]) => <button key={label} className="chip" disabled={disabled}
        onClick={() => onInstructionChange(prompt)}>{label}</button>)}
    </div>
  </>
}

export function DashboardAssist({ connectionId, dataset, timeColumn, days, existing, title, useSuggestedTitle, disabled, onAdd, onEdit, instruction, onInstructionChange }: {
  connectionId: string; dataset: WireDataset; timeColumn: string | null; days: number
  existing: StagedDashboardPanel[]; title: string; useSuggestedTitle: boolean; disabled: boolean
  onAdd: (panels: StagedDashboardPanel[], title?: string) => void
  onEdit: (draft: DraftPanel) => void
  instruction: string; onInstructionChange: (value: string) => void
}) {
  const [proposal, setProposal] = useState<DashboardSuggestion | null>(null)
  const [selected, setSelected] = useState<boolean[]>([])
  const [rename, setRename] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'preview' | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [panelErrors, setPanelErrors] = useState<Record<number, string>>({})
  const sequence = useRef(0)
  const sourceKey = JSON.stringify([connectionId, dataset.id, timeColumn, days])
  // Prevent an in-flight batch from overwriting a manually changed draft.
  const snapshot = JSON.stringify([sourceKey, existing.map(p => p.draft), title, disabled])
  const current = useRef(snapshot)
  current.current = snapshot
  useEffect(() => {
    sequence.current++
    setProposal(null); setSelected([]); setBusy(null); setError(''); setStatus(''); setPanelErrors({})
    return () => { sequence.current++ }
  }, [sourceKey])

  const suggest = async () => {
    if (disabled || busy || !instruction.trim()) return
    const mine = ++sequence.current
    setBusy('generate'); setError(''); setStatus('Suggesting panels from your source metadata…')
    try {
      const result = await generateDashboard({ connection_id: connectionId, dataset_id: dataset.id,
        instruction: instruction.trim(), time_column: timeColumn, range: `${days}d` })
      if (mine !== sequence.current) return
      if (result.time_column !== timeColumn || result.range !== `${days}d`) {
        throw new Error('The source timeline changed. Choose the source again before generating panels.')
      }
      setProposal(result); setSelected(result.panels.map(() => true)); setPanelErrors({})
      setRename(useSuggestedTitle)
      setStatus(result.panels.length ? 'Review the suggested definitions below. No data has been queried by AI.' : 'More information is needed. See the explanation below.')
    } catch (e) {
      if (mine === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setStatus('') }
    } finally { if (mine === sequence.current) setBusy(null) }
  }

  const previewAndAdd = async () => {
    if (!proposal || disabled || busy) return
    const mine = ++sequence.current
    const startedWith = current.current
    const wanted = proposal.panels.map((draft, index) => ({ draft, index })).filter(p => selected[p.index])
    if (!wanted.length) return
    setBusy('preview'); setError(''); setPanelErrors({})
    const staged: StagedDashboardPanel[] = []
    const errors: Record<number, string> = {}
    const used = new Set(existing.map(p => titleKey(p.draft.title)))
    const unchanged = () => {
      if (mine !== sequence.current) return false
      if (startedWith === current.current) return true
      setBusy(null); setStatus(''); setError('Your dashboard changed while previews were running. Nothing was added; preview again to use the current draft.')
      return false
    }
    // At most six sequential previews: no model-driven fan-out to a warehouse.
    for (const [n, item] of wanted.entries()) {
      if (!unchanged()) return
      setStatus(`Running preview ${n + 1} of ${wanted.length}…`)
      let name = item.draft.title.trim()
      for (let suffix = 2; used.has(titleKey(name)); suffix++) name = `${item.draft.title.slice(0, 30)} ${suffix}`
      used.add(titleKey(name))
      const draft = { ...item.draft, title: name }
      try {
        const r = await previewPanel(connectionId, dataset.id, draft, timeColumn, `${days}d`)
        staged.push({ draft, days, panel: toPanel({
          panel: { id: `ai-preview-${titleKey(name)}`, title: name, mark: draft.mark, metric_id: r.expr,
            dataset_id: dataset.id, grain: draft.grain },
          unit: r.unit, better: r.better, series: r.series,
        }, 6, { ratified: false, expr: `${r.expr}\n  over ${dataset.id}`, note: 'Not saved yet' }) })
      } catch (e) { errors[item.index] = e instanceof Error ? e.message : String(e) }
    }
    if (!unchanged()) return
    setBusy(null)
    if (Object.keys(errors).length) {
      setPanelErrors(errors); setStatus('')
      setError('Some previews failed. Nothing was added. Edit those suggestions or deselect them, then try again.')
      return
    }
    onAdd(staged, rename ? proposal.title : undefined)
    setProposal(null); setSelected([])
    setStatus(`${staged.length} suggested panel${staged.length === 1 ? '' : 's'} added to your draft. Review the charts below, then create the dashboard to save.`)
  }

  const count = selected.filter(Boolean).length
  return <section className="dashboard-assist" aria-labelledby="dashboard-assist-title">
    <DashboardPrompt instruction={instruction} onInstructionChange={onInstructionChange}
      disabled={!!busy || disabled} onSubmit={() => void suggest()} />
    <div className="dashboard-assist-actions">
      <button className="btn action" disabled={!instruction.trim() || !!busy || disabled} onClick={() => void suggest()}>
        {busy === 'generate' ? 'Generating suggestions…' : proposal ? 'Generate again' : 'Suggest panels'}
      </button>
      {busy && <button className="chip" onClick={() => {
        sequence.current++; setBusy(null); setStatus('Results dismissed. An in-flight request may still finish; nothing will be added.')
      }}>Dismiss request</button>}
      <span className="builder-field-note">{dataset.id} · {timeColumn ? `last ${days} days` : 'no time filter'}</span>
    </div>
    <p id="dashboard-ai-privacy" className="builder-field-note">Your request and this source’s column names and types go to the configured model. No warehouse rows, SQL text, or credentials are sent. Nothing is saved until you create the dashboard.</p>
    {disabled && <p className="builder-field-note">Finish the current panel edit or save before using AI suggestions.</p>}
    <p role="status" aria-live="polite" className="builder-field-note">{status}</p>
    {error && <div className="notice" role="alert">{error}</div>}
    {proposal && <div className="dashboard-assist-review">
      <div className="dashboard-assist-heading"><h3>{proposal.panels.length ? 'Review suggestions' : 'About this request'}</h3>
        {proposal.model && <span className="builder-field-note">{proposal.model}</span>}</div>
      <p>{proposal.summary}</p>
      {proposal.panels.length > 0 && <>
        <label className="dashboard-assist-check"><input type="checkbox" checked={rename} disabled={!!busy || disabled}
          onChange={e => setRename(e.target.checked)} />Use dashboard title: <strong>{proposal.title}</strong></label>
        <div className="dashboard-assist-panels">
          {proposal.panels.map((p, i) => <article key={i} className="dashboard-assist-panel">
            <label className="dashboard-assist-check"><input type="checkbox" checked={selected[i]} disabled={!!busy || disabled}
              onChange={e => setSelected(s => s.map((v, j) => j === i ? e.target.checked : v))} /><strong>{p.title}</strong></label>
            <dl><div><dt>Measure</dt><dd>{measure(p)}</dd></div>
              <div><dt>Chart</dt><dd>{p.mark === 'stat' ? 'Number' : p.mark} · {p.grain === 'none' ? 'no time buckets' : `by ${p.grain}`}{p.dimension ? ` · grouped by ${p.dimension}` : ''}</dd></div>
              <div><dt>Format & order</dt><dd>{p.unit || 'Automatic'} · {p.sort === 'value_desc' ? 'largest first' : p.sort === 'value_asc' ? 'smallest first' : 'bucket order'}{p.limit ? ` · ${p.limit} results` : ' · all result rows'}</dd></div></dl>
            {panelErrors[i] && <p className="bad" role="alert">{panelErrors[i]}</p>}
            <button className="tool" disabled={!!busy || disabled} onClick={() => {
              onEdit(p); setSelected(s => s.map((v, j) => j === i ? false : v))
              setStatus('Suggestion opened in the builder below. Preview and add it there when ready.')
            }}>Edit in builder</button>
          </article>)}
        </div>
        <div className="dashboard-assist-actions">
          <button className="btn action" disabled={!count || !!busy || disabled} onClick={() => void previewAndAdd()}>
            {busy === 'preview' ? 'Running previews…' : `Preview and add ${count} panel${count === 1 ? '' : 's'}`}
          </button>
          <button className="chip" disabled={!!busy} onClick={() => { setProposal(null); setSelected([]); setError(''); setStatus('Suggestions discarded. Your draft is unchanged.') }}>Discard suggestions</button>
          <span className="builder-field-note">Runs real queries. Adds to your draft without replacing existing panels.</span>
        </div>
      </>}
    </div>}
  </section>
}
