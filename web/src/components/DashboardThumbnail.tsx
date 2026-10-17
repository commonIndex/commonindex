import type { DashboardPreviewPanel } from '../data/types'

/** Representative panels, not a scaled-down layout whose labels become unreadable.
 * Prefer variety among the metadata supplied by the server; preserve source order. */
export function dashboardPreviewPanels(panels: DashboardPreviewPanel[]) {
  const selected = new Set<string>(), kinds = new Set<string>()
  const kind = (mark: string) => ['table', 'sql', 'pivot'].includes(mark) ? 'table'
    : ['line', 'area', 'stacked'].includes(mark) ? 'trend' : mark === 'heat' ? 'heatmap' : mark
  for (const panel of panels) {
    if (selected.size === 3) break
    if (!kinds.has(kind(panel.mark))) { selected.add(panel.id); kinds.add(kind(panel.mark)) }
  }
  for (const panel of panels) {
    if (selected.size === 3) break
    selected.add(panel.id)
  }
  return panels.filter(panel => selected.has(panel.id)).slice(0, 3)
}

/** These marks illustrate chart TYPES, not values; no fabricated KPI numbers. */
function ChartShape({ mark }: { mark: string }) {
  if (mark === 'stat') return <><text x="4" y="31" fontSize="29" fill="var(--text2)">—</text><path d="M4 45h38" stroke="var(--border)" strokeWidth="3" /></>
  if (mark === 'table' || mark === 'sql' || mark === 'pivot') return <>
    <rect x="2" y="4" width="96" height="10" rx="2" fill="var(--accent-bg)" />
    {[22, 34, 46, 58].map(y => <path key={y} d={`M4 ${y}H96`} stroke="var(--border)" strokeWidth="1.2" />)}
    <path d="M38 4v54M71 4v54" stroke="var(--border)" />
  </>
  if (mark === 'pie') return <>
    <circle cx="50" cy="34" r="26" fill="var(--accent-bg)" />
    <path d="M50 34V8a26 26 0 0 1 24.7 34Z" fill="var(--accent)" opacity=".7" />
    <path d="M50 34l24.7 8A26 26 0 0 1 31 51.8Z" fill="var(--green)" opacity=".55" />
    <circle cx="50" cy="34" r="13" fill="var(--panel)" />
  </>
  if (mark === 'gauge') return <>
    <path d="M16 54a34 34 0 0 1 68 0" stroke="var(--accent-bg)" strokeWidth="10" fill="none" />
    <path d="M16 54a34 34 0 0 1 34-34" stroke="var(--accent)" opacity=".65" strokeWidth="10" fill="none" />
    <text x="50" y="51" textAnchor="middle" fontSize="18" fill="var(--text2)">—</text>
  </>
  if (mark === 'heatmap' || mark === 'heat') return <>{Array.from({ length: 24 }, (_, i) =>
    <rect key={i} x={4 + (i % 6) * 16} y={4 + Math.floor(i / 6) * 15} width="13" height="12" rx="2"
      fill="var(--accent)" opacity={.16 + ((i * 7) % 5) * .12} />)}</>
  if (mark === 'bar') return <>
    <path d="M2 61h96" stroke="var(--border)" />
    {[38, 22, 48, 30, 42, 27].map((height, i) => <rect key={i} x={5 + i * 16} y={60 - height} width="10" height={height} rx="2" fill="var(--accent)" opacity={i % 2 ? '.65' : '.4'} />)}
  </>
  if (['line', 'area', 'stacked'].includes(mark)) return <>
    <path d="M2 16H98M2 38H98M2 60H98" stroke="var(--border)" strokeWidth=".7" />
    {mark !== 'line' && <path d="M3 40 20 30 36 38 52 24 70 35 96 30V60H3Z" fill="var(--accent-bg)" />}
    {mark === 'stacked' && <path d="M3 52 20 43 36 49 52 39 70 46 96 43V60H3Z" fill="var(--accent)" opacity=".3" />}
    <path d="M3 40 20 30 36 38 52 24 70 35 96 30" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
  </>
  return <rect x="6" y="8" width="88" height="48" rx="4" fill="var(--panel2)" stroke="var(--border)" />
}

export function DashboardThumbnail({ panels, title, count, metrics }: {
  panels?: DashboardPreviewPanel[]; title: string; count: number; metrics: string[]
}) {
  const preview = dashboardPreviewPanels(panels ?? [])
  if (!preview.length) return <div className="dash-thumbnail-fallback">
    <strong>{count} {count === 1 ? 'panel' : 'panels'}</strong>
    {metrics.slice(0, 3).map(metric => <span key={metric}>{metric.replaceAll('_', ' ')}</span>)}
    <small>Panel layout unavailable</small>
  </div>
  return <>
    <div className={`dash-thumbnail-panels panels-${preview.length}`} role="img"
      aria-label={`${title}: panel preview of ${preview.length} of ${count} panels. ${preview.map(panel => `${panel.title} (${panel.mark})`).join(', ')}. Illustrative shapes, not live values.`}>
      {preview.map(panel => <div className="dash-thumbnail-panel" key={panel.id} data-preview-panel={panel.id}>
        <span title={panel.title}>{panel.title}</span>
        <svg viewBox="0 0 100 66" preserveAspectRatio={['pie', 'gauge', 'stat'].includes(panel.mark) ? 'xMidYMid meet' : 'none'} aria-hidden="true">
          <ChartShape mark={panel.mark} />
        </svg>
      </div>)}
    </div>
    <div className="dash-thumbnail-caption"><span>Panel preview · not live values</span>{count > preview.length && <span>+{count - preview.length} panels</span>}</div>
  </>
}
