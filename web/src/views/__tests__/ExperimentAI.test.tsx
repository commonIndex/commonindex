/**
 * AI on an experiment, as the other collections have it: asked for, not
 * automatic; its summary says it was checked; a write-up opens as a doc.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExperimentAICard, useExperimentAI } from '../../components/ExperimentAI'

const EXPLAINED = {
  headline: "Don't ship yet: payment failures rose 43.5%.",
  summary: 'Conversion rose 12.1% but the interval spans zero.',
  recommendation: 'iterate', reasons: ['Payment failed is worse.'], next_steps: ['Fix payments, then rerun.'],
  allowed: ['iterate', 'kill', 'keep_running'], model: 'qwen', checked: 'checked', read_at: '2026-10-13T00:00:00Z',
}

function Panel({ readAt = null }: { readAt?: number | null }) {
  const ai = useExperimentAI('exp-1', readAt)
  return <ExperimentAICard ai={ai} />
}

function mount(answer: (op: string, body: Record<string, unknown>) => { status?: number; body: unknown },
               readAt: number | null = null) {
  const sent: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    sent.push({ op, body })
    const a = answer(op, body)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
  }))
  render(<MemoryRouter initialEntries={['/experiments/exp-1']}><Routes>
    <Route path="/experiments/:id" element={<Panel readAt={readAt} />} />
    <Route path="/docs/edit/:id" element={<div>Doc editor open</div>} />
  </Routes></MemoryRouter>)
  return sent
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the summary loads with the readout', () => {
  it('asks once the readout has arrived, and Explain again asks for a fresh one', async () => {
    const u = userEvent.setup()
    const sent = mount(op => ({ body: op === 'experiments.explain' ? EXPLAINED : {} }), Date.now())
    const card = await screen.findByRole('region', { name: 'AI summary' })
    expect(card.textContent).toContain('Recommends: Iterate')
    expect(sent[0]).toMatchObject({ op: 'experiments.explain', body: { experiment_id: 'exp-1' } })
    expect(sent[0].body.fresh).toBeUndefined()                      // the gateway's kept one is fine
    await u.click(screen.getByRole('button', { name: /Explain again/ }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].body).toMatchObject({ fresh: true })
  })

  it('shows that it is reading while the model works', async () => {
    let release: () => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(res => {
      release = () => res(new Response(JSON.stringify(EXPLAINED), { status: 200 }))
    })))
    render(<MemoryRouter initialEntries={['/experiments/exp-1']}><Routes>
      <Route path="/experiments/:id" element={<Panel readAt={1} />} /></Routes></MemoryRouter>)
    expect((await screen.findByRole('status')).textContent).toMatch(/AI is reading the results/)
    release()
    expect(await screen.findByRole('region', { name: 'AI summary' })).toBeTruthy()
  })
})

describe('explain with AI', () => {
  it('asks only when asked, then shows the summary and what it recommends', async () => {
    const u = userEvent.setup()
    const sent = mount(op => ({ body: op === 'experiments.explain' ? EXPLAINED : {} }))
    expect(sent).toHaveLength(0)                                   // nothing on load
    await u.click(screen.getByRole('button', { name: /Explain with AI/ }))
    const card = await screen.findByRole('region', { name: 'AI summary' })
    expect(card.textContent).toContain('Recommends: Iterate')
    expect(card.textContent).toContain('payment failures rose 43.5%')
    expect(card.textContent).toContain('checked against this readout')
    expect(sent[0]).toMatchObject({ op: 'experiments.explain', body: { experiment_id: 'exp-1' } })
  })

  it('says why when the summary could not be held to the readout', async () => {
    const u = userEvent.setup()
    mount(() => ({ status: 502, body: { error: { code: 'model_output_unchecked',
      message: 'The AI summary did not hold to the readout, so it is not shown. Try again.' } } }))
    await u.click(screen.getByRole('button', { name: /Explain with AI/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not hold to the readout/)
  })
})

describe('write up as doc', () => {
  it('carries the summary on screen into the doc and opens it', async () => {
    const u = userEvent.setup()
    const sent = mount(op => ({ body: op === 'experiments.explain' ? EXPLAINED
      : op === 'experiments.write_up' ? { doc_id: 'doc-9', projects: [] } : {} }))
    await u.click(screen.getByRole('button', { name: /Explain with AI/ }))
    await screen.findByRole('region', { name: 'AI summary' })
    await u.click(screen.getByRole('button', { name: 'Write up as doc' }))
    expect(await screen.findByText('Doc editor open')).toBeTruthy()
    const w = sent.find(s => s.op === 'experiments.write_up')!
    expect(w.body).toMatchObject({ experiment_id: 'exp-1', summary: { recommendation: 'iterate' } })
    expect(String(w.body.idempotencyKey)).toMatch(/^writeup:exp-1:/)
  })
})
