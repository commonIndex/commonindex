/**
 * How a column becomes a number.
 *
 * "Refund rate" is the example this product uses to explain itself — in the
 * schema comments, in the UI copy, and in the argument for having a metric
 * registry at all. The server has been able to express it since `ratio` and
 * `share` were added, under a comment saying "a dashboard tool whose headline
 * example it cannot build is not finished".
 *
 * Neither authoring surface offered either one. The wizard listed six of the
 * eight and the add-panel form listed five, having also quietly lost
 * `count_distinct`. Three hand-kept lists, exactly like the chart marks one
 * field over — and `test_agg_lists_agree.py` is the same answer.
 */

export interface AggOption {
  id: string
  /** Reads inside a sentence: "…the average of cost_usd". */
  label: string
  /** A column to aggregate. */
  column: boolean
  /** A second column to divide by. */
  denominator?: boolean
  /** A value to match against. */
  value?: boolean
  hint?: string
}

export const AGGS: AggOption[] = [
  { id: 'count', label: 'how many rows there are', column: false },
  { id: 'sum', label: 'the total of', column: true },
  { id: 'avg', label: 'the average of', column: true },
  { id: 'max', label: 'the highest', column: true },
  { id: 'min', label: 'the lowest', column: true },
  { id: 'count_distinct', label: 'how many distinct values of', column: true },
  {
    id: 'ratio', label: 'the ratio of', column: true, denominator: true,
    hint: 'one column divided by another — refunds over orders, and the '
      + 'division happens in the warehouse rather than in two panels a reader '
      + 'has to divide by eye',
  },
  {
    id: 'share', label: 'the share of rows where', column: true, value: true,
    hint: 'what fraction of rows match a value — the other way to say a rate '
      + 'when the numerator is a category rather than a column',
  },
]

export const aggById = (id: string) => AGGS.find(a => a.id === id)
