import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DesignTokens, WireDesign } from '../data/gateway'
import { DesignScreenView, palette } from './DesignCanvas'

// Older seeded systems predate catalogue metadata. Keep their saved selections
// readable without treating every email-shaped palette specimen as a layout.
export const isDesignSystem = (design: WireDesign) => design.template_kind
  ? design.template_kind === 'system' : /^System\s*[·:—-]/i.test(design.title)

function description(design: WireDesign) {
  if (design.description) return design.description
  return design.spec.screens.map(screen => screen.name).join(' · ') || 'An approved design system.'
}

export function DesignTemplatePicker({ templates, selected, mode, tokensFor, onPick, disabled,
  styleId = null, onStylePick }: {
  templates: WireDesign[]
  selected: WireDesign | null
  mode: 'brief' | 'template'
  tokensFor: (design: WireDesign) => DesignTokens | undefined
  onPick: (design: WireDesign) => void
  disabled: boolean
  styleId?: string | null
  onStylePick?: (id: string | null) => void
}) {
  const [surface, setSurface] = useState('all')
  const [query, setQuery] = useState('')
  const systems = templates.filter(isDesignSystem)
  const layouts = templates.filter(design => !isDesignSystem(design) && design.spec.screens.length > 0)
  const term = query.trim().toLowerCase()
  const visible = layouts.filter(design => (surface === 'all' || design.surface === surface)
    && (!term || `${design.title} ${description(design)}`.toLowerCase().includes(term)))
  const chosen = selected && !isDesignSystem(selected) ? selected : null
  const style = systems.find(system => system.id === styleId)
  const previewTokens = (design: WireDesign) => tokensFor(mode === 'template' && style ? style : design)
  const reset = () => { setSurface('all'); setQuery('') }

  return <div className="dtemplate-library">
    {mode === 'brief' && systems.length > 0 && <section aria-label="Design systems">
      <h3>Style <span className="hint">optional</span></h3>
      <p className="hint">Colours and typography from a design system. Click again to clear.</p>
      <div className="dsystem-grid">
        {systems.map(system => {
          const colours = palette(tokensFor(system))
          return <button key={system.id} className={`dsystem-pick dpick${selected?.id === system.id ? ' on' : ''}`}
            disabled={disabled} aria-pressed={selected?.id === system.id} onClick={() => onPick(system)}>
            <span className="dsystem-swatches" aria-hidden="true">
              {[colours.bg, colours.surface, colours.text, colours.accent].map((colour, i) =>
                <span key={i} style={{ background: colour }} />)}
            </span>
            <span className="dpick-name">{system.title}</span>
          </button>
        })}
      </div>
    </section>}

    <LayoutsSection brief={mode === 'brief'} chosen={!!selected && !isDesignSystem(selected)}>
      {mode === 'template' && <>
        <h3>1. Choose a starter layout</h3>
        <p className="hint">Editable screens with real content. Preview the flow, then make it yours.</p>
      </>}
      <div className="dtemplate-filters">
        {['all', 'web', 'mobile', 'email'].map(value =>
          <button key={value} className={`tool${surface === value ? ' on' : ''}`}
            aria-pressed={surface === value} onClick={() => setSurface(value)}>
            {value === 'all' ? 'All layouts' : value[0].toUpperCase() + value.slice(1)}
          </button>)}
        <input className="dsearch" type="search" aria-label="Search starter layouts"
          placeholder="Search layouts…" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="dtemplate-grid">
        {visible.map(design => <div key={design.id}
          className={`dpick dtemplate-pick${selected?.id === design.id ? ' on' : ''}`}
          role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
          aria-pressed={selected?.id === design.id} aria-label={`Choose ${design.title}`}
          onClick={() => { if (!disabled) onPick(design) }}
          onKeyDown={event => {
            if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault(); onPick(design)
          }}>
          <div className="dtemplate-thumb" aria-hidden="true" inert>
            <DesignScreenView screen={design.spec.screens[0]} tokens={previewTokens(design) ?? {}}
              surface={design.surface} width={240} maxHeight={192} />
          </div>
          <div className="dtemplate-meta">
            <span className="dpick-name">{design.title}</span>
            <span className="dtemplate-description">{description(design)}</span>
            <span className="dtemplate-badges"><span>{design.surface}</span>
              <span>{design.spec.screens.length} {design.spec.screens.length === 1 ? 'screen' : 'screens'}</span>
              {selected?.id === design.id && <span className="chosen">✓ Selected</span>}
            </span>
          </div>
        </div>)}
      </div>
      {visible.length === 0 && <div className="dtemplate-empty">
        {layouts.length ? <>No layouts match these filters. <button className="tool" onClick={reset}>Show all layouts</button></>
          : 'No starter layouts are available yet. You can still describe a design in the other tab.'}
      </div>}
    </LayoutsSection>

    {mode === 'template' && onStylePick && <section aria-label="Layout style">
      <h3>2. Choose a style</h3>
      <p className="hint">Keep the layout. Change its colours and typography using a linked design system.</p>
      <div className="dsystem-grid">
        <button className={`dsystem-pick dpick${!styleId ? ' on' : ''}`}
          disabled={disabled} aria-pressed={!styleId} onClick={() => onStylePick(null)}>
          <span className="dpick-name">Original style</span>
          <span className="hint">Use the layout’s own palette</span>
        </button>
        {systems.map(system => {
          const colours = palette(tokensFor(system))
          const available = !!tokensFor(system)
          return <button key={system.id} className={`dsystem-pick dpick${styleId === system.id ? ' on' : ''}`}
            disabled={disabled || !available} aria-pressed={styleId === system.id}
            onClick={() => onStylePick(system.id)}>
            <span className="dsystem-swatches" aria-hidden="true">
              {[colours.bg, colours.surface, colours.text, colours.accent].map((colour, i) =>
                <span key={i} style={{ background: colour }} />)}
            </span>
            <span className="dpick-name">{system.title}</span>
            {!available && <span className="hint">Palette unavailable</span>}
          </button>
        })}
      </div>
    </section>}

    {mode === 'template' && chosen && chosen.spec.screens.length > 0 &&
      <TemplatePreview key={chosen.id} design={chosen} tokens={previewTokens(chosen)}
        styleTitle={style?.title} disabled={disabled} />}
  </div>
}

