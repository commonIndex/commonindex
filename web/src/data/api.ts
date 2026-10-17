// Mock API. Every function here maps 1:1 to an operation in the backend's
// operation registry (see backend/DESIGN.md §6) — swap the body for a
// JSON-RPC call and the UI does not change. Latency is simulated so the UI
// is honest about loading states; pagination is cursor-based like the
// real gateway will be.
import {
  AGENTS, dashboards, experiments, oversightFor, panelsFor, programStats, seriesFor,
} from './seed'
import {
  fetchSkill, listBoard, listLive, listLiveDocs, listLiveExperiments, listMetrics, programStatsLive, searchWorkspace, toRow,
  toSkill, whoAmI, type WireDoc,
  type WireExperiment, type WireSearchHit, workspaceCounts,
} from './gateway'
import { codeHref, conversationFor, pageFor } from './links'
import type {
  AgentCard, AgentOversight, Counts, Dashboard, Diagram, Doc, ExpStatus, Experiment, MetricSeries, Page, Panel, ProgramStats, SearchHit, Skill,
} from './types'

// Every call here once waited 60ms first, to make sample data feel like a
// network. The data is real now; the wait was only latency added to every
// page, counts and lists included.
const wait = () => Promise.resolve()
const PAGE = 60

function page<T>(all: T[], cursor = 0): Page<T> {
  const items = all.slice(cursor, cursor + PAGE)
  const next = cursor + PAGE
  return { items, nextCursor: next < all.length ? next : null, total: all.length }
}

export type ExpFilter = 'all' | ExpStatus | 'mine' | 'attention'
/** Warehouse-backed experiments, fetched once and held — the same treatment the
 *  live dashboards get. A gateway that is down costs you these rows and nothing
 *  else: the seeded experiments are generated in the browser and keep working.
 *
 *  The difference from a seeded row is that `lift` here is a CACHE. The number
 *  on the detail page is recomputed from the warehouse on every read, and can
 *  come back refusing to answer at all. */
let liveExpPromise: Promise<Experiment[]> | null = null
function liveExperiments(): Promise<Experiment[]> {
  liveExpPromise ??= listLiveExperiments()
    .then(rows => rows.map(toExperimentRow))
    .catch(() => [])
  return liveExpPromise
}
/** Called after registering one, so it appears without a reload. */
export function forgetLiveExperiments() { liveExpPromise = null }

function toExperimentRow(w: WireExperiment): Experiment {
  return {
    id: w.id,
    key: w.key ?? w.id.slice(0, 12).toUpperCase(),
    name: w.name,
    hypothesis: w.hypothesis,
    space: w.space,
    owner: w.owner || 'unassigned',
    metric: w.metric,
    status: (w.status as Experiment['status']) ?? 'draft',
    day: w.day ?? 0,
    days: w.days ?? 14,
    lift: w.lift,
    liftAt: w.lift_at ?? null,
    guardrail: (w.guardrail as Experiment['guardrail']) ?? 'clean',
    ...(w.better ? { better: w.better } : {}),
    // Days ago, matching the seeded rows. A live row that has never been read
    // out has no lift_at, and 0 is the honest answer: nothing has happened to it.
    updated: w.lift_at
      ? Math.max(0, Math.round((Date.now() - Date.parse(w.lift_at)) / 86_400_000))
      : 0,
    live: true,
    preRegistered: w.pre_registered,
    amendments: w.amendments,
    ownerId: w.owner_id ?? w.owner,
    startedAt: w.started_at ?? null,
    endsAt: w.ends_at ?? null,
    stoppedAt: w.stopped_at ?? null,
    attention: w.attention ?? [],
    srmPassed: w.srm_passed ?? null,
    liftCi: w.lift_ci ?? null,
    units: w.units ?? null,
    verdict: w.verdict ?? null,
    mde: w.mde ?? null,
    decision: w.decision ?? null,
  }
}

