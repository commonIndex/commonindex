/**
 * The agents page, reading the record.
 *
 * Everything on it was generated in the browser: acceptance, merged-of-filed,
 * run cost, what each agent was "watching", and an AI usage register naming
 * four accountable owners. None of it came from the platform. A governance page
 * that invents its own numbers is worse than no page — it answers the auditor's
 * question confidently and wrongly.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentDetail, AgentsView } from '../Agents'
import { AgentCreated } from '../agents/AgentSetup'
import { CopyButton } from '../agents/shared'
import { GatewayError } from '../../data/gateway'

const agent = (over: object = {}) => ({
  id: 'triage', display: 'triage', trust_tier: 'propose-only',
  owner: null, created_at: '2026-08-01T00:00:00Z',
  grants: [{ relation: 'propose', resource: 'space:pay', expires_at: null, last_used: null }],
  may: ['propose'],
  tokens: { count: 0, last_used: null, next_expiry: null },
  authored: { experiment: 1 }, defined: { metrics: 0, ratified: 0 },
  may_ratify_own_work: false, ...over,
})

function mount(agents: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    return { ok: true, status: 200,
             json: async () => (op === 'agents.list' ? { agents } : {}) } as Response
  }))
  render(<MemoryRouter><AgentsView /></MemoryRouter>)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('the agents page', () => {
  it('searches accountable owners and filters agents that need attention', async () => {
    mount([agent(), agent({ id: 'auto', display: 'Autonomous helper', may_ratify_own_work: true,
      owner: { id: 'maya', display: 'Maya', kind: 'human' }, tokens: { count: 1, last_used: null, next_expiry: null } })])
    await screen.findByRole('link', { name: 'Open agent triage' })
    await userEvent.click(screen.getByRole('button', { name: 'Needs attention' }))
    expect(screen.getByRole('link', { name: 'Open agent triage' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open agent Autonomous helper' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Autonomous' }))
    expect(screen.getByRole('link', { name: 'Open agent Autonomous helper' })).toBeTruthy()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'Maya')
    expect(screen.getByRole('link', { name: 'Open agent Autonomous helper' })).toBeTruthy()
    await userEvent.clear(screen.getByRole('searchbox'))
    await userEvent.type(screen.getByRole('searchbox'), 'nobody matches')
    expect(screen.getByText('No agents match')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Show all agents' }))
    expect(screen.getByRole('link', { name: 'Open agent triage' })).toBeTruthy()
  })

  it('keeps the audit register available without duplicating it by default', async () => {
    mount([agent()])
    const summary = await screen.findByText('AI usage register')
    expect(summary.closest('details')?.open).toBe(false)
    await userEvent.click(summary)
    expect(summary.closest('details')?.open).toBe(true)
  })

  it('says plainly when nobody answers for an agent', async () => {
    // `owner_id` has existed since the first migration and was read nowhere,
    // while the UI type declared it "the human answerable for this agent's
    // conduct. Every agent has one."
    mount([agent()])
    expect(await screen.findByText(/nobody answers for this/)).toBeTruthy()
  })

  it('counts the unowned ones at the top, because that is the finding', async () => {
    mount([agent(), agent({ id: 'scribe', display: 'scribe' })])
    expect(await screen.findByText(/2 of 2 agents have no owner/)).toBeTruthy()
  })

  it('names the owner when there is one', async () => {
    mount([agent({ owner: { id: 'maya', display: 'Maya', kind: 'human' } })])
    expect(await screen.findByText(/answerable to Maya/)).toBeTruthy()
    expect(screen.queryByText(/have no owner/)).toBeNull()
  })

  it('says what the agent may do rather than what it is "watching"', async () => {
    mount([agent()])
    expect(await screen.findByText(/May propose in this space/)).toBeTruthy()
  })

  it('says so when an agent holds no grant here', async () => {
    // It can authenticate and do nothing, which is a real and invisible state.
    mount([agent({ grants: [], may: [] })])
    expect(await screen.findByText(/No grant in this space/)).toBeTruthy()
  })

  it('reports a token that has never been used', async () => {
    // The safest revocation there is.
    mount([agent()])
    await screen.findByText(/nobody answers/)
    expect(screen.getAllByText('never').length).toBeGreaterThan(0)
  })

  it('builds the register from the same rows as the cards', async () => {
    // It used to be a separate fixture, and it disagreed: the cards said
    // nobody answered for any agent while the register named four owners.
    mount([agent({ owner: { id: 'maya', display: 'Maya', kind: 'human' } })])
    await screen.findByText(/answerable to Maya/)
    expect(screen.getAllByText('Maya').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Priya|Sam|Lena/)).toBeNull()
  })

  it('does not claim a column the schema has no source for', async () => {
    // Purpose and data boundary were invented per agent. An invented column is
    // worse than a missing one.
    mount([agent()])
    await screen.findByText(/nobody answers/)
    expect(screen.queryByText(/data boundary/i)).toBeNull()
    expect(screen.queryByText(/confidential|restricted/)).toBeNull()
  })

  it('says it could not read them rather than showing none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch') }))
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Could not read the agents/)).toBeTruthy())
  })
})

describe('an agent', () => {
  it('can be talked about, like anything else in the workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const out = op === 'agents.get' ? { agent: { ...agent(), recent: [] } }
        : op === 'agents.inbox' ? { agent_id: 'triage', asks: [] }
        : op === 'messages.counts' ? { counts: { triage: 2 } }
        : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    render(<MemoryRouter initialEntries={['/agents/triage']}>
      <Routes><Route path="/agents/:id" element={<AgentDetail />} /></Routes></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Comments 2' })).toBeTruthy()
  })
})

describe('agent connection activity', () => {
  it('recognizes recent token use without treating it as proof of execution', async () => {
    const { runnerSeen } = await import('../Agents')
    const now = Date.parse('2026-10-06T12:00:00Z')
    expect(runnerSeen('2026-10-06T11:59:48Z', now)).toBe(12)
    expect(runnerSeen('2026-10-06T11:58:30Z', now)).toBeNull()
    expect(runnerSeen(null, now)).toBeNull()
    expect(runnerSeen('invalid date', now)).toBeNull()
    expect(runnerSeen('2026-10-06T12:01:00Z', now)).toBeNull()
  })
})

describe('creating an agent', () => {
  it('owns the agent for its creator, says what each setting means, and Never sends no expiry at all', async () => {
    const u = userEvent.setup()
    const sent: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const op = String(url).split('/api/v1/')[1]
      if (op === 'agents.create') sent.push(JSON.parse(String(init?.body)))
      const out = op === 'agents.list' ? { agents: [] }
        : op === 'people.list' ? { people: [{ id: 'alex', display: 'Alex', agents_owned: 6 }] }
        : op === 'agents.create' ? { agent_id: 'readout-writer', token: 'ci_x', token_note: '' } : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: '+ Add an agent' }))
    expect(await screen.findByText(/You’ll be the owner/)).toBeTruthy()
    expect(screen.queryByText('Responsible person')).toBeNull()                      // nothing to choose
    expect(screen.getByText(/Private docs stay private unless someone shares them with it/)).toBeTruthy()
    await u.type(screen.getByPlaceholderText('readout-writer'), 'readout-writer')
    await u.selectOptions(screen.getByRole('combobox', { name: /Access expires/ }), 'Never')
    expect(screen.getByText(/never expire/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].expires_days).toBeUndefined()
    expect((sent[0].grant as Record<string, unknown>).days).toBeUndefined()
    expect(sent[0].owner_id).toBeUndefined()                                          // the creator, server-side
    expect(sent[0]).toMatchObject({ agent_id: 'readout-writer', trust_tier: 'propose-only',
                                    grant: { relation: 'propose', resource: 'space:pay' } })
  })
})

function stubGateway(overrides: Record<string, unknown> = {}, handle?: (op: string, body: Record<string, unknown>) => unknown) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const answer = await handle?.(op, JSON.parse(String(init?.body ?? '{}')))
    const out = answer ?? overrides[op] ?? ({
      'agents.list': { agents: [] },
      'agents.get': { agent: { ...agent(), recent: [] } },
      'agents.inbox': { asks: [] },
      'agents.create': { agent_id: 'readout-writer', token: 'ci_test_only_secret', token_note: 'Only shown once.' },
      'agents.ask': { repeat: false, seq: 7 },
      'messages.counts': { counts: {} },
    } as Record<string, unknown>)[op] ?? {}
    return { ok: true, status: 200, json: async () => out } as Response
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function mountDetail() {
  return render(<MemoryRouter initialEntries={['/agents/triage']}><Routes>
    <Route path="/agents/:id" element={<AgentDetail />} />
  </Routes></MemoryRouter>)
}

describe('guided agent setup', () => {
  it('focuses the name, suggests a handle, and keeps a manually chosen handle', async () => {
    const user = userEvent.setup()
    stubGateway()
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: '+ Add an agent' }))
    const name = screen.getByRole('textbox', { name: /Name/ })
    const handle = screen.getByRole('textbox', { name: /Handle/ }) as HTMLInputElement
    expect(document.activeElement).toBe(name)
    expect(screen.queryByRole('searchbox')).toBeNull()
    await user.type(name, 'Readout writer')
    expect(handle.value).toBe('readout-writer')
    await user.clear(handle); await user.type(handle, 'my-writer')
    await user.type(name, ' updated')
    expect(handle.value).toBe('my-writer')
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Add an agent' }))
  })

  it('validates handles before sending and creates with safe defaults through Enter', async () => {
    const user = userEvent.setup()
    const fetch = stubGateway()
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: '+ Add an agent' }))
    const handle = screen.getByRole('textbox', { name: /Handle/ })
    const submit = screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement
    for (const invalid of ['ab', 'Bad Name', '9agent', 'agent-']) {
      await user.clear(handle); await user.type(handle, invalid); await user.tab()
      expect(submit.disabled).toBe(true)
      expect(handle.getAttribute('aria-invalid')).toBe('true')
    }
    expect(fetch.mock.calls.some(([url]) => url.includes('agents.create'))).toBe(false)
    await user.clear(handle); await user.type(handle, 'readout-writer{Enter}')
    await screen.findByText('Agent created. Now connect it.')
    const created = fetch.mock.calls.find(([url]) => url.includes('agents.create'))!
    expect(JSON.parse(String(created[1]?.body))).toMatchObject({ agent_id: 'readout-writer', trust_tier: 'propose-only', expires_days: 90,
      grant: { relation: 'propose', resource: 'space:pay', days: 90 } })
    expect(screen.queryByRole('button', { name: '+ Add an agent' })).toBeNull()
  })

  it('makes autonomous publishing explicit and resets it for read-only access', async () => {
    const user = userEvent.setup()
    stubGateway()
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: '+ Add an agent' }))
    const review = screen.getByRole('combobox', { name: 'Metric approval' }) as HTMLSelectElement
    await user.selectOptions(review, 'autonomous')
    expect(screen.getByText(/without a person approving them/)).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: /Read only/ }))
    expect(review.disabled).toBe(true)
    expect(review.value).toBe('propose-only')
    expect(screen.getByText(/Read-only agents cannot create/)).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: /Can approve/ }))
    expect(review.disabled).toBe(false)
    expect(review.value).toBe('propose-only')
  })

  it('keeps form values and focuses the handle after a duplicate error', async () => {
    const user = userEvent.setup()
    stubGateway({}, op => {
      if (op === 'agents.create') throw new GatewayError('actor_exists', 'This handle already exists', 'agent_id')
    })
    render(<MemoryRouter><AgentsView /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: '+ Add an agent' }))
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Readout writer')
    await user.click(screen.getByRole('button', { name: 'Create agent' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This handle already exists')
    expect((screen.getByRole('textbox', { name: /Handle/ }) as HTMLInputElement).value).toBe('readout-writer')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Handle/ }))
    expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('masks the token, copies it, and requires acknowledgement before leaving setup', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const done = vi.fn()
    render(<MemoryRouter><AgentCreated made={{ agent_id: 'writer', token: 'ci_test_only', token_note: '' }} onDone={done} /></MemoryRouter>)
    const token = screen.getByLabelText('Agent token') as HTMLInputElement
    expect(token.type).toBe('password')
    expect((screen.getByRole('button', { name: 'Open agent →' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Show token' }))
    expect(token.type).toBe('text')
    await user.click(screen.getByRole('button', { name: 'Copy token' }))
    expect(write).toHaveBeenCalledWith('ci_test_only')
    expect(screen.getByText('Copied to clipboard.')).toBeTruthy()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await user.click(screen.getByRole('checkbox'))
    const allowed = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(allowed)
    expect(allowed.defaultPrevented).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Back to agents' }))
    expect(done).toHaveBeenCalledOnce()
  })

  it('warns before losing a token through sidebar navigation', async () => {
    const user = userEvent.setup()
    const router = createMemoryRouter([
      { path: '/', element: <><Link to="/elsewhere">Elsewhere</Link><AgentCreated made={{ agent_id: 'writer', token: 'ci_test_only', token_note: '' }} onDone={() => {}} /></> },
      { path: '/elsewhere', element: <h1>Other page</h1> },
    ])
    render(<RouterProvider router={router} />)
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(await screen.findByText('Save your token before leaving.')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/')
    await user.click(screen.getByRole('button', { name: 'Stay and save token' }))
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(await screen.findByRole('heading', { name: 'Other page' })).toBeTruthy()
  })

  it('does not report success when clipboard access fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'))
    render(<CopyButton text="test command" />)
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(await screen.findByText(/Could not copy/)).toBeTruthy()
    expect(screen.queryByText('Copied to clipboard.')).toBeNull()
  })
})

describe('the agent request workspace', () => {
  it('shows a connection signal without claiming the agent is running', async () => {
    stubGateway({ 'agents.get': { agent: agent({ tokens: { count: 1, last_used: new Date().toISOString(), next_expiry: null } }) } })
    mountDetail()
    expect(await screen.findByText('Recently connected')).toBeTruthy()
    expect(screen.getByText(/not that a task is running/)).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Ask triage' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Access & review' })).toBeTruthy()
    expect(screen.getByText('Owner needed')).toBeTruthy()
  })

  it('queues an offline request and displays it without pretending it has completed', async () => {
    const user = userEvent.setup()
    let queued = false
    const fetch = stubGateway({}, op => {
      if (op === 'agents.ask') { queued = true; return { seq: 7, repeat: false } }
      if (op === 'agents.inbox') return { asks: queued ? [{ seq: 7, note: 'Summarize this week', asked_by: 'Alex', asked_at: new Date().toISOString(), object: null }] : [] }
    })
    mountDetail()
    await screen.findByRole('heading', { name: 'Ask triage' })
    expect(screen.getByText(/You can queue a request now/)).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Request for triage' }), 'Summarize this week')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(await screen.findByText('Summarize this week')).toBeTruthy()
    expect(screen.getByText('Queued')).toBeTruthy()
    expect(screen.getByText(/Request queued\. It will be picked up/)).toBeTruthy()
    const asks = fetch.mock.calls.filter(([url]) => url.includes('agents.ask'))
    expect(asks).toHaveLength(1)
    expect(JSON.parse(String(asks[0][1]?.body))).toMatchObject({ agent_id: 'triage', note: 'Summarize this week' })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps request text after a send failure', async () => {
    const user = userEvent.setup()
    stubGateway({}, op => { if (op === 'agents.ask') throw new Error('Network unavailable') })
    mountDetail()
    await user.type(await screen.findByRole('textbox'), 'Please review this')
    await user.click(screen.getByRole('button', { name: 'Queue request' }))
    expect(await screen.findByText(/Could not queue the request/)).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Please review this')
  })

  it('reports an inbox error instead of claiming the queue is empty and supports retry', async () => {
    const user = userEvent.setup()
    let fail = true
    stubGateway({}, op => { if (op === 'agents.inbox' && fail) throw new Error('Offline') })
    mountDetail()
    expect(await screen.findByText('Could not refresh the request queue.')).toBeTruthy()
    expect(screen.queryByText('No requests waiting')).toBeNull()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry queue' }))
    expect(await screen.findByText('No requests waiting')).toBeTruthy()
  })

  it('does not enable requests with expired workspace permissions', async () => {
    stubGateway({ 'agents.get': { agent: agent({ grants: [{ relation: 'propose', resource: 'space:pay', expires_at: '2020-01-01T00:00:00Z', last_used: null }] }) } })
    mountDetail()
    expect((await screen.findByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(/grant or renew access/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Queue request' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses actual task routes for queued context and authored work', async () => {
    stubGateway({
      'agents.get': { agent: agent({ recent: [{ id: 'task-8', type: 'task', title: 'Draft a report', created_at: new Date().toISOString() }] }) },
      'agents.inbox': { asks: [{ seq: 8, note: 'Check this task', asked_by: 'maya', asked_at: new Date().toISOString(), object: { id: 'task-1', type: 'task', title: 'Review request' } }] },
    })
    mountDetail()
    expect((await screen.findByRole('link', { name: 'Review request' })).getAttribute('href')).toBe('/board?task=task-1')
    expect(screen.getByRole('link', { name: /Draft a report/ }).getAttribute('href')).toBe('/board?task=task-8')
  })

  it('refreshes the queue while preserving an unsent request', async () => {
    vi.useFakeTimers()
    let reads = 0
    stubGateway({}, op => {
      if (op === 'agents.inbox') return { asks: ++reads === 1 ? [{ seq: 8, note: 'Queued before pickup', asked_by: 'maya', asked_at: new Date().toISOString(), object: null }] : [] }
    })
    await act(async () => { mountDetail() })
    expect(screen.getByText('Queued before pickup')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My unsent request' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(reads).toBe(2)
    expect(screen.getByText('No requests waiting')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My unsent request')
  })

  it('does not submit a second request while the first is in flight', async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    const fetch = stubGateway({}, op => op === 'agents.ask' ? new Promise(resolve => { finish = resolve }) : undefined)
    mountDetail()
    await user.type(await screen.findByRole('textbox'), 'One request only')
    await user.dblClick(screen.getByRole('button', { name: 'Queue request' }))
    expect(fetch.mock.calls.filter(([url]) => url.includes('agents.ask'))).toHaveLength(1)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    await act(async () => { finish({ repeat: false, seq: 9 }) })
    expect(screen.getByText(/Request queued\. It will be picked up/)).toBeTruthy()
  })

  it('does not carry an unsent request over to another agent', async () => {
    const user = userEvent.setup()
    stubGateway({}, (op, body) => op === 'agents.get' ? { agent: agent({ id: body.agent_id, display: body.agent_id }) } : undefined)
    const router = createMemoryRouter([{ path: '/agents/:id', element: <AgentDetail /> }], { initialEntries: ['/agents/triage'] })
    render(<RouterProvider router={router} />)
    await user.type(await screen.findByRole('textbox', { name: 'Request for triage' }), 'Private draft for triage')
    await act(async () => { await router.navigate('/agents/scribe') })
    const input = await screen.findByRole('textbox', { name: 'Request for scribe' }) as HTMLTextAreaElement
    expect(input.value).toBe('')
    expect(screen.queryByText('Private draft for triage')).toBeNull()
  })
})
