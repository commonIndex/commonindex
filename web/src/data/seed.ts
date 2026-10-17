// Deterministic seed data. In production every list here is a query against
// the graph read models; the shapes match what the GraphQL gateway returns.
import type {
  AgentCard, Dashboard, Diagram, Doc, ExpStatus, Experiment, Freshness, MetricDir,
  MetricSeries, MetricUnit, PR, ProgramStats, Panel, PanelAgg, PanelKind, AgentOversight,
} from './types'
import { collapse, shares } from './agg'

// mulberry32 — small seeded RNG so the demo world is stable across reloads
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = rng(20260719)
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))

export const SPACES = ['Payments', 'Checkout', 'Growth', 'Search', 'Platform', 'Support']
export const HUMANS = ['Maya', 'Alex', 'Jordan', 'Priya', 'Sam', 'Lena', 'Diego', 'Noor']
export const AGENTS: AgentCard[] = [
  { id: 'scribe', name: 'Scribe', role: 'docs gardener', trust: 'auto-merge-minor', acceptance: 94, filed: 412, merged: 388, cost: '$31/wk', watching: '520 docs · drift + staleness', owner: 'Maya' },
  { id: 'triage', name: 'Triage', role: 'issue triage', trust: 'auto-merge-minor', acceptance: 92, filed: 618, merged: 571, cost: '$24/wk', watching: 'all PRs + incidents · routing', owner: 'Priya' },
  { id: 'analyst', name: 'Analyst', role: 'data analyst', trust: 'propose-only', acceptance: 91, filed: 233, merged: 214, cost: '$46/wk', watching: '38 running experiments · guardrails', owner: 'Sam' },
  { id: 'release', name: 'Release scribe', role: 'release notes', trust: 'propose-only', acceptance: 89, filed: 96, merged: 85, cost: '$9/wk', watching: '6 repos · weekly changelogs', owner: 'Lena' },
]

const FEATURES = ['dupe-charge warning', 'one-tap refund', 'saved cards nudge', 'checkout progress bar', 'address autofill', 'trust badges', 'express lane', 'retry banner', 'receipt email v2', 'promo stacking', 'search synonyms', 'zero-results rescue', 'onboarding checklist', 'welcome tour', 'paywall copy test', 'annual plan default', 'invoice reminders', 'dark mode default', 'faster OTP', 'guest checkout']
const SURFACES = ['checkout', 'search', 'onboarding', 'billing', 'refunds', 'signup', 'settings', 'dashboard']
// Each ratified metric carries its unit, which direction is good, and the
// baseline the control arm hovers around — enough to generate an honest
// readout series and to say whether a delta is a win.
export const METRIC_META: Record<string, { unit: MetricUnit; better: MetricDir; base: number; noise: number }> = {
  refund_rate: { unit: 'pct', better: 'down', base: 2.41, noise: 0.09 },
  checkout_conversion: { unit: 'pct', better: 'up', base: 61.4, noise: 0.04 },
  search_ctr: { unit: 'pct', better: 'up', base: 34.2, noise: 0.05 },
  activation_rate: { unit: 'pct', better: 'up', base: 27.8, noise: 0.06 },
  arpu: { unit: 'currency', better: 'up', base: 18.4, noise: 0.05 },
  support_tickets: { unit: 'count', better: 'down', base: 412, noise: 0.07 },
  retention_d30: { unit: 'pct', better: 'up', base: 41.6, noise: 0.04 },
}
const METRICS = Object.keys(METRIC_META)

// The question the test was opened to answer, written the way an owner writes
// it: the change, where it lands, the metric that decides it, and when it gets
// called. A collection that shows only names makes every row look alike.
const HYPOTHESES = [
  (f: string, s: string, m: string, d: number) => `Does ${f} on ${s} move ${m}? Ships if the lift holds through day ${d} with no guardrail breach.`,
  (f: string, s: string, m: string) => `Hypothesis: putting ${f} in front of ${s} lifts ${m} enough to justify the surface area it costs.`,
  (f: string, s: string, m: string, d: number) => `Tests ${f} against the ${s} flow we ship today, powered on ${m} over ${d} days.`,
  (f: string, s: string, m: string, d: number) => `${f} on ${s}, decided on ${m} — called at day ${d} whichever way it lands.`,
]

export const experiments: Experiment[] = Array.from({ length: 240 }, (_, i) => {
  const n = 240 - i
  const r = rand()
  const status: ExpStatus = r < 0.06 ? 'draft' : r < 0.22 ? 'running' : r < 0.3 ? 'readout' : r < 0.82 ? 'shipped' : 'killed'
  const days = pick([7, 14, 14, 21, 28])
  const decided = status === 'shipped' || status === 'killed'
  const feature = pick(FEATURES)
  const surface = pick(SURFACES)
  const metric = pick(METRICS)
  return {
    id: `exp-${n}`,
    key: `E-${n}`,
    name: `${feature} · ${surface}`,
    owner: pick(HUMANS),
    space: pick(SPACES),
    metric,
    hypothesis: pick(HYPOTHESES)(feature, surface, metric.replace(/_/g, ' '), days),
    status,
    day: status === 'running' ? int(1, days - 1) : days,
    days,
    lift: status === 'draft' || status === 'running' ? null : Math.round((rand() * 24 - (status === 'killed' ? 14 : 4)) * 10) / 10,
    guardrail: status === 'running' && rand() < 0.12 ? 'watch' : status === 'killed' && rand() < 0.4 ? 'breach' : 'clean',
    updated: decided ? int(2, 120) : int(0, 3),
  }
})

