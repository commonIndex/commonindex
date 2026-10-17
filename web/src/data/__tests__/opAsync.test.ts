/**
 * A model's answer is asked for as a job and read until it is done, so no load
 * balancer's 60-second limit can cut it off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { explainExperiment, GatewayError } from '../gateway'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function gateway(script: ((op: string, init: RequestInit) => { status: number; body: unknown })) {
  const calls: { op: string; prefer?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    calls.push({ op, prefer: (init.headers as Record<string, string>)?.prefer })
    const a = script(op, init)
    return new Response(JSON.stringify(a.body), { status: a.status })
  }))
  return calls
}

describe('an answer that takes a while', () => {
  it('is asked for as a job and read until done', async () => {
    let reads = 0
    const calls = gateway(op => op === 'experiments.explain'
      ? { status: 202, body: { job_id: 'job-1', state: 'queued' } }
      : ++reads < 2 ? { status: 200, body: { state: 'running' } }
      : { status: 200, body: { state: 'done', result: { status: 200, body: { headline: 'Iterate.' } } } })
    const got = await explainExperiment('exp-1')
    expect(got.headline).toBe('Iterate.')
    expect(calls[0]).toEqual({ op: 'experiments.explain', prefer: 'respond-async' })
    expect(calls.filter(c => c.op === 'jobs.get').length).toBe(2)
  }, 10_000)

  it('raises the operation’s own typed error when that is its answer', async () => {
    gateway(op => op === 'experiments.explain'
      ? { status: 202, body: { job_id: 'job-1', state: 'queued' } }
      : { status: 200, body: { state: 'done', result: { status: 502, body: { error: { code: 'model_output_unchecked', message: 'not held to the readout' } } } } })
    await expect(explainExperiment('exp-1')).rejects.toMatchObject({ code: 'model_output_unchecked' })
  }, 10_000)

  it('takes a direct answer from a gateway that does not queue', async () => {
    gateway(() => ({ status: 200, body: { headline: 'Ship.' } }))
    expect((await explainExperiment('exp-1')).headline).toBe('Ship.')
  })

  it('says when the job itself failed', async () => {
    gateway(op => op === 'experiments.explain'
      ? { status: 202, body: { job_id: 'job-1', state: 'queued' } }
      : { status: 200, body: { state: 'failed', error: 'the model went away' } })
    const e = await explainExperiment('exp-1').catch(x => x)
    expect(e).toBeInstanceOf(GatewayError)
    expect(e.message).toContain('the model went away')
  }, 10_000)
})
