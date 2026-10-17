import type { Skill } from '../data/types'

/** What an authored skill does, for a person.
 *
 *  Every skill's SKILL.md is written for the agent that runs it, so a reviewer
 *  reads instructions addressed to somebody else. The loop underneath is the
 *  same for all of them and is the product's whole thesis — **agents draft,
 *  humans steer and merge** — so it is drawn once and filled in from the
 *  skill's own triggers, tools and history.
 *
 *  The feedback arrow is the part worth drawing. A rejection here is not a
 *  dead end: the reason is typed, and it is the signal the skill is measured
 *  by. An acceptance rate that came from a benchmark would be a claim; one that
 *  came from this loop is evidence.
 */

const W = 1040
const H = 292
const TOP = 56
const BH = 104

type Cell = { x: number; w: number; eyebrow: string; title: string; lines: string[]; tone?: string }

function trim(items: string[], n: number): string {
  if (!items.length) return '—'
  const head = items.slice(0, n).join(', ')
  return items.length > n ? `${head} +${items.length - n}` : head
}

/** SVG text does not wrap, so long values are cut to what the box holds. */
function fit(s: string, chars: number): string {
  return s.length > chars ? s.slice(0, chars - 1).trimEnd() + '…' : s
}

/** Break at word boundaries across at most `max` lines, then ellipsize.
 *
 *  Used for the trigger, which is the one field in this diagram somebody is
 *  actually reading for content — "a running experiment reaches its planne…"
 *  cuts off the part that says what happens.
 */
function wrap(s: string, chars: number, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= chars) { line = next; continue }
    out.push(line)
    line = word
    if (out.length === max) return [...out.slice(0, max - 1), fit(`${out[max - 1]} ${line}`, chars)]
  }
  if (line) out.push(line)
  return out.slice(0, max)
}

export function AuthoredFlow({ skill }: { skill: Skill }) {
  const live = skill.status === 'installed' && !skill.blocked
  const pct = skill.acceptance

  const cells: Cell[] = [
    {
      x: 0, w: 262, eyebrow: 'when it fires', title: live ? 'A trigger' : 'Nothing yet',
      tone: live ? 'plain' : 'idle',
      lines: live
        ? [...wrap(skill.triggers[0] ?? 'on request', 40, 2),
           ...(skill.triggers.length > 1 ? [`or ${skill.triggers.length - 1} other trigger`
             + (skill.triggers.length > 2 ? 's' : '')] : [])]
        : [skill.blocked ? 'Blocked: it wants scopes' : 'Not installed on any agent.',
           skill.blocked ? 'nobody has granted.' : 'Installing one is a grant.'],
    },
    {
      x: 286, w: 268, eyebrow: 'what it does', title: 'Reads, then calls',
      lines: [`SKILL.md + ${Math.max(0, skill.files.length - 1)} reference files.`,
              fit(`Calls ${trim(skill.tools, 2)}`, 41),
              fit(`with ${trim(skill.scopes, 2)}`, 41)],
    },
    {
      x: 578, w: 176, eyebrow: 'what it produces', title: 'A proposal',
      lines: ['Never a direct write.', 'The same review path', 'as any other change.'],
    },
    {
      x: 778, w: 262, eyebrow: 'what happens to it', title: 'A person decides',
      tone: 'end',
      lines: pct === null
        ? ['No history here yet, so no', 'acceptance rate — the number', 'is earned, not claimed.']
        : [`Merged unchanged ${pct}% of the time`, `over ${skill.runs7d} runs in 7 days.`,
           'The rest come back with a reason.'],
    },
  ]

  return (
    <svg className="skillflow" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={
        `What ${skill.name} does. ` + (live
          ? `It fires when ${skill.triggers[0] ?? 'asked'}. `
          : 'Nothing runs it yet: it is not installed on any agent. ')
        + `It reads its instructions and calls ${trim(skill.tools, 3)}, using the scopes its host `
        + 'agent already holds. It never writes directly — it files a proposal, which goes through '
        + 'the same review as any other change. A person merges or rejects it'
        + (pct === null ? '. It has no acceptance rate here yet.'
          : `, and ${pct}% are merged unchanged. `)
        + 'A rejection carries a typed reason, which is the signal the skill is measured by.'}>
      <defs>
        <marker id="af-head" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="var(--border2)" />
        </marker>
      </defs>

      {cells.map((c, i) => (
        <g key={c.eyebrow}>
          {i > 0 && (
            <path d={`M${cells[i - 1].x + cells[i - 1].w + 6} ${TOP + BH / 2} L${c.x - 6} ${TOP + BH / 2}`}
              className="sf-arrow" markerEnd="url(#af-head)" />
          )}
          <rect x={c.x} y={TOP} width={c.w} height={BH} rx={9} className={`sf-b sf-${c.tone ?? 'plain'}`} />
          <text x={c.x + 14} y={TOP + 20} className="sf-when">{c.eyebrow}</text>
          <text x={c.x + 14} y={TOP + 42} className="sf-t">{c.title}</text>
          {c.lines.map((l, k) => (
            <text key={k} x={c.x + 14} y={TOP + 63 + k * 15} className="sf-d">{l}</text>
          ))}
        </g>
      ))}

      <text x={0} y={22} className="sf-start">
        {live ? 'it runs on its own' : 'it is not running'}
      </text>

      {/* The loop. A rejection is not a dead end — the reason is typed, and it
          is what the acceptance rate above is made of. */}
      <path d={`M909 ${TOP + BH} L909 238 L420 238 L420 ${TOP + BH + 6}`}
        className="sf-arrow sf-dash" markerEnd="url(#af-head)" />
      <text x={664} y={232} className="sf-lab-back" textAnchor="middle">
        a rejection carries a typed reason — that is what the rate above is made of
      </text>
    </svg>
  )
}
