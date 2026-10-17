import { ShareButton } from '../components/ShareButton'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { GatewayError, designHistory, designReferences, generateDesign, getDesign,
         listDesigns, proposeDesign, reviseDesign,
         type DesignElement, type DesignReference, type DesignRevision,
         type DesignTokens, type GeneratedDesign, type WireDesign } from '../data/gateway'
import { clearDraft, loadDraft, saveDraft } from '../data/drafts'
import { addScreen, addTo, duplicateAt, elementAt, patchAt, pathOfId, removeAt,
         removeScreen, renameScreen, reorderAt, restackAt, samePath,
         type Path } from '../data/spec'
import { Pill } from '../components/ui'
import { DesignScreenView, designScreenScale, gesturePatch, HOLDS, onSystem } from '../components/DesignCanvas'
import { DesignInspector } from '../components/DesignInspector'
import { DesignSidebar, type InspectorTab } from '../components/DesignSidebar'
import { DesignNavigationGuard } from '../components/DesignNavigationGuard'
import { DesignGalleryCard, designCollection, sortDesigns, type DesignCollection, type DesignSort } from '../components/DesignGalleryCard'
import { DesignTools, DesignScreenNavigator, DesignZoomControls, EditorPopover, TOOL_LABELS, type CanvasZoom } from '../components/DesignEditorControls'
import { DesignLayers } from '../components/DesignLayers'
import { DesignChecks, revealCanvasElement } from '../components/DesignChecks'
import { DesignAIReview, designChangeSummary, type AIProposal } from '../components/DesignAIReview'
import { DesignReviewBar } from '../components/DesignReviewBar'
import { CommentsButton } from '../components/discussion/Thread'
import { TasksButton } from '../components/TaskLinks'
import { ProjectsButton } from '../components/ProjectChips'
import { DesignTemplatePicker, isDesignSystem } from '../components/DesignTemplatePicker'
import { designToHtml, designToPackage, downloadHtml, downloadJson,
         resolveVars, ROLE_CATALOGUE, slug } from '../data/exportDesign'

const SURFACES = ['all', 'mobile', 'web', 'email'] as const

/** What the gateway keeps, and therefore the most this list can ever show.
 *  Every revision is a full snapshot and every gesture writes one, so the
 *  history is capped rather than unbounded — said here, because a person who
 *  expects to find yesterday's first draft should not have to discover it is
 *  gone by looking for it. */
const KEEP_REVISIONS = 100



/** A new element has to arrive somewhere you can see it and at a size you can
 *  grab. These are starting points, not rules — every one of them is a number
 *  in the panel the moment it exists. */
const STARTING: Partial<Record<string, { w: number; h: number; text?: string }>> = {
  heading: { w: 280, h: 40, text: 'Heading' },
  body: { w: 280, h: 22, text: 'Some words' },
  'field-label': { w: 160, h: 16, text: 'Label' },
  button: { w: 160, h: 44, text: 'Do the thing' },
  input: { w: 280, h: 44, text: 'you@example.com' },
  image: { w: 280, h: 180 },
  list: { w: 320, h: 260 },
  nav: { w: 360, h: 60, text: 'Product' },
  tabbar: { w: 360, h: 56, text: 'Home,Search,You' },
  card: { w: 240, h: 140, text: 'Card' },
  divider: { w: 280, h: 1 },
  logo: { w: 140, h: 32, text: 'Example Co' },
  avatar: { w: 36, h: 36, text: 'A' },
  badge: { w: 74, h: 22, text: 'New' },
  icon: { w: 22, h: 22 },
}

interface Stash {
  screen: string
  path: Path
  patch: Partial<DesignElement>
  label: string
}

/** An element's address as one string, so a Map key and an equality test agree.
 *  Comparing only the path made the element at index 0 on one screen the same
 *  selection as the element at index 0 on another. */
const keyOf = (s: { screen: string; path: Path }) => `${s.screen}:${s.path.join('.')}`



/** Relative time, because "rev 3, 2026-09-15T23:11:04Z" is a timestamp and
 *  "rev 3, 4 minutes ago" is an answer. */
function ago(at: string): string {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000)
  if (s < 90) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m ago`
  const h = m / 60
  return h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`
}

function stateTone(s: string | undefined) {
  return s === 'approved' ? 'green' : s === 'review' ? 'warn'
       : s === 'superseded' ? 'red' : 'gray'
}


/** Tokens come from the design itself, or from the template it cites.
 *
 *  This is the citation doing real work rather than being a label: change the
 *  approved template's accent and every screen citing it restyles, because
 *  nothing copied the value down. */
function resolveTokens(d: WireDesign, byId: Map<string, WireDesign>): DesignTokens | undefined {
  // Match the detail view's breadth-first lookup. Templates can themselves
  // cite a system; empty palettes and citation cycles are not a dead end.
  const queue = [d]
  const seen = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]
    if (seen.has(current.id)) continue
    seen.add(current.id)
    if (current.spec?.tokens && Object.keys(current.spec.tokens).length) return current.spec.tokens
    for (const id of current.cites ?? []) {
      const cited = byId.get(id)
      if (cited && !seen.has(id)) queue.push(cited)
    }
  }
  return undefined
}

/** Starting a design: describe it, or begin from a template.
 *
 *  "Describe it" is the mode that matters — picking a template and naming it is
 *  not designing, it is filing. The brief goes to a model under the design
 *  type's own schema, the spec comes back, and it renders here before anything
 *  is filed. Nothing is written until somebody decides it is worth reviewing.
 */