// lift is the signed change on the target metric, so on a metric where lower
// is better a win points down. Orient it after the fact: shipped experiments
// should read as wins on their own metric, killed ones as losses.
for (const e of experiments) {
  if (e.lift !== null && METRIC_META[e.metric].better === 'down') e.lift = -e.lift
}

// Two experiments are pinned like featuredDoc: the inbox links to them by id,
// so they carry the readout its copy promises instead of whatever the RNG dealt.
function pin(id: string, patch: Partial<Experiment>) {
  const i = experiments.findIndex(e => e.id === id)
  if (i >= 0) experiments[i] = { ...experiments[i], ...patch }
}
pin('exp-238', {
  name: 'dupe-charge warning · checkout', owner: 'Maya', space: 'Payments',
  metric: 'refund_rate', status: 'readout', day: 14, days: 14, lift: -18, guardrail: 'clean', updated: 0,
})
pin('exp-231', {
  name: 'zero-results rescue · search', owner: 'Diego', space: 'Search',
  metric: 'search_ctr', status: 'readout', day: 21, days: 21, lift: 2.6, guardrail: 'watch', updated: 1,
})

// The readout series. Generated per experiment from its own id so it is stable
// across reloads without perturbing the rest of the seeded world, and derived
// from the experiment's own fields so the picture can never contradict them.
const seriesCache = new Map<string, MetricSeries>()

function roundTo(v: number, unit: MetricUnit) {
  const dp = unit === 'count' ? 1 : 2
  return Math.round(v * 10 ** dp) / 10 ** dp
}

export function seriesFor(exp: Experiment): MetricSeries {
  const hit = seriesCache.get(exp.id)
  if (hit) return hit
  const m = METRIC_META[exp.metric]
  const r = rng(exp.id.split('').reduce((a, c) => a + c.charCodeAt(0), 991))
  const elapsed = exp.status === 'draft' ? 0 : exp.day
  // Running experiments have no ratified readout yet — they track toward an
  // effect the analyst hasn't called; decided ones must land on their lift.
  const target = exp.lift ?? Math.round((r() * 14 - 7) * 10) / 10
  const rampDays = Math.max(2, Math.round(exp.days * 0.25))

  // Most tests are A/B, but enough are not that a two-arm chart is a lie for
  // the rest. The winning arm carries the experiment's stated lift; the others
  // land wherever they land, including behind the baseline.
  const extra = r() < 0.75 ? 0 : r() < 0.93 ? 1 : 2
  const names = extra === 0 ? ['variant'] : ['variant A', 'variant B', 'variant C'].slice(0, extra + 1)
  const winner = Math.floor(r() * names.length)
  const effects = names.map((_, i) => (i === winner ? target : Math.round(target * (r() * 1.4 - 0.6) * 10) / 10))

  const baseDaily: number[] = []
  const armDaily: number[][] = names.map(() => [])
  for (let d = 1; d <= elapsed; d++) {
    // These are cumulative estimates, so the noise shrinks as ~1/√n.
    const decay = 1 / Math.sqrt(d + 1)
    const ctrl = m.base * (1 + (r() - 0.5) * 2 * m.noise * decay)
    baseDaily.push(roundTo(ctrl, m.unit))
    const ramp = Math.min(1, d / rampDays) // the effect takes a few days to land
    effects.forEach((eff, i) => {
      const v = ctrl * (1 + (eff / 100) * ramp) * (1 + (r() - 0.5) * 2 * m.noise * decay)
      armDaily[i].push(roundTo(v, m.unit))
    })
  }
  // The last point is the readout everyone quotes — pin the winner to the
  // stated lift so the chart and the number in the row cannot disagree.
  if (elapsed > 0 && exp.lift !== null) {
    const lastBase = baseDaily[elapsed - 1]
    armDaily[winner][elapsed - 1] = roundTo(lastBase * (1 + exp.lift / 100), m.unit)
  }

  const perDay = 700 + Math.floor(r() * 2400)
  const share = Math.round((perDay * elapsed) / (names.length + 1))
  const out: MetricSeries = {
    metric: exp.metric, unit: m.unit, better: m.better, days: exp.days,
    arms: [
      { name: 'control', daily: baseDaily, exposure: share, baseline: true },
      ...names.map((name, i) => ({
        name,
        daily: armDaily[i],
        exposure: Math.round(share * (1 + (r() - 0.5) * 0.02)),
      })),
    ],
  }
  seriesCache.set(exp.id, out)
  return out
}

const hashCode = (str: string) => str.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) >>> 0

// --- program analysis ------------------------------------------------------
// The in-plane half of "analyse the experiments": every input below is already
// an object in the graph, so the whole portfolio view is a query over the
// collection CommonIndex owns — no warehouse, no statistics engine. The registry has
// declared avg(lift) as a measure on this type since day one; this is the
// first surface that reads it.

/** Lift reoriented so positive always means "the variant won", whichever way
 *  the metric is supposed to move. A refund rate that fell 18% is a +18 win. */
