import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import type {
  DesignElement, DesignScreen, DesignTokens, WireDesign,
} from '../data/gateway'
import { samePath, type Path } from '../data/spec'

/** How much of a design is on-system.
 *
 *  An element cites what it instantiates; one citing nothing is off-system.
 *  The design-side twin of a dashboard being certified when every panel cites a
 *  ratified definition.
 *
 *  THREE states, not two. The type has always said "a citation that resolves is
 *  on-system; one that does not is drawn as drift rather than quietly looking
 *  finished", and the code resolved nothing — it counted the field being
 *  non-empty, so `color.acent` read exactly like `color.accent`.
 *
 *  But the type also allows citing an approved COMPONENT, and there is no
 *  component registry in this workspace to check one against. A design in this
 *  very database cites `cmp-heading-lg`. Calling that drift would be as wrong
 *  as calling a typo approved: it is a claim nothing here can check, which is
 *  its own answer and not either of the other two.
 *
 *  `tokens` omitted means the palette is not known here rather than empty, and
 *  a claim that cannot be checked is taken at its word. */
export function onSystem(
  d: WireDesign, tokens?: DesignTokens,
): { on: number; total: number; unverified: number; ownColour: number } {
  const walk = (e: DesignElement): DesignElement[] => [e, ...(e.children ?? [])]
  const els = (d.spec?.screens ?? []).flatMap(s => (s.elements ?? []).flatMap(walk))
  return {
    on: els.filter(e => resolves(e.cites, tokens)).length,
    unverified: els.filter(e => !!e.cites && !resolves(e.cites, tokens)).length,
    // Counted separately from the citation, because it is a different claim:
    // an element can cite an approved component perfectly well and still be
    // painted a colour the palette has never heard of. Folding the two
    // together would hide one behind the other.
    ownColour: els.filter(e => !!e.color && LITERAL.test(e.color)).length,
    total: els.length,
  }
}

/** Whether a citation names something the palette actually defines. */
export function resolves(cites: string | null | undefined, tokens?: DesignTokens): boolean {
  if (!cites) return false
  if (tokens === undefined) return true
  return Object.prototype.hasOwnProperty.call(tokens, cites)
}

function tok(t: DesignTokens | undefined, path: string, fallback: string): string {
  const v = t?.[path]?.$value
  return v === undefined ? fallback : String(v)
}

/** A DTCG dimension is canonically a string with a unit — `"12px"` — and
 *  `Number("12px")` is NaN. Parse the leading number and fall back. */
function num(t: DesignTokens | undefined, path: string, fallback: number): number {
  const n = parseFloat(tok(t, path, String(fallback)))
  return Number.isFinite(n) ? n : fallback
}

export interface Palette {
  bg: string; surface: string; text: string; muted: string
  accent: string; onAccent: string; border: string; danger: string
  radius: number; headingSize: number; bodySize: number; font: string
}

export function palette(t?: DesignTokens): Palette {
  return {
    bg: tok(t, 'color.bg', '#ffffff'),
    surface: tok(t, 'color.surface', '#f4f5f7'),
    text: tok(t, 'color.text', '#15181d'),
    muted: tok(t, 'color.muted', '#6b7280'),
    accent: tok(t, 'color.accent', '#2f6bed'),
    onAccent: tok(t, 'color.onAccent', '#ffffff'),
    border: tok(t, 'color.border', '#e3e6ea'),
    danger: tok(t, 'color.danger', '#d64545'),
    radius: num(t, 'radius.md', 10),
    headingSize: num(t, 'font.size.heading', 22),
    bodySize: num(t, 'font.size.body', 13),
    font: tok(t, 'font.family', 'ui-sans-serif, system-ui, -apple-system, sans-serif'),
  }
}

/** The colour a tone names, for whatever this role's principal colour is.
 *
 *  `default` means "whatever the role uses when nothing is said", so every
 *  caller passes its own. Tone was the only colour control an element had, and
 *  it was read by three roles out of fifteen — picking `danger` on a heading,
 *  a nav or a card changed nothing at all. */
function toned(p: Palette, tone: DesignElement['tone'], fallback: string): string {
  return tone === 'accent' ? p.accent
       : tone === 'muted' ? p.muted
       : tone === 'danger' ? p.danger
       : tone === 'onAccent' ? p.onAccent
       : fallback
}

/** What colour this element draws in: a token it names outright, else the role
 *  it plays, else whatever the role would use if nothing were said.
 *
 *  Five roles reached four of a palette's seven colours, so `color.bg`,
 *  `color.surface` and `color.border` could not be chosen for anything. Naming
 *  the token directly reaches all of them and grows with the system — and it
 *  is still a token, so changing the palette still restyles what names it. */
function inkOf(e: DesignElement, p: Palette, tokens: DesignTokens | undefined,
               fallback: string): string {
  const named = namedColor(e, tokens)
  if (named !== undefined) return named
  return toned(p, e.tone, fallback)
}

/** Just the token an element names, if it names one.
 *
 *  For the roles whose tone means something other than "this colour" — a muted
 *  BUTTON is a surface-filled button, not muted-coloured text — `inkOf`'s
 *  fallback is wrong, because `toned` answers the tone before the fallback is
 *  reached. Those ask this instead and keep their own rule. */
function namedColor(e: DesignElement, tokens: DesignTokens | undefined): string | undefined {
  if (!e.color) return undefined
  // A literal is used as written. It is allowed and it is reported: a colour
  // that cannot follow the palette is drift whatever it looks like, and saying
  // so is the difference between a tool that lets you off the system and one
  // that lets you off it without telling you.
  if (LITERAL.test(e.color)) return e.color
  return tok(tokens, e.color, '') || undefined
}

/** `#abc`, `#aabbcc`, `#aabbccdd` — what a colour input produces. */
export const LITERAL = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function toneColor(p: Palette, tone: DesignElement['tone']): string {
  return tone === 'danger' ? p.danger
       : tone === 'muted' ? p.surface
       : tone === 'onAccent' ? p.onAccent
       : p.accent
}

