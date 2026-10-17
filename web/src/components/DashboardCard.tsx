import { useId } from 'react'
import { Link } from 'react-router-dom'
import type { Dashboard } from '../data/types'
import { Avatar, Oid, Pill } from './ui'
import { fmtStat, signed } from './chartkit'
import { DashboardThumbnail } from './DashboardThumbnail'

export function dashboardStatus(dashboard: Dashboard) {
  if (dashboard.certified) return 'Certified'
  const queries = dashboard.queries ?? 0
  return queries > 0 && queries === dashboard.uncertified
    ? `${queries} custom ${queries === 1 ? 'query' : 'queries'}`
    : `${dashboard.uncertified || 1} uncertified`
}

function Trend({ points }: { points: number[] }) {
  if (points.length < 2 || points.some(value => !Number.isFinite(value))) return null
  const low = Math.min(...points), span = Math.max(Math.max(...points) - low, 1e-9)
  const path = points.map((value, index) => `${index ? 'L' : 'M'}${8 + index / (points.length - 1) * 284} ${66 - (value - low) / span * 50}`).join(' ')
  return <svg viewBox="0 0 300 80" className="dash-card-trend" aria-hidden="true">
    <path d="M8 70H292 M8 40H292 M8 10H292" stroke="var(--border)" fill="none" />
    <path d={`${path} L292 70 L8 70Z`} fill="var(--accent-bg)" />
    <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** The gallery never queries a warehouse or presents sample numbers as live data. */
export function DashboardCard({ dashboard: d }: { dashboard: Dashboard }) {
  const description = useId()
  const good = d.headline.better === 'up' ? d.headline.delta > 0 : d.headline.delta < 0
  const metrics = d.metricReferences ?? d.metrics.map(id => ({ id, label: id.replaceAll('_', ' ') }))
  const approved = d.approvedMetricCount ?? (d.certified ? new Set(d.metrics).size : undefined)
  const changed = d.definitionUpdatedAt ? new Date(d.definitionUpdatedAt) : null
  const updated = changed && Number.isFinite(changed.getTime()) ? changed : null
  const certification = 'Certified means every panel cites an approved metric definition. Custom SQL panels are not certified.'
  return <Link className="dash-card dashboard-gallery-card" to={`/dashboards/${d.id}`} aria-label={`Open dashboard ${d.title}`}
    aria-describedby={`${description}-facts ${description}-source ${description}-metrics`}>
    <div className={`dash-card-preview${d.live ? ' live' : ''}`}>
      {!d.live && <div className="dash-card-preview-label">Sample dashboard</div>}
      {d.live ? <DashboardThumbnail panels={d.previewPanels} title={d.title} count={d.panelCount} metrics={d.metrics} /> : <>
        <div className="dash-card-metric"><span>{d.headline.metric.replaceAll('_', ' ')}</span>
          <div><strong>{fmtStat(d.headline.value, d.headline.unit)}</strong>
            <span className={good ? 'up' : 'down'}>{signed(d.headline.delta)}</span></div>
        </div>
        <Trend points={d.spark} /><span className="dash-card-sample">28-day sample trend</span>
      </>}
    </div>
    <div className="dash-card-content">
      <h2>{d.title}</h2>
      <div className="dash-card-facts" id={`${description}-facts`}><span>{d.panelCount} {d.panelCount === 1 ? 'panel' : 'panels'}</span>
        <span title={certification}><Pill tone={d.certified ? 'green' : 'warn'}>{dashboardStatus(d)}</Pill></span>
      </div>
      <p className="dash-card-source" id={`${description}-source`} title={d.connectionId ?? d.space}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5" ry="2" /><path d="M3 3.5v9c0 2.7 10 2.7 10 0v-9M3 8c0 2.7 10 2.7 10 0" /></svg>
        <span>{d.space}</span>
      </p>
      <p className="dash-card-metrics" id={`${description}-metrics`} title={metrics.map(m => `${m.label} (${m.id})`).join(', ')}>{metrics.length ? metrics.slice(0, 3).map(m => m.label).join(' · ') : 'No metric definitions cited'}
        {metrics.length > 3 && ` · +${metrics.length - 3} more`}</p>
      {approved !== undefined && <p className="dash-card-context">{approved > 0
        ? `Uses ${approved} approved metric${approved === 1 ? '' : 's'}` : 'No approved metrics cited'}</p>}
      {d.proposals > 0 && <div><Pill tone="agent">{d.proposals} {d.proposals === 1 ? 'proposal' : 'proposals'} to review</Pill></div>}
      <div className="dash-card-footer"><span><Avatar name={d.owner} agent={d.agentOwner} />{d.owner}</span><Oid id={d.key} /></div>
      {updated && <time className="dash-card-updated" dateTime={updated.toISOString()}
        title={`Dashboard definition last changed ${updated.toLocaleString()}. Not the warehouse data refresh time.`}>
        Definition updated {updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </time>}
    </div>
  </Link>
}