export function improvement(e: Experiment): number | null {
  if (e.lift === null) return null
  // A live experiment cites a metric from the registry, which this seeded table
  // has never heard of — `METRIC_META[e.metric].better` threw the moment one
  // carried a cached lift, taking the whole program page with it.
  //
  // Excluded rather than guessed. Orienting a lift needs to know which
  // direction is good, and assuming "up" would file a refund-rate win as a
  // loss — a wrong number in the distribution is worse than a missing one.
  // The row's own direction first: a recorded readout carries it from the
  // metric it cited, which is the only place that knows. The seed table is the
  // fallback for seeded rows, and neither means the lift cannot be oriented —
  // so it is left out rather than assumed.
  const better = e.better ?? METRIC_META[e.metric]?.better
  if (!better) return null
  return better === 'up' ? e.lift : -e.lift
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10
}

// Bucket edges for the effect-size histogram, in improvement percent. The
// boundary at 0 is the one that matters, so it is an edge and never a centre.
const DIST_EDGES = [-15, -10, -5, 0, 5, 10, 15]

/** Takes the rows rather than reading the module: the collection merges
 *  warehouse-backed experiments into the same list, and a portfolio view that
 *  counted a different population than the collection above it would be the
 *  exact disagreement this whole model exists to prevent. */
export function programStats(rows: Experiment[] = experiments): ProgramStats {
  const by = (s: ExpStatus) => rows.filter(e => e.status === s).length
  const decidedRows = rows.filter(e => e.status === 'shipped' || e.status === 'killed')
  const shipped = rows.filter(e => e.status === 'shipped')
  const killed = rows.filter(e => e.status === 'killed')

  // Every metric present in the data, not only the seeded ones. Keyed off
  // METRIC_META, a live experiment on `checkout_conv_clean` was absent from
  // this breakdown entirely while still counting in the totals above it — two
  // charts on one page disagreeing about the same population.
  const metricKeys = [...new Set([
    ...Object.keys(METRIC_META),
    ...decidedRows.map(e => e.metric).filter(Boolean),
  ])]
  const byMetric = metricKeys.map(metric => {
    const rows = decidedRows.filter(e => e.metric === metric)
    const s = rows.filter(e => e.status === 'shipped').length
    const k = rows.length - s
    return { metric, shipped: s, killed: k, rate: rows.length ? Math.round((s / rows.length) * 100) : 0 }
  }).filter(r => r.shipped + r.killed > 0 || METRIC_META[r.metric])
    .sort((a, b) => (b.shipped + b.killed) - (a.shipped + a.killed))

  const dist = [-Infinity, ...DIST_EDGES].map((lo, i) => {
    const hi = i < DIST_EDGES.length ? DIST_EDGES[i] : Infinity
    const inBucket = (e: Experiment) => {
      const v = improvement(e)
      return v !== null && v >= lo && v < hi
    }
    const label = lo === -Infinity ? `≤${DIST_EDGES[0]}` : hi === Infinity ? `≥+${lo}` : lo > 0 ? `+${lo}` : String(lo)
    return {
      label,
      lo: lo === -Infinity ? DIST_EDGES[0] - 5 : lo,
      shipped: shipped.filter(inBucket).length,
      killed: killed.filter(inBucket).length,
    }
  })

  return {
    total: rows.length,
    draft: by('draft'),
    running: by('running'),
    readout: by('readout'),
    attention: rows.filter(e => e.status === 'readout' || e.guardrail !== 'clean').length,
    decided: decidedRows.length,
    shipped: shipped.length,
    killed: killed.length,
    winRate: decidedRows.length ? Math.round((shipped.length / decidedRows.length) * 100) : 0,
    medianWin: median(shipped.map(improvement).filter((v): v is number => v !== null)),
    medianLoss: median(killed.map(improvement).filter((v): v is number => v !== null)),
    medianRun: median(decidedRows.map(e => e.days)),
    byMetric,
    dist,
  }
}

const REPOS = ['payments-api', 'web-app', 'search-svc', 'notif-svc', 'infra', 'design-system']
const PR_VERBS = ['handle', 'fix', 'add', 'remove', 'refactor', 'migrate', 'speed up', 'instrument', 'gate', 'clean up']
const PR_THINGS = ['partial refund rounding', 'idempotency middleware', 'retry storm backoff', 'stale cache reads', 'flag evaluation path', 'webhook signatures', 'rate limiter', 'search reranker', 'OTP delivery', 'audit export', 'proposal diffing', 'event fanout', 'ACL check batching', 'schema validation']

// What a reviewer wants off the list before they open anything: the shape of
// the change and why it is safe to read quickly.
const PR_SUMMARIES = [
  (t: string, r: string) => `Reworks ${t} in ${r}. The interface is unchanged, so nothing downstream has to move with it.`,
  (t: string, r: string) => `${t} in ${r}, plus the regression test that would have caught this the first time.`,
  (t: string, r: string) => `One change to ${t} in ${r} — deliberately small enough to read in a sitting.`,
  (t: string, r: string) => `Narrows ${t} in ${r} to the case that actually misbehaves, and leaves the rest alone.`,
  (t: string, r: string) => `Behind a flag: ${t} in ${r} stays dark until the rollout doc says otherwise.`,
]

