export type ExpStatus = 'draft' | 'running' | 'readout' | 'shipped' | 'killed' | 'iterated'
export type Guardrail = 'clean' | 'watch' | 'breach'

export interface Experiment {
  id: string
  key: string // E-241
  name: string
  owner: string
  space: string
  metric: string
  /** What the test is actually asking, for the list preview — the line the
   *  owner wrote when they opened it, not a summary derived after the fact. */
  hypothesis: string
  status: ExpStatus
  day: number
  days: number
  lift: number | null // % on target metric, null until readout
  /** When the lift above was read — a figure without a date reads as current. */
  liftAt?: string | null
  guardrail: Guardrail
  updated: number // days ago
  /** Warehouse-backed: every number on the detail page is recomputed on read,
   *  and the readout may refuse to answer. A seeded row's lift is a fixture. */
  live?: boolean
  /** Carries a frozen contract, so `experiments.readout` will answer for it.
   *  Without one it cannot be read out at all. */
  preRegistered?: boolean
  amendments?: number
  /** Which direction is good for the cached lift, from the metric the readout
   *  cited. Carried on the row because orienting a lift needs it and the seed
   *  table only knows the seeded metrics — without it a refund-rate win files
   *  as a loss. */
  better?: 'up' | 'down'
  /** Who owns it, as an actor id — what "Mine" compares against. */
  ownerId?: string
  startedAt?: string | null
  endsAt?: string | null
  stoppedAt?: string | null
  /** Why it needs somebody, in words, from the gateway. Empty when it does not. */
  attention?: string[]
  decision?: ExperimentDecision | null
  /** The last recorded readout's split check, separate from guardrails. */
  srmPassed?: boolean | null
  /** The last recorded readout's interval on the lift, in percent. */
  liftCi?: [number, number] | null
  /** Units that readout counted. */
  units?: number | null
  verdict?: string | null
  /** The contract's minimum effect worth acting on, as a relative fraction. */
  mde?: number | null
}

export interface ExperimentDecision {
  outcome: 'ship' | 'kill' | 'iterate'
  rationale: string
  by: string
  at: string
  readout_id?: string | null
  decision_id: string
  lift?: number | null
}

// The readout series behind an experiment: one cumulative estimate per
// elapsed day, per arm. Stored as data — the chart is derived from it, the
// same way a diagram is derived from its spec.
export type MetricUnit = 'pct' | 'currency' | 'count'
export type MetricDir = 'up' | 'down' // which direction of the metric is good

/** One arm of an experiment. Same shape as PanelSeries so the two chart
 *  families read alike: a name and one value per elapsed day, oldest first. */
export interface MetricArm {
  name: string
  daily: number[]
  exposure: number
  /** Everything else is compared against this one. Exactly one arm has it. */
  baseline?: boolean
}

export interface MetricSeries {
  metric: string
  unit: MetricUnit
  better: MetricDir
  days: number // planned length — the x domain, even while the test is mid-flight
  /** Two or more. An experiment is not required to be A/B, and a chart that
   *  can only draw control-versus-variant quietly hides every arm past the
   *  second. */
  arms: MetricArm[]
}

export type CheckState = 'passed' | 'running' | 'failed'

export interface PR {
  id: string
  repo: string
  num: number
  title: string
  /** The opening of the description, for the list preview. */
  summary: string
  author: string
  agentAuthor: boolean
  status: 'open' | 'merged' | 'closed'
  checks: CheckState
  awaitingYou: boolean
  updated: number
}

export type Freshness = 'fresh' | 'stale' | 'verified'

export interface Doc {
  id: string
  title: string
  space: string
  owner: string
  /** The opening of the doc, for the list preview — what the page actually says,
   *  not a hand-written blurb, so it can never drift from the body. */
  excerpt: string
  freshness: Freshness
  proposals: number
  rev: number
  updated: number
  /** Written in the editor and stored on the gateway, rather than seeded. */
  live?: boolean
  /** A doc made into a full page: the page it now is. Its body is that one
   *  embed and no text, so its preview is the page, not an excerpt. */
  pageRef?: string
}

export interface AgentCard {
  id: string
  name: string
  role: string
  trust: 'propose-only' | 'auto-merge-minor' | 'autonomous'
  acceptance: number
  filed: number
  merged: number
  cost: string
  watching: string
  /** The human answerable for this agent's conduct. Every agent has one. */
  owner: string
}

// --- AI governance ---------------------------------------------------------
// The register an auditor asks for, generated from the graph rather than kept
// by hand: what each agent is for, who answers for it, what it may see, and
// what it actually touched.
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted'

