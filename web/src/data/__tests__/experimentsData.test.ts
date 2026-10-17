/**
 * Real experiments only; "mine" is whoever is
 * signed in. 240 generated rows used to sit in the list and feed every
 * portfolio number, and "mine" meant one hard-coded person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetLiveExperiments, getProgramStats, listExperiments } from '../api'
import { forgetWhoAmI } from '../gateway'

const LIVE = [
  { id: 'exp-a', key: 'EXP-1', name: 'A', hypothesis: '', owner: 'maya', owner_id: 'maya', space: 'pay',
    metric: 'm', status: 'running', days: 14, day: 3, lift: null, lift_at: null, guardrail: 'clean',
    pre_registered: true, amendments: 0, attention: [] },
  { id: 'exp-b', key: 'EXP-2', name: 'B', hypothesis: '', owner: 'rhea', owner_id: 'rhea', space: 'pay',
    metric: 'm', status: 'running', days: 14, day: 15, lift: null, lift_at: null, guardrail: 'clean',
    pre_registered: true, amendments: 0, attention: ['reached its planned 14 days — decide'] },
]

let program: unknown
beforeEach(() => {
  forgetLiveExperiments(); forgetWhoAmI()
  program = { total: 2, decided: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const out = op === 'experiments.list' ? { experiments: LIVE, total: 2 }
      : op === 'actors.me' ? { id: 'rhea', display: 'Rhea', kind: 'human', space: 'pay', may: ['read'] }
      : op === 'experiments.program' ? program
      : op === 'workspace.counts' ? { experiments: { total: 2, running: 2, readout: 1 } } : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the experiments collection', () => {
  it('lists only real experiments: nothing generated in the browser', async () => {
    const real = await listExperiments({})
    expect(real.total).toBe(2)
    expect(real.items.every(e => e.live)).toBe(true)
  })

  it('means the signed-in person by "mine"', async () => {
    const mine = await listExperiments({ filter: 'mine' })
    expect(mine.items.map(e => e.id)).toEqual(['exp-b'])
  })

  it('puts what the gateway flagged under "needs attention"', async () => {
    const got = await listExperiments({ filter: 'attention' })
    expect(got.items.map(e => e.id)).toEqual(['exp-b'])
  })

  it('takes portfolio numbers from the gateway, not from generated rows', async () => {
    expect(await getProgramStats()).toEqual(program)
  })
})

describe('experiments elsewhere in the platform', () => {
  it('takes the sidebar counts from the gateway, and reads a missing section as zero', async () => {
    // Counting moved to workspace.counts (tests/test_workspace_counts.py); this
    // stub answers it with experiments only.
    const { getCounts } = await import('../api')
    const c = await getCounts()
    expect(c.experiments).toEqual({ total: 2, running: 2, readout: 1 })
    expect(c.docs).toEqual({ total: 0, stale: 0 })
  })

  it('finds a real experiment by its name in search — the gateway searches, the palette links', async () => {
    const { search } = await import('../api')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const out = op === 'search.query'
        ? { q: 'B', hits: [{ kind: 'object', type: 'experiment', id: 'exp-b', key: 'EXP-2', title: 'B', snippet: null, at: null }] }
        : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    const hits = await search('B')
    expect(hits.some(h => h.href === '/experiments/exp-b')).toBe(true)
  })
})