/** Describe the principal painted property, NOT the provenance citation. */
/** A muted container is a filled panel — a sidebar, a selected tile, a
 *  callout — the way a muted button is a surface-filled button. Its tone is
 *  the fill, so its edge stays the palette's border. */
const isFilled = (e: DesignElement) => e.tone === 'muted' && HOLDS.has(e.role)
const panelOf = (e: DesignElement, p: Palette, tokens: DesignTokens | undefined) => isFilled(e)
  ? { background: namedColor(e, tokens) ?? p.surface, edge: p.border }
  : { background: p.bg, edge: inkOf(e, p, tokens, p.border) }

export function appliedColour(e: DesignElement, tokens?: DesignTokens) {
  const p = palette(tokens)
  const filled = isFilled(e)
  const fill = filled || ['button', 'badge', 'avatar', 'icon', 'image'].includes(e.role)
  const border = !filled && ['card', 'nav', 'list', 'tabbar', 'divider', 'input'].includes(e.role)
  const target = e.role === 'logo' ? 'Mark colour' : border ? 'Border colour'
    : e.role === 'badge' ? 'Tint' : fill ? 'Fill colour' : 'Text colour'
  const fallback = border ? 'border' : ['body', 'field-label'].includes(e.role) ? 'muted'
    : ['avatar', 'icon', 'image'].includes(e.role) ? 'surface'
    : ['button', 'badge', 'logo'].includes(e.role) ? 'accent' : 'text'
  const tone = e.tone === 'onAccent' ? 'onAccent'
    : e.tone === 'muted' && (filled || ['button', 'badge'].includes(e.role)) ? 'surface'
    : e.tone && e.tone !== 'default' ? e.tone : fallback
  const source = namedColor(e, tokens) !== undefined ? e.color! : `color.${tone}`
  const value = namedColor(e, tokens) ?? p[tone as 'text' | 'muted' | 'accent' | 'danger' | 'onAccent' | 'surface' | 'border']
  return { target, source, value, literal: LITERAL.test(source),
    linked: !!tokens?.[source],
    missing: e.color && !LITERAL.test(e.color) && !tokens?.[e.color] ? e.color : null }
}

export const TEXT_ROLES = new Set<DesignElement['role']>([
  'heading', 'body', 'field-label', 'button', 'input', 'badge', 'avatar', 'logo',
])

