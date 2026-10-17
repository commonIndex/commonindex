import { useId } from 'react'
import type { MermaidEdge, MermaidFlow as Flow, MermaidNode, NodeShape } from '../data/mermaid'

/** Draws a parsed mermaid flowchart.
 *
 *  Deterministic and local: the same graph always produces the same picture, so
 *  two answers about the same flow are comparable, and nothing about the drawing
 *  depends on a diagram service being reachable. The layout is a layering — a
 *  node sits one row below the furthest thing that reaches it — which is what
 *  makes "UI → handler → store" come out as a column of three rather than as a
 *  spring the reader has to untangle.
 *
 *  Labels arrive from a model and are rendered as SVG text nodes: there is no
 *  HTML, `foreignObject`, or markup path here, so the strongest thing a label
 *  can do is be long, which `wrap` handles.
 */

const W = 176
const H = 58
const GAP_ACROSS = 26
const GAP_ALONG = 54
/** Left to right, the gap between layers is horizontal and holds the edge
 *  label on one line, so it is wider than the vertical one. */
const GAP_ALONG_LR = 96
const PAD = 14
/** 12.5px of this app's UI font is close enough to 6.5px a character for
 *  wrapping; being a little conservative costs a line break, being wrong the
 *  other way costs a label that leaves its box. */
const CHARS = Math.floor((W - 22) / 6.5)

function wrap(label: string, max = 3): string[] {
  const words = label.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  for (const word of words) {
    const last = lines[lines.length - 1]
    if (last && last.length + 1 + word.length <= CHARS) lines[lines.length - 1] = `${last} ${word}`
    else if (word.length <= CHARS) lines.push(word)
    else {
      // One unbreakable token longer than the box — a path or an identifier,
      // which is the common case here — is broken across lines. One line past
      // the limit, so the ellipsis below fires: a label cut with no mark reads
      // as a shorter name rather than as a truncation.
      for (let i = 0; i < word.length && lines.length <= max; i += CHARS) {
        lines.push(word.slice(i, i + CHARS))
      }
    }
  }
  if (!lines.length) return ['?']
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), `${lines[max - 1].slice(0, CHARS - 1)}…`]
}

/** Longest path from a root, computed by relaxation.
 *
 *  Capped at one pass per node so a cycle — which a model can absolutely
 *  describe, and which is a legitimate flow (a retry loop) — settles instead of
 *  spinning.
 */
function layers(nodes: MermaidNode[], edges: MermaidEdge[]): Map<string, number> {
  const depth = new Map(nodes.map(node => [node.id, 0]))
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false
    for (const edge of edges) {
      const from = depth.get(edge.from)
      const to = depth.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (from + 1 > to) { depth.set(edge.to, from + 1); moved = true }
    }
    if (!moved) break
  }
  return depth
}

interface Placed extends MermaidNode { x: number; y: number; lines: string[] }

function place(flow: Flow): { nodes: Placed[]; width: number; height: number } {
  const depth = layers(flow.nodes, flow.edges)
  const rows: MermaidNode[][] = []
  for (const node of flow.nodes) {
    const index = depth.get(node.id) ?? 0
    ;(rows[index] ??= []).push(node)
  }
  const filled = rows.filter(Boolean)
  const widest = Math.max(1, ...filled.map(row => row.length))
  // A box is W wide and H tall whichever way the layers run, so the axis they
  // run along takes the box's extent on that axis. Stepping left-to-right
  // layers by H put each box 112px after one 176px wide — every node on top of
  // the next, and the drawing wider than the frame it was given.
  const lr = flow.direction === 'LR'
  const alongSize = lr ? W : H
  const acrossSize = lr ? H : W
  const gapAlong = lr ? GAP_ALONG_LR : GAP_ALONG
  const across = widest * acrossSize + (widest - 1) * GAP_ACROSS
  const along = filled.length * alongSize + (filled.length - 1) * gapAlong

  const nodes: Placed[] = []
  filled.forEach((row, rowIndex) => {
    const rowAcross = row.length * acrossSize + (row.length - 1) * GAP_ACROSS
    const offset = (across - rowAcross) / 2
    row.forEach((node, columnIndex) => {
      const a = PAD + offset + columnIndex * (acrossSize + GAP_ACROSS)
      const b = PAD + rowIndex * (alongSize + gapAlong)
      nodes.push({ ...node, lines: wrap(node.label), x: lr ? b : a, y: lr ? a : b })
    })
  })
  return {
    nodes,
    width: (lr ? along : across) + PAD * 2,
    height: (lr ? across : along) + PAD * 2,
  }
}