export const prs: PR[] = Array.from({ length: 380 }, (_, i) => {
  const n = 380 - i
  const r = rand()
  const status = r < 0.16 ? 'open' : r < 0.94 ? 'merged' : 'closed'
  const agentAuthor = rand() < 0.34
  const thing = pick(PR_THINGS)
  const repo = pick(REPOS)
  return {
    id: `pr-${n}`,
    repo,
    num: n,
    title: `${pick(PR_VERBS)} ${thing}`,
    summary: pick(PR_SUMMARIES)(thing, repo),
    author: agentAuthor ? pick(['Scribe', 'Triage', 'Release scribe']) : pick(HUMANS),
    agentAuthor,
    status,
    checks: status === 'open' ? (rand() < 0.7 ? 'passed' : rand() < 0.6 ? 'running' : 'failed') : 'passed',
    awaitingYou: status === 'open' && rand() < 0.18,
    updated: status === 'open' ? int(0, 4) : int(1, 90),
  }
})

/** The build number is derived from the PR so a build and the deploy that
 *  shipped it quote the same number. */
export const buildNumber = (repo: string, num: number) => 1200 + ((hashCode(repo) + num * 7) % 900)
const DOC_KINDS = ['spec', 'runbook', 'RFC', 'guide', 'postmortem', 'notes', 'policy', 'onboarding'] as const
type DocKind = (typeof DOC_KINDS)[number]

// A doc's list preview is its own first line, not a separate summary field —
// a blurb maintained beside the body is a second copy of the truth, and it is
// always the copy that goes stale.
const DOC_OPENERS: Record<DocKind, (f: string) => string> = {
  spec: f => `Defines how ${f} behaves: the states it can be in, the edge cases that have bitten us, and what a client may assume.`,
  runbook: f => `What to do when ${f} pages. First checks, how to roll it back safely, and who to wake if the rollback does not take.`,
  RFC: f => `Proposes reworking ${f}. The context, the three options we weighed, and the one this recommends — with the objections logged.`,
  guide: f => `A walkthrough of ${f} end to end, written for whoever is shipping their first change to it this week.`,
  postmortem: f => `What broke in ${f}: the timeline minute by minute, the contributing factors, and the action items with owners against them.`,
  notes: f => `Working notes on ${f} — open questions, the decisions we parked, and links back to the threads each one came out of.`,
  policy: f => `The rule of record for ${f}. What is allowed without review, what needs a second pair of eyes, and who ratifies a change to this.`,
  onboarding: f => `Everything needed to pick up ${f} in a first week: the glossary, who owns which piece, and a safe first task to land.`,
}

export const featuredDoc: Doc = {
  id: 'doc-rfc', title: 'refund request flow RFC', space: 'Payments', owner: 'Maya',
  excerpt: DOC_OPENERS.RFC('the refund request flow'),
  freshness: 'verified', proposals: 0, rev: 7, updated: 1,
}
export const docs: Doc[] = Array.from({ length: 520 }, (_, i) => {
  const r = rand()
  const freshness: Freshness = r < 0.055 ? 'stale' : r < 0.25 ? 'verified' : 'fresh'
  const feature = pick(FEATURES)
  const kind = pick(DOC_KINDS)
  return {
    id: `doc-${i + 1}`,
    title: `${feature} ${kind}`,
    space: pick(SPACES),
    owner: rand() < 0.2 ? 'Scribe' : pick(HUMANS),
    excerpt: DOC_OPENERS[kind](feature),
    freshness,
    proposals: freshness === 'stale' && rand() < 0.7 ? 1 : rand() < 0.04 ? 1 : 0,
    rev: int(2, 60),
    updated: freshness === 'stale' ? int(14, 90) : int(0, 21),
  }
})
docs.unshift(featuredDoc)


// A diagram is stored as this declarative spec — nodes and edges — and
// rendered deterministically by CommonIndex. The generating agent (any model)
// never emits HTML; that keeps diagrams diffable, safe, and re-renderable.
export const diagrams: Diagram[] = [
  {
    id: 'dgm-refund-flow', docId: 'doc-rfc', title: 'Refund request · service flow',
    generatedBy: 'Scribe', model: 'standard', rev: 3, stale: false,
    sources: ['refund request flow RFC §2–4', 'incident 2026-07-12 postmortem', 'payments-api README'],
    // x/y are part of the spec: the gaps are sized so edge labels sit in clear
    // air between boxes at any render scale.
    nodes: [
      { id: 'client', label: 'Client', sub: 'web / mobile', x: 20, y: 60, kind: 'client' },
      { id: 'gw', label: 'API gateway', sub: 'authz · idempotency', x: 240, y: 60, kind: 'svc' },
      { id: 'pay', label: 'payments-api', sub: 'refund handler', x: 460, y: 60, kind: 'svc' },
      { id: 'risk', label: 'risk-svc', sub: 'fraud check · sync', x: 460, y: 190, kind: 'svc' },
      { id: 'ledger', label: 'ledger', sub: 'double-entry store', x: 680, y: 60, kind: 'store' },
      { id: 'outbox', label: 'event outbox', sub: 'same transaction', x: 680, y: 190, kind: 'queue' },
      { id: 'hooks', label: 'webhook dispatcher', sub: 'retries · DLQ', x: 930, y: 190, kind: 'svc' },
      { id: 'merchant', label: 'Merchant endpoint', sub: 'external', x: 1180, y: 190, kind: 'ext' },
    ],
    edges: [
      { from: 'client', to: 'gw', label: 'POST /refunds' },
      { from: 'gw', to: 'pay', label: 'scoped token' },
      { from: 'pay', to: 'risk', label: 'check' },
      { from: 'pay', to: 'ledger', label: 'commit' },
      { from: 'ledger', to: 'outbox', label: 'refund.settled', async: true },
      { from: 'outbox', to: 'hooks', label: 'consume', async: true },
      { from: 'hooks', to: 'merchant', label: 'POST', async: true },
    ],
  },
]

