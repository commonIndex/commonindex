// The seam where the seeded prototype ends and the real backend begins.
//
// Everything else in `data/` is generated in the browser. This module talks to
// the gateway over the same JSON operations an agent calls — the operation name
// IS the tool name IS the URL path — so a dashboard built here and a dashboard
// built by an agent go through one code path on the server.
//
// A dashboard that lives on the gateway is marked `live` and rendered from the
// warehouse; the seeded ones keep working untouched, which is what lets the two
// sit in one collection instead of two.

import type { Dashboard, MetricDir, MetricUnit, Panel, PanelKind, Skill, StoredMark } from './types'

// The app's own address by default: its web server (vite in development, nginx
// in production) forwards the gateway's paths, so the browser uses one port.
// VITE_GATEWAY_URL points it at a gateway somewhere else instead.
export const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? ''

/** The bearer token this browser session acts as.
 *
 *  Every operation requires one — an actor id in the request body is not a
 *  credential, it is the caller naming itself, which is what this replaces.
 *  Mint one with `uv run python scripts/mint_token.py <actor>` and put it in
 *  `web/.env.local` as VITE_COMMONINDEX_TOKEN.
 *
 *  A token in a Vite env var is baked into the bundle, so this is a DEV
 *  arrangement only: in a real deployment the token is a session cookie or an
 *  OIDC exchange, never a build-time constant. */
const DEV_TOKEN = import.meta.env.VITE_COMMONINDEX_TOKEN ?? ''
const SESSION = 'commonindex.token'

/** A token this browser sends: one pasted on the sign-in page, or, in
 *  development, the one in web/.env.local until this browser signs out. A
 *  person who signed in with a link or single sign-on holds a session cookie
 *  instead — the browser sends it, and this code never sees it. */
const SIGNED_OUT_KEY = 'commonindex.signed-out'

export function sessionToken(): string {
  try {
    return localStorage.getItem(SESSION) || (localStorage.getItem(SIGNED_OUT_KEY) ? '' : DEV_TOKEN)
  } catch { return DEV_TOKEN }
}

/** Fired when the gateway says the caller is not signed in, so the app can
 *  send the person to sign in rather than show errors everywhere. */
export const SIGNED_OUT = 'commonindex:signed-out'

/** How this deployment signs people in, asked before anyone has. */
export type AuthConfig = {
  methods: { google: boolean; sso: { name: string } | null; email: boolean; proxy: boolean; code: boolean }
}
export async function authConfig(): Promise<AuthConfig> {
  const r = await fetch(`${GATEWAY}/auth/config`, { credentials: 'include' })
  if (!r.ok) throw new GatewayError(`http_${r.status}`, `the gateway returned ${r.status}`)
  return await r.json() as AuthConfig
}

/** Where "Continue with …" goes: the gateway, then Google or the company's
 *  identity provider. */
export const ssoStart = (provider: 'google' | 'sso', returnTo = '/') =>
  `${GATEWAY}/auth/sso/start?provider=${provider}&return_to=${encodeURIComponent(returnTo)}`

async function auth<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${GATEWAY}${path}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await r.json().catch(() => null)
  if (!r.ok) throw new GatewayError(json?.error?.code ?? `http_${r.status}`, json?.error?.message ?? `the gateway returned ${r.status}`)
  return json as T
}

/** Send a sign-in code to this address. The answer is the same whether or
 *  not the address may sign in — the page is not a way to learn who is in. */
export const emailStart = (email: string) => auth<{ sent: boolean; email: string; minutes: number }>('/auth/email/start', { email })

/** The code typed, or the link from the email: a session. */
export async function emailVerify(by: { email: string; code: string } | { link: string }): Promise<WireMe> {
  const me = await auth<WireMe>('/auth/email/verify', by)
  try { localStorage.removeItem(SESSION) } catch { /* nothing kept */ }
  signedIn()
  return me
}

function signedIn() {
  try { localStorage.removeItem(SIGNED_OUT_KEY) } catch { /* private window */ }
  forgetWhoAmI()
}

/** Sign in with what an admin sent: a one-time sign-in code (what an
 *  invitation link carries), or a token. A code buys a session cookie and is
 *  spent; a token is checked and kept for this browser. */
export async function signIn(value: string): Promise<WireMe> {
  const v = value.trim()
  if (!v.startsWith('ci_')) {
    const r = await fetch(`${GATEWAY}/auth/redeem`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: v }),
    })
    const json = await r.json().catch(() => null)
    if (r.status === 401) throw new GatewayError('bad_code', json?.error?.message ?? 'That sign-in link has been used or has expired.')
    if (!r.ok) throw new GatewayError(`http_${r.status}`, `the gateway returned ${r.status}`)
    try { localStorage.removeItem(SESSION) } catch { /* nothing kept */ }
    signedIn()
    return json as WireMe
  }
  const r = await fetch(`${GATEWAY}/api/v1/actors.me`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${v}` },
    body: '{}',
  })
  if (r.status === 401) throw new GatewayError('bad_credentials', 'That token is not valid. Ask an admin for a new sign-in link.')
  if (!r.ok) throw new GatewayError(`http_${r.status}`, `the gateway returned ${r.status}`)
  try { localStorage.setItem(SESSION, v) } catch { /* private window: this tab only */ }
  signedIn()
  return await r.json() as WireMe
}

/** Sign out: the session ends on the server, not only in this browser. */
export async function signOut() {
  try { await fetch(`${GATEWAY}/auth/logout`, { method: 'POST', credentials: 'include' }) } catch { /* offline: still forget it here */ }
  try { localStorage.removeItem(SESSION); localStorage.setItem(SIGNED_OUT_KEY, '1') } catch { /* nothing kept */ }
  forgetWhoAmI()
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    /** Whatever the specific failure knows that a code and a field cannot
     *  hold — a parse error's line and column, which the editor points at
     *  rather than making somebody re-read their own query. */
    readonly at?: { line: number; col: number; token?: string },
  ) {
    super(message)
  }
}

async function op<T>(name: string, body: unknown, prefer?: string): Promise<T> {
  const r = await fetch(`${GATEWAY}/api/v1/${name}`, {
    method: 'POST',
    // The session cookie of a person signed in with a link or single sign-on.
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken() ? { authorization: `Bearer ${sessionToken()}` } : {}),
      ...(prefer ? { prefer } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await r.json().catch(() => null)
  return answered<T>(r.status, r.ok, json)
}

/** An operation that waits on a model, asked for as `Prefer: respond-async`:
 *  the gateway queues it and answers with a job, read here until it is done.
 *  An answer held open for a minute or more was cut off by any load balancer
 *  with the usual 60-second limit, and the model's work lost with it. A
 *  gateway that answers at once is used as it is. */
async function opAsync<T>(name: string, body: unknown): Promise<T> {
  const first = await op<{ job_id?: string; state?: string } & T>(name, body, 'respond-async')
  const job = (first as { job_id?: string })?.job_id
  if (!job || (first as { state?: string }).state !== 'queued') return first as T
  const started = Date.now()
  for (let wait = 700; Date.now() - started < 25 * 60_000; wait = Math.min(wait * 1.4, 3000)) {
    await new Promise(res => setTimeout(res, wait))
    const j = await op<{ state: string; result?: { status: number; body: unknown }; error?: string }>(
      'jobs.get', { job_id: job })
    if (j.state === 'done' && j.result) {
      const ok = j.result.status >= 200 && j.result.status < 300
      return answered<T>(j.result.status, ok, j.result.body)
    }
    if (j.state === 'failed') throw new GatewayError('job_failed', j.error || `${name} did not finish`)
  }
  throw new GatewayError('job_timeout', `${name} is taking longer than 25 minutes`)
}

/** A response, as an answer or as the typed error the gateway gave. */
function answered<T>(status: number, ok: boolean, json: unknown): T {
  const r = { status, ok }
  if (r.status === 401) {
    // Distinguished from a general failure because the fix is specific and the
    // message would otherwise read as "the gateway is down".
    // A token the gateway no longer takes is forgotten, not offered again.
    try { localStorage.removeItem(SESSION) } catch { /* nothing kept */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT))
    throw new GatewayError('no_credentials', 'Sign in to continue.')
  }
  if (!r.ok) {
    // The gateway returns typed errors — a code and the field that caused it —
    // so a form can put the message next to the control instead of showing a
    // status number and making the author guess.
    const e = (json as { error?: { code?: string; message?: string; field?: string
      at?: ConstructorParameters<typeof GatewayError>[3] } } | null)?.error
    throw new GatewayError(e?.code ?? `http_${r.status}`,
      e?.message ?? `gateway returned ${r.status}`, e?.field, e?.at)
  }
  return json as T
}

// ── wire types ──────────────────────────────────────────────────────────

export type WirePoint = [string, number | null]
export interface WireSeries { name: string; points: WirePoint[] }
export interface WirePanel {
  panel: {
    id: string; title: string; mark: string
    /** Null on a panel that carries its own query: it cites no definition,
     *  which is the point of that panel. Typed `string` here, this was a
     *  crash the compiler could not see. */
    metric_id: string | null
    dataset_id: string; grain?: string
    /** Columns out of 12, or null when nobody has said and the client's
     *  heuristic decides. */
    span?: number | null
    /** Starting column 1..12, or null to follow the panel before it. */
    col?: number | null
    /** Plot height in pixels, or null for the default. */
    height?: number | null
  }
  label?: string
  unit: string | null
  better: string | null
  series?: WireSeries[]
  /** The same panel over the window just before, when a comparison was asked. */
  previous?: WireSeries[]
  error?: string
  status?: string
  /** Which warehouse this panel read, where it is not the dashboard's own. */
  connection_id?: string
  /** A panel that carries its own query returns ROWS, not a series: an
   *  arbitrary SELECT has no metric and no guaranteed shape. */
  sql?: string
  columns?: string[]
  rows?: (string | number | null)[][]
  /** Which of the dashboard's filters this panel could answer, and which it
   *  could not. A dashboard where two of six panels quietly ignored the filter
   *  looks exactly like one where all six honoured it — this is the difference. */
  filters_applied?: WireFilter[]
  filters_skipped?: (WireFilter & { why: string })[]
}
/** A WHERE clause as data. The operator is a name from a closed table, never a
 *  fragment, so nothing typed here reaches the statement as SQL. */
export interface WireFilter {
  dimension: string
  op: FilterOp
  values: (string | number | boolean | null)[]
  /** Which panels this filter is for. Absent means every panel whose dataset
   *  declares the column, which is right almost always — this is for two
   *  tables that share a column NAME meaning two different things. It narrows
   *  what the dataset would have allowed and never widens it. */
  panels?: string[]
}
export interface FilterColumn { name: string; kind: string }
export type FilterOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in'
  | 'contains' | 'starts_with' | 'is_null' | 'is_not_null' | 'between'
export interface WireDash {
  dashboard: { id: string; title: string; range: string
               connection_id: string | null; dataset_id: string | null }
  certified: boolean
  /** Panels citing a definition nobody has ratified. This is what `certified`
   *  is computed from — a claim about DEFINITIONS. */
  unratified: string[]
  /** Panels that could not run: a dropped table, a timeout, a revoked grant.
   *  Kept apart because the two need different sentences and different fixes,
   *  and because a query failing today does not un-ratify anything. */
  failed?: string[]
  panels: WirePanel[]
  window_days: number
  /** The window the range resolved to, and the one compared against. */
  window?: { start: string; end: string }
  previous_window?: { start: string; end: string }
  /** Echoed back, so the slice these numbers were taken under travels with
   *  them rather than living only in the URL bar. */
  filters: WireFilter[]
  /** The panels that could not honour the bar. The headline version of the
   *  per-panel detail above. */
  filters_partial: string[]
  /** The columns this dashboard can be sliced by — the union across its
   *  panels' datasets, computed by the render that just resolved them, each
   *  with the kind that decides which operators mean anything for it. */
  filterable: FilterColumn[]
  /** The slice the dashboard OPENS on, set by whoever built it. Distinct from
   *  `filters`, which is what this read actually applied: they differ the
   *  moment a reader changes or clears one. */
  default_filters?: WireFilter[]
}
export interface WireConnection {
  id: string; name: string; kind: string; dsn: string
  read_only: boolean; impersonation: boolean
  checked_at: string | null; last_error: string | null
}
export interface WireColumn { name: string; kind: string }
export interface WireDataset {
  id: string; physical: string; is_virtual: boolean
  time_column: string | null
  times: string[]
  grains: string[]
  columns: WireColumn[]
  measures: string[]
  slices: string[]
}
export interface WireListRow {
  id: string; key: string; title: string; panel_count: number
  certified: boolean; unratified: number
  /** How many of the uncertified panels carry their OWN query. They cite no
   *  metric at all, so "unratified metric" is the wrong words for them. */
  queries?: number
  preview_panels?: import('./types').DashboardPreviewPanel[]
  metrics: string[]
  metric_labels?: Record<string, string>
  approved_metrics?: number
  connection_name?: string | null
  owner: string; connection_id: string | null; updated_at: string | null
}

// ── operations ──────────────────────────────────────────────────────────

/** Who the workspace thinks is authoring. Sent explicitly rather than defaulted
 *  server-side, because the default was an agent id — and an agent may not
 *  ratify its own definitions, so everything a person built arrived unratified. */
export const ME = 'alex'

/** What the search actually did, not just what it found.
 *
 *  Carried through to the page on purpose: an answer drawn from one repository
 *  out of six, or from the degraded text index, is a weaker claim than the same
 *  answer drawn from everything — and the reader has no way to tell them apart
 *  from the prose alone. */
export interface CodeContext {
  engine?: string
  context: { citation: string; repo: string; path: string; snippet: string
             stale?: boolean
             /** The file, and the lines cited — enough to open it there. */
             object_id?: string; start_line?: number | null; end_line?: number | null }[]
  routing?: string
  /** Set when the precise code index was unavailable and a weaker full-text
   *  search answered instead. Recall is materially worse. */
  degraded?: string | null
  searched_repos: string[]
  selected_repos: { repo: string; files: number; score: number }[]
  /** Known but never indexed — silence from these is not evidence of absence. */
  unindexed_repos?: string[]
  /** Readable, but outside the repositories the question named — not a
   *  permissions fact. Only ever non-zero when the caller narrowed. */
  withheld_repos?: number
  truncated?: boolean
}

export interface CodeAnswer {
  /** Exactly what the model said, unformatted — for a caller that wants to
   *  post-process the prose rather than read it. */
  answer: string
  /** The same answer as a markdown document: the prose under a heading, the
   *  validated flow as a ```mermaid fence, the citations as a list and the
   *  routing as a table. This is what the view renders. */
  markdown?: string
  citations: string[]
  model?: string | null
  context?: CodeContext
  /** The validated flow specification the mermaid fence was written from. Kept
   *  on the wire because it is the contract the server checks; the diagram the
   *  reader sees is drawn from the markdown. */
  diagram: { title: string; nodes: { id: string; label: string; kind: string }[]
             edges: { from: string; to: string; label: string }[] } | null
}

