import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type InspectorTab = 'layers' | 'properties' | 'design'
const TABS: InspectorTab[] = ['layers', 'properties', 'design']

/** Fixed navigation and selection context; only the active panel scrolls. */
export function DesignSidebar({ active, onChange, selectionKey, reviewing = false, ai, header, actions, notices, layers, properties, design }: {
  active: InspectorTab
  onChange: (tab: InspectorTab) => void
  selectionKey?: string
  reviewing?: boolean
  ai?: ReactNode
  header: ReactNode
  actions?: ReactNode
  notices: ReactNode
  layers: ReactNode
  properties: ReactNode
  design: ReactNode
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(() => !window.matchMedia?.('(max-width: 1180px)').matches)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1180px)')
    if (!media) return
    const change = () => setExpanded(!media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => { if (selectionKey) setExpanded(true) }, [selectionKey])
  useEffect(() => {
    if (reviewing && window.matchMedia?.('(max-width: 1180px)').matches) setExpanded(false)
  }, [reviewing])
  const scroll = useRef<HTMLDivElement>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const positions = useRef<Record<InspectorTab, number>>({ layers: 0, properties: 0, design: 0 })
  const lastSelection = useRef(selectionKey)
  useLayoutEffect(() => {
    if (lastSelection.current !== selectionKey) positions.current.properties = 0
    lastSelection.current = selectionKey
    if (scroll.current) scroll.current.scrollTop = positions.current[active]
  }, [active, selectionKey])
  const panels = { layers, properties, design }
  return <aside className={`dedit-rail${expanded ? '' : ' collapsed'}`} aria-label="Design sidebar">
    <button ref={toggle} className="drail-toggle" aria-label={expanded ? 'Hide inspector' : 'Show inspector'} aria-expanded={expanded} aria-controls={`${id}-body`}
      onClick={() => setExpanded(value => !value)}>
      <span>Inspector</span><span>{expanded ? 'Hide' : 'Show'}</span>
    </button>
    <div id={`${id}-body`} className="drail-body" hidden={!expanded}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented && window.matchMedia?.('(max-width: 1180px)').matches
          && !(event.target as HTMLElement).closest('input, textarea, select')) {
          event.stopPropagation(); setExpanded(false); toggle.current?.focus()
        }
      }}>
    <div className="drail-tabs" role="tablist" aria-label="Design sidebar sections">
      {TABS.map((tab, index) => <button key={tab} type="button" role="tab" id={`${id}-${tab}-tab`}
        ref={node => { tabs.current[index] = node }} aria-controls={`${id}-${tab}`} aria-selected={active === tab}
        tabIndex={active === tab ? 0 : -1} onClick={() => onChange(tab)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
            : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null
          if (next === null) return
          event.preventDefault(); onChange(TABS[next]); tabs.current[next]?.focus()
        }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
    </div>
    {active === 'properties' && header}
    {active === 'properties' && actions && <div className="drail-actions" role="group" aria-label="Selection actions">{actions}</div>}
    <div className="drail-scroll" ref={scroll} onScroll={event => { positions.current[active] = event.currentTarget.scrollTop }}>
      {notices}
      {TABS.map(tab => <div key={tab} role="tabpanel" id={`${id}-${tab}`} aria-labelledby={`${id}-${tab}-tab`} hidden={active !== tab}>
        {panels[tab]}
      </div>)}
    </div>
    {/* Last, like a composer: above the tabs it took a third of the rail, so
        selecting an element pushed its properties below the fold. */}
    {ai}
    </div>
  </aside>
}