export async function listExperiments(opts: { cursor?: number; filter?: ExpFilter; q?: string }): Promise<Page<Experiment>> {
  await wait()
  let rows = await liveExperiments()
  const f = opts.filter ?? 'all'
  if (f === 'mine') {
    // Whoever is signed in.
    const me = await whoAmI()
    const ids = new Set([me?.id, me?.display].filter(Boolean).map(v => String(v).toLowerCase()))
    rows = rows.filter(e => ids.has((e.ownerId ?? e.owner).toLowerCase()) || ids.has(e.owner.toLowerCase()))
  } else if (f === 'attention') rows = rows.filter(e => e.attention
    ? e.attention.length > 0 : e.status === 'readout' || e.guardrail !== 'clean')
  else if (f !== 'all') rows = rows.filter(e => e.status === f)
  if (opts.q) {
    const q = opts.q.toLowerCase()
    rows = rows.filter(e => `${e.key} ${e.name} ${e.metric} ${e.owner} ${e.space} ${e.hypothesis}`.toLowerCase().includes(q))
  }
  return page(rows, opts.cursor)
}

export async function getExperiment(id: string): Promise<Experiment | undefined> {
  await wait()
  return (await liveExperiments()).find(e => e.id === id)
}

/** Portfolio analysis. Aggregates over experiment objects CommonIndex already holds —
 *  in production this is one grouped query against the read model, not a
 *  warehouse round trip, which is why it needs no connector. */
export async function getProgramStats(): Promise<ProgramStats> {
  await wait()
  // Same population as the collection above it, or the two quote different
  // totals for the same question.
  return programStatsLive().catch(async () => programStats(await liveExperiments()))
}

export async function getExperimentSeries(id: string): Promise<MetricSeries | undefined> {
  await wait()
  // Seeded only. A live experiment's chart would be a fabricated series next to
  // a real readout, which is worse than no chart.
  const e = experiments.find(x => x.id === id)
  return e && seriesFor(e)
}

export type DocFilter = 'all' | 'stale' | 'verified' | 'proposals'

/** The page a doc was made into: a body that is one embed and nothing else. */
function pageOf(body: WireDoc['body'] | undefined): { pageRef?: string } {
  const kids = body?.content ?? []
  const ref = kids.length === 1 && kids[0].type === 'embed' ? kids[0].attrs?.ref : undefined
  return typeof ref === 'string' && ref ? { pageRef: ref } : {}
}

/** A doc written in the editor, as a collection row. The owner is not on the
 *  wire yet — `docs.list` returns props, not `created_by` — so it says what
 *  is true rather than guessing a name. */
export function toDocRow(w: WireDoc, now = Date.now()): Doc {
  const at = w.updated_at ? Date.parse(w.updated_at) : now
  return {
    id: w.id, title: w.title || 'Untitled', space: w.space ?? 'pay', owner: 'written here',
    excerpt: w.excerpt ?? '', freshness: w.freshness ?? 'fresh', proposals: 0,
    rev: w.current_rev ?? 1, updated: Math.max(0, Math.floor((now - at) / 86_400_000)),
    live: true,
    ...pageOf(w.body),
  }
}

/** Held like the live dashboards, and forgotten on failure for the same
 *  reason: a cached rejection would mean "you have no docs" until a reload. */
let liveDocsPromise: Promise<Doc[]> | null = null
function liveDocRows(): Promise<Doc[]> {
  liveDocsPromise ??= listLiveDocs().then(r => r.docs.map(w => toDocRow(w))).catch(e => {
    liveDocsPromise = null
    throw e
  })
  return liveDocsPromise
}
/** Called after creating or saving one, so the list shows it without a reload. */
export function forgetLiveDocs() { liveDocsPromise = null }