// ── dashboards ─────────────────────────────────────────────────────────────
// Every panel keeps this much history; each window in the UI is a tail slice
// of it, which is why a stat tile and the line above it can never disagree.
export const HORIZON = 90

type MetricMeta = {
  unit: MetricUnit; better: MetricDir; base: number; noise: number
  ratified: boolean; agg: PanelAgg; source: MetricSource; expr: string
}
export type MetricSource = 'prometheus' | 'warehouse'

// Metrics Prometheus can answer. CommonIndex stores no time series and runs no PromQL:
// the metric object holds the *binding*, and the query executes read-only against
// your Prometheus through the connector. Two dashboards citing this metric send
// the identical expression, which is the whole point of binding rather than
// pasting a query into each panel.
const PROM_EXPR: Record<string, string> = {
  checkout_p95: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="checkout"}[5m])))',
  query_p95: 'histogram_quantile(0.95, sum by (le) (rate(search_query_duration_seconds_bucket[5m])))',
  settle_p95: 'histogram_quantile(0.95, sum by (le) (rate(refund_settle_duration_seconds_bucket[5m])))',
  build_p95: 'histogram_quantile(0.95, sum by (le) (rate(jenkins_build_duration_seconds_bucket[1h])))',
  error_rate: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
  errors: 'sum(increase(http_requests_total{status=~"5.."}[1d]))',
  requests: 'sum(increase(http_requests_total[1d]))',
  queries: 'sum(increase(search_queries_total[1d]))',
  sessions: 'sum(increase(session_started_total[1d]))',
  deploy_freq: 'sum(increase(argocd_app_sync_total{phase="Succeeded"}[1d]))',
  first_response: 'avg(support_first_response_seconds) / 60',
}

// Metrics only dashboards use. Deliberately kept out of METRIC_META: adding
// keys there would re-deal every experiment's target metric, and — more to the
// point — a few of these are *unratified*, which is a state the dashboard is
// supposed to show rather than hide.
/** The raw table. agg, source, and expr are all derived in metricMeta(). */
type DashMetric = Omit<MetricMeta, 'agg' | 'source' | 'expr'>
export const DASH_METRICS: Record<string, DashMetric> = {
  refunds_settled: { unit: 'count', better: 'down', base: 1240, noise: 0.07, ratified: true },
  refund_value: { unit: 'currency', better: 'down', base: 84.2, noise: 0.08, ratified: true },
  dispute_rate: { unit: 'pct', better: 'down', base: 0.42, noise: 0.1, ratified: true },
  settle_p95: { unit: 'count', better: 'down', base: 840, noise: 0.09, ratified: true },
  checkout_p95: { unit: 'count', better: 'down', base: 612, noise: 0.08, ratified: true },
  error_rate: { unit: 'pct', better: 'down', base: 0.31, noise: 0.12, ratified: true },
  order_value: { unit: 'currency', better: 'up', base: 62.5, noise: 0.05, ratified: true },
  zero_results: { unit: 'pct', better: 'down', base: 6.8, noise: 0.09, ratified: true },
  query_p95: { unit: 'count', better: 'down', base: 148, noise: 0.07, ratified: true },
  queries: { unit: 'count', better: 'up', base: 18400, noise: 0.08, ratified: true },
  sessions: { unit: 'count', better: 'up', base: 26800, noise: 0.08, ratified: true },
  errors: { unit: 'count', better: 'down', base: 1180, noise: 0.12, ratified: true },
  requests: { unit: 'count', better: 'up', base: 42000, noise: 0.07, ratified: true },
  signups: { unit: 'count', better: 'up', base: 2140, noise: 0.09, ratified: true },
  trial_starts: { unit: 'count', better: 'up', base: 486, noise: 0.1, ratified: true },
  first_response: { unit: 'count', better: 'down', base: 42, noise: 0.11, ratified: true },
  deflection_rate: { unit: 'pct', better: 'up', base: 38.4, noise: 0.06, ratified: true },
  agent_proposals: { unit: 'count', better: 'up', base: 214, noise: 0.09, ratified: true },
  agent_accept_rate: { unit: 'pct', better: 'up', base: 91.4, noise: 0.03, ratified: true },
  agent_spend: { unit: 'currency', better: 'down', base: 110, noise: 0.08, ratified: true },
  build_p95: { unit: 'count', better: 'down', base: 418, noise: 0.09, ratified: true },
  deploy_freq: { unit: 'count', better: 'up', base: 34, noise: 0.12, ratified: true },
  // Wired by hand against the warehouse, never put up for ratification. Two
  // dashboards using these can legitimately disagree — the panel says so.
  ticket_backlog: { unit: 'count', better: 'down', base: 268, noise: 0.13, ratified: false },
  nps_proxy: { unit: 'count', better: 'up', base: 41, noise: 0.08, ratified: false },
  churn_signal: { unit: 'pct', better: 'down', base: 3.1, noise: 0.14, ratified: false },
}