export interface CodeRepo {
  repo: string
  repo_id: string
  branch: string
  health: string
  last_indexed_at: string | null
}

export const askCode = (q: string, include_diagram: boolean, repos?: string[]) =>
  opAsync<CodeAnswer>('code.ask', repos?.length ? { q, include_diagram, repos }
                                           : { q, include_diagram })

/** A repository being indexed from the page — or that failed to be. */
export interface CodeIndexJob {
  path: string
  repo: string
  source?: 'url' | 'path'
  state: 'indexing' | 'ready' | 'failed'
  step?: string | null
  started_at: string
  finished_at: string | null
  error: string | null
}

export const listCodeRepos = () =>
  op<{ repos: CodeRepo[]; count: number; indexing?: CodeIndexJob[]; may_index?: boolean;
       may_index_paths?: boolean }>('code.list_repos', {})

/** What to index: a repository URL (with a token for a private one), or a
 *  clone's folder on the gateway's machine. */
export type CodeIndexSource = { url: string; branch?: string; token?: string } | { path: string }

/** Index a repository; progress shows in listCodeRepos. */
export const indexCodeRepo = (source: CodeIndexSource) =>
  op<{ job: CodeIndexJob; already: boolean }>('code.index', { ...source, idempotencyKey: said('index') })

export interface CodeFile {
  object_id: string; repo: string; path: string; sha: string | null
  start_line: number; end_line: number; body: string; truncated: boolean; citation: string
}

/** One indexed file — the whole of it, up to the gateway's limit. */
export const getCodeFile = (object_id: string) =>
  op<CodeFile>('code.get_file', { object_id, max_chars: 50_000 })

export const listLive = () => op<{ dashboards: WireListRow[] }>('dashboards.list', {})
export interface ColumnValues {
  column: string
  kind: string
  values: { value: string | number | boolean | null; rows: number }[]
  /** A number's span, where a list of distinct floats is not a list anyone
   *  wants and what you need is that it runs from 3 to 30. */
  min: number | null
  max: number | null
  /** Which datasets answered. A dashboard spans them, and a value in one is
   *  not necessarily in another. */
  from: string[]
  /** Said out loud rather than presenting the top N as the whole set. */
  truncated: boolean
  errors: string[]
}

/** What a column actually contains, so a filter can be CHOSEN.
 *
 *  The bar made you type it blind: to slice by region you had to already know
 *  the column holds `emea` and not `EMEA` or `eu-west`, and a typo returns an
 *  empty chart rather than an error. */
export const columnValues = (dashboard_id: string, column: string, range: string) =>
  op<ColumnValues>('columns.values', { dashboard_id, column, range })

export const renderLive = (dashboard_id: string, range: string,
                           filters: WireFilter[] = [], compare = false) =>
  op<WireDash>('dashboards.render', { dashboard_id, range, filters, ...(compare ? { compare } : {}) })

/** The windows the server accepts, in its order. Kept here as the one list the
 *  picker renders — the server rejects anything else, so a copy that drifts
 *  shows the reader an option that 422s. */
export const RANGES = ['1d', '7d', '14d', '30d', '60d', '90d', '180d', '365d'] as const

/** How each operator reads in a sentence, for the chip on the filter bar. */
export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is', ne: 'is not', gt: 'more than', gte: 'at least', lt: 'less than',
  lte: 'at most', in: 'is one of', not_in: 'is not one of', contains: 'contains',
  starts_with: 'starts with', is_null: 'is empty', is_not_null: 'is not empty',
  between: 'between',
}

/** Which operators are worth offering for a column of this kind.
 *
 *  All thirteen used to be offered for every column, so the list included
 *  `contains` on a float and `between` on a status — a reader had to know the
 *  schema to tell which of them meant anything for the column they had just
 *  picked, and picking wrong produces a query that runs and answers nothing.
 */
export function opsFor(kind: string): FilterOp[] {
  const empty: FilterOp[] = ['is_null', 'is_not_null']
  if (kind === 'number') {
    // Equality on a measure is the one everybody warns about and it stays,
    // because an integer column — a count, a rating, a status code — is a
    // number you legitimately match exactly. It is simply not first.
    return ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'ne', ...empty]
  }
  if (kind === 'bool') return ['eq', 'ne', ...empty]
  if (kind === 'time') return ['gte', 'lte', 'between', ...empty]
  return ['eq', 'ne', 'in', 'not_in', 'contains', 'starts_with', ...empty]
}
// ── agents ──────────────────────────────────────────────────────────────
//
// The platform has had real agent identity for a while — an `actors` row with a
// kind and a trust tier, hashed revocable tokens, ReBAC grants per space, and
// `_may_ratify` reading the tier so an agent's definitions arrive PROPOSED
// where a person's arrive ratified. What it did not have was any way to see it,
// and the agents page was generated in the browser: acceptance, cost, what it
// was watching, all of it fiction.

export interface WireGrant {
  relation: string
  resource: string
  expires_at: string | null
  /** Never used is the safest revocation there is, and it only shows up
   *  because `require` stamps the grant that satisfied each check. */
  last_used: string | null
}

export interface WireAgent {
  id: string
  display: string
  trust_tier: 'propose-only' | 'auto-merge-minor' | 'autonomous'
  /** Null is a real answer. An agent nobody answers for is the finding, not a
   *  blank to be filled in with the first plausible name. */
  owner: { id: string; display: string; kind: string } | null
  created_at: string
  grants: WireGrant[]
  /** The one-line version of the grants: what it may do in this space. */
  may: string[]
  tokens: { count: number; last_used: string | null; next_expiry: string | null }
  /** What it has authored here, by object type, from `objects.created_by`. */
  authored: Record<string, number>
  defined: { metrics: number; ratified: number }
  /** The rule `_may_ratify` applies — the whole difference the tier makes. */
  may_ratify_own_work: boolean
  /** `agents.get` only: the most recent objects it made, which is the honest
   *  version of an activity feed while `events` has never been written to. */
  recent?: { id: string; type: string; title: string; created_at: string }[]
}

export interface WirePerson { id: string; display: string; agents_owned: number
  /** How an item is shared with them. */
  email?: string | null
}

export const listPeople = () => op<{ people: WirePerson[] }>('people.list', {})

export interface NewAgent {
  agent_id: string
  display?: string
  /** Whoever creates it, when not given. */
  owner_id?: string
  trust_tier?: string
  grant?: { relation: string; resource: string; days?: number }
  token_label?: string
  expires_days?: number
}

/** The token comes back ONCE. Only its SHA-256 is stored, so there is no
 *  operation that can show it again — replacing it is the only recovery. */
export const createAgent = (a: NewAgent) =>
  op<{ agent_id: string; token: string; token_note: string
       granted: { relation: string; resource: string } | null }>(
    'agents.create', { ...a, idempotencyKey: `agent:${a.agent_id}` })

export const revokeAgent = (agent_id: string) =>
  op<{ agent_id: string; tokens_destroyed: number; grants_removed: number; note: string }>(
    'agents.revoke', { agent_id, idempotencyKey: `revoke:${agent_id}:${Date.now()}` })

export const listAgentsLive = () => op<{ agents: WireAgent[] }>('agents.list', {})
export const getAgentLive = (agent_id: string) =>
  op<{ agent: WireAgent }>('agents.get', { agent_id })

export interface WireAsk {
  seq: number
  asked_by: string
  asked_at: string
  note: string
  object: { id: string; type: string; title: string } | null
}

/** Tagging an agent on something. This writes an EVENT — nothing starts. The
 *  agent picks it up when it next connects, which is the only honest thing to
 *  show a person when the process that runs the agent is not one this platform
 *  owns or can wake.
 *
 *  The key is derived from what is being asked rather than from the clock, so
 *  a double-submit is one ask and the second returns the first. */
