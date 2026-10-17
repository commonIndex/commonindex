import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { DesignElement, DesignScreen } from '../data/gateway'
import { RoleGlyph } from './RoleGlyph'

/** A disclosure, not an ARIA menu: its fields and buttons use normal Tab navigation. */
export function EditorPopover({ label, children, className = '', disabled = false, title }: {
  label: ReactNode
  children: (close: () => void) => ReactNode
  className?: string
  disabled?: boolean
  title?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div className={`deditor-popover ${className}`} ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
    }}>
    <button type="button" className="tool" ref={trigger} disabled={disabled} title={title}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {label}<span aria-hidden="true">⌄</span>
    </button>
    {open && <div className="deditor-popover-body" id={id}>{children(close)}</div>}
  </div>
}

export const TOOL_LABELS: Record<DesignElement['role'], string> = {
  heading: 'Heading', body: 'Paragraph', 'field-label': 'Label', button: 'Button', input: 'Input',
  image: 'Image', icon: 'Icon', logo: 'Logo', avatar: 'Avatar', card: 'Card', list: 'List',
  nav: 'Navigation', tabbar: 'Tab bar', divider: 'Divider', badge: 'Badge',
}
const GROUPS: { label: string; roles: DesignElement['role'][] }[] = [
  { label: 'Text', roles: ['heading', 'body', 'field-label'] },
  { label: 'Controls', roles: ['button', 'input', 'badge'] },
  { label: 'Media', roles: ['image', 'icon', 'logo', 'avatar'] },
  { label: 'Layout', roles: ['card', 'list', 'nav', 'tabbar', 'divider'] },
]

export function DesignTools({ tool, onChange, disabled }: {
  tool: DesignElement['role'] | null
  onChange: (role: DesignElement['role'] | null) => void
  disabled: boolean
}) {
  return <div className="dtool-categories" aria-label="Insert elements">
    {GROUPS.map(group => <EditorPopover key={group.label} disabled={disabled}
      className={tool && group.roles.includes(tool) ? 'active' : ''}
      label={tool && group.roles.includes(tool) ? TOOL_LABELS[tool] : group.label}>
      {close => <>{group.roles.map(role => <button key={role} type="button" className="dtool"
        disabled={disabled}
        aria-pressed={tool === role} onClick={() => { onChange(tool === role ? null : role); close() }}>
        <RoleGlyph role={role} />{TOOL_LABELS[role]}
      </button>)}</>}
    </EditorPopover>)}
  </div>
}

export function DesignScreenNavigator({ screens, current, onChange, overview, onOverview, playing = false, disabled = false }: {
  screens: DesignScreen[]
  current?: string
  onChange: (screenId: string) => void
  overview: boolean
  onOverview: () => void
  playing?: boolean
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const index = screens.findIndex(screen => screen.id === current)
  const active = screens[index]
  const term = query.trim().toLowerCase()
  const matches = screens.filter(screen => `${screen.name} ${screen.id}`.toLowerCase().includes(term))
  return <div className="dscreen-nav" aria-label="Screen navigation">
    <button className="tool" aria-label="Previous screen" disabled={disabled || index <= 0}
      onClick={() => onChange(screens[index - 1].id)}>←</button>
    <EditorPopover className="dscreen-picker" disabled={disabled || !screens.length}
      label={<><span>{active?.name ?? 'No screens'}</span>{' '}<small>{index + 1} / {screens.length}</small></>}
      title="Choose a screen">
      {close => <>
        <input autoFocus type="search" className="dsearch" aria-label="Search screens" placeholder="Find a screen…"
          value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && matches.length === 1) {
              event.preventDefault(); onChange(matches[0].id); setQuery(''); close()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.dscreen-option')?.focus()
            }
          }} />
        <div className="dscreen-options">
          {matches.map(screen => <button key={screen.id} className="dscreen-option" disabled={disabled}
            aria-current={screen.id === current ? 'page' : undefined}
            onClick={() => { onChange(screen.id); setQuery(''); close() }}>
            <small>{screens.indexOf(screen) + 1}</small>{' '}<span>{screen.name}</span>
            {screen.id === current && <span aria-hidden="true">✓</span>}
          </button>)}
          {!matches.length && <p className="hint">No screens match. Try another name.</p>}
        </div>
      </>}
    </EditorPopover>
    <button className="tool" aria-label="Next screen" disabled={disabled || index < 0 || index >= screens.length - 1}
      onClick={() => onChange(screens[index + 1].id)}>→</button>
    {!playing && <button className="tool" aria-pressed={overview} disabled={disabled || !screens.length}
      onClick={onOverview}>Overview</button>}
  </div>
}

export type CanvasZoom = 'width' | 'screen' | number
export function DesignZoomControls({ zoom, scale, onChange, disabled }: {
  zoom: CanvasZoom
  scale: number
  onChange: (zoom: CanvasZoom) => void
  disabled: boolean
}) {
  const step = (by: number) => onChange(Math.min(3, Math.max(.1, Math.round((scale + by) * 100) / 100)))
  return <div className="dzoom" role="group" aria-label="Canvas zoom">
    <button className="tool" aria-label="Zoom out" disabled={disabled || scale <= .1} onClick={() => step(-.1)}>−</button>
    <EditorPopover disabled={disabled} className="dzoom-picker"
      label={`${Math.round(scale * 100)}%`} title="Canvas zoom">
      {close => <>{([
        ['Fit width', 'width'], ['Fit screen', 'screen'], ['100%', 1],
      ] as const).map(([label, value]) => <button key={label} className="dtool" aria-pressed={zoom === value}
        onClick={() => { onChange(value); close() }}>{label}</button>)}</>}
    </EditorPopover>
    <button className="tool" aria-label="Zoom in" disabled={disabled || scale >= 3} onClick={() => step(.1)}>+</button>
  </div>
}
