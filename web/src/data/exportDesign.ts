/** Getting a design out of the platform.
 *
 *  The export serialises the SVG the renderer already drew rather than drawing
 *  it again server-side. A second renderer would have to be kept in step with
 *  the first by hand, and the day it slipped the file somebody shared would
 *  stop being the design somebody approved — which is the argument this
 *  codebase already makes for a panel citing a metric instead of carrying its
 *  own SQL.
 */

/** The custom properties the drawing actually references. Resolved from the
 *  live document so the file matches the screen it came from, rather than a
 *  palette guessed at export time. */
const VARS = [
  '--sans', '--mono', '--text', '--text2', '--muted', '--border', '--border2',
  '--panel', '--panel2', '--sunk', '--accent', '--warn', '--green', '--r',
]

export interface ExportMeta {
  title: string
  surface: string
  state: string
  builtOn?: string | null
  onSystem: { on: number; total: number; unverified?: number }
  exportedAt: string
}

export function resolveVars(doc: Document = document): Record<string, string> {
  const s = getComputedStyle(doc.documentElement)
  const out: Record<string, string> = {}
  for (const v of VARS) out[v] = s.getPropertyValue(v).trim()
  return out
}

/** A standalone page: no script, no network, no fonts to fetch. It opens in
 *  fifteen years and in an email client, which a link to a design tool does
 *  not. */
export function designToHtml(
  screens: { id: string; name: string; html: string }[],
  meta: ExportMeta,
  vars: Record<string, string>,
): string {
  const { on, total, unverified = 0 } = meta.onSystem
  // The same discipline the CSV export follows: a file that leaves here says
  // what produced it, so a number in a deck can be traced back to an object.
  const provenance = [
    `${meta.title} — ${meta.surface}, ${meta.state}`,
    meta.builtOn ? `built on ${meta.builtOn}` : 'built on nothing — cites no template',
    total === 0 ? 'no elements'
      : on === total ? 'on-system: every element cites a token in this palette'
      // Reported apart, because they are not the same claim: one names nothing,
      // the other names something this file cannot check.
      : `${on} of ${total} elements cite a token in this palette`
        + (unverified ? `; ${unverified} cite something it does not define` : '')
        + (total - on - unverified ? `; ${total - on - unverified} cite nothing` : ''),
    `exported ${meta.exportedAt} from CommonIndex`,
  ]
  const root = Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join('\n')

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(meta.title)}</title>
<!--
${provenance.map(l => `  ${safeComment(l)}`).join('\n')}
-->
<style>
  :root {
${root}
  }
  body {
    margin: 0; padding: 40px; background: #f2efe9;
    font-family: var(--sans), -apple-system, system-ui, sans-serif; color: var(--text);
  }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .meta { font-family: var(--mono), monospace; font-size: 11.5px; color: var(--muted); }
  .meta div { margin-top: 2px; }
  .screens { display: flex; flex-wrap: wrap; gap: 26px; margin-top: 26px; align-items: flex-start; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 7px; }
  figcaption { font-family: var(--mono), monospace; font-size: 11px; color: var(--muted); }
  .screen { position: relative; overflow: hidden; }
  .screen * { box-sizing: border-box; }
  /* A link in the design is an anchor to the screen it names. The file still
     carries no script, which is the point of it: the spec says which screen,
     and an id and an href are enough to go there. */
  .goto { position: absolute; display: block; }
  figure:target figcaption { color: var(--accent); }
</style>
<h1>${esc(meta.title)}</h1>
<div class="meta">${provenance.map(l => `<div>${esc(l)}</div>`).join('')}</div>
<div class="screens">
${screens.map(s => `  <figure id="screen-${esc(s.id)}">
${s.html}
    <figcaption>${esc(s.name)}</figcaption>
  </figure>`).join('\n')}
</div>
`
}

/** Safe inside an HTML comment, where entities are not parsed — so escaping is
 *  both useless and misleading there. A title carrying `-->` would otherwise
 *  close the comment and everything after it would be markup. */
function safeComment(s: string): string {
  return s.replace(/-{2,}/g, '\u2013').replace(/[<>]/g, '')
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

export function downloadHtml(filename: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design'
}

/** The engineering handoff.
 *
 *  The HTML above is something a person reads. This is what a coding agent
 *  reads: the exact spec that was approved, the tokens it resolved against,
 *  which revision it is, and the role vocabulary the renderer implements — so
 *  an implementation can be checked against the same names the design composed
 *  with rather than eyeballed from a picture.
 *
 *  It is deliberately the same object `designs.get` returns over HTTP and MCP.
 *  A file is for attaching to a ticket; the API is for an agent that would
 *  rather not be handed a download. */
export interface HandoffPackage {
  design: { id: string; title: string; surface: string; state: string; rev?: number }
  spec: unknown
  tokens: Record<string, unknown> | null
  tokensFrom: string | null
  roles: string[]
  onSystem: { on: number; total: number; unverified?: number }
  fetchedWith: string
  exportedAt: string
}

/** The roles the renderer implements. An implementer needs to know the
 *  vocabulary is closed — that this is the whole list, not a sample. */
export const ROLE_CATALOGUE = [
  'heading', 'body', 'field-label', 'button', 'input', 'image', 'list', 'nav',
  'tabbar', 'card', 'divider', 'logo', 'avatar', 'badge', 'icon',
] as const

export function designToPackage(
  design: { id: string; title: string; surface: string; state?: string
            spec: unknown; current_rev?: number },
  tokens: Record<string, unknown> | undefined,
  tokensFrom: string | null,
  onSystem: { on: number; total: number; unverified?: number },
  exportedAt: string,
): HandoffPackage {
  return {
    design: { id: design.id, title: design.title, surface: design.surface,
              state: design.state ?? 'draft', rev: design.current_rev },
    spec: design.spec,
    tokens: tokens ?? null,
    tokensFrom,
    roles: [...ROLE_CATALOGUE],
    onSystem,
    fetchedWith: `POST /api/v1/designs.get {"id":"${design.id}"}`,
    exportedAt,
  }
}

export function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
