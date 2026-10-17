import { useId } from 'react'
import type { DashOwnership } from '../data/api'
import { GalleryOptions } from './Gallery'

/** A disclosure with native form controls, not an ARIA menu of checkboxes. */
export function DashboardFilters({ ownership, onChange }: {
  ownership: DashOwnership; onChange: (value: DashOwnership) => void
}) {
  const id = useId()
  return <GalleryOptions label="dashboard" active={Number(ownership !== 'all')}>
      <fieldset><legend>Ownership & activity</legend>
        {([
          ['all', 'Everyone'], ['mine', 'Mine'], ['agent', 'Agent-touched'],
        ] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name={`${id}-ownership`} value={value} checked={ownership === value}
            onChange={() => onChange(value)} />{label}
        </label>)}
      </fieldset>
      <p className="dash-filter-help">Certified dashboards use approved metric definitions in every panel. Custom SQL panels are not certified.</p>
  </GalleryOptions>
}