export async function listDocs(opts: { cursor?: number; filter?: DocFilter; q?: string }): Promise<Page<Doc>> {
  await wait()
  // The ones written here first: they are the ones somebody is working on.
  let rows = await liveDocRows()
  const f = opts.filter ?? 'all'
  if (f === 'stale') rows = rows.filter(d => d.freshness === 'stale')
  else if (f === 'verified') rows = rows.filter(d => d.freshness === 'verified')
  else if (f === 'proposals') rows = rows.filter(d => d.proposals > 0)
  if (opts.q) {
    const q = opts.q.toLowerCase()
    // the preview is on screen, so it has to be searchable — filtering on a
    // field the reader cannot see is how a search box loses their trust
    rows = rows.filter(d => `${d.title} ${d.space} ${d.owner} ${d.excerpt}`.toLowerCase().includes(q))
  }
  return page(rows, opts.cursor)
}

export type DashFilter = 'all' | 'certified' | 'attention' | 'agent' | 'mine'
export type DashOwnership = 'all' | 'agent' | 'mine'
/** Live rows are fetched once and held, because the collection list re-runs on
 *  every keystroke of the filter box and the gateway should not. A failure here
 *  is not an error state for the whole screen: the seeded dashboards still
 *  work, so a gateway that is down costs you the live rows and nothing else. */
let livePromise: Promise<Dashboard[]> | null = null
function liveRows(): Promise<Dashboard[]> {
  // The catch used to swallow the failure into `[]` AND memoise it. A 401, a
  // dropped connection or a restart during page load therefore cached "there
  // are no warehouse dashboards" for the lifetime of the tab: the collection
  // quietly showed only seeded rows, and opening one by URL said "Dashboard
  // not found". The carefully worded credentials message never reached a
  // screen on this path.
  //
  // Forgetting the promise on failure means the next call tries again, and the
  // rejection travels so the list can say what happened.
  livePromise ??= listLive().then(r => r.dashboards.map(toRow)).catch(e => {
    livePromise = null
    throw e
  })
  return livePromise
}
/** Called after creating one, so the new dashboard appears without a reload. */
export function forgetLiveDashboards() { livePromise = null }

export async function listDashboards(opts: { cursor?: number; filter?: DashFilter; ownership?: DashOwnership; q?: string }): Promise<Page<Dashboard>> {
  await wait()
  // Warehouse-backed first: they are the ones whose numbers moved since you
  // last looked, and there are few of them.
  let rows = await liveRows()
  const f = opts.filter ?? 'all'
  if (f === 'certified') rows = rows.filter(d => d.certified)
  else if (f === 'attention') rows = rows.filter(d => !d.certified || d.proposals > 0)
  const ownership = opts.ownership ?? (f === 'agent' || f === 'mine' ? f : 'all')
  if (ownership === 'agent') rows = rows.filter(d => d.agentOwner || d.proposals > 0)
  else if (ownership === 'mine') {
    // Whoever is signed in, as for experiments.
    const me = await whoAmI()
    const ids = new Set([me?.id, me?.display].filter(Boolean).map(v => String(v).toLowerCase()))
    rows = rows.filter(d => ids.has(d.owner.toLowerCase()))
  }
  if (opts.q) {
    const q = opts.q.toLowerCase()
    rows = rows.filter(d => `${d.key} ${d.title} ${d.space} ${d.connectionId ?? ''} ${d.owner} ${d.metrics.join(' ')} ${d.metricReferences?.map(m => `${m.id} ${m.label}`).join(' ') ?? ''}`.toLowerCase().includes(q))
  }
  return page(rows, opts.cursor)
}

export async function getDashboard(id: string): Promise<Dashboard | undefined> {
  await wait()
  return (await liveRows()).find(d => d.id === id)
}

/** Panels come back separately — the collection row never carries 90 days × 9 panels. */
export async function getPanels(id: string): Promise<Panel[]> {
  await wait()
  const d = dashboards.find(x => x.id === id)
  return d ? panelsFor(d) : []
}

export type SkillFilter = 'all' | 'installed' | 'available' | 'proposed' | 'workspace' | 'deprecated'
/** The generated data-context skill, fetched once and held. A gateway that is
 *  Search can tolerate a missing source; the Skills collection must surface
 *  failures instead of presenting an outage as an empty registry. */