export function fontSizeToken(tokens: DesignTokens | undefined, path: string): number | undefined {
  const value = parseFloat(String(tokens?.[path]?.$value ?? ''))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Shared by the drawing and inspector, so inherited sizes cannot disagree. */
export function typography(e: DesignElement, tokens?: DesignTokens) {
  const defaults: Partial<Record<DesignElement['role'], [number, number, number]>> = {
    heading: [num(tokens, 'font.size.heading', 22), 680, 1.2],
    body: [num(tokens, 'font.size.body', 13), 400, 1.5],
    'field-label': [10.5, 600, 1.45], button: [14.5, 620, 1.45],
    input: [13, 400, 1.45], badge: [11, 640, 1.45], avatar: [14, 640, 1.45],
    logo: [15.5, 680, 1.45],
  }
  const [size, weight, height] = defaults[e.role] ?? [13, 400, 1.45]
  const linked = e.textStyle ? fontSizeToken(tokens, e.textStyle) ?? size : size
  const finite = (value: number | undefined, fallback: number, min: number, max: number) =>
    value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  return {
    fontSize: finite(e.fontSize, Math.max(1, Math.min(240, linked)), 1, 240),
    fontWeight: finite(e.fontWeight, weight, 100, 900),
    lineHeight: finite(e.lineHeight, height, 0.8, 3),
    textAlign: e.textAlign ?? (['button', 'badge', 'avatar'].includes(e.role) ? 'center' : 'left'),
  } as const
}

/** How far the pointer must travel before a press becomes a drag. */
export const DRAG_START_PX = 6

/** Which corner is being pulled, or the whole box being moved. */
export type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/** A gesture in flight. `place` carries the patch it would commit rather than
 *  raw pixels, so the preview under the cursor is rendered from exactly the
 *  object that gets written — there is no second implementation of the maths to
 *  drift out of agreement with the first. */
export type Gesture =
  | { kind: 'place'; path: Path; patch: Partial<DesignElement> }
  | { kind: 'flow'; path: Path; parent: Path; from: number; to: number
      dx: number; dy: number; line: { x: number; y: number; w: number; h: number } | null }

interface Ctx {
  p: Palette
  /** The palette a citation is checked against, so an element drawn as drift on
   *  the artboard and one counted as drift in the total are the same element. */
  tokens?: DesignTokens
  selected?: Path
  onSelect?: (path: Path) => void
  onNavigate?: (screenId: string) => void
  onGrab?: (path: Path, handle: Handle, ev: React.PointerEvent) => void
  gesture?: Gesture | null
  /** Whether a gesture has just finished, so the click it generates can be
   *  ignored rather than re-selecting whatever the pointer happened to be over. */
  justDragged?: () => boolean
  /** Unsaved edits from the panel, drawn as though they had been saved.
   *
   *  Without this the panel is a form you fill in blind: picking a colour
   *  changed nothing on the screen until Save, so the honest conclusion from
   *  watching it was that picking a colour does not work. */
  preview?: { path: Path; patch: Partial<DesignElement> } | null
}

/** Nothing may be dragged so far off the screen that it cannot be got back. */
const KEEP = 24
/** Below this a box has no grab area left. */
const MIN = 8

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** What a gesture would change, given where the pointer has travelled.
 *
 *  In spec units, not screen pixels: the caller divides by the preview's scale
 *  first, so dragging a 390-wide phone shown at half size moves the box by the
 *  distance the pointer actually covered. */
export function gesturePatch(
  e: DesignElement, handle: Handle, dx: number, dy: number,
  screen: { w: number; h: number },
): Partial<DesignElement> {
  const x = e.x ?? 0, y = e.y ?? 0, w = e.w ?? 0, h = e.h ?? 0
  const r = Math.round
  if (handle === 'move') {
    return { x: r(clamp(x + dx, KEEP - w, screen.w - KEEP)),
             y: r(clamp(y + dy, KEEP - h, screen.h - KEEP)) }
  }
  const east = handle === 'ne' || handle === 'se'
  const south = handle === 'se' || handle === 'sw'
  const nw = Math.max(MIN, east ? w + dx : w - dx)
  const nh = Math.max(MIN, south ? h + dy : h - dy)
  // A resize obeys the same rule a move does: some of the box stays on the
  // artboard. Without it a corner dragged up and to the left put the box
  // outside the screen, where the only way back was typing numbers.
  return {
    x: r(clamp(east ? x : x + (w - nw), KEEP - nw, screen.w - KEEP)),
    y: r(clamp(south ? y : y + (h - nh), KEEP - nh, screen.h - KEEP)),
    w: r(nw), h: r(nh),
  }
}

/** The box an element occupies.
 *
 *  Absolute when it carries coordinates, in flow when it does not — which is
 *  what lets a container lay its children out rather than every box carrying a
 *  coordinate that is only correct at one width. */
function frame(e: DesignElement): CSSProperties {
  const placed = e.x !== undefined && e.y !== undefined
  return placed
    ? { position: 'absolute', left: e.x, top: e.y, width: e.w, height: e.h }
    : { width: e.w, height: e.h, flex: e.w === undefined ? '1 1 auto' : undefined,
        // Shifted from where the row or column put it, without leaving it.
        ...(e.dx || e.dy ? { position: 'relative', left: e.dx ?? 0, top: e.dy ?? 0 } : {}) }
}

/** The roles that lay children out rather than drawing their own contents.
 *  Exported because the editor must not offer to put a child somewhere that
 *  will never draw one: a button given a child saved it and then rendered
 *  nothing, leaving an element in the spec with no box, no handles and nothing
 *  to click — unreachable for good. */
export const HOLDS = new Set<DesignElement['role']>(['card', 'nav', 'tabbar', 'list'])

/** The surface a role paints regardless of what is inside it.
 *
 *  A container lays its children out instead of drawing its own furniture, and
 *  the first version of that dropped the role's chrome with the furniture: a
 *  nav given a real link stopped looking like a nav. What a nav is — a bar
 *  across the top with a rule under it — does not depend on whether the links
 *  in it are painted or real. */
function chrome(e: DesignElement, p: Palette,
                tokens: DesignTokens | undefined): CSSProperties {
  const role = e.role
  const { background, edge } = panelOf(e, p, tokens)
  switch (role) {
    case 'card':
      return { background, border: `1px solid ${edge}`, borderRadius: p.radius }
    case 'nav':
      return { background, borderBottom: `1px solid ${edge}` }
    case 'tabbar':
      return { background, borderTop: `1px solid ${edge}` }
    case 'list':
      return { background, border: `1px solid ${edge}`, borderRadius: p.radius, overflow: 'hidden' }
    default:
      return {}
  }
}

function Element({ e: given, path, ctx }: {
  e: DesignElement; path: Path; ctx: Ctx
}): ReactNode {
  const { p } = ctx
  const g = ctx.gesture && samePath(ctx.gesture.path, path) ? ctx.gesture : null
  const pv = ctx.preview && samePath(ctx.preview.path, path) ? ctx.preview.patch : null
  // The box on the screen IS the box that would be written — by a drag, or by
  // the panel. A gesture wins over the panel, because it is the one with a
  // finger on it.
  const e = { ...given, ...pv, ...(g?.kind === 'place' ? g.patch : null) }
  // The same question the count asks. `Ctx.tokens` was plumbed in for exactly
  // this and never read, so an element citing `color.acent` was drawn as if it
  // were fully on-system while the rail said it defined nothing — the comment
  // on that field claimed the two agreed and they did not.
  const off = !resolves(e.cites, ctx.tokens)
  const selected = samePath(ctx.selected, path)

  const shell: CSSProperties = {
    ...frame(e),
    boxSizing: 'border-box',
    // Drift drawn on the artboard, not listed beside it.
    outline: selected ? '2px solid #2f6bed'
           : off ? '1.5px dashed #b4801a' : undefined,
    outlineOffset: selected ? 1 : 0,
    cursor: ctx.onGrab ? (selected ? 'move' : 'grab')
          : ctx.onSelect || e.goto ? 'pointer' : undefined,
    // Carried by the dragged element only. Everything else keeps its own
    // position, so the layout under it is the layout it will land in.
    ...(g?.kind === 'flow' && {
      transform: `translate(${g.dx}px, ${g.dy}px)`,
      opacity: 0.85, zIndex: 6, pointerEvents: 'none' as const,
    }),
    ...(g?.kind === 'place' && { zIndex: 6 }),
    // `undefined`, not falsy. An element at exactly 0,0 IS placed, and testing
    // truthiness made it a flow child in the editor while `frame()` — which
    // asks the right question — had already placed it absolutely. The two
    // disagreed, so a box dragged onto the origin jumped somewhere else, and
    // the panel went on reporting X=0 Y=0 while it sat further down.
    ...(e.x === undefined && e.y === undefined && ctx.onGrab
      ? { position: 'relative' as const } : {}),
  }

  const click = (ev: React.MouseEvent) => {
    ev.stopPropagation()
    // A gesture is followed by a click whose target is the common ancestor of
    // where the pointer went down and came up — the container, for a child
    // dragged within one. Acting on it threw the selection from the element
    // just dropped onto its parent, every time.
    if (ctx.justDragged?.()) return
    // Editing wins over the prototype link: you cannot change a nav button that
    // navigates away the moment you touch it.
    if (e.goto && ctx.onNavigate && !ctx.onGrab) ctx.onNavigate(e.goto)
    ctx.onSelect?.(path)
  }

  const hooks = {
    'data-el': e.id,
    'data-path': path.join('.'),
    // So the export can tell the blue selection ring from the amber drift one.
    // The drift outline BELONGS in the file — it is what "drawn dashed rather
    // than quietly looking finished" means — and the selection ring does not.
    ...(selected ? { 'data-selected': '' } : {}),
    // Where this links to, for the exporter: a standalone file has no script to
    // run a handler, but it can have anchors.
    ...(e.goto ? { 'data-goto': e.goto } : {}),
    onClick: click,
    onPointerDown: ctx.onGrab
      ? (ev: React.PointerEvent) => ctx.onGrab?.(path, 'move', ev)
      : undefined,
  }

  // A container lays its children out; everything else renders its role. Only
  // the roles that ARE containers, though: a button given a child rendered as a
  // bare div — no background, no radius, and its own label gone — which is one
  // click to turn a call to action into an invisible box.
  if (e.children?.length && HOLDS.has(e.role)) {
    return (
      <div {...hooks} style={{
        ...shell,
        display: 'flex',
        flexDirection: e.layout === 'row' ? 'row' : 'column',
        gap: e.gap ?? 8,
        padding: e.pad ?? 0,
        alignItems: e.align === 'center' ? 'center' : e.align === 'end' ? 'flex-end' : 'stretch',
        justifyContent: e.align === 'between' ? 'space-between' : 'flex-start',
        ...chrome(e, p, ctx.tokens),
      }}>
        {e.children.map((c, i) => (
          <Element key={`${c.id}.${i}`} e={c} path={[...path, i]} ctx={ctx} />
        ))}
      </div>
    )
  }

  const text = e.text ?? ''
  const textCss = typography(e, ctx.tokens)
  const wrap = (node: ReactNode, extra: CSSProperties = {}) => (
    <div {...hooks} style={{ ...shell, ...extra }}>{node}</div>
  )

  switch (e.role) {
    case 'heading':
      return wrap(<span style={{ width: '100%' }}>{text}</span>, {
        color: inkOf(e, p, ctx.tokens, p.text),
        letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', whiteSpace: 'pre-wrap', ...textCss,
      })
    case 'body':
      return wrap(<span style={{ width: '100%' }}>{text}</span>, {
        color: inkOf(e, p, ctx.tokens, p.muted),
        display: 'flex', alignItems: 'center', whiteSpace: 'pre-wrap', ...textCss,
      })
    case 'field-label':
      return wrap(<span style={{ width: '100%' }}>{text}</span>, {
        letterSpacing: '0.07em',
        textTransform: 'uppercase', color: inkOf(e, p, ctx.tokens, p.muted),
        display: 'flex', alignItems: 'center', whiteSpace: 'pre-wrap', ...textCss,
      })

    case 'button':
      // A real button: it focuses, it has a hit area, and a screen reader finds it.
      return (
        <button {...hooks} type="button" style={{
          ...shell, border: e.tone === 'muted' ? `1px solid ${p.border}` : 'none',
          // Through `inkOf`, like the other thirteen roles. These two read the
          // tone directly and ignored a named colour outright — on the two
          // roles anybody would reach for first.
          background: namedColor(e, ctx.tokens)
                      ?? (e.tone === 'muted' ? p.surface : toneColor(p, e.tone)),
          color: e.tone === 'muted' ? p.text : p.onAccent,
          borderRadius: p.radius,
          fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'pre-wrap', ...textCss,
        }}>{text}</button>
      )

    case 'input':
      // A real input, so type, padding and placeholder colour are the real ones
      // rather than a rectangle with a caption that only looks like them.
      return (
        <input {...hooks} readOnly={!ctx.onNavigate || !!ctx.onGrab} placeholder={text}
          aria-label={text || 'Design input'} style={{
          ...shell, border: `1px solid ${inkOf(e, p, ctx.tokens, p.border)}`, background: p.bg,
          borderRadius: p.radius * 0.8, padding: '0 12px',
          color: inkOf(e, p, ctx.tokens, p.text), fontFamily: 'inherit', ...textCss,
        }} />
      )

    case 'image':
      return e.src
        // `draggable={false}`: a native HTML5 image drag cancels the pointer
        // stream, so an image with a src could not be moved at all while the
        // placeholder — a div — could.
        ? <img {...hooks} draggable={false} src={e.src} alt={text}
               style={{ ...shell, objectFit: 'cover', borderRadius: p.radius * 0.8 }} />
        : wrap(
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path d="M3 17l5-6 4 5 3-3 6 7H3z" fill={p.border} />
              <circle cx="8" cy="7" r="2.2" fill={p.border} />
            </svg>,
            { background: inkOf(e, p, ctx.tokens, p.surface), border: `1px solid ${p.border}`,
              borderRadius: p.radius * 0.8, display: 'flex',
              alignItems: 'center', justifyContent: 'center' })

    case 'list': {
      const rows = Math.max(1, Math.min(7, Math.round((e.h ?? 200) / 64)))
      return wrap(
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px',
              borderBottom: i < rows - 1 ? `1px solid ${p.border}` : undefined,
            }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: p.surface, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ height: 7, width: '55%', borderRadius: 4, background: p.text, opacity: 0.7 }} />
                <div style={{ height: 6, width: '35%', borderRadius: 3, background: p.muted, opacity: 0.45, marginTop: 5 }} />
              </div>
              <div style={{ width: 26, height: 14, borderRadius: 7,
                            background: inkOf(e, p, ctx.tokens, p.accent), opacity: 0.16 }} />
            </div>
          ))}
        </div>,
        { background: panelOf(e, p, ctx.tokens).background, border: `1px solid ${panelOf(e, p, ctx.tokens).edge}`,
          borderRadius: p.radius, overflow: 'hidden' })
    }

    case 'nav':
      return wrap(
        <>
          <div style={{ width: 22, height: 14, borderRadius: 4, background: inkOf(e, p, ctx.tokens, p.accent) }} />
          <span style={{ fontSize: 13, fontWeight: 640, color: p.text }}>{text}</span>
          <span style={{ flex: 1 }} />
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 30, height: 7, borderRadius: 4, background: p.muted, opacity: 0.4 }} />
          ))}
        </>,
        { background: panelOf(e, p, ctx.tokens).background, borderBottom: `1px solid ${panelOf(e, p, ctx.tokens).edge}`,
          display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' })

    case 'tabbar': {
      const tabs = (text || 'Home,Search,Saved,You').split(',')
      return wrap(
        <>{tabs.map((t, i) => (
          <div key={t} style={{ flex: 1, display: 'flex', flexDirection: 'column',
                                alignItems: 'center', gap: 4 }}>
            <div style={{ width: 18, height: 18, borderRadius: 5,
                          background: i === 0 ? inkOf(e, p, ctx.tokens, p.accent) : p.muted,
                          opacity: i === 0 ? 1 : 0.4 }} />
            <span style={{ fontSize: 10, color: i === 0 ? inkOf(e, p, ctx.tokens, p.accent) : p.muted }}>
              {t.trim()}
            </span>
          </div>))}</>,
        { background: panelOf(e, p, ctx.tokens).background, borderTop: `1px solid ${panelOf(e, p, ctx.tokens).edge}`,
          display: 'flex', alignItems: 'center', paddingTop: 8 })
    }

    case 'logo':
      return wrap(
        <>
          <div style={{ width: (e.h ?? 32), height: (e.h ?? 32), borderRadius: (e.h ?? 32) * 0.28,
                        background: inkOf(e, p, ctx.tokens, p.accent), flex: 'none', display: 'flex',
                        alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: (e.h ?? 32) * 0.34, height: (e.h ?? 32) * 0.34,
                          borderRadius: '50%', background: p.onAccent }} />
          </div>
          {text && <span style={{ flex: 1, color: p.text, whiteSpace: 'pre-wrap', ...textCss }}>{text}</span>}
        </>,
        { display: 'flex', alignItems: 'center', gap: 10 })

    case 'avatar':
      return wrap((text || 'A').slice(0, 1).toUpperCase(), {
        borderRadius: '50%', background: inkOf(e, p, ctx.tokens, p.surface),
        border: `1px solid ${p.border}`,
        display: 'flex', alignItems: 'center',
        color: p.muted, ...textCss,
        justifyContent: textCss.textAlign === 'left' ? 'flex-start' : textCss.textAlign === 'right' ? 'flex-end' : 'center',
      })

    case 'badge': {
      // A muted badge is a neutral one — "draft", a count — so it is the surface
      // with muted text. Tinting the surface with itself, and writing in it too,
      // drew it invisible on every light palette.
      const named = namedColor(e, ctx.tokens)
      const neutral = !named && e.tone === 'muted'
      const ink = named ?? toneColor(p, e.tone ?? 'accent')
      return wrap(<span style={{ width: '100%' }}>{text}</span>, {
        borderRadius: 999,
        background: neutral ? p.surface : ink + '28',
        color: neutral ? p.muted : ink,
        display: 'flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'pre-wrap', ...textCss,
      })
    }

    case 'icon':
      return wrap(null, { background: inkOf(e, p, ctx.tokens, p.surface),
                          border: `1px solid ${p.border}`,
                          borderRadius: (e.w ?? 20) * 0.26 })

    case 'divider':
      return wrap(null, { borderTop: `1px solid ${inkOf(e, p, ctx.tokens, p.border)}`, height: 1 })

    case 'card':
    default:
      return wrap(
        text ? <span style={{ fontSize: 13.5, fontWeight: 600, color: p.text }}>{text}</span> : null,
        { background: panelOf(e, p, ctx.tokens).background, border: `1px solid ${panelOf(e, p, ctx.tokens).edge}`,
          borderRadius: p.radius, padding: 14, display: 'flex', alignItems: 'flex-start' })
  }
}

