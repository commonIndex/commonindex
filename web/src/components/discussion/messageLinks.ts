import type { ItemReference } from '../../data/gateway'

export type MessageLink = { start: number; end: number; label: string; href: string; item?: ItemReference }
const TYPES: Record<string, string> = {
  docs: 'doc', dashboards: 'dashboard', experiments: 'experiment', designs: 'design',
  videos: 'video', artifacts: 'artifact', channels: 'channel', agents: 'agent', skills: 'skill',
}
export const referenceKey = (item: ItemReference) => `${item.type}:${item.id}`

/** Only exact routes on THIS origin are workspace references. No port/host
 * aliases, arbitrary URLs, redirects, credentials, or API endpoints. */
export function internalReference(url: URL): ItemReference | undefined {
  if (url.origin !== window.location.origin || url.username || url.password) return
  const path = url.pathname.replace(/\/$/, '')
  let type: string | undefined, id: string | undefined
  if (path === '/board') { type = 'task'; id = url.searchParams.get('task') ?? undefined }
  else if (path === '/code') { type = 'code_file'; id = url.searchParams.get('file') ?? undefined }
  else {
    const match = path.match(/^\/(docs|dashboards|experiments|designs|videos|artifacts|channels|agents|skills)\/(?:edit\/)?([^/]+)$/)
    if (!match || (path.includes('/edit/') && match[1] !== 'docs')) return
    type = TYPES[match[1]]
    try { id = decodeURIComponent(match[2]) } catch { return }
    if (['new', 'plan', 'analysis'].includes(id)) return
  }
  if (!type || !id || id.length > 200 || /[\s/\\?#\u0000-\u001f]/.test(id)) return
  return { type, id }
}

function safeLink(raw: string) {
  try {
    const url = new URL(raw, window.location.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    const item = internalReference(url)
    if (raw.startsWith('/') && !item) return
    return { href: url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href, item }
  } catch { return }
}

/** Small plain-text linkifier, not an HTML/Markdown renderer. Recognizes bare
 * links and [label](url); leaves all other formatting as literal text. */
export function messageLinks(text: string): MessageLink[] {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s<>"`]+|\/(?:docs|dashboards|experiments|designs|videos|artifacts|channels|agents|skills|board|code)[^\s<>"`]*)\)|https?:\/\/[^\s<>"`]+|(?<![\w/:])\/(?:docs|dashboards|experiments|designs|videos|artifacts|channels|agents|skills|board|code)[^\s<>"`]*/g
  const result: MessageLink[] = []
  for (const match of text.matchAll(pattern)) {
    let raw = match[2] ?? match[0]
    if (!match[2]) {
      raw = raw.replace(/[.,!?;:]+$/, '')
      // Punctuation around a URL is not part of it; balanced parentheses in
      // external URLs are preserved. Encoded characters are left untouched.
      while (/[)\]}]$/.test(raw)) {
        const close = raw.at(-1)!, open = ({ ')': '(', ']': '[', '}': '{' })[close]!
        if (raw.split(close).length <= raw.split(open).length) break
        raw = raw.slice(0, -1)
      }
    }
    const link = safeLink(raw)
    if (link) result.push({ ...link, start: match.index!, end: match.index! + (match[2] ? match[0].length : raw.length),
      label: match[1] ?? raw })
  }
  return result
}

export function previewLinks(text: string): MessageLink[] {
  const seen = new Set<string>()
  return messageLinks(text).filter(link => {
    if (!link.item || seen.has(referenceKey(link.item))) return false
    seen.add(referenceKey(link.item)); return true
  }).slice(0, 3)
}
