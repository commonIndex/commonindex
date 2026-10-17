/** A mermaid `flowchart` block, parsed back into nodes and edges.
 *
 *  The gateway writes the diagram as mermaid text so the markdown document is
 *  correct markdown anywhere — a file, a PR description, an MCP client. The web
 *  client still draws it itself, from the graph parsed back out of that text,
 *  rather than shipping a diagram engine that turns text into markup: the node
 *  labels come from a model, and `MermaidFlow` renders them as SVG text nodes
 *  the same way every other diagram in this app does.
 *
 *  This is a subset — `flowchart`/`graph`, one direction, node shapes, edges
 *  with or without labels — because that is the whole of what the gateway emits.
 *  It is tolerant of the rest (`subgraph`, `classDef`, `style`) by ignoring it,
 *  and refuses rather than half-drawing when a block is mostly things it does
 *  not understand: `Markdown` then shows the fence as code, which is honest
 *  about there being a diagram it could not draw.
 */

export type NodeShape = 'box' | 'round' | 'stadium' | 'store' | 'queue' | 'decision' | 'external'

export interface MermaidNode { id: string; label: string; shape: NodeShape }
export interface MermaidEdge { from: string; to: string; label: string; dashed: boolean }

export interface MermaidFlow {
  title: string
  direction: 'TD' | 'LR'
  nodes: MermaidNode[]
  edges: MermaidEdge[]
}

const HEADER = /^\s*(?:flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?\s*;?\s*$/i
const TITLE = /^\s*%%\s*title:\s*(.+?)\s*$/

/** The bracket pairs, longest first — `([` must be tried before `[`. */
const SHAPES: [string, string, NodeShape][] = [
  ['([', '])', 'stadium'],
  ['[(', ')]', 'store'],
  ['[[', ']]', 'external'],
  ['[/', '/]', 'queue'],
  ['[\\', '\\]', 'queue'],
  ['{{', '}}', 'decision'],
  ['((', '))', 'round'],
  ['[', ']', 'box'],
  ['(', ')', 'round'],
  ['{', '}', 'decision'],
]

const IGNORED = /^\s*(%%|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b)/i

/** Mermaid's own escapes, undone.
 *
 *  `#quot;` and `#35;` are how a label carries a quote or a hash through mermaid
 *  text at all — the gateway writes them, so a reader would otherwise see the
 *  entity rather than the character. `<br/>` becomes a space: a line break is
 *  the one piece of markup mermaid labels allow, and this renderer wraps text
 *  itself. */
function decode(label: string): string {
  return label
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/#quot;/g, '"')
    .replace(/#(\d{1,5});/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function unquote(label: string): string {
  const trimmed = label.trim()
  return /^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)
    ? trimmed.slice(1, -1) : trimmed
}

/** One side of an edge, or a line that only declares a node. */
function declaration(raw: string): MermaidNode | null {
  const text = raw.trim().replace(/;$/, '')
  if (!text) return null
  for (const [open, close, shape] of SHAPES) {
    const start = text.indexOf(open)
    if (start <= 0 || !text.endsWith(close)) continue
    const id = text.slice(0, start).trim()
    if (!/^[\w.-]+$/.test(id)) return null
    return { id, label: decode(unquote(text.slice(start + open.length, text.length - close.length))), shape }
  }
  return /^[\w.-]+$/.test(text) ? { id: text, label: decode(text), shape: 'box' } : null
}

/** `A -- label --> B` rewritten as `A -->|label| B`, so one arrow form is
 *  enough for the scanner below. */
function normalizeEdgeLabels(line: string): string {
  return line.replace(/\s(--|==|-\.)\s+([^->|][^>]*?)\s+(-->|==>|-\.->|-->)\s/g,
                      (_, _dash, label, arrow) => ` ${arrow}|${label}| `)
}

const ARROW = /(-{2,}>|-\.-+>|={2,}>|-{3,}|-\.-)(?:\s*\|([^|]*)\|)?/g

export function parseFlowchart(src: string): MermaidFlow | null {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const first = lines.find(line => line.trim())
  if (!first || !HEADER.test(first)) return null

  const direction: 'TD' | 'LR' = /\b(LR|RL)\b/i.test(first) ? 'LR' : 'TD'
  const nodes = new Map<string, MermaidNode>()
  const edges: MermaidEdge[] = []
  let title = ''
  let unread = 0
  let read = 0

  const remember = (node: MermaidNode | null): string | null => {
    if (!node) return null
    const existing = nodes.get(node.id)
    // A later declaration wins only where it says more: `n0 --> n1` after
    // `n1["Postgres"]` must not rename the node to `n1`.
    if (!existing) nodes.set(node.id, node)
    else if (node.label !== node.id && existing.label === existing.id) nodes.set(node.id, node)
    return node.id
  }

  for (const raw of lines.slice(lines.indexOf(first) + 1)) {
    const line = raw.trim()
    if (!line) continue
    const titled = TITLE.exec(raw)
    if (titled) { title = decode(titled[1]); continue }
    if (IGNORED.test(line)) continue

    const normalized = normalizeEdgeLabels(` ${line} `)
    ARROW.lastIndex = 0
    const arrows = [...normalized.matchAll(ARROW)]
    if (arrows.length) {
      // A chain (`A --> B --> C`) is the segments between arrows, so the same
      // scan handles one edge and several. The arrow is held over to the next
      // segment because an edge's label belongs to the arrow BEHIND it.
      let cursor = 0
      let previous: string | null = null
      let pending: RegExpMatchArray | null = null
      let ok = true
      const join = (from: string, to: string, arrow: RegExpMatchArray) => edges.push({
        // Quoted, because that is how the gateway writes a label that could
        // contain a space or a bracket.
        from, to, label: decode(unquote(arrow[2] ?? '')), dashed: arrow[1].includes('.'),
      })
      for (const arrow of arrows) {
        const id = remember(declaration(normalized.slice(cursor, arrow.index)))
        if (!id) ok = false
        if (previous && id && pending) join(previous, id, pending)
        previous = id
        pending = arrow
        cursor = (arrow.index ?? 0) + arrow[0].length
      }
      const last = remember(declaration(normalized.slice(cursor)))
      if (!last) ok = false
      if (previous && last && pending) join(previous, last, pending)
      if (ok) read += 1
      else unread += 1
      continue
    }

    if (remember(declaration(line))) read += 1
    else unread += 1
  }

  // Half a diagram is worse than none: a reader cannot tell which half is
  // missing, and the fence itself is still readable.
  if (!nodes.size || unread > read) return null
  return { title, direction, nodes: [...nodes.values()], edges }
}