type Surface = 'mobile' | 'web' | 'email'

function chromeOf(surface: Surface) {
  if (surface === 'mobile') return { pad: 13, top: 30, bottom: 20, radius: 40 }
  if (surface === 'web') return { pad: 0, top: 36, bottom: 0, radius: 10 }
  return { pad: 0, top: 0, bottom: 0, radius: 8 }
}

/** Shared by the renderer and zoom controls, including the surrounding device chrome. */
export function designScreenScale(screen: DesignScreen, surface: Surface, width: number, maxHeight?: number) {
  const c = chromeOf(surface)
  return Math.min(width / (Math.max(1, screen.w) + c.pad * 2),
    maxHeight ? maxHeight / (Math.max(1, screen.h) + c.pad * 2 + c.top + c.bottom) : Infinity)
}

/** One sibling's box, in both frames of reference: client coordinates to
 *  hit-test the pointer against, stage coordinates to draw the insertion line
 *  in. Measured once when a drag begins — the siblings do not move while it is
 *  in flight, because the dragged one is translated rather than removed. */
interface Box { cx: number; cy: number; x: number; y: number; w: number; h: number }

function at(els: DesignElement[], path: Path): DesignElement | undefined {
  let list: DesignElement[] | undefined = els
  let found: DesignElement | undefined
  for (const i of path) {
    found = list?.[i]
    if (!found) return undefined
    list = found.children
  }
  return found
}