let ctxPromise: Promise<Skill[]> | null = null
export function forgetLiveSkills() { ctxPromise = null }
function contextSkill(strict = false): Promise<Skill[]> {
  ctxPromise ??= Promise.all([fetchSkill(), listLive(), listMetrics()])
    .then(([sk, dash, ms]) => [toSkill(sk, {
      // Count reference files, not all files. `length - 1` assumed the only
      // non-reference file was SKILL.md, and stopped being true the moment a
      // script was bundled — an off-by-one that reads as a real dataset.
      datasets: Object.keys(sk.files).filter(f => f.startsWith('references/')).length,
      definitions: ms.metrics.length,
      dashboards: dash.dashboards.length,
      unratified: ms.metrics.filter(m => m.status !== 'ratified').length,
    })])
    .catch(error => { ctxPromise = null; throw error })
  return strict ? ctxPromise : ctxPromise.catch(() => [])
}

export async function listSkills(opts: { cursor?: number; filter?: SkillFilter; q?: string }): Promise<Page<Skill>> {
  await wait()
  let rows = await contextSkill(true)
  const f = opts.filter ?? 'all'
  if (f === 'installed') rows = rows.filter(s => s.status === 'installed')
  else if (f === 'available') rows = rows.filter(s => s.status === 'available')
  else if (f === 'proposed') rows = rows.filter(s => s.status === 'proposed' || s.status === 'draft')
  else if (f === 'workspace') rows = rows.filter(s => s.source === 'workspace')
  else if (f === 'deprecated') rows = rows.filter(s => s.status === 'deprecated')
  if (opts.q) {
    const q = opts.q.toLowerCase()
    rows = rows.filter(s => `${s.key} ${s.name} ${s.title} ${s.summary} ${s.source} ${s.scopes.join(' ')} ${s.installedOn.join(' ')}`.toLowerCase().includes(q))
  }
  return page(rows, opts.cursor)
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  await wait()
  return (await contextSkill()).find(s => s.id === id)
}

export async function getAgent(id: string): Promise<{ agent: AgentCard; oversight: AgentOversight } | undefined> {
  await wait()
  const agent = AGENTS.find(a => a.id === id)
  const ov = oversightFor(id)
  return agent && ov ? { agent, oversight: ov } : undefined
}

export async function listOversight(): Promise<{ agent: AgentCard; oversight: AgentOversight }[]> {
  await wait()
  return AGENTS.flatMap(a => {
    const ov = oversightFor(a.id)
    return ov ? [{ agent: a, oversight: ov }] : []
  })
}

export async function listAgents(): Promise<AgentCard[]> {
  await wait()
  return AGENTS
}


const NO_COUNTS: Counts = {
  experiments: { total: 0, running: 0, readout: 0 }, docs: { total: 0, stale: 0 },
  dashboards: { total: 0, proposals: 0 }, skills: { total: 0, installed: 0, proposed: 0 },
  tasks: { total: 0, review: 0, flight: 0 },
}

export async function getCounts(): Promise<Counts> {
  // Real rows only: the sidebar describes this workspace. Counted by the
  // gateway from the same lists, so the page no longer downloads every
  // experiment, task, doc and dashboard to draw six numbers. A gateway that is
  // down — or an answer missing a section — counts nothing rather than taking
  // the sidebar with it.
  const got = await workspaceCounts().catch(() => null) as Partial<Counts> | null
  const out = {} as Counts
  for (const k of Object.keys(NO_COUNTS) as (keyof Counts)[]) {
    const part = got?.[k] as Record<string, unknown> | undefined
    out[k] = Object.fromEntries(Object.entries(NO_COUNTS[k]).map(([f, zero]) =>
      [f, typeof part?.[f] === 'number' ? part[f] : zero])) as never
  }
  return out
}

