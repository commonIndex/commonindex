/**
 * ⌘K, finding what the workspace holds.
 *
 * The palette searched the samples generated in the browser and nothing else:
 * "Two warehouses", a real dashboard, found nothing, and "Refund spec" found
 * two samples with similar names. What is defended: it finds the workspace's
 * own things by the words typed, says where a body or a comment matched, opens
 * a comment where it was said, and says so when the gateway cannot answer rather
 * than claiming nothing matched.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Palette } from '../Palette'
import type { WireSearchHit } from '../../data/gateway'

const HITS: WireSearchHit[] = [
  { kind: 'object', type: 'dashboard', id: 'dash-31', key: 'DASH-31', title: 'Two warehouses', snippet: null, at: null },
  { kind: 'object', type: 'doc', id: 'doc-2', key: 'D-2', title: 'Retry policy',
    snippet: 'Refunds retry three times before «paging» the on-call.', at: null },
  { kind: 'message', type: 'message', id: 'm1', key: null, title: 'Two warehouses', at: null,
    snippet: 'Spend jumped on the 12th — is that the new warehouse?',
    author: { id: 'alex', name: 'Alex', kind: 'human' },
    subject: { id: 'dash-31', type: 'dashboard', key: 'DASH-31', title: 'Two warehouses' } },
  { kind: 'message', type: 'message', id: 'm2', key: null, title: 'refund-incidents', at: null,
    snippet: 'EU refund retries are spiking', author: { id: 'maya', name: 'Maya', kind: 'human' },
    subject: { id: 'ch-1', type: 'channel', key: 'CH-1', title: 'refund-incidents' } },
  { kind: 'agent', type: 'agent', id: 'scribe', key: null, title: 'scribe', snippet: null, at: null },
]

function gateway(answer: () => { status: number; body: unknown },
                 asking?: () => { status: number; body: unknown }) {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    if (op === 'search.query' || (op === 'workspace.ask' && asking)) {
      asked.push(`${op === 'workspace.ask' ? 'ask: ' : ''}${JSON.parse(String(init?.body)).q}`)
      const { status, body } = op === 'workspace.ask' ? asking!() : answer()
      return { ok: status < 400, status, json: async () => body } as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }))
  return asked
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = () => {
  const go = vi.fn()
  render(<Palette onClose={() => {}} onGo={go} />)
  return go
}
const options = () => screen.queryAllByRole('option').map(o => o.textContent)

describe('the palette', () => {
  it("finds the workspace's own things by the words typed", async () => {
    const u = userEvent.setup()
    const asked = gateway(() => ({ status: 200, body: { q: 'two', hits: HITS } }))
    open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'two')
    // Every hit, and last — "two" is not worded as a question — the offer to ask.
    await waitFor(() => expect(options().length).toBe(HITS.length + 1))
    expect(options().at(-1)).toMatch(/^askAsk the workspace: “two”/)
    expect(asked.at(-1)).toBe('two')
    expect(options()[0]).toMatch(/dashboardTwo warehousesDASH-31/)
    // A body match shows the sentence it matched in, with the matched word marked.
    const snip = document.querySelector('.p-snip mark')!
    expect(snip.textContent).toBe('paging')
    expect(snip.parentElement!.textContent).toBe('Refunds retry three times before paging the on-call.')
    // A channel reads as one; an agent as an agent.
    expect(options()).toContain('channel#refund-incidentsEU refund retries are spikingMaya')
    expect(options().at(-2)).toMatch(/^agentscribe/)
  })

  it('finds code, definitions, runs and earlier versions, and opens each where it lives', async () => {
    const u = userEvent.setup()
    const more: WireSearchHit[] = [
      { kind: 'code', type: 'code_file', id: 'code_file-1', key: null, title: 'refunds/retry.py', at: null,
        repo: 'example/payments', lines: [10, 12], snippet: 'MAX_REFUND_RETRIES = 3' },
      { kind: 'metric', type: 'metric', id: 'refund_rate', key: null, title: 'Refund rate', at: null,
        status: 'ratified', snippet: 'Share of orders refunded',
        used_on: [{ id: 'dash-31', type: 'dashboard', key: 'DASH-31', title: 'Two warehouses' }] },
      { kind: 'dataset', type: 'dataset', id: 'public.orders', key: null, title: 'public.orders', at: null,
        snippet: 'One row per order' },
      { kind: 'run', type: 'run', id: 'run-1', key: null, title: 'Scribe', at: '2026-09-27T10:00:00Z',
        status: 'done', snippet: 'Why did the refund rate jump?',
        agent: { id: 'scribe', name: 'Scribe', kind: 'agent' } },
      { kind: 'history', type: 'doc', id: 'doc-2', key: 'D-2', title: 'Retry policy', at: '2026-09-20T00:00:00Z',
        snippet: 'Refunds retry five times' },
    ]
    gateway(() => ({ status: 200, body: { q: 'refund', hits: more } }))
    const go = open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'refund')
    await waitFor(() => expect(options().length).toBe(more.length + 1))
    const rows = screen.getAllByRole('option')
    expect(options()[0]).toMatch(/^coderefunds\/retry\.py/)
    expect(options()[1]).toMatch(/^metricRefund rate.*on Two warehouses$/)
    expect(options()[3]).toMatch(/^runScribe run/)
    expect(rows[4].className).toMatch(/earlier/)
    expect(options()[4]).toMatch(/earlier version · until/)
    const opened = []
    for (const i of [0, 1, 2, 3, 4]) {
      await u.click(rows[i])
      opened.push(go.mock.lastCall![0])
    }
    expect(opened).toEqual([
      '/code?file=code_file-1&path=refunds%2Fretry.py&repo=example%2Fpayments&lines=10-12',
      '/dashboards/dash-31',                     // a metric where it is charted
      '/skills/skill-warehouse-context',         // a dataset where definitions are documented
      '/agents/scribe',                          // a run on its agent's page
      '/docs/edit/doc-2',                        // an earlier version on the page it was on
    ])
  })

  it('opens a comment where it was said, and a channel message in its channel', async () => {
    const u = userEvent.setup()
    gateway(() => ({ status: 200, body: { q: 'spend', hits: HITS } }))
    const go = open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'spend')
    await u.click(await screen.findByText('Spend jumped on the 12th — is that the new warehouse?'))
    expect(go).toHaveBeenLastCalledWith('/dashboards/dash-31#comments')
    await u.click(screen.getByText('EU refund retries are spiking'))
    expect(go).toHaveBeenLastCalledWith('/channels/ch-1')
    await u.click(screen.getByText('Retry policy'))
    expect(go).toHaveBeenLastCalledWith('/docs/edit/doc-2')
  })

  it('says the gateway could not answer, rather than that nothing matched', async () => {
    const u = userEvent.setup()
    gateway(() => ({ status: 503, body: { error: { code: 'down', message: 'the gateway is restarting' } } }))
    open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'refund')
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the gateway: the gateway is restarting/)
  })

  it('goes to a screen by its name, without asking the gateway', async () => {
    const u = userEvent.setup()
    const asked = gateway(() => ({ status: 200, body: { q: '', hits: [] } }))
    open()
    await waitFor(() => expect(options()).toContain('screenAgentswho they are and what they may do'))
    expect(asked).toEqual([])
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'desig')
    await waitFor(() => expect(options()[0]).toBe('screenDesignsscreens and design systems'))
  })
})


describe('asking the workspace', () => {
  const ANSWER = {
    q: 'how many times do refunds retry?', answer: 'Three times, then **on-call** is paged.',
    citations: [{ id: 'doc-2', type: 'doc', key: 'D-2', title: 'Retry policy' }],
    steps: [{ kind: 'search', detail: 'refund retry', found: 2 }, { kind: 'read', detail: 'doc-2', found: 1, label: 'D-2 Retry policy' }],
    model: 'm',
  }

  it('offers a question first, and answers it with what it relied on', async () => {
    const u = userEvent.setup()
    const asked = gateway(() => ({ status: 200, body: { q: '', hits: HITS } }), () => ({ status: 200, body: ANSWER }))
    const go = open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'how many times do refunds retry?')
    await waitFor(() => expect(options()[0]).toMatch(/^askAsk the workspace/))
    await u.keyboard('{Enter}')
    expect(await screen.findByText('Three times, then', { exact: false })).toBeTruthy()
    expect(asked).toContain('ask: how many times do refunds retry?')
    expect(screen.getByText('searched “refund retry” (2) · read D-2 Retry policy')).toBeTruthy()
    await u.click(within(screen.getByLabelText('Sources')).getByRole('button', { name: 'D-2 Retry policy' }))
    expect(go).toHaveBeenLastCalledWith('/docs/edit/doc-2')
  })

  it('asks from anywhere with ⌘⏎, and a new search goes back to the results', async () => {
    const u = userEvent.setup()
    gateway(() => ({ status: 200, body: { q: '', hits: HITS } }), () => ({ status: 200, body: ANSWER }))
    open()
    const box = screen.getByRole('textbox', { name: 'Search the workspace' })
    await u.type(box, 'refund retries')
    await waitFor(() => expect(options()[0]).not.toMatch(/^ask/))   // not a question: matches first
    await u.keyboard('{Meta>}{Enter}{/Meta}')
    expect(await screen.findByLabelText('Sources')).toBeTruthy()
    await u.type(box, 's')
    expect(screen.queryByLabelText('Sources')).toBeNull()
  })

  it('says what asking needs when the gateway has no model', async () => {
    const u = userEvent.setup()
    gateway(() => ({ status: 200, body: { q: '', hits: [] } }),
      () => ({ status: 422, body: { error: { code: 'no_model', message: 'asking needs a model to read with' } } }))
    open()
    await u.type(screen.getByRole('textbox', { name: 'Search the workspace' }), 'why did refunds spike?')
    await u.keyboard('{Enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/asking needs a model/)
  })
})
