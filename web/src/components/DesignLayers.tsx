import { useEffect, useId, useState } from 'react'
import type { DesignElement, DesignScreen } from '../data/gateway'
import { samePath, type Path } from '../data/spec'
import { RoleGlyph } from './RoleGlyph'

type Selection = { screen: string; path: Path }

function layers(elements: DesignElement[], parent: Path = []): { el: DesignElement; path: Path }[] {
  return elements.flatMap((el, i) => {
    const path = [...parent, i]
    return [{ el, path }, ...layers(el.children ?? [], path)]
  })
}

/** An alternate way to select boxes that are covered, off-screen, or nested. */
export function DesignLayers({ screens, selected, currentScreen, onSelect, onJump, disabled = false }: {
  screens: DesignScreen[]
  selected?: Selection
  currentScreen?: string
  onSelect: (selection: Selection) => void
  onJump: (screenId: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const activeScreen = currentScreen ?? selected?.screen ?? screens[0]?.id
  useEffect(() => {
    if (scope === 'current') setQuery('')
    // Preserve searches when browsing all screens, but don't carry a filter to a new active screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreen])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const selectionKey = selected ? `${selected.screen}:${selected.path.join('.')}` : ''
  useEffect(() => {
    if (!selected) return
    setExpanded(value => ({ ...value, [selected.screen]: true }))
    setFolded(value => {
      const next = { ...value }
      selected.path.slice(0, -1).forEach((_, at) => {
        delete next[`${selected.screen}:${selected.path.slice(0, at + 1).join('.')}`]
      })
      return next
    })
    // Reveal a newly selected layer without preventing manual collapse afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey])
  const term = query.trim().toLowerCase()
  const groups = screens.filter(screen => scope === 'all' || screen.id === activeScreen).map(screen => {
    const all = layers(screen.elements ?? [])
    const screenMatches = `${screen.name} ${screen.id}`.toLowerCase().includes(term)
    const matches = all.filter(({ el }) => screenMatches
      || `${el.text ?? ''} ${el.id} ${el.role}`.toLowerCase().includes(term))
    return { screen, all, matches }
  }).filter(({ screen, matches }) => !term || matches.length
    || `${screen.name} ${screen.id}`.toLowerCase().includes(term))

  return <section className="dlayers" aria-label="Layers">
    <button className="dlayers-heading" aria-label="Layers" aria-expanded={!collapsed} aria-controls={`${id}-body`}
            onClick={() => setCollapsed(value => !value)}>
      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> Layers
      <span className="hint">select any element</span>
    </button>
    <div id={`${id}-body`} hidden={collapsed}>
    <select className="dlayers-scope" aria-label="Layer scope" value={scope}
      onChange={event => setScope(event.target.value as 'current' | 'all')}>
      <option value="current">Current screen</option><option value="all">All screens</option>
    </select>
    <input type="search" className="dsearch" aria-label="Search layers"
           placeholder={scope === 'current' ? 'Find a layer on this screen…' : 'Find text, a role, or a screen…'} value={query}
           onChange={e => setQuery(e.target.value)} />
    <div className="dlayers-list">
      {groups.map(({ screen, all, matches }, i) => {
        const open = !!term || (expanded[screen.id] ?? (scope === 'current' || selected?.screen === screen.id || i === 0))
        // Keep ancestors visible in search results to make nested matches legible.
        const visible = term ? all.filter(row => matches.some(match =>
          row.path.every((part, at) => part === match.path[at]))) : all.filter(row =>
            !row.path.slice(0, -1).some((_, at) => folded[`${screen.id}:${row.path.slice(0, at + 1).join('.')}`]))
        return <div className="dlayers-group" key={screen.id}>
          <div className="dlayers-screen">
            <button className="dlayers-toggle" aria-expanded={open}
                    aria-controls={`${id}-${screen.id}`} aria-label={`${open ? 'Collapse' : 'Expand'} ${screen.name}`}
                    disabled={!!term}
                    onClick={() => setExpanded(value => ({ ...value, [screen.id]: !open }))}>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
            <button className="dlayers-jump" onClick={() => onJump(screen.id)}
                    disabled={disabled}
                    aria-current={screen.id === currentScreen ? 'page' : undefined}
                    aria-label={`Go to screen ${screen.name}`}>
              <span>{screen.name}</span><small>{all.length}</small>
            </button>
          </div>
          <ul id={`${id}-${screen.id}`} hidden={!open}>
            {visible.map(({ el, path }) => <li key={path.join('.')} className="dlayer-row"
              style={{ paddingLeft: (path.length - 1) * 16 }}>
              {el.children?.length ? <button className="dlayer-fold"
                aria-label={`${folded[`${screen.id}:${path.join('.')}`] && !term ? 'Expand' : 'Collapse'} children of ${el.text || el.id}`}
                aria-expanded={!!term || !folded[`${screen.id}:${path.join('.')}`]} disabled={!!term}
                onClick={() => setFolded(value => ({ ...value,
                  [`${screen.id}:${path.join('.')}`]: !value[`${screen.id}:${path.join('.')}`],
                }))}>
                <span aria-hidden="true">{folded[`${screen.id}:${path.join('.')}`] && !term ? '▸' : '▾'}</span>
              </button> : <span className="dlayer-indent" aria-hidden="true" />}
              <button className="dlayer" disabled={disabled}
                      aria-pressed={selected?.screen === screen.id && samePath(selected.path, path)}
                      aria-label={`Select ${el.role}: ${el.text || el.id} on ${screen.name}`}
                      title={`${el.text || el.id} — ${el.role} · ${el.id}`}
                      onClick={() => onSelect({ screen: screen.id, path })}>
                <RoleGlyph role={el.role} />
                <span>{el.text || el.id}</span><small>{el.role}</small>
              </button>
            </li>)}
            {all.length === 0 && <li className="dlayers-empty">No elements yet. Pick a tool and draw.</li>}
          </ul>
        </div>
      })}
      {groups.length === 0 && <div className="dlayers-empty">
        {term ? 'No layers match your search.' : 'Add a screen to start designing.'}
        {term && scope === 'current' && screens.length > 1 && <button className="linkbtn" onClick={() => setScope('all')}>Search all screens</button>}
      </div>}
    </div>
    {query && <button className="linkbtn" onClick={() => setQuery('')}>Clear layer search</button>}
    </div>
  </section>
}