// How a metric collapses over a window is part of its definition, not a choice
// the panel gets to make — otherwise two dashboards sum and average the same
// metric and both call the answer "ARPU".
const METRIC_AGG: Record<string, PanelAgg> = {
  refunds_settled: 'sum', signups: 'sum', trial_starts: 'sum', deploy_freq: 'sum',
  agent_proposals: 'sum', support_tickets: 'sum', queries: 'sum', requests: 'sum',
  sessions: 'sum', errors: 'sum',
  refund_value: 'sum', order_value: 'sum', agent_spend: 'sum',
  arpu: 'mean', settle_p95: 'mean', checkout_p95: 'mean', query_p95: 'mean',
  build_p95: 'mean', first_response: 'mean', ticket_backlog: 'mean', nps_proxy: 'mean',
}

export function metricMeta(name: string): MetricMeta {
  const base: DashMetric = METRIC_META[name]
    ? { ...METRIC_META[name], ratified: true }
    : DASH_METRICS[name] ?? { unit: 'count', better: 'up', base: 100, noise: 0.08, ratified: false }
  const prom = PROM_EXPR[name]
  return {
    ...base,
    agg: METRIC_AGG[name] ?? (base.unit === 'pct' ? 'last' : 'mean'),
    source: prom ? 'prometheus' : 'warehouse',
    expr: prom ?? `metric('${name}')  -- semantic layer, read-only against the warehouse`,
  }
}

const hash = (s: string) => s.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)

function roundUnit(v: number, unit: MetricUnit) {
  const dp = unit === 'count' ? 0 : 2
  return Math.round(v * 10 ** dp) / 10 ** dp
}

// A day series with a weekly rhythm under the drift — real operational data
// breathes on a 7-day cycle, and the heatmap panel reads that cycle back out.
function daily(seed: number, m: MetricMeta, trend: number, weekly: number, scale = 1): number[] {
  const r = rng(seed)
  const out: number[] = []
  for (let i = 0; i < HORIZON; i++) {
    const t = i / (HORIZON - 1)
    const v = m.base * scale
      * (1 + trend * t)
      * (1 + weekly * Math.sin((i / 7) * Math.PI * 2))
      * (1 + (r() - 0.5) * 2 * m.noise)
    out.push(roundUnit(Math.max(v, 0), m.unit))
  }
  return out
}

type Topic = {
  label: string
  space: string
  stats: [string, string, string, string]
  /** Plotted per segment. A rate is measured *within* each segment; a volume splits across them. */
  primary: string
  /** A count or currency metric — the only kind you can honestly stack. */
  volume: string
  segments: [string, string, string]
  breakdown: string
  cats: string[]
  note: string
}

const TOPICS: Topic[] = [
  {
    label: 'refund operations', space: 'Payments',
    stats: ['refund_rate', 'refunds_settled', 'refund_value', 'dispute_rate'],
    primary: 'refund_rate', volume: 'refunds_settled', segments: ['checkout', 'support console', 'API'],
    breakdown: 'refund reason', cats: ['duplicate charge', 'item not received', 'changed mind', 'fraud hold', 'price dispute', 'other'],
    note: 'Refund rate is the ratified metric E-238 shipped against — same object, same definition, one revision.',
  },
  {
    label: 'checkout funnel', space: 'Checkout',
    stats: ['checkout_conversion', 'order_value', 'checkout_p95', 'error_rate'],
    primary: 'checkout_conversion', volume: 'sessions', segments: ['web', 'iOS', 'Android'],
    breakdown: 'drop-off step', cats: ['cart', 'address', 'payment', 'review', '3DS challenge', 'confirm'],
    note: 'Conversion is measured on the ratified definition, so this dashboard and every checkout experiment quote the same number.',
  },
  {
    label: 'search quality', space: 'Search',
    stats: ['search_ctr', 'zero_results', 'query_p95', 'retention_d30'],
    primary: 'search_ctr', volume: 'queries', segments: ['head queries', 'torso', 'tail'],
    breakdown: 'intent', cats: ['product', 'support', 'navigational', 'typo', 'long tail', 'unknown'],
    note: 'Zero-results is the guardrail E-231 is watching — the readout and this panel read the same series.',
  },
  {
    label: 'activation funnel', space: 'Growth',
    stats: ['activation_rate', 'signups', 'trial_starts', 'arpu'],
    primary: 'activation_rate', volume: 'signups', segments: ['organic', 'paid', 'referral'],
    breakdown: 'onboarding step', cats: ['signup', 'verify', 'first action', 'invite team', 'connect data', 'habit'],
    note: 'Activation is defined once and cited here; changing it is a proposal, not an edit to a saved query.',
  },
  {
    label: 'support load', space: 'Support',
    stats: ['support_tickets', 'first_response', 'deflection_rate', 'ticket_backlog'],
    primary: 'support_tickets', volume: 'support_tickets', segments: ['email', 'chat', 'in-product'],
    breakdown: 'contact reason', cats: ['billing', 'refunds', 'login', 'shipping', 'bug report', 'other'],
    note: 'Backlog is wired by hand against the warehouse — it is the one panel here nobody has ratified.',
  },
  {
    label: 'platform reliability', space: 'Platform',
    stats: ['error_rate', 'build_p95', 'deploy_freq', 'checkout_p95'],
    primary: 'error_rate', volume: 'errors', segments: ['payments-api', 'search-svc', 'web-app'],
    breakdown: 'error class', cats: ['timeout', 'validation', '5xx upstream', 'rate limited', 'auth', 'unknown'],
    note: 'Checks are objects, so deploy frequency counts the same events the merge queue records.',
  },
  {
    label: 'agent throughput', space: 'Platform',
    stats: ['agent_proposals', 'agent_accept_rate', 'agent_spend', 'deploy_freq'],
    primary: 'agent_proposals', volume: 'agent_proposals', segments: ['Scribe', 'Triage', 'Analyst'],
    breakdown: 'proposal kind', cats: ['doc sync', 'routing', 'readout', 'changelog', 'cleanup', 'other'],
    note: 'Agents are members, so their output is a first-class series here — the same events the scorecards count.',
  },
  {
    label: 'revenue quality', space: 'Payments',
    stats: ['arpu', 'order_value', 'churn_signal', 'retention_d30'],
    primary: 'arpu', volume: 'order_value', segments: ['new', 'returning', 'enterprise'],
    breakdown: 'plan', cats: ['free', 'starter', 'growth', 'business', 'enterprise', 'legacy'],
    note: 'Churn signal is unratified — it is a proxy, and the panel is labelled so nobody quotes it as the number.',
  },
  {
    label: 'retention cohorts', space: 'Growth',
    stats: ['retention_d30', 'activation_rate', 'nps_proxy', 'churn_signal'],
    primary: 'retention_d30', volume: 'signups', segments: ['week 0', 'week 4', 'week 12'],
    breakdown: 'cohort source', cats: ['organic', 'paid search', 'social', 'referral', 'partner', 'direct'],
    note: 'Two of these four are proxies. The certified badge is off for exactly that reason.',
  },
  {
    label: 'latency budget', space: 'Platform',
    stats: ['checkout_p95', 'query_p95', 'settle_p95', 'error_rate'],
    primary: 'checkout_p95', volume: 'requests', segments: ['checkout', 'search', 'refunds'],
    breakdown: 'surface', cats: ['web', 'mobile', 'API', 'partner', 'internal', 'batch'],
    note: 'One axis per panel — percentiles share a scale, latency and error rate never do.',
  },
  {
    label: 'dispute exposure', space: 'Payments',
    stats: ['dispute_rate', 'refund_value', 'refunds_settled', 'error_rate'],
    primary: 'dispute_rate', volume: 'refund_value', segments: ['card', 'wallet', 'bank transfer'],
    breakdown: 'network', cats: ['visa', 'mastercard', 'amex', 'discover', 'local', 'other'],
    note: 'Exposure is settled value, not count — the panel binds to the ratified value metric to keep those apart.',
  },
  {
    label: 'release health', space: 'Platform',
    stats: ['deploy_freq', 'build_p95', 'error_rate', 'agent_proposals'],
    primary: 'deploy_freq', volume: 'deploy_freq', segments: ['payments-api', 'web-app', 'infra'],
    breakdown: 'change type', cats: ['feature', 'fix', 'chore', 'revert', 'infra', 'agent-filed'],
    note: 'Reverts are a change type here because a revert is an event on the same object, not a separate system.',
  },
]