export const askAgent = (a: { agent_id: string; note: string; object_id?: string }) =>
  op<{ seq: number; agent_id: string; repeat: boolean; note: string }>(
    'agents.ask',
    { ...a, idempotencyKey: `ask:${a.agent_id}:${a.object_id ?? '-'}:${hashNote(a.note)}` })

/** Enough to separate two different asks, and stable across a retry of the
 *  same one — which is the whole requirement. */
function hashNote(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const agentInbox = (agent_id?: string) =>
  op<{ agent_id: string; asks: WireAsk[] }>('agents.inbox', agent_id ? { agent_id } : {})

export const listConnections = () => op<{ connections: WireConnection[] }>('connections.list', {})
export interface NewConnection {
  name: string; kind: string
  host?: string; port?: number; database: string
  user?: string; password?: string
}
export const createConnection = (c: NewConnection) =>
  op<{ connection_id: string; name: string; kind: string; dsn: string; status: string; detail: string }>(
    'connections.create', { actor_id: ME, idempotencyKey: `${c.kind}:${c.host ?? ''}:${c.database}:${c.name}`, ...c })

export const checkConnection = (connection_id: string) =>
  op<{ connection_id: string; ok: boolean; detail: string }>('connections.check', { connection_id })

export const introspect = (connection_id: string) =>
  op<{ connection: { id: string; name: string; kind: string }; datasets: WireDataset[] }>(
    'datasets.introspect', { connection_id })
export interface SqlPreview {
  columns: { name: string; kind: string }[]
  rows: (string | number | boolean | null)[][]
  row_count: number
  truncated: boolean
  times: string[]
}
export const previewSql = (connection_id: string, sql: string) =>
  op<SqlPreview>('datasets.preview_sql', { connection_id, sql })

export const saveVirtualDataset = (connection_id: string, name: string, sql: string,
                                   time_column: string | null) =>
  op<{ dataset_id: string; name: string; time_column: string | null
       columns: { name: string; kind: string }[] }>(
    'datasets.create_virtual',
    { connection_id, name, sql, time_column, actor_id: ME,
      idempotencyKey: `${connection_id}:${name}` })

// ── editing a dashboard that already exists ─────────────────────────────

export interface WireMetric {
  id: string; version: number; label: string; expr: string
  unit: string | null; better: string | null; dataset: string | null; status: string
}
export const listMetrics = (dataset_id?: string) =>
  op<{ metrics: WireMetric[] }>('metrics.list', { dataset_id })

/** Put the panels in the order they should be read.
 *
 *  The WHOLE order goes over, not a from/to pair: a drag is one intent, and
 *  applying it as pairwise moves leaves the stored order briefly neither the
 *  old one nor the new one. */
/** Set how wide panels are. `null` puts one back on the heuristic, which is
 *  the only way to undo a resize without guessing what the guess would be. */
export const resizePanels = (
  dashboard_id: string,
  spans: Record<string, number | null>,
  heights: Record<string, number | null> = {},
  cols: Record<string, number | null> = {},
) =>
  op<{ dashboard_id: string; spans: Record<string, number | null> }>(
    'panels.resize', { dashboard_id, spans, heights, ...(Object.keys(cols).length ? { cols } : {}),
                       idempotencyKey: `resize:${dashboard_id}:${Date.now()}` })

export const reorderPanels = (dashboard_id: string, panel_ids: string[]) =>
  op<{ dashboard_id: string; panel_ids: string[] }>(
    'panels.reorder', { dashboard_id, panel_ids, idempotencyKey: `ord-${Date.now()}` })

/** Save the slice a dashboard opens on. A reading choice still — slicing does
 *  not change what a metric means — but one made on everyone's behalf, which
 *  is the difference between "I sliced this to EMEA" and "this dashboard is
 *  about EMEA". */
export const setDefaultFilters = (dashboard_id: string, filters: WireFilter[]) =>
  op<{ dashboard_id: string; filters: WireFilter[] }>(
    'dashboards.update', { dashboard_id, filters })

/** dashboards.ai_edit: a proposed change to a dashboard. Saves nothing. */
export interface WireDashEdit {
  summary: string
  title?: string | null
  add: DraftPanel[]
  remove: string[]
  replace: { panel_id: string; panel: DraftPanel }[]
  /** The current titles, by panel id, so the change can be said in words. */
  titles: Record<string, string>
  dataset_id: string
  model?: string | null
}
export const aiEditDashboard = (dashboard_id: string, instruction: string) =>
  opAsync<WireDashEdit>('dashboards.ai_edit', { dashboard_id, instruction })

export const renameDashboard = (dashboard_id: string, title: string) =>
  op<{ dashboard_id: string; title: string }>(
    'dashboards.update', { dashboard_id, title, idempotencyKey: `${dashboard_id}:${title}` })

export const deleteDashboard = (dashboard_id: string) =>
  op<{ dashboard_id: string; deleted: boolean; panels_removed: number }>(
    'dashboards.delete', { dashboard_id, idempotencyKey: `del:${dashboard_id}` })

export const removePanel = (panel_id: string) =>
  // Null when the panel carried its own query: there was no definition to
  // keep, which is the point of that panel and not an omission.
  op<{ panel_id: string; metric_kept: string | null }>(
    'panels.remove', { panel_id, idempotencyKey: `rm:${panel_id}` })

/** Add a panel. Pass `metric_id` to cite a definition that already exists —
 *  without it every panel writes a new one, and at N dashboards the registry
 *  holds N rows that all say COUNT(*). */
export const addPanel = (dashboard_id: string,
                         p: DraftPanel & { metric_id?: string; dataset_id?: string }) =>
  op<{ panel_id: string; metric_id: string; cited_existing: boolean }>(
    'panels.add', { dashboard_id, actor_id: ME,
                    idempotencyKey: `${dashboard_id}:${p.title}:${Date.now()}`, ...p })

export interface WireSkill {
  name: string
  files: Record<string, string>
  generated: string
}
export const fetchSkill = () => op<WireSkill>('context.skill', {})
/** The skill as a .zip, to install where an agent reads skills from. */
export async function skillZip(): Promise<Blob> {
  const r = await fetch(`${GATEWAY}/api/v1/context.skill`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...(sessionToken() ? { authorization: `Bearer ${sessionToken()}` } : {}) },
    body: JSON.stringify({ zip: true }),
  })
  if (!r.ok) throw new GatewayError(`http_${r.status}`, 'the skill could not be downloaded')
  return await r.blob()
}
/** The sidebar's numbers in one call, worked out by the gateway from the same
 *  lists, instead of downloading every list to count it here. */
export const workspaceCounts = () => op<import('./types').Counts>('workspace.counts', {})

/** The generated data-context skill, as a row in the Skills collection.
 *
 *  It belongs there: it IS a skill this workspace has, and keeping it API-only
 *  meant the collection showed a dozen authored skills while the one actually
 *  wired to the dashboards was invisible. The fields it cannot honestly fill —
 *  a revision, an author, an acceptance rate — are left empty rather than
 *  faked, and the detail page explains why.
 */
