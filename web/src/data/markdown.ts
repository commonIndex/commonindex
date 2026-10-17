/** Markdown, parsed to data rather than to HTML.
 *
 *  Code Query answers arrive as a markdown document — headings, a routing
 *  table, cited excerpts, a ```mermaid flow — and a document is what the reader
 *  should see, not one pre-wrapped paragraph of it.
 *
 *  The reason this is a parser to *data* and not a markdown-to-HTML library is
 *  the same reason `code.ask` returns a validated flow specification instead of
 *  a picture: the answer is model text, so nothing in it may become markup. The
 *  output here is a tree of spans and blocks, every leaf of which is a string
 *  that React will render as a text node. There is no `dangerouslySetInnerHTML`
 *  anywhere in this path, so an `<img onerror=…>` in an answer renders as the
 *  literal characters `<img onerror=…>` — which is also what a reader who wants
 *  to see what the model said should see.
 *
 *  A deliberately small subset: headings, paragraphs, lists, fenced code,
 *  tables, blockquotes (including GitHub's `[!NOTE]` alerts), thematic rules,
 *  and inline code/emphasis/links. Anything unrecognised survives as text.
 */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; spans: Span[] }
  | { kind: 'em'; spans: Span[] }
  | { kind: 'link'; href: string; spans: Span[] }

/** GitHub's alert flavours, which the gateway emits for a degraded index and
 *  for "this repository was never indexed". They carry the part of a response a
 *  reader most needs and most easily skips. */
export type Tone = 'plain' | 'note' | 'warn' | 'important' | 'tip' | 'caution'

export interface ListItem { spans: Span[]; depth: number }

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'para'; spans: Span[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'mermaid'; text: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'quote'; tone: Tone; blocks: Block[] }
  | { kind: 'table'; head: Span[][]; rows: Span[][][] }
  | { kind: 'rule' }

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)/
const RULE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const ALERT = /^\[!(NOTE|WARNING|IMPORTANT|TIP|CAUTION)\]\s*$/
const TABLE_ROW = /^\s*\|(.*)\|?\s*$/
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

const TONES: Record<string, Tone> = {
  NOTE: 'note', WARNING: 'warn', IMPORTANT: 'important', TIP: 'tip', CAUTION: 'caution',
}

/** Only schemes a link may actually have.
 *
 *  A model can write a link, so this is an allowlist rather than a denylist of
 *  the two or three schemes anyone remembers — a rejected href renders as its
 *  own text, which loses nothing a reader needed. */
function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (!href) return null
  if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(href)) return href
  // A bare `example.com/x` is a relative path as far as the browser is
  // concerned; treated as one rather than guessed into https.
  return /^[\w./-]+$/.test(href) ? href : null
}

/** Inline spans. Scanned left to right rather than by one big alternation, so a
 *  backtick run inside emphasis and an asterisk inside code both land in the
 *  right place. */
export function inline(src: string): Span[] {
  const out: Span[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ kind: 'text', text }); text = '' } }

  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const escape = /^\\([\\`*_[\]()#|~>])/.exec(rest)
    if (escape) { text += escape[1]; i += 2; continue }

    // A code span is closed by a run of the same length, which is how a snippet
    // containing backticks is quoted at all.
    const code = /^(`+)([\s\S]*?)\1/.exec(rest)
    if (code) { flush(); out.push({ kind: 'code', text: code[2].trim() }); i += code[0].length; continue }

    // `_` inside a word is not emphasis — `object_id_here` and `__init__.py`
    // are identifiers, and reading them as emphasis deletes the underscores from
    // a citation the reader is meant to be able to paste.
    const intraword = /\w/.test(src[i - 1] ?? '')
    const strong = /^(\*\*|__)(?=\S)([\s\S]+?)\1(?!\w)/.exec(rest)
    if (strong && !(strong[1] === '__' && intraword)) {
      flush(); out.push({ kind: 'strong', spans: inline(strong[2]) })
      i += strong[0].length
      continue
    }

    const em = /^(\*|_)(?=\S)([^\n]*?[^\s\\])\1(?!\w)/.exec(rest)
    if (em && !(em[1] === '_' && intraword)) {
      flush(); out.push({ kind: 'em', spans: inline(em[2]) })
      i += em[0].length
      continue
    }

    // A balanced pair inside the target, so `[x](./a(b).md)` keeps its suffix
    // rather than leaving a stray bracket behind as text.
    const link = /^\[([^\]\n]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/.exec(rest)
    if (link) {
      flush()
      const href = safeHref(link[2])
      const label = inline(link[1] || link[2])
      if (href) out.push({ kind: 'link', href, spans: label })
      else out.push(...label)
      i += link[0].length
      continue
    }

    text += rest[0]
    i += 1
  }
  flush()
  return out
}

const cells = (line: string): Span[][] =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
    // An escaped pipe is a cell's own content — `one_line` writes them, so a
    // repository named `a|b` must not split its row in two.
    .split(/(?<!\\)\|/)
    .map(cell => inline(cell.replace(/\\\|/g, '|').trim()))

export function parse(src: string): Block[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { i += 1; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const [, , marker, lang] = fence
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const close = FENCE.exec(lines[i])
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length
            && !close[3]) { i += 1; break }
        body.push(lines[i]); i += 1
      }
      const text = body.join('\n')
      blocks.push(lang.toLowerCase() === 'mermaid'
        ? { kind: 'mermaid', text } : { kind: 'code', lang: lang.toLowerCase(), text })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: inline(heading[2].trim()) })
      i += 1
      continue
    }

    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); i += 1; continue }

    // A table needs its delimiter row to be a table at all; without that check a
    // sentence containing a pipe becomes a one-cell table.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line)
      const rows: Span[][][] = []
      i += 2
      while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push(cells(lines[i])); i += 1 }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const body: string[] = []
      while (i < lines.length) {
        const more = QUOTE.exec(lines[i])
        if (!more) break
        body.push(more[1]); i += 1
      }
      let tone: Tone = 'plain'
      const alert = ALERT.exec(body[0]?.trim() ?? '')
      if (alert) { tone = TONES[alert[1]]; body.shift() }
      blocks.push({ kind: 'quote', tone, blocks: parse(body.join('\n')) })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      const isOrdered = !bullet
      const items: ListItem[] = []
      while (i < lines.length) {
        const next = lines[i]
        const match = isOrdered ? ORDERED.exec(next) : BULLET.exec(next)
        if (match) {
          items.push({ spans: inline(match[3]), depth: Math.min(3, Math.floor(match[1].length / 2)) })
          i += 1
          continue
        }
        // A wrapped item continues its own bullet rather than starting a
        // paragraph, which is what a hard-wrapped generated list looks like.
        if (items.length && next.trim() && /^\s+\S/.test(next)
            && !BULLET.test(next) && !ORDERED.test(next)) {
          const last = items[items.length - 1]
          last.spans = [...last.spans, { kind: 'text', text: ' ' }, ...inline(next.trim())]
          i += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i])
           && !FENCE.test(lines[i]) && !RULE.test(lines[i]) && !QUOTE.test(lines[i])
           && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])
           && !(TABLE_ROW.test(lines[i]) && TABLE_RULE.test(lines[i + 1] ?? ''))) {
      para.push(lines[i]); i += 1
    }
    blocks.push({ kind: 'para', spans: inline(para.join('\n')) })
  }

  return blocks
}
