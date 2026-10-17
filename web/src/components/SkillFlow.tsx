/** What the skill does, for a person.
 *
 *  Everything else on this page is written for a model. A human needs the
 *  decision procedure the skill encodes — which is a real branch, not a
 *  sequence: cite what exists, or define something new and route it through a
 *  person. The fast path and the slow path differ by whether a human is in it,
 *  and that is the whole design in one picture.
 */

const A = 'var(--accent)'
const INK = 'var(--ink)'

/** A box with wrapped lines, since SVG text does not wrap. */
function Box({ x, y, w, h, title, lines, tone = 'plain' }: {
  x: number; y: number; w: number; h: number
  title: string; lines?: string[]; tone?: 'plain' | 'good' | 'wait' | 'start' | 'end'
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={9} className={`sf-b sf-${tone}`} />
      <text x={x + 14} y={y + 24} className="sf-t">{title}</text>
      {(lines ?? []).map((l, i) => (
        <text key={i} x={x + 14} y={y + 44 + i * 15} className="sf-d">{l}</text>
      ))}
    </g>
  )
}

/** A question. Drawn as a box with a rule under the title rather than a
 *  diamond — a diamond big enough for this much text is mostly empty corners. */
function Ask({ x, y, w, title, note }: { x: number; y: number; w: number; title: string; note: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={58} rx={9} className="sf-b sf-ask" />
      <text x={x + 14} y={y + 24} className="sf-q">{title}</text>
      <text x={x + 14} y={y + 43} className="sf-d">{note}</text>
    </g>
  )
}

function Arrow({ d, label, lx, ly, tone }: {
  d: string; label?: string; lx?: number; ly?: number; tone?: 'yes' | 'no'
}) {
  return (
    <g>
      <path d={d} className="sf-arrow" markerEnd="url(#sf-head)" />
      {label && (
        <text x={lx} y={ly} className={`sf-lab sf-lab-${tone ?? 'yes'}`}>{label}</text>
      )}
    </g>
  )
}

export function SkillFlow({ datasets }: { datasets: number }) {
  const W = 1040
  const H = 566

  return (
    <svg className="skillflow" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={
        'What the skill does. Someone asks for a number. First question: is there already a '
        + 'ratified definition for it? If yes, run it and answer, citing the definition — no '
        + 'human needed. If no, second question: is there a dataset holding the rows? If yes, '
        + 'add a new measure over it; if no, write SQL and save it as a dataset first. Either '
        + 'way the new definition lands proposed and will not run until a person ratifies it. '
        + 'Both paths end at the same place: the number, and the definition id it came from.'}>
      <defs>
        <marker id="sf-head" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="var(--border2)" />
        </marker>
      </defs>

      <text x={300} y={20} className="sf-start">
        “what’s our merge rate this month?”
      </text>
      <Arrow d="M520 28 L520 44" />

      <Ask x={290} y={44} w={460}
        title="Is there a ratified definition for it?"
        note={datasets === 1 ? 'the dataset file lists every one' : `the ${datasets} dataset files list every one`} />

      {/* the fast path: nothing new, nobody needed */}
      <Arrow d="M290 73 L210 73 L210 160" label="yes" lx={232} ly={66} tone="yes" />
      <Box x={70} y={160} w={280} h={84} tone="good"
        title="Run it"
        lines={['scripts/ask.py, or panels.preview.', 'Same number as every other panel', 'that cites it.']} />

      {/* the slow path */}
      <Arrow d="M750 73 L830 73 L830 158" label="no" lx={786} ly={66} tone="no" />
      <Ask x={620} y={158} w={380}
        title="Is there a dataset with the rows?"
        note="a table, or a saved query" />

      <Arrow d="M620 187 L560 187 L560 272" label="yes" lx={578} ly={180} tone="yes" />
      <Box x={430} y={272} w={250} h={84}
        title="Add a measure"
        lines={['over a dataset that', 'already exists.']} />

      <Arrow d="M880 216 L880 272" label="no" lx={890} ly={247} tone="no" />
      <Box x={720} y={272} w={280} h={84}
        title="Write SQL"
        lines={['Save it as a dataset first,', 'then measure over it.']} />

      {/* both new-definition paths converge on the same gate */}
      <Arrow d="M555 356 L555 396" />
      <Arrow d="M860 356 L860 380 L600 380 L600 396" />
      <Box x={430} y={396} w={570} h={74} tone="wait"
        title="It lands proposed — and will not run"
        lines={['Only ratified definitions resolve. A person has to stand behind',
                'what the number means before anything can quote it.']} />

      {/* one ending, reached two ways */}
      <Arrow d="M210 244 L210 496" />
      <Arrow d="M715 470 L715 496" />
      <Box x={60} y={496} w={920} h={54} tone="end"
        title="The number, and the definition id it came from"
        lines={[]} />
      <text x={974} y={520} className="sf-d" textAnchor="end">
        a number without its definition cannot be checked
      </text>
    </svg>
  )
}