const DASH_QUALIFIERS = ['', ' · weekly review', ' · on-call view', ' · exec cut', ' · deep dive', ' · EU']
const DATASETS = ['warehouse.events', 'warehouse.orders', 'warehouse.tickets', 'graph.read_models', 'warehouse.sessions', 'graph.event_log']

/** The one place a panel's numbers come from. Seeded by (dashboard, metric,
 *  series) alone, so the collection row's preview and the dashboard's own KPI
 *  tile are literally the same array — they cannot drift apart. */
function seriesDaily(dashId: string, metric: string, name: string, scale: number): number[] {
  const m = metricMeta(metric)
  const seed = hash(`${dashId}:${metric}:${name}`)
  const trend = rng(seed ^ 0x9e37)()
  return daily(seed, m, (trend - 0.45) * 0.34, 0.1, scale)
}

export const dashboards: Dashboard[] = Array.from({ length: 64 }, (_, i) => {
  const n = 64 - i
  const topic = TOPICS[i % TOPICS.length]
  const qual = DASH_QUALIFIERS[Math.floor(i / TOPICS.length) % DASH_QUALIFIERS.length]
  const id = `dash-${n}`
  const r = rng(hash(id))
  const agentOwner = r() < 0.22
  // A dashboard is certified when every metric it cites has been ratified —
  // computed from the panels, never a badge somebody set by hand.
  const metrics = [...topic.stats, topic.primary, topic.volume].filter((m, k, a) => a.indexOf(m) === k)
  const certified = metrics.every(m => metricMeta(m).ratified)
  const head = metricMeta(topic.stats[0])
  const series = seriesDaily(id, topic.stats[0], 'all', 1)
  const win = series.slice(-30)
  const prev = series.slice(-60, -30)
  const cur = collapse(win, head.agg)
  const before = collapse(prev, head.agg)
  return {
    id,
    key: `D-${n}`,
    title: `${topic.label}${qual}`,
    space: topic.space,
    owner: agentOwner ? 'Analyst' : pick(HUMANS),
    agentOwner,
    rev: int(2, 40),
    updated: int(0, 12),
    refresh: pick(['every 5m', 'every 15m', 'hourly', 'live · event stream']),
    viewers: int(4, 180),
    proposals: r() < 0.28 ? 1 : 0,
    certified,
    panelCount: 9,
    metrics,
    headline: {
      metric: topic.stats[0], unit: head.unit, better: head.better,
      // Stored raw and formatted at the edge, exactly like the tile does it —
      // rounding here would make the row and the panel two different numbers.
      value: cur,
      delta: before === 0 ? 0 : Math.round(((cur - before) / before) * 1000) / 10,
    },
    spark: series.slice(-28),
  }
})

