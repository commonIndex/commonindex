import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { DesignElement, DesignScreen, DesignTokens } from '../data/gateway'
import { appliedColour, fontSizeToken, LITERAL, palette, TEXT_ROLES, typography } from './DesignCanvas'

const TONES = ['default', 'accent', 'muted', 'danger', 'onAccent'] as const
const LABELS = { default: 'Default', accent: 'Accent', muted: 'Muted', danger: 'Danger', onAccent: 'On accent' }

/** A paragraph stays editable without introducing another scroll area. */
function TextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const fit = () => {
      node.style.height = 'auto'
      node.style.height = `${Math.max(76, node.scrollHeight + node.offsetHeight - node.clientHeight)}px`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    let width = node.clientWidth
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; fit() }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [value])
  return <textarea ref={ref} rows={3} value={value} onChange={e => onChange(e.target.value)} />
}

function bounded(value: string, min: number, max: number, integer = false) {
  if (!value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, integer ? Math.round(n) : n)) : undefined
}

/** Keep the typed string until blur, while sending only valid numbers to the spec.
 * Converting every keystroke back to a number turns "0.9" into "0.89" when
 * the intermediate zero is clamped to the minimum line height of 0.8. */
function NumberEditor({ value, onChange, min, max, integer = false, step = 'any', placeholder }: {
  value?: number
  onChange: (value: number | undefined) => void
  min: number
  max: number
  integer?: boolean
  step?: number | 'any'
  placeholder?: string
}) {
  const [draft, setDraft] = useState(String(value ?? ''))
  const editing = useRef(false)
  useLayoutEffect(() => { if (!editing.current) setDraft(String(value ?? '')) }, [value])
  return <input type="number" min={min} max={max} step={step} placeholder={placeholder} value={draft}
    onFocus={() => { editing.current = true }}
    onKeyDown={event => {
      if (event.key === 'Enter' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's')) {
        setDraft(String(bounded(event.currentTarget.value, min, max, integer) ?? ''))
      }
    }}
    onChange={event => {
      setDraft(event.target.value)
      onChange(bounded(event.target.value, min, max, integer))
    }}
    onBlur={event => {
      editing.current = false
      const next = bounded(event.target.value, min, max, integer)
      setDraft(String(next ?? ''))
      if (next !== value) onChange(next)
    }} />
}

