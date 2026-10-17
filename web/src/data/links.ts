/** Where each thing lives in the app — one answer for search, notifications,
 *  and anything else that links to a thing it did not render itself. */

export interface Linkable { id: string; type: string }

/** The page a thing is on. */
export function pageFor(t: Linkable): string {
  switch (t.type) {
    case 'dashboard': return `/dashboards/${t.id}`
    case 'doc': return `/docs/edit/${t.id}`
    case 'experiment': return `/experiments/${t.id}`
    case 'design': return `/designs/${t.id}`
    case 'video': return `/videos/${t.id}`
    case 'artifact': return `/artifacts/${t.id}`
    case 'project': return `/projects/${t.id}`
    case 'skill': return `/skills/${t.id}`
    case 'agent': return `/agents/${t.id}`
    case 'task': return `/board?task=${t.id}`
    case 'channel': return `/channels/${t.id}`
    case 'code_file': return codeHref({ id: t.id })
    // A definition has no page of its own; the generated warehouse skill
    // documents every one, with the panels that chart it.
    case 'metric': case 'dataset': return DEFINITIONS
    default: return '/board'
  }
}

const DEFINITIONS = '/skills/skill-warehouse-context'

/** A code file, opened on Code query at the lines that matched. */
export function codeHref(f: { id: string; path?: string | null; repo?: string | null
                              lines?: (number | null)[] | null }): string {
  const q = new URLSearchParams({ file: f.id })
  if (f.path) q.set('path', f.path)
  if (f.repo) q.set('repo', f.repo)
  const [from, to] = f.lines ?? []
  if (from) q.set('lines', to && to !== from ? `${from}-${to}` : String(from))
  return `/code?${q}`
}

/** Where the conversation about a thing is: its comments, opened from the
 *  hash — or the page that shows it already, a channel's or a task's panel. */
export function conversationFor(t: Linkable): string {
  const page = pageFor(t)
  return t.type === 'task' || t.type === 'channel' || page === '/board' ? page : `${page}#comments`
}
