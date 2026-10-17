/**
 * The design you had not filed yet, kept across a reload.
 *
 * `designs.generate` writes nothing — deliberately. Filing every attempt would
 * put abandoned generations in the collection and `state: 'draft'` would stop
 * meaning "somebody intends to ship this". But the tokens were spent and the
 * refinement conversation is several turns long, so losing it to a reloaded tab
 * is throwing away work that cost money.
 *
 * So it lives here: in the browser, for one person, until it is filed or
 * discarded. That is the right shape for it — an unfiled draft is nobody else's
 * business, and the graph is the record of decisions rather than of attempts.
 * The cost is that it does not follow you to another machine, which is the
 * honest trade and not a bug to fix later by writing drafts to the graph.
 *
 * What comes back out is untrusted. It survives an app deploy, so it may have
 * been written by an older build, and anybody can edit it in devtools. Parsing
 * is forgiving in the same way `viewstate` is: a draft that will not parse is
 * dropped rather than raised, because a broken key should open an empty panel
 * and not an error page.
 */
import type { GeneratedDesign } from './gateway'

const KEY = 'commonindex.designs.draft.v1'

/** Old enough that offering to resume it is noise rather than a rescue. */
const KEEP_DAYS = 14

const SURFACES = ['mobile', 'web', 'email'] as const
type Surface = (typeof SURFACES)[number]

const MODES = ['brief', 'template'] as const
type Mode = (typeof MODES)[number]

export interface DesignDraft {
  /** When it was last touched, so the banner can say how old it is. */
  at: string
  /** Which half of the panel was open. Stored because the fields differ: a
   *  restored template name is invisible in the mode that has no name field. */
  mode: Mode
  brief: string
  title: string
  surface: Surface
  screens: number
  /** The template, by id. The object is re-resolved from the loaded list —
   *  storing it whole would pin a copy of a template that has since changed,
   *  which is exactly the drift the citation exists to prevent. */
  pickId: string | null
  /** Optional independent system for a copied layout. IDs stay live citations. */
  styleId?: string | null
  turns: string[]
  generated: GeneratedDesign | null
}

/** Every access is guarded, not just every write. Reading `window.localStorage`
 *  itself throws when site data is blocked, so a `try` around `getItem` alone
 *  still takes the panel down in a browser that refuses storage. */
function store(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parse(raw: string): DesignDraft | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const d = v as Record<string, unknown>

  const at = Date.parse(str(d.at))
  if (!Number.isFinite(at)) return null
  // A clock that moved backwards is not a reason to throw the draft away; an
  // `at` in the future just reads as new.
  if (Date.now() - at > KEEP_DAYS * 86_400_000) return null

  const surface = str(d.surface) as Surface
  if (!(SURFACES as readonly string[]).includes(surface)) return null

  const generated = validGenerated(d.generated)
  const brief = str(d.brief)
  const title = str(d.title)
  const pickId = typeof d.pickId === 'string' && d.pickId ? d.pickId : null
  const styleId = typeof d.styleId === 'string' && d.styleId ? d.styleId : null
  // Nothing to resume. Reported as absent rather than as an empty draft, so no
  // banner offers to restore a blank panel.
  if (!brief && !generated && !title && !pickId && !styleId) return null

  const mode = str(d.mode) as Mode

  return {
    at: new Date(at).toISOString(),
    mode: (MODES as readonly string[]).includes(mode) ? mode : 'brief',
    brief,
    title,
    surface,
    screens: Math.min(6, Math.max(1, Math.round(Number(d.screens) || 1))),
    pickId,
    styleId,
    turns: Array.isArray(d.turns) ? d.turns.filter(t => typeof t === 'string') : [],
    generated,
  }
}

/** The spec is what gets rendered the moment the panel restores, so the shape
 *  the renderer walks is checked rather than assumed. A half-written draft that
 *  renders as a blank screen is worse than one that never came back. */
function validGenerated(v: unknown): GeneratedDesign | null {
  if (!v || typeof v !== 'object') return null
  const g = v as Record<string, unknown>
  const spec = g.spec as Record<string, unknown> | undefined
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.screens)) return null
  if (!(SURFACES as readonly string[]).includes(str(g.surface))) return null
  return g as unknown as GeneratedDesign
}

export function loadDraft(): DesignDraft | null {
  const s = store()
  if (!s) return null
  let raw: string | null = null
  try {
    raw = s.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  const draft = parse(raw)
  // It will not parse on the next reload either, so stop carrying it.
  if (!draft) clearDraft()
  return draft
}

export function saveDraft(d: Omit<DesignDraft, 'at'>): void {
  // A picked template and a typed name are worth keeping even with no brief and
  // nothing generated — that is the whole of the from-a-template panel, and
  // losing it to a mis-clicked Cancel is the same annoyance in miniature.
  if (!d.brief && !d.generated && !d.title && !d.pickId && !d.styleId) return clearDraft()
  const s = store()
  if (!s) return
  try {
    s.setItem(KEY, JSON.stringify({ ...d, at: new Date().toISOString() }))
  } catch {
    // Quota, or a browser that reports storage and refuses writes. Autosave is
    // a convenience: it must never be the reason the panel stops working, and
    // the draft on screen is still there.
  }
}

export function clearDraft(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    /* nothing to do about it and nothing that depends on it */
  }
}