/** Edits are patches: colour and typography never silently rewrite provenance. */
export function DesignInspector({ element, tokens, paletteReady, placed, canHold, screens, onChange }: {
  element: DesignElement
  tokens?: DesignTokens
  paletteReady: boolean
  placed: boolean
  canHold: boolean
  screens: DesignScreen[]
  onChange: (patch: Partial<DesignElement>) => void
}) {
  const id = useId()
  const p = palette(tokens)
  const applied = appliedColour(element, tokens)
  const text = typography(element, tokens)
  const isText = TEXT_ROLES.has(element.role)
  const colourTokens = Object.entries(tokens ?? {})
    .filter(([, token]) => token.$type === 'color' && typeof token.$value === 'string')
    .sort(([a], [b]) => a.localeCompare(b))
  const sizeTokens = Object.entries(tokens ?? {})
    .filter(([path]) => path.startsWith('font.size.') && fontSizeToken(tokens, path) !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  const custom = !!element.color?.startsWith('#')
  const defaultStyle = element.role === 'heading' ? 'font.size.heading' : element.role === 'body' ? 'font.size.body' : null
  const stylePath = element.textStyle ?? defaultStyle
  const styleLinked = !!stylePath && fontSizeToken(tokens, stylePath) !== undefined
  const sizeSource = element.fontSize !== undefined ? 'Custom size'
    : styleLinked ? stylePath : 'Role default'
  const imageHasSource = element.role === 'image' && !!element.src

  return <div className="dproperties">
    <section className="dprop-section" aria-label="Content">
      <h3>Content</h3>
      {element.role === 'image' ? <><label className="fld"><span>Image URL</span>
        <input value={element.src ?? ''} placeholder="https://…"
          onChange={e => onChange({ src: e.target.value || undefined })} />
      </label><label className="fld"><span>Alt text</span>
        <TextEditor value={element.text ?? ''} onChange={value => onChange({ text: value })} />
      </label></> : <label className="fld"><span>{element.role === 'input' ? 'Placeholder' : 'Text'}</span>
        {element.role === 'input' ? <input value={element.text ?? ''} onChange={e => onChange({ text: e.target.value })} />
          : <TextEditor value={element.text ?? ''} onChange={value => onChange({ text: value })} />}
      </label>}
    </section>

    {isText && <section className="dprop-section" aria-label="Typography">
      <h3>Typography</h3>
      <label className="fld"><span>Text style</span>
        <select value={element.textStyle ?? ''} onChange={e => onChange({ textStyle: e.target.value || undefined, fontSize: undefined })}>
          <option value="">Role default</option>
          {sizeTokens.map(([path]) => <option key={path} value={path}>{path} · {fontSizeToken(tokens, path)}px</option>)}
          {element.textStyle && !sizeTokens.some(([path]) => path === element.textStyle)
            && <option value={element.textStyle}>{element.textStyle} · unavailable</option>}
        </select>
      </label>
      <div className="dprop-grid">
        <label className="fld"><span>Size (px)</span>
          <NumberEditor min={1} max={240} value={element.fontSize} placeholder={String(text.fontSize)}
            onChange={fontSize => onChange({ fontSize })} />
        </label>
        <label className="fld"><span>Weight</span>
          <select value={element.fontWeight ?? ''} onChange={e => onChange({ fontWeight: bounded(e.target.value, 100, 900, true) })}>
            <option value="">Default ({typography({ ...element, fontWeight: undefined }, tokens).fontWeight})</option>
            {[...new Set([100, 200, 300, 400, 500, 600, 700, 800, 900, ...(element.fontWeight ? [element.fontWeight] : [])])].sort((a, b) => a - b)
              .map(weight => <option key={weight} value={weight}>{weight}</option>)}
          </select>
        </label>
        <label className="fld"><span>Alignment</span>
          <select value={element.textAlign ?? ''} onChange={e => onChange({ textAlign: (e.target.value || undefined) as DesignElement['textAlign'] })}>
            <option value="">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </label>
        <label className="fld"><span>Line height</span>
          <NumberEditor min={0.8} max={3} step={0.1} value={element.lineHeight} placeholder={String(text.lineHeight)}
            onChange={lineHeight => onChange({ lineHeight })} />
        </label>
      </div>
      <p className="dprop-note">{text.fontSize}px · {sizeSource}{element.fontSize !== undefined ? ' · clear Size to follow the style' : ''}</p>
      {element.textStyle && !styleLinked && <p className="dprop-note warning">Size token unavailable; using the role default unless Size is overridden.</p>}
      <button type="button" className="linkbtn" onClick={() => onChange({ textStyle: undefined, fontSize: undefined, fontWeight: undefined, lineHeight: undefined, textAlign: undefined })}>Reset typography</button>
    </section>}

    <section className="dprop-section" aria-label="Appearance">
      <h3>Appearance</h3>
      {imageHasSource ? <p className="dprop-note">Colour comes from the image. Replace the image to change it.</p> : <>
        <div className="dcolour-applied" aria-label="Applied colour">
          <span className="dcolour-dot" style={{ background: applied.value }} />
          <span><b>{applied.target}</b><code>{applied.source}</code></span>
          <small>{applied.literal ? 'Custom' : applied.linked ? 'Linked' : 'Default'}</small>
        </div>
        {applied.missing && <p className="dprop-note warning">{applied.missing} is unavailable. Showing the role fallback.</p>}
        <div className="tones" role="group" aria-label="Colour">
          {TONES.map(tone => {
            // A role is not always color.text: body defaults to muted and a muted button uses surface.
            const paint = appliedColour({ ...element, color: undefined, tone }, tokens)
            const chosen = !element.color && (element.tone ?? 'default') === tone
            return <button key={tone} type="button" className={`tone${chosen ? ' on' : ''}`} aria-pressed={chosen}
              title={`${LABELS[tone]} · ${paint.source}`} onClick={() => {
                if (!chosen) onChange({ tone, color: element.color ? null : element.color })
              }}>
              <span className="chip" style={{ background: paint.value }} /><em>{LABELS[tone]}</em>
            </button>
          })}
          <label className={`tone custom${custom ? ' on' : ''}`} title="Custom colour does not follow the palette">
            <input type="color" aria-label="Custom colour" value={element.color && /^#[0-9a-f]{6}$/i.test(element.color) ? element.color : /^#[0-9a-f]{6}$/i.test(applied.value) ? applied.value : p.text}
              onChange={e => onChange({ color: e.target.value, tone: undefined })} />
            <span className="chip" style={custom && element.color && LITERAL.test(element.color) ? { background: element.color } : undefined} /><em>Custom</em>
          </label>
        </div>
        <label className="fld"><span>Colour token</span>
          <select value={element.color && !custom ? element.color : ''} onChange={e => onChange({ color: e.target.value || null })}>
            <option value="">{custom ? 'Custom colour' : 'Use colour role'}</option>
            {colourTokens.map(([path]) => <option key={path} value={path}>{path}</option>)}
            {element.color && !custom && !colourTokens.some(([path]) => path === element.color)
              && <option value={element.color}>{element.color} · unavailable</option>}
          </select>
        </label>
        {custom && <label className="fld"><span>Hex colour</span>
          <input value={element.color ?? ''} placeholder="#rrggbb" onChange={e => onChange({ color: e.target.value.trim() || null })} />
        </label>}
        {custom && <p className="dprop-note">Custom colour does not follow palette changes.</p>}
      </>}
    </section>

    <section className="dprop-section" aria-label="Layout">
      <h3>Layout</h3>
      {!placed && <p className="dprop-note">Position managed by parent.</p>}
      <div className="dprop-grid">
        {(placed ? ['x', 'y', 'w', 'h'] as const : ['w', 'h'] as const).map(key => <label className="fld" key={key}>
          <span>{key.toUpperCase()}</span><NumberEditor min={key === 'x' || key === 'y' ? -10000 : 0} max={10000} integer step={1}
            value={element[key]} onChange={value => onChange({ [key]: value })} />
        </label>)}
      </div>
      {canHold && <div className="dprop-grid">
        <label className="fld"><span>Layout</span>
          <select value={element.layout ?? 'column'} onChange={e => onChange({ layout: e.target.value as DesignElement['layout'] })}>
            <option value="column">Column</option><option value="row">Row</option>
          </select>
        </label>
        <label className="fld"><span>Align</span>
          <select value={element.align ?? 'start'} onChange={e => onChange({ align: e.target.value as DesignElement['align'] })}>
            {['start', 'center', 'end', 'between'].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        {(['gap', 'pad'] as const).map(key => <label className="fld" key={key}><span>{key === 'gap' ? 'Gap' : 'Padding'}</span>
          <NumberEditor min={0} max={10000} integer step={1} value={element[key]} onChange={value => onChange({ [key]: value })} />
        </label>)}
      </div>}
    </section>

    <details className="dprop-section">
      <summary>Prototype <small>{element.goto ? 'Linked' : 'No link'}</small></summary>
      <label className="fld"><span>Links to</span>
        <select value={element.goto ?? ''} onChange={e => onChange({ goto: e.target.value || undefined })}>
          <option value="">No link</option>
          {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}
          {element.goto && !screens.some(screen => screen.id === element.goto)
            && <option value={element.goto}>{element.goto} — no such screen</option>}
        </select>
      </label>
    </details>

    <details className="dprop-section">
      <summary>Provenance <small>{!element.cites ? 'Not cited' : tokens?.[element.cites] ? 'Cited' : 'Unverified'}</small></summary>
      <label className="fld"><span>Cites</span>
        <input list={`${id}-tokens`} value={element.cites ?? ''} placeholder="Token or component path"
          onChange={e => onChange({ cites: e.target.value || null })} />
      </label>
      <datalist id={`${id}-tokens`}>{Object.keys(tokens ?? {}).sort().map(path => <option key={path} value={path} />)}</datalist>
      <p className="dprop-note">Records provenance. This does not set colour or typography.</p>
      <p className="dprop-note">{!element.cites ? 'No citation. Shown with a dashed outline.'
        : !paletteReady ? 'Palette is still loading; this citation has not been checked.'
        : tokens?.[element.cites] ? 'This citation resolves in the palette.'
        : 'Not defined in this palette. This may be a component reference or a typo; it is unverified.'}</p>
      {element.cites?.startsWith('color.') && element.cites !== applied.source && !imageHasSource
        && <p className="dprop-note">Citation: <code>{element.cites}</code>. Applied {applied.target.toLowerCase()}: <code>{applied.source}</code>.</p>}
    </details>
  </div>
}