export function toSkill(w: WireSkill, stats: {
  datasets: number; definitions: number; dashboards: number; unratified: number
}): Skill {
  const files = Object.entries(w.files).map(([path, body]) => ({
    path, lines: body.split('\n').length, body,
  }))
  return {
    id: 'skill-warehouse-context', key: 'SK-CTX', name: w.name,
    title: 'What this warehouse holds and what its numbers mean',
    summary: 'Which datasets exist, which definitions are ratified, and how each is '
      + 'actually queried on real dashboards. Read before writing SQL.',
    source: 'workspace', author: 'derived', agentAuthor: false, status: 'installed',
    rev: 0, installedOn: [], scopes: ['metrics:read', 'datasets:read'],
    tools: ['panels.preview', 'metrics.list', 'datasets.introspect'],
    triggers: ['a question that needs a number from the warehouse'],
    runs7d: 0, acceptance: null, p50: '—', cost: '—', model: 'frontier',
    updated: 0, files,
    // The instruction text, which for this skill is the top of the generated
    // SKILL.md rather than something anyone typed.
    // The rule the file leads with, as prose. Markdown emphasis and list
    // markers are stripped: this renders as paragraphs, so leaving `**` in
    // shows the asterisks rather than the emphasis.
    body: (w.files['SKILL.md'] ?? '')
      .split('## The one rule')[1]?.split('\n## ')[0]
      ?.split('\n\n')
      // A numbered list keeps one line per item: joined, its items ran
      // together as one paragraph of bullets.
      .flatMap(p => /^\d+\.\s/m.test(p) ? p.split('\n') : [p.split('\n').join(' ')])
      .map(p => p.replace(/\*\*/g, '').replace(/^\d+\.\s*/, '• ').replace(/`/g, '').trim())
      .filter(Boolean).slice(0, 5) ?? [],
    generated: { from: { datasets: stats.datasets, definitions: stats.definitions,
                         dashboards: stats.dashboards },
                 unratified: stats.unratified },
  }
}

export const ratifyMetric = (metric_id: string) =>
  op<{ metric_id: string; decision_id?: string; already: boolean }>(
    'metrics.ratify', { metric_id })

export interface DraftPanel {
  title: string
  /** The server's spelling — this goes into `panel_bindings.mark`. */
  mark: StoredMark
  agg: string
  column?: string
  /** `ratio` divides by this. */
  denominator?: string
  /** `share` counts rows where `column` equals this. */
  value?: string | number | boolean
  grain: string
  /** Ordering: `bucket` (chronological), `value_desc`, `value_asc`. A limit
   *  without a deliberate ordering returns an arbitrary N, which is a top-N
   *  chart that is not showing the top of anything. */
  sort?: string
  /** Rows kept. 0 means all of them. */
  limit?: number
  dimension?: string
  unit?: string
  better?: MetricDir
  /** A panel that carries its own query instead of citing a definition. Set
   *  with `mark: 'sql'`; the panel prints the rows the statement returns and
   *  makes its dashboard report itself uncertified. */
  sql?: string
}

export const previewPanel = (connection_id: string, dataset_id: string, p: DraftPanel,
                             time_column: string | null, range: string) =>
  op<{ expr: string; unit: string; better: string; rows: number; series: WireSeries[] }>(
    'panels.preview', { connection_id, dataset_id, time_column, range, ...p })

export interface DashboardSuggestion {
  title: string; summary: string; panels: DraftPanel[]; model: string | null
  time_column: string | null; range: string; note: string
}

export const generateDashboard = (body: {
  connection_id: string; dataset_id: string; instruction: string
  time_column: string | null; range: string
}) => opAsync<DashboardSuggestion>('dashboards.generate', body)

export const createDashboard = (body: {
  title: string; connection_id: string; dataset_id: string
  time_column: string | null; panels: DraftPanel[]; idempotencyKey: string
}) => op<{ dashboard_id: string; created: boolean; certified: boolean
           unratified: string[]; authority: string; message: string }>(
  'dashboards.create', { actor_id: ME, ...body })


// ── translation ─────────────────────────────────────────────────────────

const KIND: Record<string, PanelKind> = {
  stat: 'stat', line: 'line', area: 'area', bar: 'bar', stacked: 'stacked', heatmap: 'heat',
  // Both spellings of the heat panel: `heatmap` is stored, `heat` is what the
  // client calls it, and a mark that falls through this map renders as a line
  // chart of nothing.
  heat: 'heat', table: 'table', sql: 'sql',
  pie: 'pie', gauge: 'gauge', pivot: 'pivot',
}

/** The gateway reports a metric's true unit; the chart kit knows four and reads
 *  `pct` as 0-100 rather than a fraction. Rather than let a 0.78 render as
 *  "0.78%", each wire unit declares its own scale — and where the scale changes
 *  what the number means, the title says so instead of the reader guessing. */
const UNIT: Record<string, { unit: MetricUnit; scale: number; suffix?: string }> = {
  pct: { unit: 'pct', scale: 100 },
  currency: { unit: 'currency', scale: 1 },
  count: { unit: 'count', scale: 1 },
  // No duration unit exists here. Seconds become hours — legible at review-wait
  // scale — and the title carries the unit so nothing is silently relabelled.
  duration: { unit: 'count', scale: 1 / 3600, suffix: ' (hours)' },
}
const FALLBACK = { unit: 'count' as MetricUnit, scale: 1 }

export const unitOf = (wire: string | null | undefined) => UNIT[wire ?? 'count'] ?? FALLBACK


export function toPanel(w: WirePanel, span: number, over?: Partial<Panel>): Panel {
  const u = unitOf(w.unit)
  const grain = w.panel.grain ?? 'day'
  const wireSeries = w.series ?? []
  // Live results are already windowed by the server. Align by the returned
  // bucket, never by array position; absence and SQL NULL are not zero.
  const temporal = grain !== 'none' && wireSeries.every(s => s.points.every(([at]) => Number.isFinite(Date.parse(at))))
  // A bucket is the warehouse's own calendar date, or its wall-clock time:
  // a label, never shifted into this browser's time zone. A time without a
  // zone is read as UTC only so it can be ordered and spaced.
  const bucketKey = (at: string) =>
    new Date(/^\d{4}-\d{2}-\d{2}$|(?:Z|[+-]\d{2}:?\d{2})$/.test(at) ? at : `${at}Z`).toISOString()
  const buckets = temporal ? [...new Set(wireSeries.flatMap(s => s.points.map(([at]) => bucketKey(at))))].sort() : undefined
  const series = wireSeries.map(s => {
    const values = new Map(s.points.map(([at, value]) => [temporal ? bucketKey(at) : at, value]))
    return { name: s.name, daily: (buckets ?? s.points.map(([at]) => at)).map(at => {
      const value = values.get(at)
      return value == null || !Number.isFinite(value) ? Number.NaN : value * u.scale
    }) }
  })
  return {
    id: w.panel.id,
    title: (w.panel.title || w.label || 'Untitled panel') + (u.suffix ?? ''),
    kind: KIND[w.panel.mark] ?? 'line',
    unit: u.unit,
    better: (w.better as MetricDir) ?? 'up',
    // The short name on the face, the full id in the definition drawer below.
    // A generated metric id is a path — showing it whole crowds out the title
    // it is supposed to annotate.
    metric: w.panel.metric_id?.split('.').pop() ?? '',
    // A panel reads as ratified only because it rendered — an unratified
    // binding comes back as an error, never as numbers.
    ratified: !w.error,
    source: 'warehouse',
    expr: w.panel.metric_id
      ? `${w.panel.metric_id}\n  over ${w.panel.dataset_id}`
      : (w.sql ?? ''),
    dataset: w.panel.dataset_id,
    span,
    agg: w.panel.mark === 'stat' ? 'last' : 'mean',
    // Carried through untouched: an arbitrary SELECT has no unit to scale by
    // and no grain to bucket into.
    ...(w.sql ? { sql: w.sql, columns: w.columns ?? [], rows: w.rows ?? [] } : {}),
    filtersApplied: w.filters_applied ?? [],
    filtersSkipped: w.filters_skipped ?? [],
    series,
    grain,
    windowed: true,
    ...(w.panel.height ? { height: w.panel.height } : {}),
    ...(w.panel.col ? { col: w.panel.col } : {}),
    bucketDates: buckets?.map(at => ['hour', 'minute'].includes(grain) ? at : at.slice(0, 10)),
    // The window before, by series name: only its total is compared.
    ...(w.previous ? { previous: series.map(s => (w.previous!.find(p => p.name === s.name)?.points ?? [])
      .map(([, value]) => (value == null || !Number.isFinite(value) ? Number.NaN : value * u.scale))) } : {}),
    ...over,
  }
}

/** A live dashboard as a row in the one dashboards collection.
 *
 *  The seeded rows carry a headline and a sparkline computed in the browser;
 *  a live row cannot without running its query, so it declares what it knows
 *  and leaves the preview flat rather than inventing a shape. */
export function toRow(w: WireListRow): Dashboard {
  return {
    // The connection, not the word "live" — the row already carries a
    // "warehouse" pill, and what a reader wants next is WHICH warehouse.
    id: w.id, key: w.key ?? w.id, title: w.title, space: w.connection_name || w.connection_id || 'Warehouse',
    connectionId: w.connection_id,
    definitionUpdatedAt: w.updated_at,
    owner: w.owner, agentOwner: false, rev: 1,
    updated: w.updated_at ? Math.max(0, Math.round((Date.now() - Date.parse(w.updated_at)) / 864e5)) : 0,
    refresh: 'on read · queried when opened', viewers: 0, proposals: 0,
    certified: w.certified,
    uncertified: w.unratified,
    queries: w.queries ?? 0,
    panelCount: w.panel_count,
    previewPanels: w.preview_panels,
    metrics: w.metrics.map(m => m.split('.').pop() ?? m),
    metricReferences: w.metrics.map(id => ({ id, label: w.metric_labels?.[id] || (id.split('.').pop() ?? id).replaceAll('_', ' ') })),
    approvedMetricCount: w.approved_metrics,
    headline: { metric: w.metrics[0] ?? '', unit: 'count', value: w.panel_count, delta: 0, better: 'up' },
    spark: new Array(28).fill(0),
    live: true,
  }
}

// ── experiments ─────────────────────────────────────────────────────────
//
// An experiment on the gateway is an object with a CONTRACT: what it committed
// to measuring, fixed before any data was visible. That is the difference from
// the seeded ones, whose `lift` is a number in a fixture — here every figure on
// the page is recomputed from the warehouse on each read, and the readout can
// refuse to answer.

export interface WireContract {
  connection_id: string
  dataset_id: string
  variation: string
  unit?: string | null
  control?: string | null
  outcome: string
  binary?: boolean
  weights?: Record<string, number> | null
  metric_id?: string | null
  metric_version?: number | null
  /** `better` and `binary` registered with the guardrail itself, for one that
   *  cites no definition: which way is bad, and whether it is a rate. */
  guardrails?: { outcome: string; metric_id?: string; metric_version?: number
                 better?: 'up' | 'down'; binary?: boolean }[]
  alpha?: number | null
  mde?: number | null
  planned_days?: number | null
  registered_at?: string | null
  registered_by?: string | null
  sequential?: boolean | null
  threshold?: number | null
  cohort?: string | null
  unit_agg?: string | null
  cap?: number | null
  null_is_zero?: boolean | null
}

export interface WireExperiment {
  id: string
  key: string | null
  name: string
  hypothesis: string
  owner: string
  space: string
  metric: string
  status: string
  days: number | null
  day: number | null
  lift: number | null
  lift_at: string | null
  better?: 'up' | 'down' | null
  guardrail: string
  pre_registered: boolean
  amendments: number
  owner_id?: string
  /** The last recorded readout's split check. Null when it could not run. */
  srm_passed?: boolean | null
  lift_ci?: [number, number] | null
  units?: number | null
  verdict?: string | null
  mde?: number | null
  started_at?: string | null
  ends_at?: string | null
  stopped_at?: string | null
  attention?: string[]
  decision?: import('./types').ExperimentDecision | null
}

export interface WireProgress {
  day: number; days: number; started_at: string | null; ends_at: string | null
  stopped_at: string | null; due: boolean
}

export interface WireReadoutWindow {
  start: string; end: string; basis: 'experiment' | 'range'; applied: boolean
  /** Why these are not the experiment's own days, when they are not. */
  note?: string
}

export interface WireAmendment { at: string; by: string; why: string; was?: WireContract }

export interface WireSrmArm {
  name: string; observed: number; expected: number; ratio: number
}
export interface WireSrm {
  ran: boolean
  error?: string
  passed?: boolean
  p_value?: number
  statistic?: number
  df?: number
  threshold?: number
  total?: number
  counted?: 'units' | 'rows'
  arms?: WireSrmArm[]
  worst?: string | null
  note?: string
  warning?: string
  assumed_even_split?: boolean
}

export interface WireComparison {
  variation: string
  baseline: string
  n: number
  baseline_n: number
  mean: number
  baseline_mean: number
  lift: number | null
  lift_ci: [number, number] | null
  p_value: number | null
  test: string
  undecidable: string | null
  verdict: string
  invalidated_by?: string
}

export interface WireResult {
  outcome: string
  role?: 'target' | 'guardrail'
  /** The table this outcome was joined from, when it was not the assignment table. */
  source?: string
  cites?: string | null
  metric_label?: string | null
  metric_version?: number | null
  metric_status?: string | null
  metric_expr?: string | null
  unit?: string | null
  better?: string
  direction_assumed?: boolean
  control?: string
  binary?: boolean
  arms?: { name: string; n: number; mean: number }[]
  comparisons?: WireComparison[]
  /** The same outcome split by the pre-registered cohort. Each cohort is
   *  compared against its own control, never against the whole population. */
  cohorts?: WireCohort[]
  error?: string
}

export interface WireCohort {
  cohort: string
  arms: { name: string; n: number; mean: number }[]
  comparisons?: WireComparison[]
  error?: string
}

export interface WireReadout {
  dataset_id: string
  range: string
  alpha: number
  sequential: boolean
  tuning?: number
  srm: WireSrm
  pre_registered: boolean
  experiment?: { id: string; title: string; registered_at?: string | null
                 planned_days?: number | null; mde?: number | null }
  contract_notes?: string[]
  results: WireResult[]
  caveats: string[]
  /** The days this read: the experiment's own once started, else the range. */
  window?: WireReadoutWindow
  recorded?: { id: string; at: string }
}

export interface WireRecordedReadout {
  id: string; key: string; title: string; at: string; by: string
  srm_passed: boolean | null
  lift: number | null; lift_ci: [number, number] | null; verdict: string | null; n: number | null
  window?: WireReadoutWindow | null
}

export interface WireReference { id: string; type: string; key: string | null; title: string
                                 by: string; at: string; rel: string }
/** What points at an experiment: decisions, recorded readouts, and anything
 *  listing it in its sources. */
export const experimentReferences = (experiment_id: string) =>
  op<{ decisions: WireReference[]; readouts: WireReference[]; cited_by: WireReference[]; total: number }>(
    'experiments.references', { experiment_id })

/** What this experiment's recorded readouts said, newest first. */
export const readoutHistory = (experiment_id: string) =>
  op<{ readouts: WireRecordedReadout[] }>('experiments.history', { experiment_id })

/** Pre-register an experiment: fix what will be measured before any data is
 *  visible. The gateway checks every named column against the real dataset and
 *  pins the metric version in force right now, so a contract that cannot
 *  compile is refused here rather than three weeks later. */
export const registerExperiment = (body: {
  experiment_id?: string; name: string; hypothesis?: string; owner?: string
  status?: 'draft' | 'running'; started_at?: string; idempotencyKey: string
  contract: Partial<WireContract> & {
    connection_id: string; dataset_id: string; variation: string; outcome: string
  }
}) => op<{ experiment_id: string; title: string; contract: WireContract; amended: boolean }>(
  'experiments.register', body)

/** The assignment check, runnable before an experiment exists. It needs no
 *  outcome, so the split can be verified while the columns are still being
 *  chosen — which is when a mistake is cheap to fix. */
export const checkSrm = (body: {
  connection_id: string; dataset_id: string; variation: string
  unit?: string; weights?: Record<string, number>; range?: string
}) => op<{ dataset_id: string; range: string; srm: WireSrm }>('experiments.srm', body)

export interface WireSuggestion {
  dataset_id: string
  rows: number
  versions: { column: string; distinct: number; share: number }[]
  units: { column: string; distinct: number; share: number }[]
  measures: { column: string; metric_id?: string; label?: string; better?: string; expr?: string }[]
  confident: boolean
  verdict: string
}

/** Ask the table what shape it is in, instead of asking the author.
 *  One scan: which column holds a handful of repeated values, which is close to
 *  unique per row, and what there is to measure. */
export const suggestExperiment = (connection_id: string, dataset_id: string) =>
  op<WireSuggestion>('experiments.suggest', { connection_id, dataset_id })

// No space is sent: the gateway answers in the workspace the caller signed in
// to. These sent 'pay' — the demo's — and were refused in any other one.
export async function listLiveExperiments(space?: string): Promise<WireExperiment[]> {
  const r = await op<{ experiments: WireExperiment[] }>('experiments.list', space ? { space_id: space } : {})
  return r.experiments ?? []
}

export async function getLiveExperiment(id: string, space?: string) {
  return op<{ experiment: Omit<WireExperiment, 'amendments'> & {
                contract?: WireContract; title?: string
                started_at?: string | null; stopped_at?: string | null
                last_readout?: string | null; srm_passed?: boolean | null
                /** The list itself here; the collection row carries only its length. */
                amendments?: WireAmendment[]
                dates_recorded?: { at: string; by: string } | null }
              contract: WireContract | null; pre_registered: boolean
              progress?: WireProgress; attention?: string[] }>(
    'experiments.get', { experiment_id: id, space_id: space })
}

const key = (verb: string, id: string) => `${verb}:${id}:${Date.now()}`

/** experiments.explain: words around the engine's numbers, checked against
 *  them — every figure and the recommendation — before they are returned. */
export interface WireExplanation {
  headline: string
  summary: string
  recommendation: 'ship' | 'kill' | 'iterate' | 'keep_running'
  reasons: string[]
  next_steps?: string[]
  allowed: string[]
  model?: string | null
  checked: string
  read_at: string
}
/** Reused while the readout is unchanged; `fresh` writes a new one. */
export const explainExperiment = (experiment_id: string, fresh = false) =>
  opAsync<WireExplanation & { cached?: boolean }>('experiments.explain', { experiment_id, ...(fresh ? { fresh } : {}) })

/** A draft for the decision form. Records nothing. */
export const draftRationale = (experiment_id: string, decision: 'ship' | 'kill' | 'iterate') =>
  opAsync<{ rationale: string; decision: string; model?: string | null; note: string }>('experiments.draft_rationale', { experiment_id, decision })

/** The experiment as a doc, built from the readout; with `summary`, the AI
 *  summary on screen goes in too, marked as drafted. */
export const writeUpExperiment = (experiment_id: string, summary?: WireExplanation | null) =>
  op<{ doc_id: string; key?: string; projects: string[] }>('experiments.write_up', {
    experiment_id, idempotencyKey: key('writeup', experiment_id),
    ...(summary ? { summary: { headline: summary.headline, summary: summary.summary,
      recommendation: summary.recommendation, reasons: summary.reasons, next_steps: summary.next_steps ?? [] } } : {}),
  })

/** When traffic really began. From then on every readout reads the
 *  experiment's own days instead of "the last 30". */
export const startExperiment = (experiment_id: string, started_at?: string, stopped_at?: string) =>
  op<{ status: string; started_at: string; stopped_at?: string | null }>('experiments.start',
    { experiment_id, ...(started_at ? { started_at } : {}), ...(stopped_at ? { stopped_at } : {}),
      idempotencyKey: key('start', experiment_id) })

/** When traffic in the experiment's table starts and ends: the evidence for
 *  the dates of one registered after the fact. */
export const experimentExtent = (experiment_id: string) =>
  op<{ first_seen: string | null; last_seen: string | null; rows: number }>('experiments.extent', { experiment_id })

export const stopExperiment = (experiment_id: string, reason?: string) =>
  op<{ status: string; stopped_at: string }>('experiments.stop',
    { experiment_id, ...(reason ? { reason } : {}), idempotencyKey: key('stop', experiment_id) })

/** Ship, kill or iterate, citing a recorded readout. Needs merge. */
export const decideExperiment = (a: { experiment_id: string; decision: 'ship' | 'kill' | 'iterate'
                                      rationale: string; readout_id?: string }) =>
  op<{ status: string; decision_id: string; readout_id: string | null }>('experiments.decide',
    { ...a, idempotencyKey: key('decide', a.experiment_id) })

export interface WirePlan {
  per_arm: Record<string, number>
  total: number
  delta: number
  sequential: boolean
  days: number | null
  assumptions: string[]
  measured: { baseline?: number; sd?: number; daily_units?: number; lookback_days?: number | null }
  enough?: boolean
  planned_days?: number
}

/** Units and days needed to see the effect, sized for the readout's own
 *  interval. Name the table and the baseline and traffic are read from it. */
export const planExperiment = (a: {
  mde: number; baseline?: number; sd?: number; binary?: boolean; alpha?: number; power?: number
  sequential?: boolean; daily_units?: number; planned_days?: number
  weights?: Record<string, number>; control?: string
  connection_id?: string; dataset_id?: string; variation?: string; outcome?: string; unit?: string
  unit_agg?: string; cap?: number; null_is_zero?: boolean
}) => op<WirePlan>('experiments.plan', a)

export const programStatsLive = () =>
  op<import('./types').ProgramStats>('experiments.program', {})

export interface WireMe { id: string; display: string; kind: string | null; space: string
                          may: ('read' | 'propose' | 'merge' | 'admin')[]
                          /** How this request was signed in; "local" is no sign-in, on this computer. */
                          via?: 'session' | 'token' | 'proxy' | 'local' | null }
let mePromise: Promise<WireMe | null> | null = null
/** Who this browser is signed in as, asked once. */
export const whoAmI = () => (mePromise ??= op<WireMe>('actors.me', {}).catch(() => null))
/** For tests, and after a token changes. */
export function forgetWhoAmI() { mePromise = null }

/** Recomputed from the warehouse on every read. There is no stored number. */
export async function readout(
  id: string, opts: { range?: string; sequential?: boolean; record?: boolean } = {}, space?: string,
): Promise<WireReadout> {
  return op<WireReadout>('experiments.readout', { experiment_id: id, ...(space ? { space_id: space } : {}), ...opts })
}

// ── designs ────────────────────────────────────────────────────────────
/** One element of a screen: a ROLE and a box, never markup.
 *
 *  That is what makes a design reviewable — a spec can be diffed, filed as a
 *  proposal and drawn without a sandbox, and markup emitted by an agent can do
 *  none of the three. The same contract a diagram and a panel already hold to. */
export interface DesignElement {
  id: string
  role: 'heading' | 'body' | 'button' | 'input' | 'image' | 'list' | 'nav' | 'card'
      | 'divider' | 'logo' | 'avatar' | 'badge' | 'icon' | 'tabbar' | 'field-label'
  text?: string
  /** A size token, e.g. font.size.body. Explicit fontSize overrides this link. */
  textStyle?: string
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
  textAlign?: 'left' | 'center' | 'right'
  /** Which role in the palette this plays; resolved through the token set, so
   *  one token change restyles every element playing that role. */
  tone?: 'default' | 'accent' | 'muted' | 'danger' | 'onAccent'
  /** A colour token path from this design's palette, for the colours a system
   *  has that none of the five roles covers. Wins over `tone` when both are
   *  set. A role is still the better thing to say when one fits: it follows the
   *  system if the system changes its mind about what danger looks like. */
  color?: string | null
  /** The approved component this instantiates. Null means off-system. */
  cites?: string | null
  /** Asset id or https URL. Absent draws a placeholder rather than inventing
   *  a picture that is not there. */
  src?: string
  /** Screen this navigates to when clicked — how a prototype is click-through
   *  without a line of model-written JavaScript. */
  goto?: string
  /** Lay children out instead of placing them absolutely. This is what makes a
   *  design responsive rather than correct at exactly one width. */
  layout?: 'row' | 'column'
  gap?: number
  pad?: number
  align?: 'start' | 'center' | 'end' | 'between'
  children?: DesignElement[]
  /** Absolute position. Omitted inside a container, which places it. */
  /** Inside a row or column: how far it is shifted from where the layout
   *  puts it, in device pixels. Ignored on a placed element, whose x/y say
   *  where it is outright. */
  dx?: number
  dy?: number
  x?: number
  y?: number
  w?: number
  h?: number
}

/** Design tokens in the W3C DTCG shape — `$value` + `$type`, keyed by path.
 *  A published standard rather than a private format, so the same token set is
 *  what design tools and token build tools already read. */
export interface DesignToken {
  $value: string | number
  $type?: 'color' | 'dimension' | 'fontFamily' | 'fontWeight' | 'number' | 'shadow'
  $description?: string
}
export type DesignTokens = Record<string, DesignToken>

export interface DesignScreen {
  id: string
  name: string
  w: number
  h: number
  elements?: DesignElement[]
}

export interface WireDesign {
  id: string
  key?: string
  title: string
  template_kind?: 'layout' | 'system'
  description?: string
  surface: 'mobile' | 'web' | 'email'
  state?: 'draft' | 'review' | 'approved' | 'superseded'
  /** Written only by the review operations. */
  review?: DesignReviewRecord | null
  /** Ids of the approved designs this one is built from — cited, never copied,
   *  so changing the template changes every screen citing it. */
  cites?: string[]
  generated_by?: string | null
  sources?: string[]
  /** From a `preview` list: the spec holds only the first screen, so these
   *  say how many there are and what they are called. */
  screen_count?: number
  screen_names?: string[]
  spec: { tokens?: DesignTokens; screens: DesignScreen[] }
  /** Bumped by every revise, so the history can mark which one is current. */
  current_rev?: number
  updated_at?: string
}

/** Filters are the type's own enum facets, so the arguments an agent sees over
 *  MCP and the ones this page sends are the same list. */
export const listDesigns = (filter: { surface?: string; state?: string; preview?: boolean } = {}) =>
  op<{ designs: WireDesign[]; total: number }>('designs.list', filter)

export const getDesign = (id: string) =>
  op<{ design: WireDesign }>('designs.get', { id })

/** Start a design from an approved template.
 *
 *  The screens are copied because layout is yours to change. The TOKENS are
 *  not: the new design cites the template and resolves them at render, so the
 *  system it is built on stays one object. Copy the tokens too and you have
 *  made the drift this whole type exists to prevent. */
export const proposeDesign = (d: {
  title: string
  surface: string
  state?: string
  cites?: string[]
  spec: unknown
  generated_by?: string | null
  idempotencyKey: string
}) => op<{ id: string; created: boolean }>('designs.propose', d)

export interface GeneratedDesign {
  title: string
  surface: 'mobile' | 'web' | 'email'
  spec: { tokens?: DesignTokens; screens: DesignScreen[] }
  cites: string[]
  grounded_in: string | null
  rationale: string
  sources?: string[]
  /** What emitted the spec. Filed with the design so a generated screen does
   *  not arrive claiming a person drew it. */
  generated_by: string | null
  usage: { input_tokens: number; output_tokens: number; model?: string }
  note: string
}

/** Describe what you want; get a spec back. Files nothing — generating is
 *  cheap to redo and filing is a proposal somebody reviews, so the two are
 *  separate acts and this one is safe to repeat. */
export const generateDesign = (a: {
  brief: string
  surface: string
  cites?: string
  screens?: number
  /** The spec being refined. With it, `brief` reads as a change to make rather
   *  than a design to start — and the conversation stays in the client, so the
   *  operation remains a request rather than a run with state to resume. */
  base?: unknown
  /** Change only this element. What comes back can then be reviewed as an edit
   *  rather than as a redesign. */
  element?: string
  /** Objects to design against — their titles go into the brief. */
  sources?: string[]
}) => opAsync<GeneratedDesign>('designs.generate', a)

export interface DesignRevision {
  rev: number
  at: string
  by: string
  note: string
  title?: string
  screens: number
  /** Present only when asked for, by `rev` or `with_spec`. */
  spec?: { tokens?: DesignTokens; screens: DesignScreen[] }
  /** Whether this revision carries a spec that can be restored. */
  has_spec?: boolean
}

/** Replace a design's spec and keep what it replaced. Every call writes a
 *  revision, so a draft is something you can come back to and a wrong turn is
 *  something you can undo. */
export const reviseDesign = (a: {
  design_id: string
  /** The revision this change was made against. The gateway refuses the write
   *  if the design has moved since, rather than carrying somebody else's edit
   *  back to how it was before they made it. */
  if_rev?: number
  spec?: unknown
  title?: string
  /** Object ids this design is drawn from. Provenance, and what makes it go
   *  stale when the thing it was drawn from moves. */
  sources?: string[]
  note?: string
}) => op<{ design_id: string; rev: number; state?: string; reopened_from?: string }>('designs.revise',
  { ...a, idempotencyKey: `rev:${a.design_id}:${Date.now()}` })

export interface DesignReviewRecord {
  requested_by?: string | null
  requested_at?: string | null
  note?: string | null
  decision?: 'approved' | 'changes_requested' | null
  decided_by?: string | null
  decided_at?: string | null
  decision_note?: string | null
  approved_rev?: number | null
  self_approved?: boolean | null
  reopened_from?: 'review' | 'approved' | null
}

/** Where a design stands in review and what the caller may do next. The
 *  gateway answers "may I approve", so the page never offers a button the
 *  gateway would refuse. */
export interface DesignReview {
  design_id: string
  state: 'draft' | 'review' | 'approved' | 'superseded'
  rev: number
  review: DesignReviewRecord | null
  contributors: { id: string; name: string }[]
  names: Record<string, string>
  you: {
    id: string
    made_this: boolean
    may_request: boolean
    may_approve: boolean
    may_self_approve: boolean
    may_request_changes: boolean
  }
}

export const designReview = (design_id: string) =>
  op<DesignReview>('designs.review', { design_id })

const reviewKey = (verb: string, id: string) => `${verb}:${id}:${Date.now()}`

export const requestDesignReview = (a: { design_id: string; if_rev?: number; note?: string }) =>
  op<{ state: string; rev: number }>('designs.request_review',
    { ...a, idempotencyKey: reviewKey('review', a.design_id) })

/** Approve the revision you read. `self_approve` with a reason is an admin's
 *  explicit, recorded exception for their own work. */
export const approveDesign = (a: { design_id: string; if_rev: number; note?: string; self_approve?: boolean }) =>
  op<{ state: string; rev: number; decision_id: string; self_approved: boolean }>('designs.approve',
    { ...a, idempotencyKey: reviewKey('approve', a.design_id) })

export const requestDesignChanges = (a: { design_id: string; if_rev?: number; note: string }) =>
  op<{ state: string; rev: number }>('designs.request_changes',
    { ...a, idempotencyKey: reviewKey('changes', a.design_id) })

export const designHistory = (design_id: string, rev?: number) =>
  op<{ design_id: string; revisions: DesignRevision[] }>('designs.history', { design_id, ...(rev !== undefined ? { rev } : {}) })

export interface DesignReference {
  id: string
  type: string | null
  key?: string
  title: string | null
  updated_at?: string
  unresolved: boolean
  changed_since: boolean
}

/** What a design was drawn from, resolved, with whichever of them has moved
 *  since the design last did. Stale means the thing it was drawn from changed —
 *  not that time passed. */
export const designReferences = (design_id: string) =>
  op<{ design_id: string; references: DesignReference[]; stale: boolean
       unresolved?: string[] }>('designs.references', { design_id })

// ── docs ────────────────────────────────────────────────────────────────

/** A ProseMirror node as JSON. The doc type declares which node and mark
 *  names are legal, and the gateway refuses anything else — so this is a
 *  block tree, never markup. */
export interface DocNode {
  type: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

export interface WireDoc {
  id: string
  key: string
  title: string
  space?: string
  freshness?: 'fresh' | 'stale' | 'verified'
  /** The first words as plain text, derived by the gateway on every revise. */
  excerpt?: string
  body: DocNode
  current_rev?: number
  updated_at?: string
}

export const EMPTY_DOC: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] }

export const listLiveDocs = (filter: { freshness?: string } = {}) =>
  op<{ docs: WireDoc[]; total: number }>('docs.list', filter)

export const getLiveDoc = (id: string) =>
  op<{ doc: WireDoc }>('docs.get', { id })

/** A doc asked for before its editor has loaded — on hover, or as the route
 *  starts — so the read and the editor's code arrive together instead of one
 *  after the other. Taken once, and only while fresh: an editor must open on
 *  what the doc is, not on what it was a minute ago. */
const docAhead = new Map<string, { at: number; got: ReturnType<typeof getLiveDoc> }>()
const AHEAD_MS = 5000
export function prefetchDoc(id: string) {
  const held = docAhead.get(id)
  if (held && Date.now() - held.at < AHEAD_MS) return
  const got = getLiveDoc(id)
  got.catch(() => docAhead.delete(id))
  docAhead.set(id, { at: Date.now(), got })
}
export function takeDoc(id: string) {
  const held = docAhead.get(id)
  docAhead.delete(id)
  return held && Date.now() - held.at < AHEAD_MS ? held.got : getLiveDoc(id)
}

export const createDoc = (title: string) =>
  op<{ id: string; created: boolean }>('docs.propose', {
    title, body: EMPTY_DOC, freshness: 'fresh',
    idempotencyKey: `doc:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  })

/** Replace a doc's body and keep what it replaced. `if_rev` is the revision
 *  this edit was made against; the gateway refuses the write if the doc moved
 *  since, rather than overwriting somebody else's paragraph. */
export const reviseDoc = (a: {
  doc_id: string
  if_rev?: number
  body?: DocNode
  title?: string
  note?: string
}) => op<{ doc_id: string; rev: number; excerpt: string }>('docs.revise',
  { ...a, idempotencyKey: `rev:${a.doc_id}:${Date.now()}` })

export interface DocRevision {
  rev: number
  at: string
  by: string
  note: string
  title?: string
  body?: DocNode
}

export const docHistory = (doc_id: string) =>
  op<{ doc_id: string; revisions: DocRevision[] }>('docs.history', { doc_id })

export interface DocAssist {
  markdown: string
  /** `selection` when only the selected passage came back. */
  scope: 'document' | 'selection'
  model: string
  note: string
}

/** Ask the workspace's model to write or edit. Returns markdown and saves
 *  nothing — the editor applies it as one undoable step, and the next autosave
 *  files it with the instruction as its note. */
export const assistDoc = (a: {
  instruction: string
  markdown: string
  selection?: string
  title?: string
}) => opAsync<DocAssist>('docs.assist', a)

export interface ShareLink {
  /** Served by the gateway, outside the app: anyone with it can read the doc
   *  as it is now, without an account. */
  url: string
  token: string
  created_by: string
  created_at: string
}

export const docSharing = (doc_id: string) =>
  op<{ doc_id: string; link: ShareLink | null }>('docs.sharing', { doc_id })

export const shareDoc = (doc_id: string) =>
  op<{ doc_id: string; link: ShareLink }>('docs.share',
    { doc_id, idempotencyKey: `share:${doc_id}:${Date.now()}` })

export const unshareDoc = (doc_id: string) =>
  op<{ doc_id: string; revoked: number }>('docs.unshare',
    { doc_id, idempotencyKey: `unshare:${doc_id}:${Date.now()}` })

/** The doc as one self-contained HTML page — the same page its share link
 *  serves — for downloading. */
/** `for_page`: HTML the page store accepts — the doc's words, with no live
 *  address left in it — for turning a doc into a full page. */
export const exportDoc = (doc_id: string, opts: { for_page?: boolean } = {}) =>
  op<{ doc_id: string; filename: string; html: string }>('docs.export', { doc_id, ...opts })

// ── the board ───────────────────────────────────────────────────────────

export type TaskState = 'ready' | 'flight' | 'review' | 'done'
export type TaskRel = 'caused' | 'touches' | 'depends'

export interface WireTaskActor { id: string; name: string; kind: 'human' | 'agent' }

/** What the caller may do to one task — the same rules the verbs apply, so a
 *  page offers only what the gateway would accept. */
export interface WireTaskYou {
  own: boolean
  may_start: boolean; may_hand: boolean; may_release: boolean; may_submit: boolean
  may_accept: boolean; may_self_accept: boolean; may_send_back: boolean
  may_ask: boolean; may_answer: boolean; may_edit: boolean; may_delete: boolean
  /** May say who works it (tasks.assign). Absent from a gateway older than it. */
  may_assign?: boolean
}

export interface WireTaskRun {
  id: string
  status: 'running' | 'done' | 'blocked' | 'asking'
  started_at: string
  ended_at: string | null
  seconds: number
  cost_usd: number
  cost_tokens: number
}

export interface WireTask {
  id: string
  key: string
  title: string
  detail: string | null
  state: TaskState
  origin: 'filed' | 'triggered'
  criteria: { text: string; met: boolean | null }[]
  human_only: string | null
  /** Whether an agent may take it, and if not, why — in the gateway's words. */
  agent_ready: boolean
  not_agent_ready: string | null
  assignee: WireTaskActor | null
  created_by: WireTaskActor
  created_at: string
  moved_at: string
  /** Seconds in its current column. On a review card, the real cost. */
  in_state_s: number
  question: { text: string; by: WireTaskActor; at: string } | null
  produced: { label: string; object_id: string | null; url: string | null } | null
  review: {
    submitted_by?: WireTaskActor | null; submitted_at?: string; note?: string | null
    decision?: 'accepted' | 'sent_back'; decided_by?: WireTaskActor | null
    decided_at?: string; decision_note?: string | null; self_accepted?: boolean
  } | null
  /** Handed to an agent that has not picked it up yet. */
  asked: boolean
  run: WireTaskRun | null
  /** `available: false` is a link to something the reader may not open: it has no key or title. */
  links: { rel: TaskRel; object: { id: string; type: string; key: string | null; title: string | null; available?: false } }[]
  /** The projects it is in. Absent from a gateway older than projects. */
  projects?: ProjectTag[]
  rev: number
  updated_at: string
  you: WireTaskYou
}

export interface WireTaskStep {
  rev: number
  kind: 'create' | 'edit' | 'start' | 'hand' | 'release' | 'submit' | 'accept' | 'send_back'
    | 'question' | 'answer' | 'link' | 'unlink'
  note: string | null
  by: WireTaskActor
  at: string
  to?: string
  rel?: TaskRel
  object?: { id: string; type: string; key: string | null; title: string }
  question?: string
}

export interface WireTaskRoute {
  agent: WireTaskActor
  can: boolean
  why: string
  needs: string | null
  accepted: number
  sent_back: number
}

export interface WireBoard {
  tasks: WireTask[]
  total: number
  counts: Record<TaskState, number>
  review_oldest_s: number
  running: number
  asking: number
  you: { id: string; name: string; kind: 'human' | 'agent'; may: { propose: boolean; merge: boolean; admin: boolean } }
}

type Moved = { task: WireTask; rev: number | null; already: boolean }

/** A fresh key per action: a retry of the same request reuses it, a second
 *  click is a second request. */
const act = (verb: string) =>
  `${verb}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

export const listBoard = () => op<WireBoard>('tasks.list', {})

export const getTask = (task_id: string) =>
  op<{ task: WireTask & { history: WireTaskStep[]; routes: WireTaskRoute[] } }>('tasks.get', { task_id })

export const fileTask = (t: { title: string; detail?: string | null; criteria?: string[]; human_only?: string | null }) =>
  op<Moved & { created: boolean }>('tasks.propose', { ...t, idempotencyKey: act('file') })

export const reviseTask = (task_id: string, if_rev: number,
  change: { title?: string; detail?: string | null; criteria?: string[]; human_only?: string | null }) =>
  op<Moved>('tasks.revise', { task_id, if_rev, ...change, idempotencyKey: act('revise') })

export const startTask = (task_id: string, if_rev: number) =>
  op<Moved>('tasks.start', { task_id, if_rev, idempotencyKey: act('start') })

export const handTask = (task_id: string, if_rev: number, agent_id: string, note?: string) =>
  op<Moved>('tasks.hand', { task_id, if_rev, agent_id, ...(note ? { note } : {}), idempotencyKey: act('hand') })

/** Who works it: a member or an agent by actor id, or null for nobody. An agent
 *  is a hand-over; an in-progress task changes hands only from its assignee. */
export const assignTask = (task_id: string, if_rev: number, assignee_id: string | null) =>
  op<Moved>('tasks.assign', { task_id, if_rev, assignee_id, idempotencyKey: act('assign') })

export const releaseTask = (task_id: string, if_rev: number, note?: string) =>
  op<Moved>('tasks.release', { task_id, if_rev, ...(note ? { note } : {}), idempotencyKey: act('release') })

export const submitTask = (task_id: string, if_rev: number, s: {
  criteria_met: boolean[]; produced?: { label: string; url?: string } | null; note?: string
}) => op<Moved>('tasks.submit', {
  task_id, if_rev, criteria_met: s.criteria_met,
  ...(s.produced ? { produced: s.produced } : {}), ...(s.note ? { note: s.note } : {}),
  idempotencyKey: act('submit') })

export const acceptTask = (task_id: string, if_rev: number, own?: { note: string }) =>
  op<Moved>('tasks.accept', { task_id, if_rev, ...(own ? { self_accept: true, note: own.note } : {}),
    idempotencyKey: act('accept') })

export const sendBackTask = (task_id: string, if_rev: number, note: string) =>
  op<Moved>('tasks.send_back', { task_id, if_rev, note, idempotencyKey: act('send-back') })

export const answerTask = (task_id: string, answer: string) =>
  op<Moved>('tasks.answer', { task_id, answer, idempotencyKey: act('answer') })

/** Record how a task relates to another object — `caused` (it came from it),
 *  `touches` (the work changes it), `depends` (it needs it settled first). */
export const linkTask = (task_id: string, object_id: string, rel: TaskRel) =>
  op<Moved>('tasks.link', { task_id, object_id, rel, idempotencyKey: act('link') })

export const unlinkTask = (task_id: string, object_id: string, rel: TaskRel) =>
  op<Moved>('tasks.unlink', { task_id, object_id, rel, idempotencyKey: act('unlink') })

/** A task as an object's page lists it: with how it is linked to that object. */
export type WireLinkedTask = WireTask & { rel: TaskRel[] }

/** The tasks linked to one object, for its page. */
export const linkedTasks = (object_id: string) =>
  op<{ object_id: string; tasks: WireLinkedTask[]; total: number }>('tasks.linked', { object_id })

export const deleteTask = (task_id: string) =>
  op<{ task_id: string; deleted: boolean }>('tasks.delete', { task_id, idempotencyKey: act('delete') })

// ── discussion: comments on objects, and channels ───────────────────────

export interface WireMessage {
  id: string
  /** The thread it answers; null for a top-level message. One level deep. */
  parent_id: string | null
  author: WireTaskActor
  /** Null once deleted — a deleted message with replies stays as a marker. */
  body: string | null
  mentions: WireTaskActor[]
  created_at: string
  edited_at: string | null
  deleted: boolean
  you: { may_edit: boolean; may_delete: boolean }
}

export interface WireThread {
  subject: { id: string; type: string; key: string | null; title: string }
  messages: WireMessage[]
  /** Per message, the agents it mentioned that have not answered in its thread
   *  since — "asked, waiting for a reply", read off the record. */
  waiting: Record<string, WireTaskActor[]>
  /** The gateway's clock when it answered: pass it as `since` next time. */
  now?: string
  /** Older conversations than this page holds. */
  more_before?: boolean
  /** Present when this answer holds only what changed since then. */
  since?: string
}

export interface WireChannel {
  id: string
  key: string | null
  name: string
  topic: string | null
  /** Public: everyone in the workspace. Private: the people added to it. */
  visibility?: 'workspace' | 'private'
  archived?: boolean
  messages: number
  last_at: string | null
  last: { author: WireTaskActor; body: string } | null
}

const said = (verb: string) =>
  `${verb}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

/** What a skill is, said by the page showing it: the gateway does not store
 *  skills, so the first comment on one names it. An object or an agent is
 *  looked up by its id and needs none. */
export interface SubjectDeclaration { type: 'skill'; title: string; key?: string | null }

const declaring = (d?: SubjectDeclaration) =>
  d ? { subject: { type: d.type, title: d.title, ...(d.key ? { key: d.key } : {}) } } : {}

/** `update`: a task's Updates — dated notes on the work, read apart from the comments. */
export type MessageKind = 'comment' | 'update'
/** The newest page of a conversation; or, with `before`, the page before a
 *  message; or, with `since` (a previous answer's `now`), only what changed. */
export const listThread = (subject_id: string, about?: SubjectDeclaration, kind?: MessageKind,
                           page: { since?: string; before?: string; limit?: number } = {}) =>
  op<WireThread>('messages.list', { subject_id, ...declaring(about), ...(kind ? { kind } : {}), ...page })

export const threadCounts = (subject_ids: string[]) =>
  op<{ counts: Record<string, number> }>('messages.counts', { subject_ids })

export const postMessage = (subject_id: string, body: string, parent_id?: string | null,
                            about?: SubjectDeclaration, kind?: MessageKind) =>
  op<{ message: WireMessage; asked: string[]; not_asked: { id: string; why: string }[] }>(
    'messages.post', { subject_id, body, ...(parent_id ? { parent_id } : {}), ...declaring(about),
                       ...(kind ? { kind } : {}), idempotencyKey: said('post') })

export const editMessage = (message_id: string, body: string) =>
  op<{ message: WireMessage }>('messages.edit', { message_id, body, idempotencyKey: said('edit') })

export const deleteMessage = (message_id: string) =>
  op<{ message_id: string; deleted: boolean }>('messages.delete', { message_id, idempotencyKey: said('delete') })

/** The channels the caller can see; archived ones too when asked for. */
export const listChannelsLive = (opts: { archived?: boolean } = {}) =>
  op<{ channels: WireChannel[] }>('channels.list', opts.archived ? { archived: true } : {})

export const createChannel = (name: string, topic?: string, isPrivate = false) =>
  op<{ channel: WireChannel; created: boolean }>('channels.propose',
    { name, ...(topic ? { topic } : {}), ...(isPrivate ? { private: true } : {}), idempotencyKey: said('channel') })

export const updateChannel = (channel_id: string, changes: { name?: string; topic?: string }) =>
  op<{ channel: WireChannel }>('channels.update', { channel_id, ...changes, idempotencyKey: said('channel-edit') })

export const archiveChannel = (channel_id: string, archived: boolean) =>
  op<{ channel: WireChannel }>('channels.archive', { channel_id, archived, idempotencyKey: said('channel-archive') })

export interface WireNotification {
  kind: 'mention' | 'reply'
  unread: boolean
  message: WireMessage
  subject: { id: string; type: string; key: string | null; title: string } | null
}

export const listNotifications = () =>
  op<{ unread: number; notifications: WireNotification[] }>('messages.notifications', { limit: 30 })

export const unreadCounts = (subject_ids: string[]) =>
  op<{ unread: Record<string, number> }>('messages.unread', { subject_ids })

export const markRead = (which: { subject_id?: string; subject_ids?: string[]; all?: boolean }) =>
  op<{ read: string[] }>('messages.read', { ...which, idempotencyKey: said('read') })

export interface WireSearchHit {
  kind: 'object' | 'agent' | 'message' | 'code' | 'metric' | 'dataset' | 'run' | 'history'
  type: string
  id: string
  key: string | null
  title: string
  snippet: string | null
  at: string | null
  author?: WireTaskActor
  subject?: { id: string; type: string; key: string | null; title: string }
  /** A code file's repository, and the lines its best match spans. */
  repo?: string | null
  lines?: [number | null, number | null]
  /** A metric's standing; a run's outcome. */
  status?: string
  /** The dashboards charting a metric. */
  used_on?: { id: string; type: string; key: string | null; title: string }[]
  /** A run: the agent that ran, and who asked it. */
  agent?: WireTaskActor
  asked_by?: WireTaskActor | null
}

/** Objects, agents and what was said, matching every word typed. */
export const searchWorkspace = (q: string) =>
  op<{ q: string; hits: WireSearchHit[] }>('search.query', { q, limit: 20 })

/** An answer from the workspace: the gateway's model searched, read and
 *  searched again, and says what it relied on. */
export interface WorkspaceAnswer {
  q: string
  answer: string
  citations: { id: string; type: string; key: string | null; title: string }[]
  steps: { kind: 'search' | 'read'; detail: string; found: number; label?: string | null }[]
  model: string | null
}

export const askWorkspace = (q: string) => opAsync<WorkspaceAnswer>('workspace.ask', { q })


/** Who can see and change one dashboard, doc or design. */
export type ShareRole = 'view' | 'edit' | 'owner'
export interface ItemAccess {
  id: string; type: string; title: string
  /** Private: only the people listed. Workspace: everyone in it. */
  visibility: 'private' | 'workspace'
  /** When open: everyone can view, edit, or (older items) has their workspace role. */
  general: 'view' | 'edit' | 'role' | null
  /** What the caller may do: manage means change who has access. */
  you: 'none' | 'view' | 'edit' | 'manage'
  people: { id: string; name: string; email: string | null; kind: string; role: ShareRole }[]
}
const shareKey = (verb: string) => `${verb}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
export type ItemReference = { id: string; type: string }
export type DocumentPreviewBlock =
  | { kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'notice'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'divider' }
  | { kind: 'snapshot'; artifact_id: string; version: string }
export type ItemPreview = ItemReference & {
  available: boolean; title?: string; key?: string; summary?: string; status?: string; detail?: string
  document?: { blocks: DocumentPreviewBlock[] }
}
export const itemPreviews = (items: ItemReference[]) => op<{ items: ItemPreview[] }>('items.previews', { items })

export const itemAccess = (id: string) => op<ItemAccess>('items.access', { id })
export const shareItem = (id: string, email: string, role: ShareRole) =>
  op<{ people: ItemAccess['people'] }>('items.share', { id, email, role, idempotencyKey: shareKey('share') })
export const unshareItem = (id: string, person_id: string) =>
  op<{ people: ItemAccess['people'] }>('items.unshare', { id, person_id, idempotencyKey: shareKey('unshare') })
export const setVisibility = (id: string, visibility: 'private' | 'workspace', role: 'view' | 'edit' = 'view') =>
  op<{ visibility: string }>('items.set_visibility', { id, visibility, role, idempotencyKey: shareKey('visibility') })


/** People in the workspace, and bringing them in. */
export type MemberRole = 'viewer' | 'contributor' | 'reviewer' | 'admin'
export interface Member { id: string; name: string; email: string | null; role: MemberRole
                          joined: string | null; last_seen: string | null }
const memberKey = (verb: string) => `${verb}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
export const listMembers = () => op<{ members: Member[]; you: { id: string; role: MemberRole | null } }>('members.list', {})
export const inviteMember = (name: string, email: string, role: MemberRole) =>
  op<{ person_id: string; name: string; email: string; role: MemberRole; token: string | null }>(
    'members.invite', { name, email, role, idempotencyKey: memberKey('invite') })
export const setMemberRole = (person_id: string, role: MemberRole) =>
  op<{ members: Member[] }>('members.set_role', { person_id, role, idempotencyKey: memberKey('role') })
export const removeMember = (person_id: string) =>
  op<{ members: Member[]; items_passed_to_you: number }>('members.remove', { person_id, idempotencyKey: memberKey('remove') })
export const newMemberToken = (person_id: string) =>
  // No token where people sign in with their company account: signing them
  // out everywhere is the whole of it.
  op<{ token: string | null }>('members.new_token', { person_id, idempotencyKey: memberKey('token') })

/** A person's own tokens, for their CLI and MCP clients. */
export type PersonalToken = { id: string; label: string; created_at: string; last_used: string | null; expires_at: string | null }
export const listTokens = () => op<{ tokens: PersonalToken[] }>('tokens.list', {})
export const createToken = (label: string, days: number) =>
  op<{ id: string; label: string; token: string; expires_at: string }>('tokens.create', { label, days, idempotencyKey: memberKey('mint') })
export const revokeToken = (id: string) => op<{ revoked: string }>('tokens.revoke', { id, idempotencyKey: memberKey('revoke') })

/** How people sign in here — for the admin page. */
export type SignInMode = 'required' | 'local'
export interface SignInMethod { on: boolean; settings?: string[]; name?: string | null; log_only?: boolean; header?: string | null }
export interface SignInSettings {
  mode: SignInMode; as: string | null; as_name: string | null; locked: boolean; this_computer: boolean
  redirect_url: string; public_url: string; join_domains: string[]
  methods: { google: SignInMethod; sso: SignInMethod; email: SignInMethod; proxy: SignInMethod; link: SignInMethod }
}
export const signInSettings = () => op<SignInSettings>('signin.settings', {})
export const setSignInMode = (mode: SignInMode) =>
  op<SignInSettings>('signin.set_mode', { mode, idempotencyKey: memberKey('signin-mode') })

// ── videos ─────────────────────────────────────────────────────────────
/** A video: a composition written as code, and the file rendered from it. */
export type VideoState = 'draft' | 'rendering' | 'ready' | 'failed'
export type VideoFormat = 'landscape' | 'portrait' | 'square'
export interface WireVideo {
  id: string; key: string | null; title: string; brief?: string; format?: VideoFormat
  state?: VideoState; composition?: string; visibility?: 'workspace' | 'private'; updated_at: string | null
  render?: { status: string; format?: 'mp4' | 'webm'; bytes?: number; seconds?: number | null; error?: string;
             started_at?: string; finished_at?: string; poster?: boolean } | null
}
export interface VideoTools { renderer: boolean; ffmpeg: boolean; ready: boolean; formats: string[]; ai_configured?: boolean }
const videoKey = (verb: string) => `${verb}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
export const listVideos = () => op<{ videos: WireVideo[] }>('videos.list', {})
export const getVideo = (id: string) => op<{ video: WireVideo }>('videos.get', { id })
export const createVideo = (title: string, brief: string, format: VideoFormat) =>
  op<{ id: string }>('videos.propose', { title, brief, format, idempotencyKey: videoKey('video') })
export const saveVideo = (video_id: string, changes: { composition?: string; brief?: string; title?: string; format?: VideoFormat }) =>
  op<{ video_id: string; state: VideoState }>('videos.save', { video_id, ...changes, idempotencyKey: videoKey('video-save') })
export const renderVideo = (video_id: string, format: 'mp4' | 'webm') =>
  op<{ video_id: string; state: VideoState }>('videos.render', { video_id, format, idempotencyKey: videoKey('video-render') })
export const videoTools = () => op<VideoTools>('videos.tools', {})

export type VideoSuggestion = { composition: string; summary: string; model: string | null }
export const assistVideo = (a: { video_id: string; instruction: string; composition: string;
  title: string; brief: string; context: string }) => opAsync<VideoSuggestion>('videos.assist', a)

/** The rendered file itself, or its still, for the page: fetched like any
 *  request, so it carries the same sign-in, and shown from memory. */
export async function videoBlob(video_id: string, what: 'video' | 'poster' = 'video'): Promise<Blob> {
  const r = await fetch(`${GATEWAY}/api/v1/videos.file`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...(sessionToken() ? { authorization: `Bearer ${sessionToken()}` } : {}) },
    body: JSON.stringify(what === 'poster' ? { video_id, poster: true } : { video_id, download: true }),
  })
  if (!r.ok) throw new GatewayError(`http_${r.status}`, 'the rendered file could not be fetched')
  return await r.blob()
}
export const deleteVideo = (video_id: string) =>
  op<{ video_id: string; deleted: boolean }>('videos.delete', { video_id, idempotencyKey: videoKey('video-delete') })

// ── artifacts ──────────────────────────────────────────────────────────
/** HTML that runs, kept as its own item; a doc embeds it by id. */
export interface WireArtifact {
  id: string; key: string | null; title: string; description?: string; html?: string; height?: number
  snapshot?: { status: 'pending' | 'ready' | 'failed' | 'unavailable'; error?: string } | null
  visibility?: 'workspace' | 'private'; updated_at: string | null
}
const artifactKey = (verb: string) => `${verb}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
export const getArtifact = (id: string) => op<{ artifact: WireArtifact }>('artifacts.get', { id })
/** A saved still only: never starts a browser or executes the embedded page. */
export async function artifactSnapshot(artifact_id: string, signal?: AbortSignal): Promise<Blob> {
  const token = sessionToken()
  const r = await fetch(`${GATEWAY}/api/v1/artifacts.snapshot`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ artifact_id }),
  })
  if (!r.ok) throw new GatewayError(`http_${r.status}`, 'The saved preview is unavailable.')
  const blob = await r.blob()
  if (blob.type !== 'image/png') throw new GatewayError('bad_preview', 'The saved preview is not an image.')
  return blob
}
export const createArtifact = (title: string, html: string) =>
  op<{ id: string }>('artifacts.propose', { title, html, idempotencyKey: artifactKey('artifact') })
