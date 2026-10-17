import type { PanelAgg } from './types'

// How a window of days becomes one number, and how a whole splits into parts.
// Pure arithmetic with no React and no seed data, so the generator and the
// renderer can both use it without either importing the other.

export function collapse(values: number[], agg: PanelAgg): number {
  if (values.length === 0) return 0
  values = values.filter(Number.isFinite)
  if (values.length === 0) return Number.NaN
  if (agg === 'last') return values[values.length - 1]
  const sum = values.reduce((a, b) => a + b, 0)
  return agg === 'sum' ? sum : sum / values.length
}

/** Parts of a whole always sum to the whole — geometric decay, never a
 *  subtraction that can run negative once a breakdown has more than four rows. */
export function shares(n: number): number[] {
  if (n === 1) return [1]
  const raw = Array.from({ length: n }, (_, k) => 0.68 ** k)
  const sum = raw.reduce((a, b) => a + b, 0)
  return raw.map(v => v / sum)
}