function Shape({ node }: { node: Placed }) {
  const { x, y, shape } = node
  const common = { className: `mf-shape mf-${shape}` }
  if (shape === 'queue') {
    return <polygon {...common} points={`${x + 13},${y} ${x + W},${y} ${x + W - 13},${y + H} ${x},${y + H}`} />
  }
  if (shape === 'decision') {
    // A hexagon rather than mermaid's diamond: a diamond wide enough for "does
    // the caller hold this grant?" is mostly empty corners.
    return <polygon {...common} points={`${x + 15},${y} ${x + W - 15},${y} ${x + W},${y + H / 2} ${x + W - 15},${y + H} ${x + 15},${y + H} ${x},${y + H / 2}`} />
  }
  const radius: Record<NodeShape, number> = {
    box: 9, round: 18, stadium: H / 2, store: 7, queue: 9, decision: 9, external: 7,
  }
  return <>
    <rect {...common} x={x} y={y} width={W} height={H} rx={radius[shape]} />
    {shape === 'store' && <line className="mf-rule" x1={x} y1={y + 13} x2={x + W} y2={y + 13} />}
    {shape === 'external' && <>
      <line className="mf-rule" x1={x + 8} y1={y} x2={x + 8} y2={y + H} />
      <line className="mf-rule" x1={x + W - 8} y1={y} x2={x + W - 8} y2={y + H} />
    </>}
  </>
}

/** Where an edge leaves and enters, given the direction the layers run in. */
function anchors(from: Placed, to: Placed, direction: 'TD' | 'LR') {
  const forward = direction === 'TD' ? to.y > from.y : to.x > from.x
  if (direction === 'TD') {
    if (forward) return { sx: from.x + W / 2, sy: from.y + H, ex: to.x + W / 2, ey: to.y, side: false }
    // A back edge (a retry, a loop) leaves and re-enters on the right, so it
    // cannot be mistaken for another step down the page.
    return { sx: from.x + W, sy: from.y + H / 2, ex: to.x + W, ey: to.y + H / 2, side: true }
  }
  if (forward) return { sx: from.x + W, sy: from.y + H / 2, ex: to.x, ey: to.y + H / 2, side: false }
  return { sx: from.x + W / 2, sy: from.y + H, ex: to.x + W / 2, ey: to.y + H, side: true }
}

function path(from: Placed, to: Placed, direction: 'TD' | 'LR') {
  const { sx, sy, ex, ey, side } = anchors(from, to, direction)
  if (side) {
    const bulge = 34
    return direction === 'TD'
      ? { d: `M ${sx} ${sy} C ${sx + bulge} ${sy}, ${ex + bulge} ${ey}, ${ex} ${ey}`,
          mx: Math.max(sx, ex) + bulge * 0.62, my: (sy + ey) / 2 }
      : { d: `M ${sx} ${sy} C ${sx} ${sy + bulge}, ${ex} ${ey + bulge}, ${ex} ${ey}`,
          mx: (sx + ex) / 2, my: Math.max(sy, ey) + bulge * 0.62 }
  }
  const mid = direction === 'TD'
    ? `C ${sx} ${(sy + ey) / 2}, ${ex} ${(sy + ey) / 2}, ${ex} ${ey}`
    : `C ${(sx + ex) / 2} ${sy}, ${(sx + ex) / 2} ${ey}, ${ex} ${ey}`
  return { d: `M ${sx} ${sy} ${mid}`, mx: (sx + ex) / 2, my: (sy + ey) / 2 }
}

export function MermaidFlow({ flow, fit = false }: {
  flow: Flow
  /** Scale the whole flow into the box it is given, however small that makes
   *  it — for an expanded view that has the room, never inline. */
  fit?: boolean
}) {
  const marker = `mf-arrow-${useId().replace(/:/g, '')}`
  const { nodes, width, height } = place(flow)
  const byId = new Map(nodes.map(node => [node.id, node]))

  return (
    <figure className={`mermaid-flow${fit ? ' fit' : ''}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={flow.title || 'Flow diagram'}
           // Shrinks to fit, but not past where the labels stop being
           // readable: a long flow scrolls sideways in its frame instead.
           style={fit ? { width: '100%', height: '100%', maxWidth: width * 1.6, maxHeight: height * 1.6 }
                      : { width: '100%', maxWidth: width * 1.05, minWidth: width * 0.85, height: 'auto' }}>
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="mf-head" />
          </marker>
        </defs>

        {flow.edges.map((edge, index) => {
          const from = byId.get(edge.from)
          const to = byId.get(edge.to)
          if (!from || !to) return null
          const { d } = path(from, to, flow.direction)
          return <path key={`e${index}`} d={d} className={`mf-edge${edge.dashed ? ' mf-dashed' : ''}`}
                       markerEnd={`url(#${marker})`} />
        })}

        {nodes.map(node => (
          <g key={node.id}>
            <Shape node={node} />
            {node.lines.map((line, index) => (
              <text key={index} className="mf-label" x={node.x + W / 2}
                    y={node.y + H / 2 - (node.lines.length - 1) * 7.5 + index * 15}>
                {line}
              </text>
            ))}
          </g>
        ))}

        {/* Labels last, so an edge never draws over the word explaining it. */}
        {flow.edges.map((edge, index) => {
          const from = byId.get(edge.from)
          const to = byId.get(edge.to)
          if (!from || !to || !edge.label) return null
          const { mx, my } = path(from, to, flow.direction)
          return <text key={`l${index}`} className="mf-edge-label" x={mx} y={my}>
            {edge.label.length > 28 ? `${edge.label.slice(0, 27)}…` : edge.label}
          </text>
        })}
      </svg>
      {flow.title && <figcaption>{flow.title}</figcaption>}
    </figure>
  )
}
