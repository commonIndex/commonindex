/** A video's composition, read as scenes and edited without touching code.
 *
 *  A composition is one root `[data-composition-id]` holding timed clips
 *  (`data-start` / `data-duration`). A **scene** is a clip that is not a
 *  backdrop — a decorative layer that runs the whole video — and its
 *  **texts** are the elements in it that hold words and nothing else.
 *  Every edit returns new HTML: the composition stays the one source. */

export interface SceneText { index: number; node?: number; tag: string; text: string; heading: boolean }
export interface Scene { id: number; start: number; duration: number; label: string; texts: SceneText[] }
export interface Parsed { width: number; height: number; duration: number; scenes: Scene[] }

const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'B', 'STRONG', 'I', 'EM', 'SPAN', 'LI', 'DIV', 'A', 'SMALL', 'LABEL'])
const round = (n: number) => Math.round(n * 100) / 100

function load(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = doc.querySelector<HTMLElement>('[data-composition-id]')
  // Editing a scene must not discard head styles, scripts or root siblings.
  const serialize = () => /<!doctype\s|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)
    ? `${doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : ''}${doc.documentElement.outerHTML}`
    : doc.head.innerHTML + doc.body.innerHTML
  return { doc, root, serialize }
}

const num = (el: Element, attr: string) => {
  const n = Number(el.getAttribute(attr) ?? '0')
  return Number.isFinite(n) ? n : 0
}

/** Timed clips under the root, in time order, with whether each is a backdrop. */
function clips(root: HTMLElement) {
  const total = num(root, 'data-duration')
  const timed = [...root.querySelectorAll<HTMLElement>('[data-start][data-duration]')]
    // Top-level clips only: a clip's nearest timed-or-root ancestor is the root.
    .filter(el => el !== root && el.parentElement?.closest('[data-start][data-duration], [data-composition-id]') === root)
    .map(el => ({ el, start: num(el, 'data-start'), duration: num(el, 'data-duration') }))
  return timed.map(c => ({ ...c, backdrop: c.el.dataset.editorBackdrop === 'true' || (
      !c.el.hasAttribute('data-editor-scene') && timed.length > 1 &&
      c.start === 0 && Math.abs(c.duration - total) < 0.01 &&
      !c.el.textContent?.trim() && !c.el.querySelector('h1,h2,h3,h4,p,img,video,svg')
    ) }))
    .sort((a, b) => a.start - b.start)
}

function texts(scene: HTMLElement): SceneText[] {
  const out: SceneText[] = []
  const indices = new Map([...scene.querySelectorAll<HTMLElement>('*')].map((el, index) => [el, index]))
  const visit = (el: HTMLElement) => {
    const index = indices.get(el)
    const editable = index !== undefined && TEXT_TAGS.has(el.tagName)
    const field = { index: index ?? -1, tag: el.tagName.toLowerCase(), heading: !!el.closest('h1,h2,h3,h4') }
    const editedNodes = new Set((el.getAttribute('data-editor-text-nodes') ?? '').split(' ').filter(Boolean).map(Number))
    if (editable && el.children.length === 0) {
      // Preserve spaces/newlines in controlled inputs while typing.
      const text = el.textContent ?? ''
      if (text.trim() || el.hasAttribute('data-editor-text') || /^(H[1-4]|P)$/.test(el.tagName)) out.push({ ...field, text })
      return
    }
    el.childNodes.forEach((child, node) => {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child as HTMLElement)
      else if (editable && ((child.nodeType === Node.TEXT_NODE && (child.textContent?.trim() || editedNodes.has(node))) ||
        (child.nodeType === Node.COMMENT_NODE && child.textContent === 'eh-editor-text'))) {
        out.push({ ...field, node, text: child.nodeType === Node.COMMENT_NODE ? '' : child.textContent ?? '' })
      }
    })
  }
  visit(scene)
  return out
}

/** An element's words as a sentence: its pieces joined with spaces (lines
 *  stacked as blocks have none between them), then no space before punctuation. */
function readable(el: Element): string {
  const parts: string[] = []
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.textContent ?? '').trim()
    if (t) parts.push(t)
  }
  return parts.join(' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim()
}

export function parse(html: string): Parsed | null {
  const { root } = load(html)
  if (!root) return null
  const scenes = clips(root).filter(c => !c.backdrop).map((c, id) => {
    const t = texts(c.el)
    // A scene is named by its heading as read, all of it — a heading styled
    // in pieces is still one sentence.
    const h = c.el.querySelector('h1, h2, h3, h4')
    const heading = h ? readable(h) : ''

    return { id, start: c.start, duration: c.duration, label: (heading || t.find(v => v.text.trim())?.text.trim() || `Scene ${id + 1}`).slice(0, 70), texts: t }
  })
  return { width: Math.max(0, num(root, 'data-width')) || 1920, height: Math.max(0, num(root, 'data-height')) || 1080,
           duration: num(root, 'data-duration'), scenes }
}

