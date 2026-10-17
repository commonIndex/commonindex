/**
 * The shapes a panel can be.
 *
 * There were four lists of these — the CHECK constraint, the schema an agent
 * reads, the client's wire mapping, and the menu an author picks from — and
 * they had drifted. `stacked`, `heatmap` and `table` render correctly, are
 * accepted by the database and are mapped by the wire, and neither authoring
 * surface offered them: three working chart types that nobody could choose.
 *
 * This is the client's one copy. `commonindex/core/warehouse/dashboard.py` holds
 * the server's, and a test asserts the two agree — the drift above is exactly
 * what happens without one.
 *
 * Chart type is a shape, so it is picked as a shape. Every BI tool people call
 * friendly does this and none of them use a dropdown: a word in a list makes
 * you translate "Area" into a picture before you can choose. The `hint` is for
 * the places too dense for an icon row, and says what the shape is FOR —
 * "stacked" and "heatmap" name a drawing technique, which tells someone
 * choosing between them nothing.
 *
 * `sql` is deliberately absent. A panel carrying its own query is chosen by
 * writing one, not by picking a shape; offering it here would ask somebody to
 * select "sql" and then wonder where to type it.
 */
import type { ReactNode } from 'react'

import type { PanelKind, StoredMark } from '../data/types'

export interface MarkOption {
  /** The spelling the SERVER stores. `heatmap`, not the client's `heat`. */
  id: StoredMark
  label: string
  hint: string
  icon: ReactNode
}

export const MARKS: MarkOption[] = [
  {
    id: 'line', label: 'Line', hint: 'a value over time',
    icon: <polyline points="2,12 6,7 10,9 14,3" />,
  },
  {
    id: 'area', label: 'Area', hint: 'a value over time, filled to zero',
    icon: <><polyline points="2,12 6,7 10,9 14,3" />
      <path d="M2 12 6 7 10 9 14 3 14 14 2 14Z" className="fill" /></>,
  },
  {
    id: 'stacked', label: 'Stacked', hint: 'how the parts add up to the whole',
    icon: <><path d="M2 14 2 10 6 8 10 9 14 6 14 14Z" className="fill" />
      <path d="M2 10 6 8 10 9 14 6" /></>,
  },
  {
    id: 'bar', label: 'Bars', hint: 'one value compared across categories',
    icon: <><rect x="2" y="8" width="3" height="6" className="fill" />
      <rect x="6.5" y="4" width="3" height="10" className="fill" />
      <rect x="11" y="10" width="3" height="4" className="fill" /></>,
  },
  {
    id: 'stat', label: 'Number', hint: 'one number, with its recent shape',
    icon: <text x="8" y="12" textAnchor="middle" fontSize="11" fontWeight="700"
      className="glyph">42</text>,
  },
  {
    id: 'heatmap', label: 'Heatmap', hint: 'where the value is dense across two axes',
    icon: <><rect x="2" y="2" width="4" height="4" className="fill" opacity={0.3} />
      <rect x="6.5" y="2" width="4" height="4" className="fill" opacity={0.9} />
      <rect x="11" y="2" width="3" height="4" className="fill" opacity={0.5} />
      <rect x="2" y="6.5" width="4" height="4" className="fill" opacity={0.9} />
      <rect x="6.5" y="6.5" width="4" height="4" className="fill" opacity={0.45} />
      <rect x="11" y="6.5" width="3" height="4" className="fill" opacity={0.2} />
      <rect x="2" y="11" width="4" height="3" className="fill" opacity={0.5} />
      <rect x="6.5" y="11" width="4" height="3" className="fill" opacity={0.25} />
      <rect x="11" y="11" width="3" height="3" className="fill" opacity={0.8} /></>,
  },
  {
    id: 'pie', label: 'Pie', hint: 'the share each part takes of the whole',
    icon: <><circle cx="8" cy="8" r="6" className="fill" opacity={0.28} />
      <path d="M8 8 L8 2 A6 6 0 0 1 13.2 11 Z" className="fill" />
      <circle cx="8" cy="8" r="2.4" fill="var(--panel)" /></>,
  },
  {
    id: 'gauge', label: 'Gauge',
    hint: 'one number against the range it has been in',
    icon: <><path d="M2.5 12 A6 6 0 0 1 13.5 12" fill="none" />
      <path d="M2.5 12 A6 6 0 0 1 6 6.4" fill="none" strokeWidth={2.2} />
      <circle cx="8" cy="12" r="1.2" className="fill" /></>,
  },
  {
    id: 'pivot', label: 'Pivot', hint: 'the table, with a total per row and column',
    icon: <><rect x="2" y="3" width="12" height="3" className="fill" opacity={0.55} />
      <rect x="2" y="11" width="12" height="3" className="fill" opacity={0.3} />
      <path d="M2 8.5 14 8.5M6.5 3 6.5 14" /></>,
  },
  {
    id: 'table', label: 'Table', hint: 'the rows themselves',
    icon: <><rect x="2" y="3" width="12" height="3" className="fill" opacity={0.55} />
      <path d="M2 8.5 14 8.5M2 12 14 12M6.5 3 6.5 14" /></>,
  },
]

/** The client's name for a stored mark. `heatmap` is what the database holds;
 *  `heat` is what the renderer branches on, and both spellings are in the
 *  CHECK because panels already existed under each. */
export const markKind = (id: StoredMark): PanelKind =>
  (id === 'heatmap' ? 'heat' : id) as PanelKind