// Pinned so the inbox and the palette land on a dashboard that carries the
// readout its copy promises — same trick as featuredDoc and the pinned tests.
dashboards[0] = {
  ...dashboards[0],
  title: 'refund operations', space: 'Payments', owner: 'Maya', agentOwner: false,
  rev: 34, updated: 0, refresh: 'every 15m', viewers: 174, proposals: 1, certified: true,
}

const panelCache = new Map<string, Panel[]>()

/** Panels are built on open — the collection row never carries 90 days × 9 panels. */
export function panelsFor(d: Dashboard): Panel[] {
  const hit = panelCache.get(d.id)
  if (hit) return hit
  const topic = TOPICS.find(t => d.title.startsWith(t.label)) ?? TOPICS[0]
  const r = rng(hash(d.id) ^ 0x5f3a)
  const ds = () => DATASETS[Math.floor(r() * DATASETS.length)]

  // A metric that sums over time is a volume, and a volume *splits* across its
  // segments. A metric that averages or takes the last reading is a level, and
  // a level is measured inside each segment — each one sits near the base
  // rather than taking a slice of it. Getting this backwards is how a stacked
  // chart ends up claiming three times the traffic that exists.
  const scales = (metric: string, n: number) =>
    metricMeta(metric).agg === 'sum'
      ? shares(n)
      : Array.from({ length: n }, (_, k) => 1 + ((n - 1) / 2 - k) * 0.13)

  const build = (
    id: string, title: string, kind: PanelKind, metric: string, span: number,
    names: string[], note?: string,
  ): Panel => {
    const m = metricMeta(metric)
    const sc = scales(metric, names.length)
    return {
      id: `${d.id}-${id}`, title, kind, unit: m.unit, better: m.better,
      metric, ratified: m.ratified, source: m.source, expr: m.expr, dataset: ds(), span, agg: m.agg, note,
      series: names.map((name, k) => ({ name, daily: seriesDaily(d.id, metric, name, sc[k]) })),
    }
  }

  const label = (metric: string) => metric.replace(/_/g, ' ')
  const panels: Panel[] = [
    ...topic.stats.map((metric, k) => build(`kpi${k}`, label(metric), 'stat', metric, 3, ['all'])),
    build('trend', `${label(topic.primary)} by segment`, 'line', topic.primary, 8, topic.segments),
    build('breakdown', `${label(topic.volume)} by ${topic.breakdown}`, 'bar', topic.volume, 4, topic.cats),
    build('mix', `${label(topic.volume)} mix over time`, 'stacked', topic.volume, 7, topic.segments),
    build('volume', label(topic.stats[2]), 'area', topic.stats[2], 5, ['all']),
    build('rhythm', `${label(topic.volume)} · ${topic.breakdown} × weekday`, 'heat', topic.volume, 12, topic.cats,
      'Every panel keeps 90 days, so the weekly rhythm falls out of the same series the line above plots.'),
  ]
  panelCache.set(d.id, panels)
  return panels
}

// ── AI governance ──────────────────────────────────────────────────────────
// The register an auditor asks for, assembled from the graph. Every number here
// is a count over events this workspace already recorded, which is why it cannot
// drift from what the agents actually did.
export const oversight: AgentOversight[] = [
  {
    agentId: 'scribe',
    purpose: 'Keeps documentation consistent with the code that merged, as reviewable proposals.',
    model: 'standard', boundary: 'confidential',
    dataTouched: ['docs', 'code (read)', 'merge events'],
    touched7d: [{ type: 'doc', count: 61 }, { type: 'proposal', count: 74 }, { type: 'thread', count: 12 }],
    runs7d: 312, blocked7d: 4, undone7d: 2, grants: 3, skills: 5, paused: false,
  },
  {
    agentId: 'triage',
    purpose: 'Routes incoming work to the owner nearest it and assembles incident timelines.',
    model: 'compact', boundary: 'internal',
    dataTouched: ['PRs', 'incidents', 'channels', 'deploy events'],
    touched7d: [{ type: 'pr', count: 148 }, { type: 'task', count: 39 }, { type: 'incident', count: 6 }],
    runs7d: 906, blocked7d: 11, undone7d: 1, grants: 4, skills: 4, paused: false,
  },
  {
    agentId: 'analyst',
    purpose: 'Drafts experiment readouts and panel proposals against ratified metric definitions.',
    model: 'frontier', boundary: 'restricted',
    dataTouched: ['experiments', 'metrics', 'warehouse (read-only)', 'Prometheus (read-only)'],
    touched7d: [{ type: 'experiment', count: 38 }, { type: 'proposal', count: 21 }, { type: 'dashboard', count: 9 }],
    runs7d: 174, blocked7d: 2, undone7d: 0, grants: 5, skills: 6, paused: false,
  },
  {
    agentId: 'release',
    purpose: 'Drafts changelogs from merged PRs and requests deploy sign-off through the chain.',
    model: 'standard', boundary: 'internal',
    dataTouched: ['PRs', 'releases', 'docs'],
    touched7d: [{ type: 'doc', count: 8 }, { type: 'deploy', count: 16 }, { type: 'proposal', count: 11 }],
    runs7d: 44, blocked7d: 1, undone7d: 0, grants: 2, skills: 3, paused: false,
  },
]

export const oversightFor = (agentId: string) => oversight.find(o => o.agentId === agentId)