/** Where the line goes: before this box, or after the last one. */
function edgeOf(b: Box | undefined, axis: 'row' | 'column', after: boolean) {
  if (!b) return null
  return axis === 'row'
    ? { x: after ? b.x + b.w : b.x - 2, y: b.y, w: 2, h: b.h }
    : { x: b.x, y: after ? b.y + b.h : b.y - 2, w: b.w, h: 2 }
}

/** One screen, drawn as real DOM at its own size and then scaled.
 *
 *  It used to be SVG — an input was a rectangle with a caption, an image was a
 *  drawn placeholder, and nothing could be typed in, focused or clicked. "Spec,
 *  never markup" governs what the MODEL emits so the result can be diffed and
 *  reviewed; it never required the RENDERER to avoid the DOM. The spec is
 *  unchanged and still carries no markup: these components are ours, and the
 *  model only names which one. */
export function DesignScreenView({
  screen, tokens, surface = 'mobile', width = 260, maxHeight, zoom,
  selected, onSelect, onNavigate, onEdit, onReorder, preview,
  placing, onPlace, onRename, onRemove, saving = false, interactive = false,
}: {
  screen: DesignScreen
  tokens?: DesignTokens
  surface?: Surface
  width?: number
  maxHeight?: number
  /** View-only scale. All hit testing and gestures still use spec coordinates. */
  zoom?: number
  selected?: Path
  onSelect?: (path: Path) => void
  onNavigate?: (screenId: string) => void
  /** One gesture, one call. Not one per pixel: a drag is a single change with a
   *  single before and after, and a history with forty entries reading "move
   *  b1" is a worse account of what happened than four. */
  onEdit?: (path: Path, patch: Partial<DesignElement>, what: string) => void
  onReorder?: (parent: Path, from: number, to: number, what: string) => void
  /** What the panel is showing but has not written yet. */
  preview?: { path: Path; patch: Partial<DesignElement> } | null
  /** A role armed on the toolbar, waiting to be put somewhere. */
  placing?: DesignElement['role'] | null
  /** Where it was drawn, in spec units. A click with no drag reports no size,
   *  and the caller supplies the role's own. */
  onPlace?: (at: { x: number; y: number; w?: number; h?: number }) => void
  /** Rename this screen, and remove it. Absent in the gallery, where a card is
   *  a picture of a design rather than a thing to edit. */
  onRename?: (name: string) => void
  onRemove?: () => void
  /** A write is in flight. Every edit funnels through one `busy` guard that
   *  returns early, and the artboard — unlike the rail's buttons — was not
   *  disabled, so a second drag during a save was dropped on the floor with no
   *  error. On a local gateway you would never see it; on a real one it is
   *  every other gesture. */
  saving?: boolean
  interactive?: boolean
}) {
  const p = palette(tokens)
  const els = screen.elements ?? []
  const c = chromeOf(surface)
  const sw = Math.max(1, screen.w)
  const sh = Math.max(1, screen.h)
  const outerW = sw + c.pad * 2
  const outerH = sh + c.pad * 2 + c.top + c.bottom
  const scale = zoom === undefined ? designScreenScale(screen, surface, width, maxHeight)
    : Math.max(.01, zoom)
  // Children as well, and checked rather than counted: the caption said
  // nothing while a child right under it was drawn dashed.
  const off = els.flatMap(e => [e, ...(e.children ?? [])])
    .filter(e => !resolves(e.cites, tokens)).length

  const stage = useRef<HTMLDivElement>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const start = useRef<Start | null>(null)
  // Read by the pointerup listener, which must see the gesture as it stands
  // when the button is released rather than as it was when it subscribed.
  const live = useRef<Gesture | null>(null)
  live.current = gesture
  /** Set when a gesture actually moved something, cleared by the click that
   *  follows it. */
  const dragged = useRef(false)
  const editable = !!(onEdit && onReorder)

  /** The siblings a dragged child could be dropped between. */
  const flowOf = (path: Path): Start['flow'] => {
    const parent = path.slice(0, -1)
    const from = path[path.length - 1]
    const host = stage.current
    if (!host) return undefined
    const holder = parent.length ? at(els, parent) : undefined
    const count = parent.length ? holder?.children?.length ?? 0 : els.length
    const axis: 'row' | 'column' = holder?.layout === 'row' ? 'row' : 'column'
    const st = host.getBoundingClientRect()
    const rects: Box[] = []
    for (let i = 0; i < count; i++) {
      const node = host.querySelector(`[data-path="${[...parent, i].join('.')}"]`)
      const r = node?.getBoundingClientRect()
      if (!r) return undefined
      rects.push({
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        x: (r.left - st.left) / scale, y: (r.top - st.top) / scale,
        w: r.width / scale, h: r.height / scale,
      })
    }
    return { parent, from, rects, axis }
  }

  /** Where the pointer went down, and what it grabbed. Held in a ref rather
   *  than in state: the window listeners below are installed once per gesture
   *  and would otherwise close over the values as they were when the drag
   *  began, which is the same thing but harder to read. */
  interface Start {
    path: Path; handle: Handle; el: DesignElement
    x: number; y: number; moved: boolean
    flow?: { parent: Path; from: number; rects: Box[]; axis: 'row' | 'column' }
  }

  const onGrab = editable ? (path: Path, handle: Handle, ev: React.PointerEvent) => {
    const el = at(els, path)
    // Only the main button: a secondary click opening a menu is not a grab.
    if (!el || saving || ev.button !== 0) return
    ev.stopPropagation()
    // Not preventDefault: a grab still has to be able to become a click, and on
    // a <button> that is how selection happens.
    const placed = el.x !== undefined && el.y !== undefined
    start.current = {
      path, handle, el, x: ev.clientX, y: ev.clientY, moved: false,
      flow: placed || handle !== 'move' ? undefined : flowOf(path),
    }
    setGesture(null)
  } : undefined

  useEffect(() => {
    if (!editable) return
    const move = (ev: PointerEvent) => {
      const s0 = start.current
      if (!s0) return
      // Nothing is held any more, so whatever this was, it is not a drag. A
      // trackpad release that never reached the page (tap-to-click, drag
      // lock) left the grab live: the element followed the finger with no
      // button down and the next tap dropped it a place along.
      if (ev.buttons === 0) {
        start.current = null
        setGesture(null)
        return
      }
      const dxRaw = ev.clientX - s0.x
      const dyRaw = ev.clientY - s0.y
      // A click that wobbles by a pixel is still a click.
      // A click is not a drag. Three pixels of travel (|dx|+|dy|) began one, so
      // a hand that moved while clicking moved the element — and saved it:
      // selecting the tab bar wrote "move tabs to 6,706". Six pixels of real
      // distance first; arrows place it to the pixel.
      if (!s0.moved && Math.hypot(dxRaw, dyRaw) < DRAG_START_PX) return
      s0.moved = true
      const dx = dxRaw / scale
      const dy = dyRaw / scale
      if (s0.flow) {
        const { rects, axis, parent, from } = s0.flow
        const pt = axis === 'row' ? ev.clientX : ev.clientY
        // Where it would be inserted, counted in the list as it stands — the
        // same number the indicator is drawn at, and `rects.length` for the
        // end. Sending the index of the sibling it was dropped ON instead put
        // every downward drag one slot past the line the person was looking at.
        let to = rects.length
        for (let i = 0; i < rects.length; i++) {
          const mid = axis === 'row' ? rects[i].cx : rects[i].cy
          if (pt < mid) { to = i; break }
        }
        setGesture({ kind: 'flow', path: s0.path, parent, from, to, dx, dy,
                     line: to < rects.length ? edgeOf(rects[to], axis, false)
                                             : edgeOf(rects[rects.length - 1], axis, true) })
      } else {
        setGesture({ kind: 'place', path: s0.path,
                     patch: gesturePatch(s0.el, s0.handle, dx, dy, { w: sw, h: sh }) })
      }
    }
    const up = () => {
      const s0 = start.current
      const g = live.current
      start.current = null
      setGesture(null)
      if (!s0?.moved || !g) return
      dragged.current = true
      if (g.kind === 'flow') {
        // Before itself and before the one after it are both where it is.
        if (g.to !== g.from && g.to !== g.from + 1) {
          onReorder?.(g.parent, g.from, g.to, `move ${s0.el.id}`)
        } else {
          // Not past a neighbour, so it keeps its place and is shifted by what
          // the pointer travelled — as the arrow keys shift it. Snapping back
          // made a short drag look like the mouse could not move it at all.
          const dx = Math.round((s0.el.dx ?? 0) + g.dx) || undefined
          const dy = Math.round((s0.el.dy ?? 0) + g.dy) || undefined
          if (dx !== s0.el.dx || dy !== s0.el.dy) onEdit?.(g.path, { dx, dy }, `move ${s0.el.id}`)
        }
      } else {
        // A box dragged out and put back changes nothing, and nothing is what
        // should be written. `patchAt` refuses the same edit a second time by
        // identity, which is the guarantee that matters; this is so the round
        // trip to the gateway is not made at all.
        const keys = Object.keys(g.patch) as (keyof DesignElement)[]
        if (keys.some(k => s0.el[k] !== g.patch[k])) {
          onEdit?.(g.path, g.patch,
                   s0.handle === 'move' ? `move ${s0.el.id}` : `resize ${s0.el.id}`)
        }
      }
    }
    // Re-subscribed on every render on purpose: `move` reads the scale, the
    // screen size and the callbacks, and a listener installed once would go on
    // using whatever those were when it subscribed.
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  })

  /** Drawing a new element: the rubber band, in spec units. */
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const drawFrom = useRef<{ x: number; y: number } | null>(null)

  // Escape mid-drag unmounts the layer, so its pointerup never runs and the
  // band it was drawing survives — painted again the moment any tool is next
  // armed, before a finger has touched anything.
  useEffect(() => {
    if (!placing) { setBand(null); drawFrom.current = null }
  }, [placing])

  /** Pointer position in the screen's own coordinates. */
  const specAt = (ev: React.PointerEvent | PointerEvent) => {
    const box = stage.current?.getBoundingClientRect()
    if (!box) return null
    return { x: (ev.clientX - box.left) / scale - c.pad,
             y: (ev.clientY - box.top) / scale - c.pad - c.top }
  }

  const ctx: Ctx = { p, tokens, selected, onSelect, onNavigate, onGrab, gesture, preview,
                     justDragged: () => {
                       if (!dragged.current) return false
                       dragged.current = false
                       return true
                     } }
  const raw = selected ? at(els, selected) : undefined
  // The handles follow the preview too, or a box resized by typing a number
  // keeps its handles where the old number put them.
  const sel = raw && preview && samePath(preview.path, selected)
    ? { ...raw, ...preview.patch } : raw
  // A box of four numbers rather than the element, so the coordinates the
  // overlay is positioned from cannot be undefined by the time it reads them.
  const handles = editable && sel && !gesture
    && sel.x !== undefined && sel.y !== undefined
    && sel.w !== undefined && sel.h !== undefined
    ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : null

  return (
    <div className="dscreen" data-screen-id={screen.id} data-scale={scale}>
      <div style={{ width: outerW * scale, height: outerH * scale, position: 'relative',
                    pointerEvents: interactive || editable ? 'auto' : 'none',
                    cursor: saving ? 'progress' : undefined,
                    touchAction: editable ? 'none' : undefined,
                    userSelect: editable ? 'none' : undefined }}>
        {/* data-stage is what the export serialises: the drawing at its natural
            size, with the preview's scale stripped. */}
        <div data-stage ref={stage} className="screen" style={{
          position: 'absolute', top: 0, left: 0, width: outerW, height: outerH,
          transform: `scale(${scale})`, transformOrigin: '0 0',
          background: '#23262b', borderRadius: c.radius, overflow: 'hidden',
          fontFamily: p.font,
        }}>
          {surface === 'mobile' && (
            <>
              <div style={{ position: 'absolute', left: outerW / 2 - 42, top: 5, width: 84,
                            height: 19, borderRadius: 10, background: '#000', zIndex: 2 }} />
              <div style={{ position: 'absolute', left: c.pad + 18, top: 7, fontSize: 12,
                            fontWeight: 620, color: '#fff' }}>9:41</div>
              <div style={{ position: 'absolute', left: outerW / 2 - 48, bottom: 8, width: 96,
                            height: 4, borderRadius: 2, background: 'rgba(255,255,255,.55)' }} />
            </>
          )}
          {surface === 'web' && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: outerW, height: c.top,
                          display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px' }}>
              {['#ef6a5e', '#f5bd4f', '#61c454'].map(col => (
                <div key={col} style={{ width: 10, height: 10, borderRadius: '50%', background: col }} />
              ))}
              <div style={{ flex: 1, height: 18, borderRadius: 9, background: '#3a3e45',
                            marginLeft: 8, display: 'flex', alignItems: 'center', padding: '0 10px',
                            fontSize: 10.5, color: '#aeb4bc' }}>
                {screen.name.toLowerCase().replace(/\s+/g, '')}.com
              </div>
            </div>
          )}

          {/* the screen itself */}
          <div data-screen style={{
            position: 'absolute', left: c.pad, top: c.pad + c.top, width: sw, height: sh,
            background: p.bg, overflow: 'hidden',
            borderRadius: surface === 'mobile' ? 26 : 2, color: p.text,
          }}>
            {els.map((e, i) => (
              <Element key={`${e.id}.${i}`} e={e} path={[i]} ctx={ctx} />
            ))}

          </div>

          {/* Where a dragged child would land. Measured once when the drag
              starts — the siblings do not move while it is in flight. */}
          {gesture?.kind === 'flow' && gesture.line && (
            <div data-editor style={{ position: 'absolute', zIndex: 7, pointerEvents: 'none',
                          background: '#2f6bed', borderRadius: 1,
                          left: gesture.line.x, top: gesture.line.y,
                          width: Math.max(2 / scale, gesture.line.w),
                          height: Math.max(2 / scale, gesture.line.h) }} />
          )}
        </div>
        {/* The placing layer. Above everything, so a new element can be drawn
            over an existing one, and only present while a tool is armed — the
            artboard is a canvas to draw on then, not a set of things to pick
            up. */}
        {placing && onPlace && (
          <div
            style={{ position: 'absolute', cursor: 'crosshair',
                     left: c.pad * scale, top: (c.pad + c.top) * scale,
                     width: sw * scale, height: sh * scale, zIndex: 8 }}
            onPointerDown={ev => {
              const at = specAt(ev)
              if (!at) return
              ev.preventDefault()
              ev.currentTarget.setPointerCapture(ev.pointerId)
              drawFrom.current = at
              setBand({ x: at.x, y: at.y, w: 0, h: 0 })
            }}
            onPointerMove={ev => {
              const from = drawFrom.current
              const at = from && specAt(ev)
              if (!from || !at) return
              setBand({ x: Math.min(from.x, at.x), y: Math.min(from.y, at.y),
                        w: Math.abs(at.x - from.x), h: Math.abs(at.y - from.y) })
            }}
            onPointerUp={() => {
              const b = band
              drawFrom.current = null
              setBand(null)
              if (!b) return
              // A click is a place at the default size; a drag is a place at
              // the size drawn. Below a few pixels it was a click that moved.
              const drawn = b.w > 4 && b.h > 4
              // Held to the same rule a drag obeys: a box drawn past the corner
              // ran to two and a half times the screen with its far handles
              // hundreds of pixels off-window, leaving the number fields as the
              // only way back.
              const w = drawn ? Math.min(Math.round(b.w), sw) : undefined
              const h = drawn ? Math.min(Math.round(b.h), sh) : undefined
              onPlace({
                x: Math.round(clamp(b.x, KEEP - (w ?? MIN), sw - KEEP)),
                y: Math.round(clamp(b.y, KEEP - (h ?? MIN), sh - KEEP)),
                w, h,
              })
            }}>
            {band && band.w > 4 && band.h > 4 && (
              <div style={{ position: 'absolute', left: band.x * scale, top: band.y * scale,
                            width: band.w * scale, height: band.h * scale,
                            border: '1.5px solid #2f6bed', background: 'rgba(47,107,237,.10)',
                            pointerEvents: 'none' }} />
            )}
          </div>
        )}

        {/* Drawn over the artboard rather than inside the element, because a
            button, an input and an image cannot carry children — and outside
            the STAGE, which clips. Moving them out of the screen box was not
            enough: the stage clips too, and for a web or email surface there is
            no device padding between them, so an element flush with the edge
            had handles cut away. On the shipped marketing design that was both
            right-hand corners of the nav, and the nav could not be resized from
            the right at all.

            Positioned in screen pixels rather than spec units, so they are the
            same size whatever the artboard is scaled to — a 9px grab target at
            0.43 scale was a 4px one. */}
        {handles && (
          <div data-editor style={{ position: 'absolute', pointerEvents: 'none',
                        left: (c.pad + handles.x) * scale,
                        top: (c.pad + c.top + handles.y) * scale,
                        width: handles.w * scale, height: handles.h * scale }}>
            {(['nw', 'ne', 'sw', 'se'] as const).map(h => (
              <div key={h} data-handle={h} onPointerDown={ev => onGrab?.(selected!, h, ev)}
                   style={{
                     position: 'absolute', width: 10, height: 10,
                     left: h === 'nw' || h === 'sw' ? -5 : undefined,
                     right: h === 'ne' || h === 'se' ? -5 : undefined,
                     top: h === 'nw' || h === 'ne' ? -5 : undefined,
                     bottom: h === 'sw' || h === 'se' ? -5 : undefined,
                     background: '#fff', border: '1.5px solid #2f6bed',
                     borderRadius: 2, pointerEvents: 'auto',
                     cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize',
                   }} />
            ))}
          </div>
        )}
      </div>
      <div className="dscreen-cap">
        {onRename
          ? <input className="capname" defaultValue={screen.name} key={screen.name}
                   aria-label="screen name"
                   onBlur={e => { if (e.target.value.trim() !== screen.name)
                                    onRename(e.target.value) }}
                   onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          : <b>{screen.name}</b>}
        <span>{screen.w}×{screen.h}</span>
        {/* The drift count belongs where the design is being worked on. On a
            gallery card the same fact is already in the meta line below it, in
            another colour, a hundred pixels away. */}
        {off > 0 && onRename && (
          <span style={{ color: 'var(--warn)' }}>{off} off-system</span>
        )}
        {onRemove && (
          <button className="linkbtn" style={{ marginLeft: 'auto' }}
                  onClick={onRemove}>Remove screen</button>
        )}
      </div>
    </div>
  )
}