export interface AgentOversight {
  agentId: string
  purpose: string
  model: ModelClass
  /** The highest classification this agent's model routing is allowed to see. */
  boundary: Classification
  dataTouched: string[]
  /** Blast radius: what it changed in the last 7 days, by object type. */
  touched7d: { type: string; count: number }[]
  runs7d: number
  blocked7d: number
  /** Merges of its work a human later undid — the number that matters most. */
  undone7d: number
  grants: number
  skills: number
  paused: boolean
}

export interface Counts {
  experiments: { total: number; running: number; readout: number }
  docs: { total: number; stale: number }
  dashboards: { total: number; proposals: number }
  skills: { total: number; installed: number; proposed: number }
  tasks: { total: number; review: number; flight: number }
}

export interface SearchHit {
  type: 'screen' | 'dashboard' | 'doc' | 'experiment' | 'design' | 'task' | 'channel' | 'agent' | 'skill' | 'comment'
    | 'code' | 'metric' | 'dataset' | 'run'
  title: string
  sub: string
  href: string
  /** Where the words matched, when that was not the title: a sentence in a
   *  doc, or what somebody said. */
  snippet?: string
  /** Found by what it said before an edit, not by what it says now. */
  earlier?: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: number | null
  total: number
}

/** How large a model an agent or skill runs on. */
export type ModelClass = 'frontier' | 'standard' | 'compact'

// --- diagrams: agent-generated visuals from docs, stored as spec not HTML ---
export interface DiagramNode {
  id: string
  label: string
  sub?: string
  x: number
  y: number
  kind?: 'svc' | 'store' | 'ext' | 'queue' | 'client'
  /** On an impact flow: this hop is what the proposal moves. */
  changed?: boolean
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string
  async?: boolean
  changed?: boolean
}

