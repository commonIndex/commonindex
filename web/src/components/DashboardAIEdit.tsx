import { useState } from 'react'
import {
  addPanel, aiEditDashboard, GatewayError, removePanel, renameDashboard, reorderPanels, type WireDashEdit,
} from '../data/gateway'
import { Icon } from './doc/Icons'

const MARK: Record<string, string> = {
  stat: 'number', line: 'line chart', area: 'area chart', bar: 'bar chart', stacked: 'stacked bars',
  pie: 'pie chart', table: 'table', heatmap: 'heatmap', pivot: 'pivot', gauge: 'gauge',
}
const message = (e: unknown) => e instanceof GatewayError ? e.message : e instanceof Error ? e.message : String(e)

/** Edit the dashboard by saying what to change, as designs and docs can be.
 *  The model proposes; the page shows the change in words and makes it only
 *  on Apply, through the same panel operations a person's own edits use. */
export function DashboardAIEdit({ dashboardId, panelIds, onApplied }: {
  dashboardId: string
  /** Current panels, in order: a redefined panel keeps its place. */
  panelIds: string[]
  onApplied: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'asking' | 'applying' | null>(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<WireDashEdit | null>(null)

  const ask = async () => {
    if (!text.trim()) return
    setBusy('asking'); setErr(''); setEdit(null)
    try { setEdit(await aiEditDashboard(dashboardId, text.trim())) } catch (e) { setErr(message(e)) } finally { setBusy(null) }
  }

  const apply = async () => {
    if (!edit) return
    setBusy('applying'); setErr('')
    try {
      if (edit.title) await renameDashboard(dashboardId, edit.title)
      const swapped: Record<string, string> = {}
      for (const r of edit.replace) {
        swapped[r.panel_id] = (await addPanel(dashboardId, { ...r.panel, dataset_id: edit.dataset_id })).panel_id
      }
      const added: string[] = []
      for (const p of edit.add) added.push((await addPanel(dashboardId, { ...p, dataset_id: edit.dataset_id })).panel_id)
      const gone = new Set(edit.remove)
      const order = [...panelIds.filter(id => !gone.has(id)).map(id => swapped[id] ?? id), ...added]
      if (edit.replace.length || added.length) await reorderPanels(dashboardId, order)
      for (const id of [...edit.remove, ...edit.replace.map(r => r.panel_id)]) await removePanel(id)
      setEdit(null); setText('')
      onApplied()
    } catch (e) {
      setErr(`${message(e)} — part of the change may have been made; the dashboard shows what was.`)
      onApplied()
    } finally { setBusy(null) }
  }

  const nothing = edit && !edit.title && !edit.add.length && !edit.remove.length && !edit.replace.length
  return (
    <section className="dai" aria-label="Edit with AI">
      <div className="dai-row">
        <span className="dai-tag"><Icon name="sparkle" size={13} /> Edit with AI</span>
        <input className="dai-input" value={text} onChange={e => setText(e.target.value)}
          placeholder="e.g. add revenue by region as a bar chart, make orders a weekly line, remove the gauge"
          aria-label="What to change" disabled={busy !== null}
          onKeyDown={e => { if (e.key === 'Enter') void ask() }} />
        <button className="btn xai-btn" onClick={() => void ask()} disabled={busy !== null || !text.trim()}>
          {busy === 'asking' ? 'Thinking…' : 'Suggest'}</button>
      </div>
      {err && <div className="dai-err" role="alert">{err}</div>}
      {edit && (
        <div className="dai-proposal" role="region" aria-label="Proposed change">
          <p className="dai-summary">{edit.summary}</p>
          {!nothing && <ul className="dai-changes">
            {edit.title && <li><b className="dai-k k-change">Rename</b> to “{edit.title}”</li>}
            {edit.replace.map(r => <li key={r.panel_id}><b className="dai-k k-change">Change</b>{' '}
              {edit.titles[r.panel_id] ?? r.panel_id} → {r.panel.title} as a {MARK[r.panel.mark] ?? r.panel.mark}</li>)}
            {edit.add.map(p => <li key={p.title}><b className="dai-k k-add">Add</b> {p.title} as a {MARK[p.mark] ?? p.mark}</li>)}
            {edit.remove.map(id => <li key={id}><b className="dai-k k-remove">Remove</b> {edit.titles[id] ?? id}</li>)}
          </ul>}
          <div className="dai-foot">
            <span className="hint">A proposal — nothing has changed yet.</span>
            <button className="chip" onClick={() => setEdit(null)} disabled={busy !== null}>Discard</button>
            {!nothing && <button className="btn action" onClick={() => void apply()} disabled={busy !== null}>
              {busy === 'applying' ? 'Applying…' : 'Apply'}</button>}
          </div>
        </div>
      )}
    </section>
  )
}
