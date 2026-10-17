import { describe, expect, it } from 'vitest'
import { improvement, programStats } from '../../data/seed'
import type { Experiment } from '../../data/types'

const live = {
  id: 'exp-a', key: 'EXP-1', name: 'Trust badge', hypothesis: '', owner: 'alex',
  space: 'pay', metric: 'checkout_conv_clean', status: 'shipped', day: 14, days: 14,
  lift: 4.2, guardrail: 'clean', updated: 0, live: true, preRegistered: true,
} as unknown as Experiment

describe('a live experiment reaching the seed aggregates', () => {
  it('does not crash on a metric the seed table has never heard of', () => {
    expect(() => improvement(live)).not.toThrow()
  })
  it('does not crash the whole program page', () => {
    expect(() => programStats([live])).not.toThrow()
  })
})

describe('a live experiment in the program aggregates', () => {
  it('appears in the by-metric breakdown even on a metric the seed never knew', () => {
    const st = programStats([live])
    const row = st.byMetric.find(r => r.metric === 'checkout_conv_clean')
    expect(row).toBeTruthy()
    expect(row!.shipped).toBe(1)
  })

  it('is left out of the effect distribution rather than oriented by a guess', () => {
    // Nothing here knows which way is good for a registry metric, and assuming
    // "up" would file a refund-rate win as a loss.
    const st = programStats([live])
    expect(st.dist.reduce((n, b) => n + b.shipped + b.killed, 0)).toBe(0)
    expect(st.shipped).toBe(1)   // still counted where direction does not matter
  })

  it('counts a seeded experiment in both', () => {
    const seeded = { ...live, metric: 'checkout_conversion' } as typeof live
    const st = programStats([seeded])
    expect(st.byMetric.find(r => r.metric === 'checkout_conversion')!.shipped).toBe(1)
    expect(st.dist.reduce((n, b) => n + b.shipped + b.killed, 0)).toBe(1)
  })
})

describe('a recorded readout carries its own direction', () => {
  it('orients a registry metric the seed table has never heard of', () => {
    const withDir = { ...live, better: 'up' as const }
    expect(improvement(withDir)).toBe(4.2)
    expect(programStats([withDir]).dist.reduce((n, b) => n + b.shipped + b.killed, 0)).toBe(1)
  })

  it('files a win on a lower-is-better metric as a win', () => {
    // A refund rate falling 4.2% is an improvement. Assuming "up" would have
    // filed it in the losses.
    const refund = { ...live, metric: 'checkout_refund_rate', better: 'down' as const, lift: -4.2 }
    expect(improvement(refund)).toBe(4.2)
  })

  it('still declines when nothing knows the direction', () => {
    expect(improvement(live)).toBeNull()
  })
})