export interface Diagram {
  id: string
  docId: string
  title: string
  generatedBy: string
  model: ModelClass
  sources: string[]
  rev: number
  stale: boolean
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

// --- dashboards ------------------------------------------------------------
// Same contract as Diagram: a panel is a *spec* — a mark plus a binding to a
// ratified metric — never authored SQL and never authored markup. That is the
// whole difference from a typical BI tool: there, every chart re-derives
// its own numbers and two dashboards quietly disagree; here a panel cites a
// metric object, so the definition has one owner and one revision.
/** Program-level analysis: how the whole portfolio of experiments is doing.
 *  Every field here is an aggregate over experiment objects CommonIndex already holds
 *  — no warehouse query and no statistics engine, which is what makes this the
 *  in-plane half of "analyse the experiments". */
export interface ProgramStats {
  total: number
  draft: number
  running: number
  readout: number
  attention: number
  decided: number
  shipped: number
  killed: number
  /** Not shipped, followed up: "iterate" is its own outcome, not a kill. */
  iterated?: number
  winRate: number
  /** Median improvement of shipped tests, oriented so positive always means the variant won. */
  medianWin: number
  medianLoss: number
  /** Median planned run length of the tests that reached a decision, in days. */
  medianRun: number
  byMetric: { metric: string; shipped: number; killed: number; iterated?: number; rate: number }[]
  dist: { label: string; lo: number; shipped: number; killed: number; iterated?: number }[]
}

export type PanelKind =
  'stat' | 'line' | 'area' | 'stacked' | 'bar' | 'heat' | 'table' | 'sql'
  | 'pie' | 'gauge' | 'pivot'
/** What the SERVER stores, which is not quite what the renderer branches on:
 *  the database holds `heatmap` and the client calls the same thing `heat`.
 *  Anything travelling over the wire is this type; `PanelKind` is for what is
 *  already here. Conflating them typed an authoring draft in the renderer's
 *  vocabulary, so `heatmap` could not be sent even once it was offered. */
export type StoredMark =
  'stat' | 'line' | 'area' | 'stacked' | 'bar' | 'heatmap' | 'table' | 'sql'
  | 'pie' | 'gauge' | 'pivot'
/** How a window of days collapses into the one number a panel quotes. */
export type PanelAgg = 'last' | 'sum' | 'mean'

export interface PanelSeries {
  name: string
  /** One value per bucket; live series share bucketDates. NaN means missing,
   *  not zero. Legacy samples use a daily tail slice. */
  daily: number[]
}

export interface Panel {
  id: string
  title: string
  kind: PanelKind
  unit: MetricUnit
  better: MetricDir
  /** The ratified metric this panel binds to; '' when someone wired it by hand. */
  metric: string
  ratified: boolean
  /** Where the number comes from, and the exact query the binding resolves to. */
  source: 'prometheus' | 'warehouse'
  expr: string
  dataset: string
  /** Columns out of 12. */
  span: number
  /** Starting column 1..12; absent, it follows the panel before it. */
  col?: number
  /** Pixels of PLOT, when somebody has said. Not grid rows: the grid's rows
   *  are auto-sized to their content, so a row unit would be a unit whose size
   *  depends on what is in the row beside it. */
  height?: number
  agg: PanelAgg
  series: PanelSeries[]
  note?: string
  /** A panel that carries its own query returns rows rather than a series, and
   *  cites no ratified definition — which is why the dashboard holding it
   *  reports itself uncertified. Both are true and both are said out loud. */
  sql?: string
  columns?: string[]
  rows?: (string | number | null)[][]
  /** What slice this card is actually showing, and what the dashboard asked
   *  for that it could not. The second is the one that matters: a card showing
   *  a total on a page captioned "EMEA" is the failure this makes visible. */
  /** What each entry of `series[].daily` covers — `day`, `week`, `month`. The
   *  array index is a BUCKET ordinal, not a day offset, and everything that
   *  assumed otherwise dated its values wrongly. */
  grain?: string
  /** The real bucket start dates, one per entry of `daily`. Carried rather
   *  than reconstructed from the index. */
  bucketDates?: string[]
  /** The server has already applied the selected range; do not slice again. */
  windowed?: boolean
  /** Each series over the window just before, when a comparison was asked. */
  previous?: number[][]
  filtersApplied?: { dimension: string; op: string; values: unknown[] }[]
  filtersSkipped?: { dimension: string; op: string; values: unknown[]; why: string }[]
}

/** The collection row. Panels are built on open — see panelsFor(). */
export interface DashboardPreviewPanel {
  id: string
  title: string
  mark: string
  span?: number | null
  height?: number | null
}

export interface Dashboard {
  id: string
  key: string // D-12
  title: string
  space: string
  owner: string
  agentOwner: boolean
  rev: number
  updated: number
  refresh: string
  viewers: number // distinct readers in 7d
  proposals: number // open panel proposals, agent-filed
  /** Every panel binds to a ratified metric. */
  certified: boolean
  /** Panels that cite no ratified definition, and how many of those carry
   *  their own query — which cite no definition at all. */
  uncertified?: number
  queries?: number
  panelCount: number
  /** Layout only; contains no query results or SQL text. */
  previewPanels?: DashboardPreviewPanel[]
  metrics: string[]
  /** Registry labels, with exact identifiers retained for search and inspection. */
  metricReferences?: { id: string; label: string }[]
  approvedMetricCount?: number
  connectionId?: string | null
  /** Definition change time, never a claim about warehouse data freshness. */
  definitionUpdatedAt?: string | null
  headline: { metric: string; unit: MetricUnit; value: number; delta: number; better: MetricDir }
  /** 28-day preview for the list row — the collection shows shape, not just names. */
  spark: number[]
  /** Backed by a warehouse the gateway queries on open, rather than by seed
   *  data. Both kinds live in one collection: where a number comes from is a
   *  property of the dashboard, not a reason to put it on a different screen. */
  live?: boolean
}

// --- skills ----------------------------------------------------------------
// What an agent knows how to do, as an object: versioned, reviewable, and
// scoped. Installing one is a grant — the scopes it asks for go through the
// same ratification path as any other permission change.
export type SkillStatus = 'installed' | 'available' | 'proposed' | 'draft' | 'deprecated'
export type SkillSource = 'workspace' | 'vendor' | 'community'

export interface SkillFile {
  path: string
  lines: number
  /** Present on generated skills, where the content is derived and therefore
   *  always available. A seeded skill lists its files without them. */
  body?: string
}

export interface Skill {
  id: string
  key: string // SK-14
  name: string // kebab-case, the address
  title: string
  summary: string
  source: SkillSource
  author: string
  agentAuthor: boolean
  status: SkillStatus
  rev: number
  installedOn: string[] // agent names
  scopes: string[] // permissions the skill needs to run
  tools: string[] // MCP tools it calls
  triggers: string[] // what makes it fire
  runs7d: number
  /** % of its proposals merged unchanged — null until it has run here. */
  acceptance: number | null
  p50: string
  cost: string
  model: ModelClass
  updated: number
  files: SkillFile[]
  /** Derived from the registry rather than authored — so it has no revision to
   *  diff and no author to ask, and the page says so instead of showing empty
   *  fields where those would be. */
  generated?: {
    from: { datasets: number; definitions: number; dashboards: number }
    unratified: number
  }
  body: string[]
  /** Set when the skill wants scopes nobody has granted it yet. */
  blocked?: string
}