const SCREENS: SearchHit[] = [
  { type: 'screen', title: 'Board', sub: 'work for people and agents', href: '/board' },
  { type: 'screen', title: 'Experiments', sub: 'registered tests and their readouts', href: '/experiments' },
  { type: 'screen', title: 'Code query', sub: 'ask how the code works', href: '/code' },
  { type: 'screen', title: 'Docs', sub: 'specs, runbooks and notes', href: '/docs' },
  { type: 'screen', title: 'Dashboards', sub: 'panels over ratified metrics', href: '/dashboards' },
  { type: 'screen', title: 'Designs', sub: 'screens and design systems', href: '/designs' },
  { type: 'screen', title: 'Skills', sub: 'what agents know how to do', href: '/skills' },
  { type: 'screen', title: 'Agents', sub: 'who they are and what they may do', href: '/agents' },
  { type: 'screen', title: 'Channels', sub: 'where people and agents talk', href: '/channels' },
]

const shortDay = (at: string) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The gateway could not answer: said as that, not as "no matches". */
export class SearchUnavailable extends Error {}

function toHit(h: WireSearchHit): SearchHit {
  if (h.kind === 'message' && h.subject) {
    const inChannel = h.subject.type === 'channel'
    return {
      type: inChannel ? 'channel' : 'comment',
      title: inChannel ? `#${h.subject.title}` : h.subject.title,
      sub: h.author?.name ?? '', snippet: h.snippet ?? undefined, href: conversationFor(h.subject),
    }
  }
  if (h.kind === 'agent') return { type: 'agent', title: h.title, sub: 'agent', href: pageFor({ id: h.id, type: 'agent' }) }
  const snippet = h.snippet ?? undefined
  if (h.kind === 'code') {
    return { type: 'code', title: h.title, sub: h.repo?.split('/').pop() ?? '', snippet,
             href: codeHref({ id: h.id, path: h.title, repo: h.repo, lines: h.lines }) }
  }
  if (h.kind === 'metric') {
    // Opened where it is charted, when it is.
    const on = h.used_on?.[0]
    return { type: 'metric', title: h.title, sub: on ? `on ${on.title}` : h.status ?? '', snippet,
             href: on ? pageFor(on) : pageFor(h) }
  }
  if (h.kind === 'dataset') return { type: 'dataset', title: h.title, sub: 'dataset', snippet, href: pageFor(h) }
  if (h.kind === 'run') {
    return { type: 'run', title: `${h.title} run`, snippet,
             sub: [h.status, h.at && shortDay(h.at)].filter(Boolean).join(' · '),
             href: pageFor({ id: h.agent?.id ?? h.id, type: 'agent' }) }
  }
  if (h.kind === 'history') {
    return { type: h.type as SearchHit['type'], title: h.title, earlier: true, snippet,
             sub: h.at ? `earlier version · until ${shortDay(h.at)}` : 'earlier version', href: pageFor(h) }
  }
  return {
    type: h.type as SearchHit['type'],
    title: h.type === 'channel' ? `#${h.title}` : h.title,
    sub: h.key ?? '', snippet: h.snippet ?? undefined, href: pageFor(h),
  }
}


/** What the palette finds. The screens by name; then the workspace — every
 *  collection, the agents and what was said — from the gateway's search; the
 *  generated skill; and the samples only while they are showing, after the
 *  real things and marked. It searched the samples and nothing else, so a
 *  dashboard made here could not be found by its own name. */
export async function search(q: string): Promise<SearchHit[]> {
  const needle = q.trim().toLowerCase()
  if (!needle) return SCREENS
  const hits: SearchHit[] = SCREENS.filter(s => s.title.toLowerCase().includes(needle))
  let failed: string | null = null
  const [found, generated] = await Promise.all([
    searchWorkspace(q.trim()).then(r => r.hits ?? []).catch(e => {
      failed = e instanceof Error ? e.message : String(e)
      return [] as WireSearchHit[]
    }),
    contextSkill(),
  ])
  hits.push(...found.map(toHit))
  for (const s of generated) {
    if (`${s.key} ${s.name} ${s.title}`.toLowerCase().includes(needle)) {
      hits.push({ type: 'skill', title: s.name, sub: 'generated context', href: `/skills/${s.id}` })
    }
  }
  if (failed !== null && !hits.length) throw new SearchUnavailable(failed)
  return hits.slice(0, 40)
}
