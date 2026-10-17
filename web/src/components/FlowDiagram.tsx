import type { Diagram, DiagramNode } from '../data/types'

// Deterministic renderer for agent-generated diagram specs.
// The agent emits nodes + edges (never markup); CommonIndex draws them.
// Same spec always renders the same picture, diffs are spec diffs.
const W = 150
const H = 52

/** Natural width of a spec — lets a card size itself to its diagram. */
export const naturalWidth = (d: Diagram) => Math.max(...d.nodes.map(n => n.x)) + W + 20

const KIND_FILL: Record<string, string> = {
  svc: 'var(--panel)',
  store: 'var(--accent-bg)',
  queue: 'var(--warn-bg)',
  ext: 'var(--panel2)',
  client: 'var(--green-bg)',
}

function edgePoints(a: DiagramNode, b: DiagramNode) {
  if (Math.abs(a.x - b.x) < 10) {
    // vertical: bottom center → top center
    const down = b.y > a.y
    return { sx: a.x + W / 2, sy: down ? a.y + H : a.y, ex: b.x + W / 2, ey: down ? b.y : b.y + H, vertical: true }
  }
  const rightward = b.x > a.x
  return {
    sx: rightward ? a.x + W : a.x,
    sy: a.y + H / 2,
    ex: rightward ? b.x : b.x + W,
    ey: b.y + H / 2,
    vertical: false,
  }
}

export function FlowDiagram({ diagram }: { diagram: Diagram }) {
  const byId = new Map(diagram.nodes.map(n => [n.id, n]))
  const maxX = Math.max(...diagram.nodes.map(n => n.x)) + W + 20
  const maxY = Math.max(...diagram.nodes.map(n => n.y)) + H + 24

  return (
    // Fills its card but never blows past its own natural size, so a four-node
    // flow and a nine-node one render at the same label size.
    <svg
      viewBox={`0 0 ${maxX} ${maxY}`}
      style={{ width: '100%', maxWidth: maxX * 1.06, height: 'auto', display: 'block', margin: '0 auto' }}
      role="img"
      aria-label={diagram.title}
    >
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--text2)" />
        </marker>
        <marker id="arrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
        </marker>
        <marker id="arrC" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--ink)" />
        </marker>
      </defs>
      {diagram.edges.map((e, i) => {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b) return null
        const { sx, sy, ex, ey } = edgePoints(a, b)
        return (
          <line
            key={i}
            x1={sx} y1={sy} x2={ex} y2={ey}
            stroke={e.changed ? 'var(--ink)' : e.async ? 'var(--accent)' : 'var(--text2)'}
            strokeWidth={e.changed ? 2.4 : 1.4}
            strokeDasharray={e.async ? '5 4' : undefined}
            markerEnd={e.changed ? 'url(#arrC)' : e.async ? 'url(#arrA)' : 'url(#arr)'}
          />
        )
      })}
      {diagram.nodes.map(n => (
        <g key={n.id}>
          {/* a touched hop wears an ink ring — the same ink that marks the one
              committing action on a screen, so "this is what moves" reads without
              spending a hue */}
          {n.changed && <rect x={n.x - 4} y={n.y - 4} width={W + 8} height={H + 8} rx={12} fill="none" stroke="var(--border2)" strokeWidth={1} strokeDasharray="3 3" />}
          <rect
            x={n.x} y={n.y} width={W} height={H} rx={9}
            fill={KIND_FILL[n.kind ?? 'svc']}
            stroke={n.changed ? 'var(--ink)' : 'var(--border2)'}
            strokeWidth={n.changed ? 2 : 1}
            strokeDasharray={n.kind === 'ext' ? '4 3' : undefined}
          />
          <text x={n.x + W / 2} y={n.y + 22} fontSize={12} fontWeight={600} fill="var(--text)" textAnchor="middle">{n.label}</text>
          {n.sub && <text x={n.x + W / 2} y={n.y + 38} fontSize={9.5} fill="var(--muted)" textAnchor="middle">{n.sub}</text>}
        </g>
      ))}
      {diagram.edges.map((e, i) => {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b || !e.label) return null
        const { sx, sy, ex, ey, vertical } = edgePoints(a, b)
        const mx = (sx + ex) / 2
        const my = (sy + ey) / 2
        return (
          <text
            key={`l${i}`}
            x={vertical ? mx + 8 : mx}
            y={vertical ? my + 3 : my - 7}
            fontSize={10}
            fill="var(--muted)"
            textAnchor={vertical ? 'start' : 'middle'}
            style={{ paintOrder: 'stroke', stroke: 'var(--panel)', strokeWidth: 3 }}
          >
            {e.label}{e.async ? ' ⇢ async' : ''}
          </text>
        )
      })}
    </svg>
  )
}