function NewDesign({ templates, byId, onMade, onCancel }: {
  onCancel: () => void
  templates: WireDesign[]
  byId: Map<string, WireDesign>
  onMade: (id: string) => void
}) {
  // Read once, during the first render, rather than in an effect. An effect that
  // restores necessarily runs after the effect that autosaves has already seen
  // an empty panel and written that emptiness over the draft — a race whose only
  // rescue is the re-render that follows. Reading it here means the panel is
  // never empty in the first place, so there is nothing to race.
  const [saved] = useState(loadDraft)

  const [mode, setMode] = useState<'brief' | 'template'>(saved?.mode ?? 'brief')
  // Not defaulted to a template. `surface` used to be read off whichever one
  // was selected, and every design system ships as `email` to avoid device
  // chrome — so choosing a system silently forced a 600×720 email frame and
  // there was no way to build a mobile screen on one. The copy called the
  // template optional; the code did not.
  const [pick, setPick] = useState<WireDesign | null>(null)
  const [styleId, setStyleId] = useState<string | null>(saved?.styleId ?? null)
  const templateStyle = templates.find(d => d.id === styleId && isDesignSystem(d)) ?? null
  const styleTokens = templateStyle ? resolveTokens(templateStyle, byId) : undefined
  const missingStyle = !!styleId && (!templateStyle || !styleTokens)
  const [surface, setSurface] = useState<'mobile' | 'web' | 'email'>(saved?.surface ?? 'mobile')
  const [title, setTitle] = useState(saved?.title ?? '')
  const [brief, setBrief] = useState(saved?.brief ?? '')
  const [screens, setScreens] = useState(saved?.screens ?? 1)
  const [draft, setDraft] = useState<GeneratedDesign | null>(saved?.generated ?? null)
  const [turns, setTurns] = useState<string[]>(saved?.turns ?? [])
  const [refine, setRefine] = useState('')
  const [operation, setOperation] = useState<'generate' | 'refine' | 'file' | null>(null)
  const busy = operation !== null
  const [err, setErr] = useState<{ code?: string; message: string } | null>(null)

  // The template the draft was citing, held as an id until the list arrives —
  // a draft restores before the templates it points at have loaded.
  const [wantPick, setWantPick] = useState<string | null>(saved?.pickId ?? null)
  const [restored, setRestored] = useState<string | null>(saved?.at ?? null)

  /** The banner reports when the restored draft was last saved, so it stops
   *  being true the moment anything changes. */
  const touch = () => { if (restored) setRestored(null) }

  // Re-resolved rather than restored: storing the template whole would pin a
  // copy of one that has since changed, which is the drift the citation exists
  // to prevent. A template that has been deleted simply never resolves, and
  // `wantPick` keeps the intent so saving does not quietly drop it.
  useEffect(() => {
    if (!wantPick) return
    const t = templates.find(x => x.id === wantPick)
    if (t) { setPick(t); setWantPick(null) }
  }, [wantPick, templates])

  // Written on every change rather than debounced. The panel already re-renders
  // per keystroke and a spec is a few kilobytes, so the timer would cost more in
  // the flush-on-unmount it needs than it saves. The first pass rewrites what
  // was just read, which moves the draft's age to now: opening the panel counts
  // as touching it, and the banner reports the age it was restored at.
  useEffect(() => {
    saveDraft({ mode, brief, title, surface, screens,
                pickId: pick?.id ?? wantPick, styleId, turns, generated: draft })
  }, [mode, brief, title, surface, screens, pick, wantPick, styleId, turns, draft])

  const fail = (e: unknown) => setErr(
    e instanceof GatewayError ? { code: e.code, message: e.message }
                              : { message: e instanceof Error ? e.message : String(e) })

  const generate = async () => {
    if (!brief.trim() || busy) return
    touch()
    // Keep the last successful result until its replacement has arrived. The
    // autosave effect would otherwise persist the deletion even on a failure.
    setOperation('generate'); setErr(null)
    try {
      setDraft(await generateDesign({
        brief: brief.trim(),
        surface,
        cites: pick?.id,
        screens,
      }))
      setTurns([brief.trim()])
    } catch (e) { fail(e) } finally { setOperation(null) }
  }

  /** A follow-up carries the current spec, so "make the CTA secondary" has
   *  something to be a change TO. Every turn returns a whole spec — a patch
   *  would need the model and the client to agree on how to apply it. */
  const refineIt = async () => {
    if (!draft || !refine.trim() || busy) return
    touch()
    setOperation('refine'); setErr(null)
    try {
      const next = await generateDesign({
        brief: refine.trim(), surface: draft.surface,
        cites: pick?.id, base: draft.spec,
      })
      setDraft(next); setTurns(t => [...t, refine.trim()]); setRefine('')
    } catch (e) { fail(e) } finally { setOperation(null) }
  }

  const fileIt = async (d: { title: string; surface: string; spec: unknown
                             cites: string[]; generatedBy?: string | null }) => {
    if (busy) return
    setOperation('file'); setErr(null)
    try {
      const made = await proposeDesign({
        title: d.title, surface: d.surface, state: 'draft', cites: d.cites,
        spec: d.spec, generated_by: d.generatedBy ?? null,
        // The object id is derived from this key, so a key that repeats is an
        // id that repeats: the insert no-ops and the caller is told it worked.
        // Two designs with one name on one template is an ordinary thing to do.
        idempotencyKey: `design:${d.title.toLowerCase()}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      })
      if (!made.created) {
        setErr({ message: 'Something already exists at that id, so nothing was written. '
                          + 'Rename it and file again.' })
        return
      }
      // Filed, so there is nothing left unfiled. Cleared here rather than by
      // the save effect, which would write the emptied panel back a render later
      // and works only because every field happens to be reset above.
      clearDraft()
      setDraft(null); setBrief(''); setTitle(''); setTurns([]); setRestored(null)
      onMade(made.id)
    } catch (e) { fail(e) } finally { setOperation(null) }
  }

  const fromTemplate = () => {
    if (!pick || isDesignSystem(pick) || !pick.spec.screens.length || !title.trim() || missingStyle) return
    return fileIt({ title: title.trim(), surface: pick.surface,
                    spec: { screens: pick.spec.screens },
                    // The system comes first: the existing ordered token lookup
                    // resolves its palette while retaining the layout's provenance.
                    cites: templateStyle ? [templateStyle.id, pick.id] : [pick.id] })
  }

  return (
    <div className="card addpanel">
      {/* Cancel belongs to the panel. It was a pill up in the page header, the
          same shape as the filters, beside a sentence about filing — page
          furniture rather than this panel's control. */}
      <div className="addpanel-head">
        <b>New design</b>
        <span className="hint">Nothing is saved until you choose to.</span>
        <button className="tool" onClick={onCancel}>Cancel</button>
      </div>
      {restored && (
        <div className="dresume">
          <b>Picked up where you left off.</b>
          <span className="hint">
            saved {ago(restored)} · stored in this browser
          </span>
          <button className="tool" onClick={() => {
            clearDraft(); setRestored(null); setDraft(null); setTurns([])
            setBrief(''); setTitle(''); setPick(null); setWantPick(null); setStyleId(null)
            // Including the three it used to leave behind, which is how
            // starting over left you in the abandoned draft's mode, on its
            // surface, asking for its number of screens.
            setMode('brief'); setSurface('mobile'); setScreens(1)
          }}>Start over</button>
        </div>
      )}
      <div className="dmode">
        <button className={`tool${mode === 'brief' ? ' on' : ''}`}
                aria-pressed={mode === 'brief'} disabled={busy}
                onClick={() => { touch(); setMode('brief') }}>Describe it</button>
        <button className={`tool${mode === 'template' ? ' on' : ''}`}
                aria-pressed={mode === 'template'} disabled={busy}
                onClick={() => { touch(); setMode('template') }}>From a template</button>
        <span className="p-filter-note">
          {mode === 'brief'
            ? 'Describe a flow, choose a style, and review the result before saving.'
            : 'Start with an editable layout. No AI provider required.'}
        </span>
      </div>

      {/* One question at a time, in the order you would answer them: what it
          is, what frame it goes in, what it looks like — then Generate, last,
          under everything it uses. Generate used to sit above the style
          choices, so the page asked for the style after the button that
          consumed it. */}
      {mode === 'brief' && (
        <>
          <label className="fld dbrief-label" htmlFor="dbrief"><span>What should it show?</span></label>
          <textarea id="dbrief" className="askbar-note" rows={3} value={brief}
                    onChange={e => { touch(); setBrief(e.target.value) }}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate() }}
                    placeholder="A settings screen with notification toggles, a signed-in header, and a destructive Delete account row at the bottom." />
          <p className="hint dbrief-tip">Name the states and the real copy, and you get a screen somebody can judge.</p>
          <div className="dmode dbrief-frame">
            <span className="fld"><span>Surface</span></span>
            {(['mobile', 'web', 'email'] as const).map(sf => (
              <button key={sf} className={`tool${surface === sf ? ' on' : ''}`} aria-pressed={surface === sf}
                      onClick={() => { touch(); setSurface(sf) }}>{sf}</button>
            ))}
            <label className="fld dbrief-screens"><span>Screens</span>
              <input type="number" min={1} max={6} value={screens}
                     onChange={e => { touch()
                       setScreens(Math.max(1, Math.min(6, Number(e.target.value) || 1))) }} />
            </label>
          </div>
        </>
      )}

      <DesignTemplatePicker templates={templates} selected={pick} mode={mode} disabled={busy}
        styleId={styleId} onStylePick={id => { touch(); setStyleId(id) }}
        tokensFor={design => resolveTokens(design, byId)} onPick={design => {
          touch(); setWantPick(null); setPick(current => current?.id === design.id ? null : design)
        }} />

      {mode === 'brief' && (
        <div className="dbrief-go">
          <span className="hint">⌘↵ to generate · you review it before anything is saved</span>
          <button className="btn action" onClick={generate}
                  disabled={!brief.trim() || busy}>
            {operation === 'generate' ? 'Designing…' : draft ? 'Try again' : 'Generate'}
          </button>
        </div>
      )}

      {mode === 'template' && <div className="dtemplate-create">
        <div>
          <h3>4. Name your design</h3>
          <p className="hint">{pick && !isDesignSystem(pick)
            ? `Your layout is a separate draft. Colours and typography stay linked to ${templateStyle?.title ?? 'the template'}.`
            : 'Choose a starter layout above to continue. Design systems supply styles, not app screens.'}</p>
          {missingStyle && <p className="p-warn" role="alert">Your saved style is no longer available.
            Choose another design system or select Original style before creating.</p>}
        </div>
        <div className="dtemplate-create-row">
          <label className="fld">
            <span>Design name</span>
            <input className="dsearch" value={title} disabled={busy}
              onChange={e => { touch(); setTitle(e.target.value) }}
              placeholder={pick && !isDesignSystem(pick) ? `${pick.surface} design — name it` : 'name it'}
              onKeyDown={e => { if (e.key === 'Enter') fromTemplate() }} />
          </label>
          <button className="btn action" onClick={fromTemplate}
            disabled={!pick || isDesignSystem(pick) || !pick.spec.screens.length || !title.trim() || missingStyle || busy}>
            {operation === 'file' ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>}

      {err && (
        <div className={err.code === 'model_unconfigured' ? 'dsetup' : 'p-warn'}
             style={{ marginTop: 12 }}>
          {err.code === 'model_unconfigured'
            ? <>
                <b>No model provider is configured.</b> The platform holds no key of
                its own — the org brings one. Set these on the gateway and restart it:
                <pre className="dsetup-env">{`COMMONINDEX_MODEL_PROVIDER=anthropic
COMMONINDEX_MODEL_API_KEY=sk-ant-…
COMMONINDEX_MODEL_ID=claude-opus-5        # optional
COMMONINDEX_MODEL_BASE_URL=…              # optional, for a self-hosted model`}</pre>
                Everything else on this page works without it — templates, filing and
                review need no model at all.
              </>
            : err.message}
        </div>
      )}

      {draft && (
        <div className="ddraft">
          <div className="section-label" style={{ marginTop: 18 }}>
            Proposed <span className="hint">
              not saved yet · {draft.usage.input_tokens + draft.usage.output_tokens} tokens
              {draft.grounded_in && <> · built on {draft.grounded_in}</>}
            </span>
          </div>
          {draft.rationale && <div className="fvals-note">{draft.rationale}</div>}
          <div className="dgrid" style={{ margin: '12px 0' }}>
            {draft.spec.screens.map(sc => (
              <DesignScreenView key={sc.id} screen={sc}
                                tokens={resolveTokens({ ...draft, id: '__unfiled__' }, byId) ?? {}}
                                surface={draft.surface} width={220} maxHeight={276} />
            ))}
          </div>
          <div className="dturns">
            {turns.map((t, i) => (
              <span key={i} className="dturn"><span className="n">{i + 1}</span>{t}</span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0 14px' }}>
            <input className="askbar-note" style={{ minHeight: 0, height: 38, flex: 1 }}
                   value={refine} onChange={e => setRefine(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') refineIt() }}
                   placeholder="Change something — make the CTA secondary, add an empty state, tighten the spacing" />
            <button className="btn ghost" onClick={refineIt}
                    disabled={!refine.trim() || busy}>
              {operation === 'refine' ? 'Applying…' : 'Refine'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <b style={{ flex: 1 }}>{draft.title}</b>
            <button className="tool" disabled={busy} onClick={() => {
              touch(); setDraft(null); setTurns([])
            }}>Discard</button>
            <button className="btn action" disabled={busy}
                    onClick={() => fileIt({ title: draft.title, surface: draft.surface,
                                            spec: draft.spec, cites: draft.cites,
                                            generatedBy: draft.generated_by })}>
              {operation === 'file' ? 'Saving…' : 'Save this design'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


export function DesignsView() {
  const navigate = useNavigate()
  const galleryId = useId()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [all, setAll] = useState<WireDesign[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [collection, setCollection] = useState<DesignCollection>('designs')
  const [surface, setSurface] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [state, setState] = useState('all')
  const [sort, setSort] = useState<DesignSort>('updated')
  const [adding, setAdding] = useState(false)

  // Keep the full catalogue for token resolution, even when a tab hides systems.
  const reload = () => {
    setErr(null); setAll(null)
    listDesigns({ preview: true })
      .then(r => setAll(r.designs))
      .catch(e => { setAll([]); setErr(e instanceof Error ? e.message : String(e)) })
  }
  useEffect(() => { reload() }, [])

  const collections: { id: DesignCollection; label: string }[] = [
    { id: 'designs', label: 'Designs' },
    { id: 'starters', label: 'Starters' },
    { id: 'systems', label: 'Design systems' },
  ]
  const label = collections.find(item => item.id === collection)!.label
  const byId = new Map((all ?? []).map(d => [d.id, d]))
  const templates = (all ?? []).filter(d => d.state === 'approved')
  const counts = { designs: 0, starters: 0, systems: 0 }
  for (const design of all ?? []) counts[designCollection(design)]++
  const members = (all ?? []).filter(d => designCollection(d) === collection)
  const term = query.trim().toLowerCase()
  const filtered = !!term || (collection !== 'systems' && surface !== 'all') || state !== 'all'
  const clearFilters = () => { setQuery(''); setSurface('all'); setState('all') }
  const changeCollection = (next: DesignCollection) => {
    if (next === collection) return
    setCollection(next); clearFilters()
  }
  const designs = all === null ? null : sortDesigns(members.filter(d =>
    (collection === 'systems' || surface === 'all' || d.surface === surface)
    && (state === 'all' || (d.state ?? 'draft') === state)
    && (!term || [d.title, d.description, d.key, ...(d.screen_names ?? (d.spec?.screens ?? []).map(s => s.name)),
      ...(d.cites ?? []).map(id => byId.get(id)?.title ?? id)]
      .some(value => value?.toLowerCase().includes(term)))), sort)

  return (
    <div className="collection design-collection workspace-collection">
      <div className="dgallery-scroll">
      <div className="dgallery-shell">
        <div className="coll-head dgallery-header">
          <div>
            <h1 className="coll-title">Designs {all === null && <span className="total">Loading…</span>}</h1>
            <div className="coll-sub">Create and review designs connected to your enterprise context.</div>
            <details className="dgallery-help">
              <summary>How it works</summary>
              <p>Designs are editable screen specs you can compare, propose, and review.
                Starters copy a layout into a new draft; colours and typography stay linked to
                the design system it cites. “On system” means every element’s token reference
                resolves in its design system; it is not a visual review.</p>
            </details>
          </div>
          {!adding && <button className="btn action" onClick={() => setAdding(true)}>+ New design</button>}
        </div>

        {adding ? (
          <NewDesign templates={templates} byId={byId} onCancel={() => setAdding(false)}
            onMade={id => { setAdding(false); navigate(`/designs/${encodeURIComponent(id)}`) }} />
        ) : (
          <>
            <div className="dgallery-tabs" role="tablist" aria-label="Design collections">
              {collections.map((item, index) => <button key={item.id} role="tab" type="button"
                id={`${galleryId}-${item.id}`} aria-label={item.label}
                aria-selected={collection === item.id} aria-controls={`${galleryId}-panel`}
                tabIndex={collection === item.id ? 0 : -1}
                ref={node => { tabRefs.current[index] = node }}
                onClick={() => changeCollection(item.id)}
                onKeyDown={event => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % collections.length
                    : event.key === 'ArrowLeft' ? (index + collections.length - 1) % collections.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? collections.length - 1 : null
                  if (next === null) return
                  event.preventDefault(); changeCollection(collections[next].id); tabRefs.current[next]?.focus()
                }}>
                {item.label}<span className="count" aria-hidden="true">{counts[item.id]}</span>
              </button>)}
            </div>
            <div role="tabpanel" id={`${galleryId}-panel`} aria-labelledby={`${galleryId}-${collection}`}>
              <div className="coll-tools dgallery-tools">
                {collection !== 'systems' && <div className="dgallery-surfaces" role="group" aria-label="Design surface">
                  {SURFACES.map(s => <button key={s} className={`tool${surface === s ? ' on' : ''}`}
                    aria-pressed={surface === s} onClick={() => setSurface(s)}>{s}</button>)}
                </div>}
                <div className="dgallery-filters" role="group" aria-label="Design filters">
                  <input type="search" className="dsearch dgallery-search" aria-label={`Search ${label.toLowerCase()}`}
                    placeholder={collection === 'systems' ? 'Search design systems…' : collection === 'starters' ? 'Search starter layouts…' : 'Search designs or screens…'}
                    value={query} onChange={e => setQuery(e.target.value)} />
                  <div className="dgallery-status" data-state={state}>
                    <span className="dgallery-status-dot" aria-hidden="true" />
                    <select className="dsearch dgallery-state" aria-label="Design status" value={state}
                      onChange={e => setState(e.target.value)}>
                      <option value="all">All statuses</option>
                      {['draft', 'review', 'approved', 'superseded'].map(s =>
                        <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                    </select>
                    <svg className="dgallery-status-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <select className="dsearch dgallery-sort" aria-label="Sort designs" value={sort}
                    onChange={e => setSort(e.target.value as DesignSort)}>
                    <option value="updated">Recently updated</option>
                    <option value="name">Name A–Z</option>
                  </select>
                </div>
              </div>
              <div className="dgallery-results">
                <span role="status" aria-live="polite">{all !== null && (filtered
                  ? `${designs?.length ?? 0} of ${members.length} ${label.toLowerCase()}`
                  : collection === 'designs' ? 'Your team’s designs'
                    : collection === 'starters' ? 'Reusable layouts to start from' : 'Shared colours and typography')}</span>
                {filtered && <button className="linkbtn" onClick={clearFilters}>Clear filters</button>}
              </div>
              {err && <div className="empty" role="alert"><b>Could not reach the gateway.</b> {err}
                {' '}<button className="tool" onClick={reload}>Retry</button>
              </div>}
              {designs === null && <><p className="dash-sr-only" role="status">Loading designs…</p>
                <div className="dgrid dgallery-grid" aria-hidden="true">{Array.from({ length: 4 }, (_, i) =>
                  <div key={i} className="dash-card-skeleton"><div /><span /><span /></div>)}</div></>}
              {designs !== null && designs.length === 0 && !err && <div className="empty dgallery-empty">
                {filtered ? <>
                  No {label.toLowerCase()} match these filters.{' '}
                  <button className="tool" onClick={clearFilters}>Show all {label.toLowerCase()}</button>
                </> : collection === 'designs' ? <>
                  <b>No designs yet.</b><p>Create a design from a brief, or browse starters for an editable layout.</p>
                  <button className="btn action" onClick={() => setAdding(true)}>Create a design</button>
                  {counts.starters > 0 && <button className="tool" onClick={() => changeCollection('starters')}>Browse starters</button>}
                </> : collection === 'starters' ? <>
                  <b>No starters yet.</b><p>Reusable starter layouts will appear here. You can still create a design from a brief.</p>
                </> : <>
                  <b>No design systems yet.</b><p>Shared design-token systems will appear here.</p>
                </>}
              </div>}
              <div className="dgrid dgallery-grid">
                {(designs ?? []).map(d => <DesignGalleryCard key={d.id} design={d}
                  tokens={resolveTokens(d, byId)}
                  builtOn={d.cites?.length ? byId.get(d.cites[0])?.title ?? d.cites[0] : undefined} />)}
              </div>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  )
}

export function DesignDetail() {
  const { id } = useParams()
  // Detail-to-detail navigation must not carry one design's held patches,
  // selections or prompts into another design with the same element paths.
  return <DesignEditor key={id} id={id} />
}

function DesignEditor({ id }: { id?: string }) {
  const [design, setDesign] = useState<WireDesign | null | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [resolvedTokens, setResolvedTokens] = useState<DesignTokens | undefined>(undefined)
  // Whether the palette has been worked out yet, which `resolvedTokens` alone
  // cannot say: undefined is both "still following the citations" and "there is
  // no palette". Counting a citation as verified during the first is honest;
  // during the second it is the bug this whole change is about, one level up.
  const [palReady, setPalReady] = useState(false)
  const [tokenSource, setTokenSource] = useState<WireDesign | null>(null)
  const [unresolved, setUnresolved] = useState<string[]>([])
  const [history, setHistory] = useState<DesignRevision[]>([])
  const [refine, setRefine] = useState('')
  const [busy, setBusy] = useState(false)
  const [workErr, setWorkErr] = useState<string | null>(null)
  const [sel, setSel] = useState<{ screen: string; path: Path } | undefined>()
  const [railTab, setRailTab] = useState<InspectorTab>('layers')
  const [aiScope, setAiScope] = useState<'design' | 'element'>('design')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiProposal, setAiProposal] = useState<AIProposal | null>(null)
  // Focus hides the app's own sidebar while editing. At 1440px the sidebar and
  // the inspector left the canvas about 770px. Remembered per viewer; the
  // class never outlives this page.
  const [focus, setFocus] = useState(() => {
    try { return localStorage.getItem('designs.focus') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('designs.focus', focus ? '1' : '0') } catch { /* private mode */ }
    document.body.classList.toggle('design-focus', focus)
    return () => document.body.classList.remove('design-focus')
  }, [focus])
  const editingLocked = busy || !!aiProposal
  const aiPrompt = useRef<HTMLTextAreaElement>(null)
  const [revealRequest, setRevealRequest] = useState<{ screen: string; path: Path } | null>(null)
  const [currentScreen, setCurrentScreen] = useState<string>()
  const [overview, setOverview] = useState(false)
  const [zoom, setZoom] = useState<CanvasZoom>('screen')
  const viewport = useRef<HTMLDivElement>(null)
  const [canvasH, setCanvasH] = useState(520)
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const measure = () => { if (node.clientHeight) setCanvasH(Math.max(140, node.clientHeight - 48)) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [design?.id])
  const [refs, setRefs] = useState<DesignReference[]>([])
  const [stale, setStale] = useState(false)
  const [addRef, setAddRef] = useState('')
  const [allHistory, setAllHistory] = useState(false)
  const [stashes, setStashes] = useState<Stash[]>([])
  const [newRole, setNewRole] = useState<string>('body')
  /** The role armed on the toolbar. Null is the pointer — select and drag. */
  const [tool, setTool] = useState<DesignElement['role'] | null>(null)
  /** The screen being played, and how we got there.
   *
   *  `goto` has been on the type since the first commit, describing itself as
   *  "how a prototype is click-through without a line of model-written
   *  JavaScript" — and nothing in the product ever navigated, because the only
   *  place a design is interactive is the editor, where a click has to mean
   *  select or a nav button could never be edited at all. So: a mode. */
  const [playing, setPlaying] = useState<string | null>(null)
  const [trail, setTrail] = useState<string[]>([])
  const [lostScreen, setLostScreen] = useState<string | null>(null)

  // A screen is drawn at a fixed pixel size and then scaled, so the scale has
  // to be computed from a real width. Hard-coding one made a 1280px artboard
  // overflow its column on a laptop and clip on both sides; the column is
  // measured instead, and the drawing fits whatever is left after the rail.
  const canvas = useRef<HTMLDivElement>(null)
  const [canvasW, setCanvasW] = useState(820)
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const ro = new ResizeObserver(([entry]) => setCanvasW(Math.max(260, entry.contentRect.width)))
    ro.observe(node)
    return () => ro.disconnect()
    // Keyed on the design rather than on mount: until it has loaded this page
    // returns early, so on the first pass there is no canvas to observe and the
    // artboard kept the fallback width — which is how it came to overflow.
  }, [design?.id])

  useEffect(() => {
    setDesign(undefined); setErr(null)
    getDesign(id ?? '')
      .then(r => setDesign(r.design))
      .catch(e => { setDesign(null); setErr(e instanceof Error ? e.message : String(e)) })
  }, [id])

  const loadHistory = (id: string) =>
    designHistory(id).then(r => setHistory(r.revisions)).catch(() => setHistory([]))

  const loadRefs = (did: string) =>
    designReferences(did).then(r => { setRefs(r.references); setStale(r.stale) })
      .catch(() => { setRefs([]); setStale(false) })

  useEffect(() => { if (id) { loadHistory(id); loadRefs(id) } }, [id])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      if (document.querySelector('.dleave-dialog')) return
      const command = e.metaKey || e.ctrlKey
      if (aiProposal) {
        // A keyboard save must never bypass explicit acceptance.
        if (command && e.key.toLowerCase() === 's') e.preventDefault()
        return
      }
      // Save works from the inspector's text fields too, without opening the
      // browser's Save Page dialog. Repeated keydown must not create revisions.
      if (command && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!busy && !e.repeat) saveAll()
        return
      }
      // Not while typing in the panel, where Escape means "leave this field".
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      // Nor from anywhere in the inspector. Clicking a colour swatch leaves
      // focus on that button, and Backspace then deleted the element you were
      // in the middle of recolouring.
      // `closest` guarded: a key event can be targeted at the window, which is
      // not an element and has no such method — and an exception here takes
      // Escape and Delete down with it.
      if (typeof t?.closest === 'function' && t.closest('.dedit-rail')) return
      if (e.key === 'Escape' && playing) { setPlaying(null); return }
      if (e.key === 'Escape') {
        // Putting the tool down first: pressing Escape with one armed means
        // "stop drawing", not "deselect whatever was selected before I armed it".
        if (tool) { setTool(null); return }
        select(undefined)
        return
      }
      if (playing) return
      if (command && e.key.toLowerCase() === 'd' && sel) {
        e.preventDefault()
        if (!busy && !e.repeat) duplicateEl()
        return
      }
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      }
      const direction = delta[e.key]
      if (direction && selected && sel && placed && !busy && !tool && !command && !e.altKey) {
        // Leave normal keyboard navigation on toolbar buttons alone.
        if (typeof t?.closest === 'function' && t.closest('button, a') && !t.closest('[data-path]')) return
        const frame = design?.spec.screens.find(screen => screen.id === sel.screen)
        if (!frame) return
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        setDraftEl(draft => ({ ...draft,
          ...gesturePatch({ ...selected, ...draft }, 'move', direction[0] * step, direction[1] * step, frame),
        }))
        return
      }
      // In a row or column the layout places an element, so x/y would take it
      // out of the row. Arrows shift it from where the layout put it, by a
      // pixel (Shift: ten), the way they nudge a placed element: "move it
      // slightly to the left". Alt+arrow moves it one place among its
      // neighbours, as dragging does.
      if (direction && selected && sel && !placed && sel.path.length > 1 && !busy && !tool && !command
          && !editingLocked) {
        if (typeof t?.closest === 'function' && t.closest('button, a, input, textarea, select, [contenteditable]') && !t.closest('[data-path]')) return
        e.preventDefault()
        if (!e.altKey) {
          const step = e.shiftKey ? 10 : 1
          setDraftEl(draft => {
            const now = { ...selected, ...draft }
            return { ...draft,
              dx: (now.dx ?? 0) + direction[0] * step || undefined,
              dy: (now.dy ?? 0) + direction[1] * step || undefined }
          })
          return
        }
        if (e.repeat || unsaved) return
        const parent = sel.path.slice(0, -1)
        const from = sel.path[sel.path.length - 1]
        const earlier = direction[0] < 0 || direction[1] < 0
        if (earlier && from === 0) return
        reorderEl(sel.screen, parent, from, earlier ? from - 1 : from + 2, `move ${selected.id}`)
        return
      }
      // The obvious way to delete something, and it did nothing at all: the
      // only way to remove an element was a button in the other column.
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !busy) {
        e.preventDefault()
        removeEl()
        return
      }
      // The page header says every change is a revision and anything can be
      // undone, which was true and three scrolls away in the history list.
      // ⌘Z reverts the pending edit if there is one, and otherwise restores the
      // revision before this one — itself recorded, like every other way back.
      if (command && !e.shiftKey && e.key.toLowerCase() === 'z' && !busy) {
        e.preventDefault()
        if (unsaved) { setDraftEl(mirrored); return }
        const back = history[1]
        if (back?.spec || back?.has_spec) restore(back)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
    // Re-subscribed every render: the handler reads the pending edit, and one
    // installed once would go on seeing the panel as it was at mount — which
    // is exactly how Escape came to bypass the guard.
  })

  /** Every write goes through here: revise, re-read, refresh the history. The
   *  re-read is not optional — the object is the record, and trusting a local
   *  copy after a write is how a page starts disagreeing with what it shows. */
  const write = async (patch: Parameters<typeof reviseDesign>[0], acceptingAI = false) => {
    if (busy || (aiProposal && !acceptingAI)) return false
    setBusy(true); setWorkErr(null)
    try {
      // Against the revision this page is holding. Two tabs on one design used
      // to overwrite each other without a word, because each posted the whole
      // spec built from the copy it had read.
      await reviseDesign({ if_rev: design?.current_rev, ...patch })
      const fresh = await getDesign(patch.design_id)
      setDesign(fresh.design)
      await Promise.all([loadHistory(patch.design_id), loadRefs(patch.design_id)])
      return true
    } catch (e) {
      setWorkErr(e instanceof GatewayError ? e.message
                 : e instanceof Error ? e.message : String(e))
      // Refused because somebody else got there first. Show what is actually
      // stored now, so the next attempt is made against that rather than
      // against a copy that has been overtaken.
      if (e instanceof GatewayError && e.code === 'stale_revision') {
        try {
          // Refreshing replaces the inspector's mirror too. Set the pending
          // change aside first so a conflict cannot erase the user's work.
          select(undefined)
          const fresh = await getDesign(patch.design_id)
          setDesign(fresh.design)
          await Promise.all([loadHistory(patch.design_id), loadRefs(patch.design_id)])
        } catch { /* the message already says what happened */ }
      }
      return false
    } finally { setBusy(false) }
  }

  const restore = async (h: DesignRevision) => {
    if (!design || editingLocked || !(h.spec || h.has_spec)) return
    setBusy(true); setWorkErr(null)
    try {
      // The list carries no specs; the one being restored is fetched now.
      const spec = h.spec ?? (await designHistory(design.id, h.rev)).revisions[0]?.spec
      if (!spec) throw new Error(`Revision ${h.rev} could not be read.`)
      // `if_rev` like every other write. This was the one that skipped it —
      // and it is the one that replaces the WHOLE spec with an older one, so
      // it had the most to destroy when two people had the design open.
      await reviseDesign({ design_id: design.id, if_rev: design.current_rev,
                           spec, note: `restore rev ${h.rev}` })
      const fresh = await getDesign(design.id)
      setDesign(fresh.design); await loadHistory(design.id)
    } catch (e) {
      setWorkErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const selected = design && sel
    ? elementAt(design.spec, sel.screen, sel.path) : undefined
  /** Placed absolutely, so it has coordinates to drag. A child of a container
   *  does not: its position belongs to the container. */
  const placed = selected?.x !== undefined && selected?.y !== undefined
  /** Whether this selection can take a child at all: a laying-out role, at the
   *  top level, since the type nests exactly one deep. */
  const canHold = !!selected && HOLDS.has(selected.role) && (sel?.path.length ?? 0) === 1
  /** What the selection sits inside, when it sits inside anything. */
  const parentOf = design && sel && sel.path.length > 1
    ? elementAt(design.spec, sel.screen, sel.path.slice(0, -1)) : undefined
  const [draftEl, setDraftEl] = useState<Partial<DesignElement>>({})
  const [elBrief, setElBrief] = useState('')

  // Reloaded whenever the element under the selection changes, by value.
  //
  // It used to key on `design.current_rev`, which `designs.get` does not return
  // — so it was always undefined and never changed. After "Change this", a
  // restore, or a refine, the panel went on showing the values from before,
  // and saving a tone wrote the old text back over the new one. A drag makes
  // that constant: every gesture writes a revision and re-reads the design.
  const mirror = JSON.stringify(selected ?? null)
  const selectionKey = sel ? keyOf(sel) : ''
  const mirrored: Partial<DesignElement> = selected
    // `color` included. Left out, the rail showed the ROLE as the active choice
    // for an element whose colour is a named token — the headline feature
    // misreporting its own state one render after you used it.
    ? { text: selected.text, tone: selected.tone, color: selected.color,
        cites: selected.cites, textStyle: selected.textStyle, fontSize: selected.fontSize,
        fontWeight: selected.fontWeight, lineHeight: selected.lineHeight, textAlign: selected.textAlign,
        x: selected.x, y: selected.y, w: selected.w, h: selected.h,
        gap: selected.gap, pad: selected.pad, align: selected.align,
        layout: selected.layout, goto: selected.goto, src: selected.src }
    : {}
  useEffect(() => {
    // Resume the held fields when revisiting a layer. Otherwise a later edit
    // on that layer replaced its earlier held patch with the saved values.
    const held = sel && selected ? stashes.find(value => keyOf(value) === selectionKey && value.label === selected.id) : undefined
    setDraftEl({ ...mirrored, ...held?.patch })
    if (held) setStashes(values => values.filter(value => value !== held))
    setElBrief('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror, selectionKey])

  /** The fields the panel has changed, and only those.
   *
   *  Compared against the element rather than collected as they are typed, so
   *  clearing a field previews as cleared: `{ w: undefined }` is a real edit,
   *  and dropping it because the value is undefined would make "unset this" the
   *  one change you could not see before saving. */
  const pending: Partial<DesignElement> = {}
  if (selected) {
    for (const k of Object.keys(draftEl) as (keyof DesignElement)[]) {
      if (draftEl[k] !== selected[k]) Object.assign(pending, { [k]: draftEl[k] })
    }
  }
  const unsaved = Object.keys(pending).length > 0
  const hasPending = unsaved || stashes.length > 0
  const preview = sel && unsaved ? { path: sel.path, patch: pending } : null

  useEffect(() => {
    if (!hasPending && !busy && !aiProposal) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasPending, busy, aiProposal])

  /** The one way to change or clear the selection.
   *
   *  Leaving an element used to throw away whatever you had typed and not
   *  saved, and the live preview made that worse: the change was on the screen
   *  right up until it was gone. The first version of this guarded ONE of the
   *  four ways out — a different path on the same screen — and missed the same
   *  path on another screen, Escape, and clicking past the artboard, each of
   *  which called `setSel` directly. Every one of them comes through here now,
   *  which is the only reason the guard can be relied on.
   *
   *  It also holds more than one: the first version kept a single slot, so a
   *  second unsaved edit silently replaced the first one waiting to be saved.
   */
  const select = (next: { screen: string; path: Path } | undefined) => {
    if (editingLocked) return
    if (unsaved && sel && selected && (!next || keyOf(sel) !== keyOf(next))) {
      const k = keyOf(sel)
      const held: Stash = { screen: sel.screen, path: sel.path, patch: pending,
                            label: selected.id }
      // Keyed, so returning to an element and editing it again replaces its own
      // held edit rather than queueing a second one against the same box.
      setStashes(list => [...list.filter(x => keyOf(x) !== k), held])
    }
    if (next) { setRailTab('properties'); setAiScope('element'); setCurrentScreen(next.screen) }
    setRevealRequest(null)
    setSel(next)
  }

  const focusElement = (next: { screen: string; path: Path }) => {
    if (editingLocked || playing) return
    setTool(null); select(next); setOverview(false); setCurrentScreen(next.screen)
    setRevealRequest(next)
  }
  useEffect(() => {
    if (revealRequest && viewport.current) revealCanvasElement(viewport.current, revealRequest)
  }, [revealRequest, canvasW, canvasH])
  // Auto-grow when the active scope changes as well as when typing.
  useEffect(() => {
    const node = aiPrompt.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.max(66, Math.min(128, node.scrollHeight))}px`
  }, [refine, elBrief, aiScope, sel, design?.id])

  const saveStash = async (held: Stash) => {
    if (!design || editingLocked) return
    // The path was right when the edit was set aside and may not be now: a
    // delete, a reorder, a restore or a refine all shift the tree underneath a
    // held edit. Checked against the id it was taken from, and re-found by that
    // id if it has moved — otherwise this writes somebody's words onto whatever
    // slid into the slot, and files a note naming the element it did not touch.
    const still = elementAt(design.spec, held.screen, held.path)
    const at = still?.id === held.label
      ? held.path : pathOfId(design.spec, held.screen, held.label)
    if (!at) {
      setWorkErr(`That change was to ${held.label}, which is no longer on `
                 + `${held.screen}. Nothing was written.`)
      return
    }
    const next = patchAt(design.spec, held.screen, at, held.patch)
    const saved = next === design.spec || await write({ design_id: design.id, spec: next,
      note: `edit ${held.label} on ${held.screen}` })
    // A rejected write is still work to recover, not a reason to dismiss it.
    if (saved) setStashes(list => list.filter(x => x !== held))
  }

  const saveElement = () => {
    if (!design || !sel) return
    const next = patchAt(design.spec, sel.screen, sel.path, draftEl)
    if (next === design.spec) return
    return write({ design_id: design.id, spec: next,
                   note: `edit ${selected?.id ?? 'element'} on ${sel.screen}` })
  }

  const saveAll = async () => {
    if (!design || editingLocked) return false
    if (!hasPending) return true
    const held = [...stashes]
    let next: ReturnType<typeof patchAt> = design.spec
    for (const change of held) {
      const still = elementAt(next, change.screen, change.path)
      const path = still?.id === change.label ? change.path : pathOfId(next, change.screen, change.label)
      if (!path) {
        setWorkErr(`Cannot save all: ${change.label} is no longer on ${change.screen}. `
          + 'Discard that held change and try again. No changes were written.')
        return false
      }
      next = patchAt(next, change.screen, path, change.patch)
    }
    // The current inspector wins over an older held edit to the same fields.
    if (sel && unsaved) next = patchAt(next, sel.screen, sel.path, pending)
    const count = held.length + (unsaved ? 1 : 0)
    const saved = next === design.spec || await write({ design_id: design.id, spec: next,
      note: `save ${count} pending change${count === 1 ? '' : 's'}` })
    if (saved) setStashes(list => list.filter(change => !held.includes(change)))
    return saved
  }

  /** A gesture on the artboard: one drag, one revision — and nothing written
   *  when the box lands where it started, because `patchAt` returns the spec it
   *  was given when a patch changes nothing. */
  const editEl = (screen: string, path: Path, patch: Partial<DesignElement>, what: string) => {
    if (!design) return
    // A gesture carries the panel's pending edit with it when they are about the
    // same element. Dragging a box you had just retyped saved the drag and threw
    // the words away, which is a strange thing for a drag to do.
    const withPending = sel && samePath(sel.path, path) && sel.screen === screen
      ? { ...pending, ...patch } : patch
    const next = patchAt(design.spec, screen, path, withPending)
    if (next === design.spec) return
    select({ screen, path })
    // Where it ended up, not just that it moved. Three drags of one button
    // otherwise write three identical lines, and a history that cannot tell its
    // own entries apart is a list rather than a record.
    const where = what.startsWith('resize') ? ` to ${patch.w}×${patch.h}`
                : patch.x !== undefined ? ` to ${patch.x},${patch.y}`
                : 'dx' in patch || 'dy' in patch ? ` by ${patch.dx ?? 0},${patch.dy ?? 0}` : ''
    return write({ design_id: design.id, spec: next, note: `${what}${where} on ${screen}` })
  }

  const reorderEl = (screen: string, parent: Path, from: number, to: number, what: string) => {
    if (!design) return
    const next = reorderAt(design.spec, screen, parent, from, to)
    if (next === design.spec) return
    // Where it ENDED UP, which is not where it was inserted: the splice takes
    // it out before putting it back, so a downward move lands one before the
    // index the drop indicator named. Following the insertion index put the
    // ring and the whole rail on the element after the one you dragged — and
    // one past the end it selected nothing at all.
    select({ screen, path: [...parent, to > from ? to - 1 : to] })
    return write({ design_id: design.id, spec: next, note: `${what} on ${screen}` })
  }

  const removeEl = () => {
    if (!design || !sel || !selected || editingLocked) return
    const next = removeAt(design.spec, sel.screen, sel.path)
    if (next === design.spec) return
    select(undefined)
    return write({ design_id: design.id, spec: next,
                   note: `delete ${selected.id} from ${sel.screen}` })
  }

  /** Inside the selected container when there is one, otherwise on the screen.
   *
   *  A container that had been drawing furniture — a nav's three grey links, a
   *  list's rows — lays out its children instead once it has any, so this is
   *  what turns something painted into something you can hold. */
  const addEl = (inside: boolean) => {
    if (!design || editingLocked) return
    const screen = sel?.screen ?? screens[0]?.id
    if (!screen) return
    const start = STARTING[newRole] ?? { w: 200, h: 40 }
    const parent = inside && sel ? sel.path : null
    const { spec: next, path } = addTo(design.spec, screen, parent, {
      role: newRole as DesignElement['role'],
      text: start.text,
      // A child is laid out by its container, so it is given no coordinates —
      // handing it x and y would take it straight back out of the layout.
      ...(parent ? { w: start.w, h: start.h }
                 : { x: 24, y: 24, w: start.w, h: start.h }),
    })
    if (next === design.spec) return
    select({ screen, path })
    return write({ design_id: design.id, spec: next,
                   note: `add a ${newRole} to ${screen}` })
  }

  /** Put the armed element where it was drawn.
   *
   *  Adding used to mean a dropdown in the rail and a button that dropped
   *  everything at 24,24, so two of anything landed on top of each other and
   *  had to be dragged apart. A tool you arm and draw with puts it where you
   *  meant it, at the size you meant, in one gesture.
   */
  const placeEl = (screen: string, at: { x: number; y: number; w?: number; h?: number }) => {
    if (!design || !tool || editingLocked) return
    const start = STARTING[tool] ?? { w: 200, h: 40 }
    const { spec: next, path } = addTo(design.spec, screen, null, {
      role: tool,
      text: start.text,
      x: at.x, y: at.y,
      w: at.w ?? start.w, h: at.h ?? start.h,
    })
    if (next === design.spec) return
    setTool(null)
    select({ screen, path })
    return write({ design_id: design.id, spec: next,
                   note: `add a ${tool} to ${screen}` })
  }

  /** Screens, which nothing could add or remove — so a design proposed with
   *  none was a dead end nothing in the product could open. */
  const addScreenTo = async () => {
    if (!design || editingLocked) return
    const size = design.surface === 'web' ? { w: 1280, h: 860 }
               : design.surface === 'email' ? { w: 600, h: 720 }
               : { w: 390, h: 844 }
    const next = addScreen(design.spec, size)
    select(undefined)
    const saved = await write({ design_id: design.id, spec: next, note: 'add a screen' })
    if (saved) {
      setCurrentScreen(next.screens[next.screens.length - 1].id)
      setOverview(false)
      viewport.current?.scrollTo?.({ top: 0, left: 0 })
    }
    return saved
  }

  const removeScreenFrom = (screenId: string, name: string) => {
    if (!design || editingLocked) return
    const next = removeScreen(design.spec, screenId)
    if (next === design.spec) return
    if (sel?.screen === screenId) setSel(undefined)
    return write({ design_id: design.id, spec: next, note: `remove ${name}` })
  }

  const renameScreenTo = (screenId: string, name: string) => {
    if (!design || editingLocked || !name.trim()) return
    const next = renameScreen(design.spec, screenId, name.trim())
    if (next === design.spec) return
    return write({ design_id: design.id, spec: next, note: `rename a screen to ${name.trim()}` })
  }

  /** Up and down the stack. Order in the list is paint order. */
  const restack = (by: number) => {
    if (!design || !sel || editingLocked) return
    const { spec: next, path } = restackAt(design.spec, sel.screen, sel.path, by)
    if (next === design.spec) return
    select({ screen: sel.screen, path })
    return write({ design_id: design.id, spec: next,
                   note: `${by > 0 ? 'bring forward' : 'send back'} ${selected?.id ?? ''}`.trim() })
  }

  const startPreview = () => {
    setTool(null); select(undefined); setLostScreen(null); setTrail([])
    setPlaying(activeScreen?.id ?? null)
  }

  const goTo = (from: string, to: string) => {
    if (!screens.some(sc => sc.id === to)) { setLostScreen(to); return }
    setLostScreen(null)
    setTrail(t => [...t, from])
    setPlaying(to); setCurrentScreen(to)
  }

  /** Go to a screen by name rather than by scrolling past the ones before it.
   *
   *  Twenty-five phones is thirteen rows and nearly ten thousand pixels of
   *  page: reaching Step 19 meant scrolling past eighteen others, and while
   *  playing there was no way to skip ahead at all. */
  const jumpTo = (screenId: string) => {
    if (playing) { setLostScreen(null); setTrail(t => [...t, playing]); setPlaying(screenId); setCurrentScreen(screenId); return }
    setCurrentScreen(screenId); setOverview(false)
    viewport.current?.scrollTo?.({ top: 0, left: 0 })
  }

  const navigateScreen = (screenId: string) => {
    if (editingLocked) return
    if (sel && sel.screen !== screenId) select(undefined)
    jumpTo(screenId)
  }


  const goBack = () => {
    setLostScreen(null)
    setTrail(t => {
      const back = t[t.length - 1]
      if (back) { setPlaying(back); setCurrentScreen(back) }
      return t.slice(0, -1)
    })
  }

  const duplicateEl = () => {
    if (!design || !sel || !selected || editingLocked) return
    const { spec: next, path } = duplicateAt(design.spec, sel.screen, sel.path)
    if (next === design.spec) return
    select({ screen: sel.screen, path })
    return write({ design_id: design.id, spec: next,
                   note: `duplicate ${selected.id} on ${sel.screen}` })
  }

  const addReference = () => {
    if (!design || editingLocked || !addRef.trim()) return
    const already = refs.map(r => r.id)
    if (already.includes(addRef.trim())) { setAddRef(''); return }
    const next = [...already, addRef.trim()]
    setAddRef('')
    return write({ design_id: design.id, sources: next,
                   note: `cite ${addRef.trim()}` })
  }

  // Tokens resolve through the citation, which is the point of citing rather
  // than copying: this design carries no palette of its own, and changing the
  // template it cites changes what renders here.
  useEffect(() => {
    setUnresolved([])
    setPalReady(false)
    if (!design) { setResolvedTokens(undefined); setTokenSource(null); return }
    const own = design.spec?.tokens
    if (own && Object.keys(own).length) {
      setResolvedTokens(own); setTokenSource(null); setPalReady(true); return
    }
    const cited = design.cites ?? []
    if (!cited.length) {
      setResolvedTokens(undefined); setTokenSource(null); setPalReady(true); return
    }
    // Follows the chain, not the first step of it. A design cites a template,
    // and that template may itself cite the system the tokens live on — one hop
    // stopped there and reported the readable middle link as unreadable, which
    // is both false and the wrong shape of false: the page then said "cites X —
    // unreadable" and "all on-system" at the same time, on the same palette it
    // had just failed to find.
    let live = true
    ;(async () => {
      const seen = new Set<string>([design.id])
      const queue = [...cited]
      let missed = false
      while (queue.length) {
        const id = queue.shift() as string
        if (seen.has(id)) continue
        seen.add(id)
        try {
          const r = await getDesign(id)
          if (!live) return
          if (r.design.spec?.tokens && Object.keys(r.design.spec.tokens).length) {
            setResolvedTokens(r.design.spec.tokens); setTokenSource(r.design)
            setPalReady(true); return
          }
          queue.push(...(r.design.cites ?? []))
        } catch {
          // A citation that cannot be read is not the same as no citation, and
          // saying "cites nothing" would put a falsehood in the export's
          // provenance. Note it and keep following the rest.
          missed = true
        }
      }
      if (live) {
        setResolvedTokens(undefined); setTokenSource(null)
        setUnresolved(missed ? cited : [])
        // Without this the palette stayed "not worked out yet" forever, and a
        // citation that cannot be checked is taken at its word — so the count
        // claimed every element was on a palette the page had just said it
        // could not read.
        setPalReady(true)
      }
    })()
    return () => { live = false }
  }, [design])

  if (design === undefined) return <div className="detail"><div className="empty">Loading…</div></div>
  if (design === null) {
    return (
      <div className="detail"><div className="empty">
        {err ? <><b>Could not read this design.</b> {err}</> : <>Design not found.</>}
        {' '}<Link to="/designs">Back to the collection.</Link>
      </div></div>
    )
  }

  // `{}` once the palette is known to be empty, which is not the same as not
  // knowing it: you cannot cite an approved token where nothing is approved.
  const palette0 = palReady ? resolvedTokens ?? {} : undefined
  const { on, total, unverified, ownColour } = onSystem(design, palette0)
  const screens = design.spec?.screens ?? []
  const activeScreen = screens.find(screen => screen.id === (playing ?? currentScreen)) ?? screens[0]
  const hint = playing
    ? 'Clicking follows the links. Escape stops.'
    : screens.length === 0
    ? 'This design has no screens to draw on.'
    : tool
      ? `Click a screen to place a ${TOOL_LABELS[tool]}, or drag to draw one. Escape to stop.`
      : selected && sel && !placed && sel.path.length > 1
      ? 'In a row or column: arrows shift it 1px (Shift: 10px); Alt+arrow or dragging changes its place.'
      : 'Pick one and draw it on a screen.'
  const viewWidth = Math.max(200, canvasW - 16)
  const scale = activeScreen ? typeof zoom === 'number' ? zoom
    : designScreenScale(activeScreen, design.surface, viewWidth, zoom === 'screen' ? canvasH : undefined) : 1
  const elementScope = aiScope === 'element' && !!selected
  const aiBrief = elementScope ? elBrief : refine
  const setAiBrief = elementScope ? setElBrief : setRefine
  const proposalOutdated = !!aiProposal && (aiProposal.revision !== design.current_rev
    || designChangeSummary(aiProposal.base, design.spec).hasChanges)
  const applyAI = async () => {
    if (editingLocked || hasPending || playing || !palReady || !aiBrief.trim()) return
    const brief = aiBrief.trim()
    const element = elementScope ? selected?.id : undefined
    setBusy(true); setAiBusy(true); setWorkErr(null); setTool(null)
    try {
      const generated = await generateDesign({
        brief, surface: design.surface, cites: design.cites?.[0], base: design.spec, element,
      })
      // If AI removes an owned palette, resolve the cited palette rather than
      // incorrectly previewing with the tokens it just removed.
      let afterTokens = generated.spec.tokens
      if (!afterTokens || !Object.keys(afterTokens).length) {
        afterTokens = resolvedTokens ?? {}
        if (design.spec.tokens && Object.keys(design.spec.tokens).length) {
          afterTokens = {}
          const queue = [...(design.cites ?? [])], seen = new Set([design.id])
          while (queue.length) {
            const citation = queue.shift()!
            if (seen.has(citation)) continue
            seen.add(citation)
            try {
              const { design: source } = await getDesign(citation)
              if (source.spec.tokens && Object.keys(source.spec.tokens).length) {
                afterTokens = source.spec.tokens; break
              }
              queue.push(...(source.cites ?? []))
            } catch { /* Unreadable citations render with defaults, as in the editor. */ }
          }
        }
      }
      setAiProposal({ generated, base: design.spec, revision: design.current_rev, brief,
        scope: element ? `Element: ${selected?.text || element}` : 'Whole design', element,
        beforeTokens: resolvedTokens ?? {}, afterTokens })
    } catch (error) {
      setWorkErr(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false); setAiBusy(false) }
  }
  const acceptAI = async () => {
    if (!aiProposal || busy || hasPending || proposalOutdated
      || !designChangeSummary(aiProposal.base, aiProposal.generated.spec).hasChanges) return
    const saved = await write({ design_id: design.id, if_rev: aiProposal.revision,
      spec: aiProposal.generated.spec,
      note: aiProposal.element ? `${aiProposal.element}: ${aiProposal.brief}` : aiProposal.brief }, true)
    if (saved) {
      setAiProposal(null); setSel(undefined); setDraftEl({}); setRevealRequest(null)
      if (aiProposal.element) setElBrief('')
      else setRefine('')
      requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true }))
    }
  }
  const discardAI = () => {
    if (busy) return
    setAiProposal(null); setWorkErr(null)
    requestAnimationFrame(() => {
      const target = aiPrompt.current?.closest('[hidden]') ? viewport.current : aiPrompt.current
      target?.focus({ preventScroll: true })
    })
  }

  /** Serialises the drawing already on screen rather than redrawing it. One
   *  renderer, so the file somebody shares is the design somebody approved. */
  const exportHtml = () => {
    if (hasPending || editingLocked || !palReady || playing) return
    const drawn = [...document.querySelectorAll('.detail-screens .dscreen')].map(el => {
      const stage = el.querySelector('[data-stage]') as HTMLElement | null
      // Cloned and stripped, because the editor draws INSIDE the stage: the
      // selection handles and the drop indicator are part of the drawing as far
      // as the serialiser is concerned, and a file with four blue squares on it
      // is a picture of somebody mid-edit rather than the design.
      const clean = stage?.cloneNode(true) as HTMLElement | undefined
      clean?.querySelectorAll('[data-editor]').forEach(n => n.remove())
      // The ring, and the hands. An element carries its own selection outline,
      // so stripping the handles left a blue box around whatever happened to be
      // selected when somebody pressed the button — which the comment above
      // claimed was handled and was not.
      clean?.querySelectorAll('[data-selected]').forEach(n => {
        const x = n as HTMLElement
        x.style.outline = ''
        x.style.outlineOffset = ''
        x.removeAttribute('data-selected')
      })
      clean?.querySelectorAll<HTMLElement>('[data-path]').forEach(n => { n.style.cursor = '' })
      // Links become anchors, laid over the element they belong to. The file
      // has no script — which is the point of it — and an anchor needs none:
      // each screen is a figure with an id, and `goto` names which one.
      clean?.querySelectorAll<HTMLElement>('[data-goto]').forEach(n => {
        const to = n.getAttribute('data-goto')
        n.removeAttribute('data-goto')
        if (!to || !screens.some(sc => sc.id === to)) return
        const a = document.createElement('a')
        a.className = 'goto'
        a.href = `#screen-${to}`
        a.setAttribute('aria-label', `Go to ${screens.find(sc => sc.id === to)?.name ?? to}`)
        for (const k of ['left', 'top', 'width', 'height'] as const) {
          a.style[k] = n.style[k]
        }
        n.parentElement?.insertBefore(a, n.nextSibling)
      })
      // Exported at its natural size and IN FLOW. The stage carries
      // `position:absolute; top:0; left:0` inline, which no stylesheet rule in
      // the file can outrank — so every screen was stacked on the page origin,
      // the last one painted over the rest, and the title and captions were
      // hidden underneath. The scale went and the position stayed.
      if (clean) {
        clean.style.position = 'relative'
        clean.style.top = ''
        clean.style.left = ''
        clean.style.transform = 'none'
      }
      const html = clean?.outerHTML ?? ''
      return { id: el.getAttribute('data-screen-id') ?? '',
               name: el.querySelector('.dscreen-cap b, .dscreen-cap .capname')
                 ?.textContent || (el.querySelector('.capname') as HTMLInputElement)?.value
                 || 'screen',
               html }
    })
    downloadHtml(`${slug(design.title)}.html`, designToHtml(drawn, {
      title: design.title, surface: design.surface, state: design.state ?? 'draft',
      builtOn: tokenSource?.title ?? null, onSystem: { on, total, unverified },
      exportedAt: new Date().toISOString().slice(0, 10),
    }, resolveVars()))
  }

  /** What a coding agent implements against: the exact spec, the tokens it
   *  resolved through, the revision, and the closed role vocabulary. The same
   *  object `designs.get` already returns over HTTP and MCP — the file is for
   *  attaching to a ticket. */
  const exportPackage = () => {
    if (hasPending || editingLocked || !palReady) return
    downloadJson(`${slug(design.title)}.design.json`, designToPackage(
      // The revision belongs to this snapshot, not to a separately fetched
      // history that might fail or already include somebody else's next edit.
      design,
      resolvedTokens, tokenSource?.title ?? null, { on, total, unverified },
      new Date().toISOString().slice(0, 10)))
  }
  const exportBlocked = aiProposal ? 'Accept or discard the AI preview before downloading.'
    : hasPending ? 'Save or discard your pending changes before downloading.'
    : busy ? 'Wait for the current change to finish before downloading.'
    : !palReady ? 'Resolving the design system before downloading…' : null
  const htmlBlocked = exportBlocked ?? (playing ? 'Stop preview to download all screens as HTML.' : null)

  return (
    <div className="detail dedit">
      <DesignNavigationGuard pending={hasPending || !!aiProposal} reviewRequired={!!aiProposal} busy={busy} onSave={saveAll} error={workErr} />
      <div className="crumb"><Link to="/designs">← Designs</Link> / design</div>
      <header className="deditor-header">
        <div className="deditor-title"><h1>{design.title}</h1>
          <Pill tone={stateTone(design.state)}>{design.state ?? 'draft'}</Pill>
          <span role="status" aria-live="polite" className={busy ? 'working' : hasPending || aiProposal ? 'pending' : ''}>
            {aiBusy ? 'Generating AI preview…' : busy ? 'Updating design…' : aiProposal ? 'AI changes awaiting review' : hasPending
              ? `${stashes.length + (unsaved ? 1 : 0)} unsaved change${stashes.length + (unsaved ? 1 : 0) === 1 ? '' : 's'}`
              : 'All changes saved'}
          </span>
        </div>
        <div className="deditor-actions">
          <ProjectsButton about={{ id: design.id, type: 'design' }} />
          <TasksButton about={{ id: design.id, type: 'design', title: design.title }} />
          <ShareButton id={design.id} title={design.title} />
          <CommentsButton subjectId={design.id} title={design.title} />
          <button className="btn action" disabled={editingLocked || !hasPending} onClick={saveAll}
            aria-keyshortcuts="Meta+S Control+S">Save all changes</button>
          <button className={`tool${focus ? ' on' : ''}`} aria-pressed={focus} onClick={() => setFocus(on => !on)}
            title="Hide the app sidebar to give the canvas the room">{focus ? 'Exit focus' : 'Focus'}</button>
          <EditorPopover label="Export" className="dexport">
            {() => <>
              {htmlBlocked && <p className="dprop-note warning">{htmlBlocked}</p>}
              <button className="dtool" onClick={exportHtml} disabled={!!htmlBlocked}
                title={htmlBlocked ?? 'A standalone page with every screen, without scripts or network requests'}>Download HTML</button>
              <button className="dtool" onClick={exportPackage} disabled={!!exportBlocked}
                title={exportBlocked ?? 'Spec, tokens, revision and role catalogue'}>Download spec</button>
            </>}
          </EditorPopover>
          <EditorPopover label="Help" className="deditor-help">
            {() => <>
              <b>Editing your design</b>
              <p>Click to select, drag to move, or pull a corner to resize. Choose an insert tool, then draw on a screen.</p>
              <dl>
                <dt>⌘ / Ctrl + S</dt><dd>Save all pending changes</dd>
                <dt>Arrow keys</dt><dd>Move 1px · Shift moves 10px</dd>
                <dt>⌘ / Ctrl + D</dt><dd>Duplicate selection</dd>
                <dt>⌘ / Ctrl + Z</dt><dd>Undo pending edit or restore previous revision</dd>
                <dt>Escape</dt><dd>Stop preview, put down a tool, or deselect</dd>
              </dl>
              <p>Canvas shortcuts apply outside text fields and the inspector. Saved revisions are in the Design tab.</p>
            </>}
          </EditorPopover>
        </div>
      </header>
      <DesignReviewBar design={design}
        blocked={busy ? 'Wait for the current change to finish.'
          : aiProposal ? 'Accept or discard the AI changes first.'
          : hasPending ? 'Save or discard your changes first — review covers what is saved.' : null}
        onChanged={async () => {
          const fresh = await getDesign(design.id)
          setDesign(fresh.design); await loadHistory(design.id)
        }} />

      <div className="dedit-body">
        {/* Clicking past the artboard clears the selection, and so does
            Escape. Neither did anything, so the blue ring stayed on whatever
            you last touched — including into the exported file. */}
        <div className="dedit-col">
          {/* The tools, in front of you rather than behind a dropdown in the
              other column. Arm one and draw on a screen: click for the role's
              own size, drag for the size you want. */}
          <div className="dtools">
            <button className={`dtool${playing ? ' on' : ''}`}
                    onClick={() => (playing ? setPlaying(null) : startPreview())}
                    disabled={editingLocked || screens.length === 0}
                    title="Click through it as a prototype — links go where they say">
              <svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M3.4 2.2 11.6 7 3.4 11.8z" />
              </svg>
              {playing ? 'Stop preview' : 'Preview'}
            </button>
            <span className="dtools-rule" />
            <button className={`dtool${!playing && tool === null ? ' on' : ''}`}
                    disabled={editingLocked || !!playing}
                    onClick={() => setTool(null)}
                    title="Select, move and resize what is already there">
              <svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M3 1.6 11.2 7.4 7.6 8.2 9.4 11.8 7.9 12.5 6.1 8.9 3.6 11z" />
              </svg>
              Pointer
            </button>
            {!playing && <DesignTools tool={tool} onChange={setTool} disabled={editingLocked || !screens.length} />}
            {/* One line, always: a hint that wrapped when something was
                selected pushed the whole canvas down under the pointer. */}
            <span className="dtools-hint" title={hint}>{hint}</span>
          </div>

        <div className="dedit-canvas" ref={canvas}
             onClick={e => { if (e.target === e.currentTarget) select(undefined) }}>
        {aiProposal && <DesignAIReview proposal={aiProposal} surface={design.surface} busy={busy}
          outdated={proposalOutdated} error={workErr} onAccept={acceptAI} onDiscard={discardAI} />}
        <div className="dcanvas-editor" hidden={!!aiProposal}>
        <div className="dcanvas-controls">
          <DesignScreenNavigator screens={screens} current={activeScreen?.id} onChange={navigateScreen}
            overview={overview} onOverview={() => setOverview(value => !value)} playing={!!playing} disabled={editingLocked} />
          <DesignZoomControls zoom={zoom} scale={scale} onChange={setZoom}
            disabled={!screens.length || (overview && !playing)} />
        </div>

        {playing && (
          <div className="dplay-bar">
            <button className="tool" onClick={goBack} disabled={trail.length === 0}>← Back</button>
            <b>{screens.find(sc => sc.id === playing)?.name ?? playing}</b>
            {/* Both: where you are, and why you did not go anywhere. Replacing
                the position with the warning left you unsure which screen you
                were looking at at the moment you most needed to know. */}
            <span className="hint">
              screen {screens.findIndex(sc => sc.id === playing) + 1} of {screens.length}
              {lostScreen && (
                <span style={{ color: 'var(--warn)' }}>
                  {' · '}that link points at <span className="mono">{lostScreen}</span>,
                  which is not a screen in this design
                </span>
              )}
            </span>
            <button className="tool" onClick={() => setPlaying(null)}>Stop preview</button>
          </div>
        )}
        <div className="dcanvas-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Design canvas"
          onClick={event => {
            if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('detail-screens')) select(undefined)
          }}>
        <div className={`dgrid detail-screens ${overview && !playing ? 'doverview' : 'dfocused'}`}>
          {screens.length === 0
            ? <div className="empty">This spec has no screens.</div>
            : playing
              ? (() => {
                  const sc = screens.find(x => x.id === playing)
                  if (!sc) return <div className="empty">That screen is gone.</div>
                  return (
                    <DesignScreenView key={sc.id} screen={sc} tokens={palette0}
                                      surface={design.surface} interactive
                                      onNavigate={to => goTo(sc.id, to)}
                                      width={viewWidth} zoom={scale} />
                  )
                })()
            // `palette0`, the same palette the counts are computed against.
            // Handing the artboard `resolvedTokens` and the count `palette0`
            // meant the two asked different questions: a design with no palette
            // drew every citation as fine while the rail called them unverified.
            // Keep every stage mounted for the all-screen HTML export; only
            // the focused frame is visible or keyboard-accessible in edit mode.
            : screens.map(s => (
              <div key={s.id} className="dscreen-frame" hidden={!overview && s.id !== activeScreen?.id}>
              {overview && <button className="tool dfocus-screen" onClick={() => navigateScreen(s.id)}>Focus {s.name}</button>}
              <DesignScreenView screen={s} tokens={palette0}
                                surface={design.surface} interactive
                                selected={sel?.screen === s.id ? sel.path : undefined}
                                onSelect={path => select({ screen: s.id, path })}
                                onEdit={(path, patch, what) => editEl(s.id, path, patch, what)}
                                onReorder={(parent, from, to, what) =>
                                  reorderEl(s.id, parent, from, to, what)}
                                preview={sel?.screen === s.id ? preview : null}
                                placing={tool}
                                onPlace={at => placeEl(s.id, at)}
                                onRename={name => renameScreenTo(s.id, name)}
                                onRemove={() => removeScreenFrom(s.id, s.name)}
                                saving={editingLocked}
                                width={overview ? Math.min(design.surface === 'mobile' ? 240 : 420, viewWidth) : viewWidth}
                                maxHeight={overview ? 300 : undefined}
                                zoom={overview ? undefined : scale} /></div>))}
        </div>
        </div>
        {!playing && (
          <div className="dscreen-add">
            <button className="tool" onClick={addScreenTo} disabled={editingLocked}>
              + Add a screen
            </button>
          </div>
        )}

        {!playing && <DesignChecks screens={screens} tokens={palette0} ready={palReady}
          disabled={editingLocked} onSelect={focusElement} />}
        </div>
        </div>
        </div>

        <DesignSidebar active={railTab} onChange={setRailTab} selectionKey={sel ? keyOf(sel) : undefined} reviewing={!!aiProposal}
          ai={<section className="dai-edit dai-global" aria-label="Edit with AI">
            <div className="dai-heading"><strong>Edit with AI</strong>
              <select aria-label="AI edit scope" value={elementScope ? 'element' : 'design'}
                disabled={editingLocked || !!playing} onChange={event => setAiScope(event.target.value as 'design' | 'element')}>
                <option value="design">Whole design</option>
                <option value="element" disabled={!selected}>Selected element</option>
              </select>
            </div>
            <label className="dai-label">
              <textarea ref={aiPrompt} rows={2} className="askbar-note" aria-label="Describe a change" aria-describedby="ai-prompt-help"
                value={aiBrief} onChange={event => setAiBrief(event.target.value)} disabled={editingLocked || !!playing}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !event.repeat) {
                    event.preventDefault(); applyAI()
                  }
                }}
                placeholder={elementScope ? 'Describe a change — make this secondary' : 'Describe a change — add an empty state'} />
            </label>
            {hasPending && <p className="dprop-note warning">Save or discard your pending changes before applying AI edits.</p>}
            {playing && <p className="dprop-note">Exit Preview to edit with AI.</p>}
            {aiProposal && <p className="dprop-note">Review the proposed changes on the canvas.</p>}
            <p id="ai-prompt-help" className="dprop-note">⌘ / Ctrl + Enter to preview · Enter for a new line</p>
            <div className="dai-actions">
              <span className="hint" title={elementScope ? selected?.text || selected?.id : 'Applies to all screens'}>
                {elementScope ? selected?.text || selected?.id : 'All screens'}
              </span>
              <button className="btn action" onClick={applyAI}
                disabled={!aiBrief.trim() || editingLocked || hasPending || !!playing || !palReady}
                aria-keyshortcuts="Meta+Enter Control+Enter">{aiBusy ? 'Generating preview…' : 'Preview AI changes'}</button>
            </div>
          </section>}
          header={selected && <div className="drail-selection">
            {sel && parentOf && <button className="linkbtn" disabled={editingLocked}
              onClick={() => select({ screen: sel.screen, path: sel.path.slice(0, -1) })}>
              ↑ in {parentOf.role} <span className="mono">{parentOf.id}</span>
            </button>}
            <strong>{(draftEl.text ?? selected.text)?.split('\n')[0] || selected.id}</strong>
            <span className="hint">{selected.role} · {selected.id} · {screens.find(sc => sc.id === sel?.screen)?.name}</span>
            <span className="drail-system">System: {tokenSource
              ? <Link to={`/designs/${tokenSource.id}`}>{tokenSource.title}</Link>
              : resolvedTokens && Object.keys(resolvedTokens).length ? 'This design’s tokens' : 'Renderer defaults'}</span>
          </div>}
          actions={selected && (<div className="delbar">
                <div className="delbar-acts">
                  {/* The commit first and marked as such. A `flex:1` spacer
                      pushed it onto a second line, left-aligned under three
                      secondary actions, where it read as a fourth lesser
                      button rather than the thing that writes the change. */}
                  {unsaved && (
                    <button className="linkbtn" onClick={() => setDraftEl(mirrored)}
                            disabled={editingLocked}>Undo</button>
                  )}
                  {/* A disabled button reading "Saved" sat among the actions
                      and read as one. It is a state, so it says so. */}
                  {unsaved || busy
                    ? <button className="btn action" onClick={saveElement} disabled={editingLocked || !unsaved}>
                        {busy ? 'Saving…' : 'Save change'}
                      </button>
                    : <span className="delbar-saved">Saved</span>}
                  <span className="delbar-sep" />
                  {placed && (
                    <>
                      <button className="tool" onClick={() => restack(1)} disabled={editingLocked}
                              title="Paint this later, so it sits over what it overlaps">
                        Bring forward
                      </button>
                      <button className="tool" onClick={() => restack(-1)} disabled={editingLocked}
                              title="Paint this earlier, so it sits under what it overlaps">
                        Send backward
                      </button>
                    </>
                  )}
                  <button className="tool" onClick={duplicateEl} disabled={editingLocked}
                          aria-keyshortcuts="Meta+D Control+D"
                          title="Duplicate (⌘ / Ctrl + D on canvas)">Duplicate</button>
                  <button className="tool" onClick={removeEl} disabled={editingLocked}>Delete</button>
                </div>
              </div>)}
          layers={!playing ? <DesignLayers screens={screens} selected={sel} currentScreen={activeScreen?.id} disabled={editingLocked}
            onJump={navigateScreen} onSelect={focusElement} />
            : <div className="dempty">Exit Preview to select and edit layers.</div>}
          notices={<>
        {workErr && !aiProposal && <div className="p-warn" role="alert" style={{ marginBottom: 12 }}>{workErr}</div>}
        {stashes.map(held => (
          <div className="dresume" style={{ marginBottom: 12 }} key={keyOf(held)}>
            <b>Unsaved change to <span className="mono">{held.label}</span>.</b>
            <span className="hint">You left it before saving.</span>
            <button className="tool" disabled={editingLocked}
                    onClick={() => saveStash(held)}>Save it</button>
            <button className="linkbtn" disabled={editingLocked}
                    onClick={() => setStashes(l => l.filter(x => x !== held))}>Discard</button>
          </div>
        ))}
          </>}
          properties={<>
        {selected && (
          <>
            <fieldset className="card dinspector" aria-label="Element properties" disabled={editingLocked}>
              <DesignInspector key={sel ? keyOf(sel) : undefined} element={{ ...selected, ...draftEl }} tokens={resolvedTokens}
                paletteReady={palReady} placed={placed} canHold={canHold} screens={screens}
                onChange={patch => setDraftEl(d => ({ ...d, ...patch }))} />
            </fieldset>
          </>
        )}
          {!selected && (
            <>
              <div className="section-label">Element</div>
              <div className="card dempty">
                Nothing selected. Click any box on a screen to change its words,
                its tone and what it cites — or drag it to move it.
              </div>
            </>
          )}

            <div className="addbar">
              <select disabled={editingLocked} value={newRole} onChange={e => setNewRole(e.target.value)}>
                {ROLE_CATALOGUE.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {/* Only what the toolbar cannot do. Putting an element INSIDE a
                  container is not a position on a screen — the container places
                  it — so there is nothing to draw and it stays a button.
                  Offered only where a child can live: a role that lays children
                  out, and not already inside one, since the type nests one deep. */}
              {selected && canHold && (
                <button className="tool" onClick={() => addEl(true)} disabled={editingLocked}
                        title="Several roles paint their own contents — a nav's links, a list's rows. Those are drawn, not in the spec. Put a real element inside and the container lays that out instead.">
                  Add inside
                </button>
              )}
            </div>


          </>}
          design={<>
        {history.length > 0 && (
          <>
            <div className="section-label">
              History <span className="hint">
                {history.length >= KEEP_REVISIONS
                  ? 'the last 100 changes — older ones are not kept'
                  : 'restoring is itself a revision'}
              </span>
            </div>
            <div className="card">
              {(allHistory ? history : history.slice(0, 6)).map(h => (
                <div className="hrow" key={h.rev}>
                  <span className="rev">{h.rev}</span>
                  <span className="what">
                    {h.note || 'no note'}
                    <span className="who">{h.by} · {ago(h.at)}</span>
                  </span>
                  {/* The newest revision IS the current state, so offering to
                      restore it would be offering to do nothing. Compared against
                      the history rather than `design.current_rev`, which
                      `designs.get` does not return — the first version guarded on
                      undefined and offered Restore on every row. */}
                  {(h.spec || h.has_spec) && h.rev !== history[0]?.rev && (
                    <button className="linkbtn" disabled={editingLocked}
                            onClick={() => restore(h)}>Restore</button>
                  )}
                </div>
              ))}
              {history.length > 6 && (
                <button className="hmore" onClick={() => setAllHistory(a => !a)}>
                  {allHistory ? 'Show recent only' : `Show all ${history.length} revisions`}
                </button>
              )}
            </div>
          </>
        )}

          <div className="section-label">Design</div>
          <dl className="kv railkv">
            <dt>Surface</dt><dd className="mono">{design.surface}</dd>
            <dt>On-system</dt>
            <dd>{total === 0 ? 'No elements yet.'
               : on === total ? <>All {total} cite a token in this palette.</>
               : <>
                   <b>{on} of {total}</b> cite a token in this palette.
                   {unverified > 0 && <> {unverified} cite something it does not
                     define — a component nothing here can check, or a typo.</>}
                   {total - on - unverified > 0 && <> {total - on - unverified} cite
                     nothing, and are drawn dashed.</>}
                 </>}</dd>
            {ownColour > 0 && (
              <>
                <dt>Own colours</dt>
                <dd><span style={{ color: 'var(--warn)' }}>
                  <b>{ownColour}</b> element{ownColour === 1 ? '' : 's'} painted a colour of
                  {ownColour === 1 ? ' its' : ' their'} own. Changing the palette will not
                  change {ownColour === 1 ? 'it' : 'them'}.
                </span></dd>
              </>
            )}
            <dt>Palette</dt>
            <dd>{tokenSource
              ? <Link to={`/designs/${tokenSource.id}`}>{tokenSource.title}</Link>
              : resolvedTokens
                ? <>{Object.keys(resolvedTokens).length} tokens of its own</>
                : unresolved.length
                  ? <span className="p-warn">Cites {unresolved.join(', ')} — unreadable,
                      so this draws on defaults.</span>
                  : <>Renderer defaults</>}</dd>
            <dt>Built from</dt>
            <dd>{design.cites?.length
              ? design.cites.map(c => (
                  <Link key={c} to={`/designs/${c}`} className="mono"
                        style={{ marginRight: 10 }}>{c}</Link>))
              : <>Nothing — cites no template</>}</dd>
            <dt>Authored</dt>
            <dd>{design.generated_by
              ? <span className="mono">{design.generated_by}</span>
              : 'By a person, directly'}</dd>
          </dl>
        <div className="section-label">
          References <span className="hint">objects this was drawn from</span>
          {/* The whole reason for tracking references: not that the design is
              old, but that something it was drawn from has moved since. */}
          {stale && <Pill tone="warn">one has moved</Pill>}
        </div>
        <div className="card" style={{ margin: 0, maxWidth: 660 }}>
          {refs.length === 0
            ? <div className="irow"><div className="body">
                Nothing cited, so nothing upstream can change under it.
              </div></div>
            : refs.map((r, i) => (
                // Keyed by position as well as id: citing one object twice gave
                // two rows with one key, which React reports and mis-reconciles.
                <div className="irow" key={`${r.id}:${i}`}>
                  <div className="body">
                    <b>{r.title ?? r.id}</b>
                    <div className="sub">
                      {r.unresolved
                        ? <span style={{ color: 'var(--warn)' }}>
                            named but could not be read — not the same as citing nothing
                          </span>
                        : <>
                            <span className="mono">{r.type} {r.key}</span>
                            {r.changed_since && (
                              <span style={{ color: 'var(--warn)' }}>
                                {' · '}changed since this design last did
                              </span>
                            )}
                          </>}
                    </div>
                  </div>
                  <button className="tool" disabled={editingLocked}
                          onClick={() => write({ design_id: design.id,
                            // By position. Filtering by id removed every row
                            // naming that object, so one click on one of two
                            // identical citations dropped both.
                            sources: refs.filter((_, at) => at !== i).map(x => x.id),
                            note: `stop citing ${r.id}` })}>Remove</button>
                </div>
              ))}
          <div className="irow">
            <input className="askbar-note" style={{ minHeight: 0, height: 34, flex: 1 }}
                   disabled={editingLocked} value={addRef} onChange={e => setAddRef(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') addReference() }}
                   placeholder="object id — the task that asked for this, the decision it implements" />
            <button className="tool" onClick={addReference}
                    disabled={!addRef.trim() || editingLocked}>Cite</button>
          </div>
        </div>
          </>}
        />
      </div>
    </div>
  )
}