/** In "Describe it" a starter only lends its palette, so it is a second way
 * to choose a style rather than a peer of the systems: folded under them,
 * and open when one is already chosen so the choice is never hidden. */
function LayoutsSection({ brief, chosen, children }: { brief: boolean; chosen: boolean; children: ReactNode }) {
  if (!brief) return <section aria-label="Starter layouts">{children}</section>
  return <details className="dstyle-more" open={chosen || undefined}>
    <summary>Or match a starter’s palette</summary>
    <section aria-label="Starter layouts">
      <p className="hint">Uses the starter’s colours and typography, not its screens.</p>
      {children}
    </section>
  </details>
}

/** Kept separate and keyed by design: changing the layout resets playback,
 * while a palette change keeps the current screen and never edits the source. */
function TemplatePreview({ design, tokens, styleTitle, disabled }: {
  design: WireDesign; tokens?: DesignTokens; styleTitle?: string; disabled: boolean
}) {
  const [screenId, setScreenId] = useState(design.spec.screens[0].id)
  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [trail, setTrail] = useState<string[]>([])
  const [missing, setMissing] = useState<string | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [previewWidth, setPreviewWidth] = useState(640)
  const preview = design.spec.screens.find(screen => screen.id === screenId) ?? design.spec.screens[0]
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => setPreviewWidth(Math.max(160, entry.contentRect.width)))
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (playing) stage.current?.focus()
  }, [screenId, playing])
  const show = (id: string) => { setScreenId(id); setTrail([]); setMissing(null) }
  const follow = (id: string) => {
    if (!design.spec.screens.some(screen => screen.id === id)) {
      setMissing(id); return
    }
    setMissing(null)
    if (id === preview.id) return
    setTrail(old => [...old, preview.id]); setScreenId(id)
  }
  return <section className={`dtemplate-preview${expanded ? ' expanded' : ''}`} aria-label="Template preview">
      <div className="dtemplate-preview-head">
        <div><h3>3. Preview the screens</h3><p className="hint">Selected: {design.title}
          {styleTitle && <> · Style: {styleTitle}</>}</p></div>
        <span className="hint">{preview.w} × {preview.h} · {design.surface}</span>
      </div>
      <div className="dtemplate-preview-tools">
        <button className={`tool${playing ? ' on' : ''}`} aria-pressed={playing} disabled={disabled}
          onClick={() => { setPlaying(value => !value); setTrail([]); setMissing(null) }}>
          {playing ? 'Stop prototype' : 'Try prototype'}</button>
        <button className="tool" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Compact preview' : 'Expand preview'}</button>
        {playing && <>
          <button className="tool" disabled={disabled || !trail.length} onClick={() => {
            setScreenId(trail[trail.length - 1]); setTrail(old => old.slice(0, -1)); setMissing(null)
          }}>Back</button>
          <button className="tool" disabled={disabled} onClick={() => show(design.spec.screens[0].id)}>Restart</button>
        </>}
      </div>
      <div className="dtemplate-screens" role="group" aria-label="Template screens">
        {design.spec.screens.map((screen, i) => <button key={screen.id}
          className={`tool${preview.id === screen.id ? ' on' : ''}`}
          disabled={disabled} aria-pressed={preview.id === screen.id} onClick={() => show(screen.id)}>
          {i + 1}. {screen.name}
        </button>)}
      </div>
      <p className="hint" role="status">{playing
        ? `Prototype · ${preview.name}. Linked buttons switch screens. Forms and decisions are demos; nothing is submitted.`
        : 'Browse screens, or try the prototype to follow its links.'}</p>
      {missing && <p className="p-warn" role="alert">This link points to a missing screen: {missing}.</p>}
      <div className="dtemplate-stage" ref={stage} tabIndex={playing ? -1 : undefined}
        aria-hidden={!playing || undefined} inert={!playing || disabled}>
        <DesignScreenView key={`${preview.id}:${playing}`} screen={preview} tokens={tokens ?? {}}
          surface={design.surface} width={Math.min(previewWidth, design.surface === 'web' ? (expanded ? 1100 : 640) : (expanded ? 600 : 360))}
          maxHeight={expanded ? 800 : 430} onNavigate={playing ? follow : undefined} interactive={playing} />
      </div>
      <p className="hint">All {design.spec.screens.length} {design.spec.screens.length === 1 ? 'screen will' : 'screens will'} be copied into your editable design.</p>
    </section>
}