/** Apply a change to the scenes, then lay them back end to end from where
 *  the first began, stretching backdrops and the root to the new length. */
function relayout(html: string, change: (scenes: HTMLElement[]) => HTMLElement[], resize?: (el: HTMLElement) => void): string {
  const { root, serialize } = load(html)
  if (!root) return html
  const all = clips(root)
  const scenes = all.filter(c => !c.backdrop)
  const first = scenes[0]?.start ?? 0
  const tail = (scenes.length ? num(root, 'data-duration') - (scenes.at(-1)!.start + scenes.at(-1)!.duration) : 0)
  const ordered = change(scenes.map(c => c.el))
  ordered.forEach(el => resize?.(el))
  let at = first
  for (const el of ordered) {
    el.setAttribute('data-editor-scene', 'true')
    el.setAttribute('data-start', String(round(at)))
    at += num(el, 'data-duration')
  }
  const total = round(at + Math.max(0, tail))
  root.setAttribute('data-duration', String(total))
  all.filter(c => c.backdrop).forEach(c => {
    c.el.setAttribute('data-editor-backdrop', 'true')
    c.el.setAttribute('data-duration', String(total))
  })
  return serialize()
}

export function setDuration(html: string, scene: number, seconds: number): string {
  if (!Number.isFinite(seconds)) return html
  const target = Math.max(0.5, Math.min(60, round(seconds)))
  let i = -1
  return relayout(html, s => s, el => { i += 1; if (i === scene) el.setAttribute('data-duration', String(target)) })
}

export function move(html: string, scene: number, by: -1 | 1): string {
  return relayout(html, s => {
    const to = scene + by
    if (!s[scene] || to < 0 || to >= s.length) return s
    const next = [...s];
    [next[scene], next[to]] = [next[to], next[scene]]
    return next
  })
}

export function remove(html: string, scene: number): string {
  return relayout(html, s => {
    if (s.length <= 1 || !s[scene]) return s
    s[scene].remove()
    return s.filter((_, i) => i !== scene)
  })
}

export function duplicate(html: string, scene: number): string {
  return relayout(html, s => {
    if (!s[scene]) return s
    const copy = s[scene].cloneNode(true) as HTMLElement
    const used = new Set([...s[scene].ownerDocument.querySelectorAll('[id]')].map(el => el.id))
    const ids = new Map<string, string>()
    const elements = [copy, ...copy.querySelectorAll<HTMLElement>('*')]
    for (const el of elements.filter(el => el.id)) {
      const old = el.id
      let i = 2
      while (used.has(`${old}-copy-${i}`)) i++
      el.id = `${old}-copy-${i}`
      used.add(el.id); ids.set(old, el.id)
    }
    for (const el of elements) {
      for (const attr of [...el.attributes]) {
        let value = attr.value
        if (['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers'].includes(attr.name)) {
          value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ')
        } else if (['href', 'xlink:href'].includes(attr.name) && value.startsWith('#')) {
          value = `#${ids.get(value.slice(1)) ?? value.slice(1)}`
        } else if (attr.name === 'data-start' && !Number.isFinite(Number(value))) {
          value = value.replace(/^([^\s]+)/, id => ids.get(id) ?? id)
        }
        // SVG fills, masks, clip paths and inline style references stay local.
        value = value.replace(/url\((['"]?)#([^)'"\s]+)\1\)/g, (_, quote, id) => `url(${quote}#${ids.get(id) ?? id}${quote})`)
        if (value !== attr.value) el.setAttribute(attr.name, value)
      }
    }
    s[scene].after(copy)
    return [...s.slice(0, scene + 1), copy, ...s.slice(scene + 1)]
  })
}

export function setText(html: string, scene: number, index: number, value: string, node?: number): string {
  const { root, serialize } = load(html)
  if (!root) return html
  const el = clips(root).filter(c => !c.backdrop)[scene]?.el.querySelectorAll('*')[index]
  if (!el) return html
  if (node !== undefined) {
    const child = el.childNodes[node]
    if (!child || (child.nodeType !== Node.TEXT_NODE && !(child.nodeType === Node.COMMENT_NODE && child.textContent === 'eh-editor-text'))) return html
    // A comment keeps an empty text slot stable across HTML serialization,
    // without adding a span that could change selectors or flex layout.
    const replacement = value ? el.ownerDocument.createTextNode(value) : el.ownerDocument.createComment('eh-editor-text')
    el.replaceChild(replacement, child)
    const editedNodes = new Set((el.getAttribute('data-editor-text-nodes') ?? '').split(' ').filter(Boolean))
    editedNodes.add(String(node)); el.setAttribute('data-editor-text-nodes', [...editedNodes].join(' '))
  } else {
    el.textContent = value
    el.setAttribute('data-editor-text', 'true')
  }
  return serialize()
}