export const saveArtifact = (artifact_id: string, changes: { html?: string; title?: string; height?: number }) =>
  op<{ artifact_id: string; rev: number }>('artifacts.save', { artifact_id, ...changes, idempotencyKey: artifactKey('artifact-save') })
export type ArtifactKind = 'block' | 'page'
export const draftArtifact = (instruction: string, html?: string, kind?: ArtifactKind) =>
  opAsync<{ html: string; kind: ArtifactKind; model: string }>('artifacts.draft', { instruction, html, kind })


// ── projects: a tag with a page, across every kind of work ──────────────────

export type ProjectColor = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal' | 'gray'
export type ProjectStatus = 'active' | 'done' | 'archived'
export const PROJECT_COLORS: ProjectColor[] = ['blue', 'green', 'amber', 'red', 'violet', 'teal', 'gray']
/** A project as a chip shows it. */
export interface ProjectTag { id: string; key: string | null; title: string; color: ProjectColor; status: ProjectStatus
  description?: string | null }
export interface WireProject extends ProjectTag {
  items: number
  tasks: { total: number; done: number }
  /** How many of each kind are in it — private ones counted too. */
  kinds?: Record<string, number>
  /** The newest few, each only if the reader may open it. */
  recent?: { id: string; type: string; key: string | null; title: string }[]
  updated_at: string
}
export interface ProjectItem {
  id: string; type: string; key: string | null; title: string; status: string | null; updated_at: string
  assignee?: { id: string; name: string; kind: string } | null
}
export interface ProjectContents {
  project: ProjectTag
  items: Record<string, ProjectItem[]>
  tasks: { ready: number; flight: number; review: number; done: number; total: number }
  /** In it, but not shared with you: counted, never named. */
  hidden: number
}
const projectKey = (verb: string) => `project-${verb}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
export const listProjects = (status?: ProjectStatus) =>
  op<{ projects: WireProject[]; total: number }>('projects.list', status ? { status } : {})
export const createProject = (p: { title: string; description?: string | null; color: ProjectColor }) =>
  op<{ id: string; created: boolean }>('projects.propose', { ...p, status: 'active', idempotencyKey: projectKey('new') })
export const updateProject = (project_id: string, change: Partial<Pick<ProjectTag, 'title' | 'description' | 'color' | 'status'>>) =>
  op<{ project: ProjectTag; rev: number }>('projects.update', { project_id, ...change, idempotencyKey: projectKey('update') })
export const tagProject = (project_id: string, object_id: string) =>
  op<{ tagged: boolean; already: boolean }>('projects.tag', { project_id, object_id, idempotencyKey: projectKey('tag') })
export const untagProject = (project_id: string, object_id: string) =>
  op<{ tagged: boolean; already: boolean }>('projects.untag', { project_id, object_id, idempotencyKey: projectKey('untag') })
export const projectItems = (project_id: string) => op<ProjectContents>('projects.items', { project_id })
export const projectsOf = (object_ids: string[]) =>
  op<{ projects: Record<string, ProjectTag[]> }>('projects.of', { object_ids })
