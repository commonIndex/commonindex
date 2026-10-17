/**
 * The board, reading the gateway's tasks and sending its verbs.
 *
 * What is defended here is that the page offers only what the gateway will
 * accept, and sends what it needs: a move is a verb with the revision it was
 * made on, filing for review answers every criterion, sending work back says
 * why, and a drop between lanes means the same verb the panel's button does.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { moveOf, TasksView } from '../Tasks'
import type { WireBoard, WireTask } from '../../data/gateway'

const YOU = { own: false, may_start: false, may_hand: false, may_release: false, may_submit: false,
  may_accept: false, may_self_accept: false, may_send_back: false, may_ask: false, may_answer: false,
  may_edit: true, may_delete: true }
const ALEX = { id: 'alex', name: 'Alex', kind: 'human' as const }
const SCRIBE = { id: 'scribe', name: 'Scribe', kind: 'agent' as const }

function task(over: Partial<WireTask> & { id: string }): WireTask {
  return {
    key: over.id.toUpperCase(), title: `Task ${over.id}`, detail: null, state: 'ready', origin: 'filed',
    criteria: [], human_only: null, agent_ready: false, not_agent_ready: 'it has no definition of done',
    assignee: null, created_by: ALEX, created_at: '2026-09-20T00:00:00Z',
    moved_at: '2026-09-20T00:00:00Z', in_state_s: 3600, question: null, produced: null, review: null,
    asked: false, run: null, links: [], rev: 3, updated_at: '2026-09-20T00:00:00Z',
    ...over, you: { ...YOU, ...(over.you ?? {}) },
  }
}

const READY = task({ id: 't-1', title: 'Sync the retry ceiling', agent_ready: true, not_agent_ready: null,
  criteria: [{ text: 'every spec agrees', met: null }, { text: 'each edit cites #341', met: null }],
  you: { ...YOU, may_start: true, may_hand: true } })
const PERSON = task({ id: 't-2', title: 'Interview support leads', human_only: 'talking to people',
  not_agent_ready: 'it needs a person: talking to people', you: { ...YOU, may_start: true } })
const MINE = task({ id: 't-3', title: 'Rewrite onboarding', state: 'flight', assignee: ALEX,
  criteria: [{ text: 'covers three entry points', met: null }, { text: 'a new engineer can ship', met: null }],
  you: { ...YOU, own: true, may_submit: true, may_release: true } })
const ASKING = task({ id: 't-4', title: 'Reconcile the refund spec', state: 'flight', assignee: SCRIBE,
  question: { text: 'D-12 or the code?', by: SCRIBE, at: '2026-09-25T00:00:00Z' },
  run: { id: 'run-1', status: 'asking', started_at: '2026-09-25T00:00:00Z', ended_at: '2026-09-25T00:18:00Z',
    seconds: 1080, cost_usd: 0.64, cost_tokens: 900 },
  you: { ...YOU, may_answer: true, may_release: true } })
const WORKING = task({ id: 't-5', title: 'Close decided flags', state: 'flight', assignee: SCRIBE,
  run: { id: 'run-2', status: 'running', started_at: '2026-09-26T00:00:00Z', ended_at: null,
    seconds: 252, cost_usd: 0, cost_tokens: 0 } })
const REVIEW = task({ id: 't-6', title: 'Instrument the funnel', state: 'review', assignee: SCRIBE,
  in_state_s: 5 * 86400, criteria: [{ text: 'emits events', met: true }, { text: 'dashboard reads them', met: false }],
  review: { submitted_by: SCRIBE, submitted_at: '2026-09-21T00:00:00Z', note: 'one metric missing' },
  you: { ...YOU, may_accept: true, may_send_back: true } })
const DONE = task({ id: 't-7', title: 'Document idempotency', state: 'done', assignee: SCRIBE,
  review: { decided_by: ALEX, decided_at: '2026-09-22T00:00:00Z', decision: 'accepted' } })

const BOARD: WireBoard = {
  tasks: [READY, PERSON, MINE, ASKING, WORKING, REVIEW, DONE], total: 7,
  counts: { ready: 2, flight: 3, review: 1, done: 1 }, review_oldest_s: 5 * 86400, running: 1, asking: 1,
  you: { id: 'alex', name: 'Alex', kind: 'human', may: { propose: true, merge: true, admin: true } },
}

const ROUTES = [
  { agent: SCRIBE, can: true, why: '1 accepted, 0 sent back on this board', needs: null, accepted: 1, sent_back: 0 },
  { agent: { id: 'nosy', name: 'Nosy', kind: 'agent' as const }, can: false, why: 'holds no grant in this space',
    needs: 'propose', accepted: 0, sent_back: 0 },
]

type Call = { op: string; body: Record<string, unknown> }

function LocationControls() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="location">{location.pathname}{location.search}</output>
    <button onClick={() => navigate(-1)}>Browser back</button></>
}

function mount(board: WireBoard = BOARD, path = '/board', failing: { read?: boolean; edit?: boolean } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    if ((op === 'tasks.get' && failing.read) || (op === 'tasks.revise' && failing.edit)) {
      return { ok: false, status: 503, json: async () => ({ error: { code: 'offline', message: 'Temporarily unavailable' } }) } as Response
    }
    const one = board.tasks.find(t => t.id === body.task_id)
    const out = op === 'tasks.list' ? board
      : op === 'tasks.get' ? { task: { ...one, history: [], routes: ROUTES } }
      : op.startsWith('tasks.') ? { task: one ?? READY, rev: 4, already: false, created: true }
      : op === 'messages.list' ? { subject: { id: body.subject_id, title: 'Task', type: 'task' }, messages: [], waiting: {} }
      : op === 'members.list' ? { members: [{ id: 'rhea', name: 'Rhea', email: null, role: 'contributor' },
          { id: 'vic', name: 'Vic', email: null, role: 'viewer' }], you: { id: 'maya', role: 'admin' } }
      : op === 'agents.list' ? { agents: [{ id: 'scribe', display: 'Scribe', may: ['propose'] }, { id: 'nosy', display: 'Nosy', may: [] }] }
      : { people: [], agents: [] }
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  render(<MemoryRouter initialEntries={[path]}><TasksView /><LocationControls /></MemoryRouter>)
  return calls
}
const sent = (calls: Call[], op: string) => calls.filter(c => c.op === op).map(c => c.body)
const card = (title: string) => screen.getByRole('button', { name: new RegExp(title) })
const lane = (name: string) => screen.getByRole('region', { name })

afterEach(() => { vi.unstubAllGlobals() })

describe('the board', () => {
  it('lays the gateway’s tasks out in four lanes, one signal per card', async () => {
    mount()
    await screen.findByText('Sync the retry ceiling')
    expect(within(lane('Ready')).getAllByRole('button', { name: /^T-\d/ }).map(b => b.getAttribute('aria-label')))
      .toEqual(['T-1 Sync the retry ceiling', 'T-2 Interview support leads'])
    expect(within(card('Sync the retry ceiling')).getByText('Agent-ready')).toBeTruthy()
    expect(within(card('Interview support leads')).getByText('Needs a person')).toBeTruthy()
    expect(within(card('Reconcile the refund spec')).getByText('Asking')).toBeTruthy()
    expect(within(card('Close decided flags')).getByText('Working 4m')).toBeTruthy()
    expect(within(card('Instrument the funnel')).getByText('Waiting 5d')).toBeTruthy()
    // As filed: one of two met, and the miss is visible on the card.
    expect(within(card('Instrument the funnel')).getByText('1/2')).toBeTruthy()
  })

  it('puts the oldest wait on the review lane, where work pools', async () => {
    mount()
    await screen.findByText('Sync the retry ceiling')
    expect(within(lane('In review')).getByText('oldest 5d')).toBeTruthy()
    expect(lane('In review').className).toMatch(/stale/)
    expect(within(lane('In progress')).getByText('1 running')).toBeTruthy()
  })

  it('filters to what is waiting on a person, and by title', async () => {
    const u = userEvent.setup()
    mount()
    await screen.findByText('Sync the retry ceiling')
    await u.click(screen.getByRole('tab', { name: 'Waiting on a person 2' }))
    expect(screen.queryByText('Sync the retry ceiling')).toBeNull()
    expect(screen.getByText('Reconcile the refund spec')).toBeTruthy()
    expect(screen.getByText('Instrument the funnel')).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'All 7' }))
    await u.type(screen.getByLabelText('Filter tasks'), 'onboard')
    expect(screen.getAllByRole('button', { name: /^T-\d/ }).map(b => b.getAttribute('aria-label')))
      .toEqual(['T-3 Rewrite onboarding'])
  })
})

describe('moving work', () => {
  it('maps a drop to the verb it means, only where the caller may make it', () => {
    expect(moveOf(READY, 'flight')).toBe('start')
    expect(moveOf(READY, 'review')).toBeNull()
    expect(moveOf(MINE, 'review')).toBe('submit')
    expect(moveOf(MINE, 'ready')).toBe('release')
    expect(moveOf(REVIEW, 'done')).toBe('accept')
    expect(moveOf(REVIEW, 'flight')).toBe('send_back')
    expect(moveOf(WORKING, 'review')).toBeNull()   // not yours to file
  })

  it('starts a task dropped into In progress, on the revision it was read at', async () => {
    const calls = mount()
    await screen.findByText('Sync the retry ceiling')
    fireEvent.dragStart(card('Sync the retry ceiling'))
    fireEvent.dragOver(lane('In progress'))
    fireEvent.drop(lane('In progress'))
    await waitFor(() => expect(sent(calls, 'tasks.start')).toHaveLength(1))
    const body = sent(calls, 'tasks.start')[0]
    expect(body).toMatchObject({ task_id: 't-1', if_rev: 3 })
    expect(String(body.idempotencyKey)).toMatch(/^start:/)
  })

  it('opens the filing form instead of guessing the criteria on a drop into review', async () => {
    const calls = mount()
    await screen.findByText('Rewrite onboarding')
    fireEvent.dragStart(card('Rewrite onboarding'))
    fireEvent.dragOver(lane('In review'))
    fireEvent.drop(lane('In review'))
    expect(await screen.findByText('Tick each check the work meets')).toBeTruthy()
    expect(sent(calls, 'tasks.submit')).toHaveLength(0)
  })
})

describe('the panel', () => {
  it('shows explicit completion checks, assignee details, and a full-page action', async () => {
    mount(BOARD, '/board?task=t-6')
    const panel = await screen.findByRole('dialog', { name: 'T-6 Instrument the funnel' })
    expect(within(panel).getByRole('progressbar', { name: 'Criteria met' }).getAttribute('value')).toBe('1')
    expect(within(panel).getByText('Not met')).toBeTruthy()
    expect(within(panel).getByText(/Some checks are incomplete/)).toBeTruthy()
    expect(within(panel).getByText('Assignee')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Open full page' })).toBeTruthy()
  })

  it('expands to a URL-backed full page and preserves comment drafts across tabs and resizing', async () => {
    const calls = mount(BOARD, '/board?task=t-6')
    const u = userEvent.setup()
    // Updates open first; the conversation is a tab away.
    expect(await screen.findByRole('combobox', { name: /Post an update/ })).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Comments' }))
    const composer = await screen.findByRole('combobox', { name: /Comment on this task/ })
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false))
    await u.type(composer, 'Please verify the funnel')
    await u.click(screen.getByRole('button', { name: 'Open full page' }))
    expect(screen.getByTestId('location').textContent).toBe('/board?task=t-6&view=full')
    expect(screen.getByRole('heading', { level: 1, name: REVIEW.title })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Board/ })).toBeNull()
    expect(screen.getByRole('combobox')).toBe(composer)
    expect((composer as HTMLTextAreaElement).value).toBe('Please verify the funnel')
    const comments = screen.getByRole('tab', { name: 'Comments' })
    comments.focus()
    await u.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Activity 0' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('combobox')).toBeNull()
    await u.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Updates' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('combobox', { name: /Post an update/ })).toBeTruthy()
    await u.keyboard('{ArrowRight}')
    expect(screen.getByRole('combobox')).toBe(composer)
    await u.click(screen.getByRole('button', { name: 'Show side panel' }))
    expect(screen.getByTestId('location').textContent).toBe('/board?task=t-6')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('Please verify the funnel')
    expect(sent(calls, 'messages.post')).toEqual([])
    expect(sent(calls, 'tasks.get')).toHaveLength(1)
  })

  it('restores the full page from a direct URL, keeps Escape local, and returns to the board', async () => {
    mount(BOARD, '/board?task=t-6&view=full')
    await screen.findByRole('heading', { level: 1, name: REVIEW.title })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('location').textContent).toContain('view=full')
    await userEvent.click(screen.getByRole('button', { name: 'Back to board' }))
    expect(screen.getByTestId('location').textContent).toBe('/board')
    expect(screen.getByRole('heading', { name: /^Board/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: REVIEW.title })).toBeNull()
  })

  it('retains a send-back reason through expansion and browser back without submitting it', async () => {
    const calls = mount(BOARD, '/board?task=t-6')
    await userEvent.click(await screen.findByRole('button', { name: 'Send back…' }))
    await userEvent.type(screen.getByLabelText('What should change?'), 'Check the last metric')
    await userEvent.click(screen.getByRole('button', { name: 'Open full page' }))
    expect((screen.getByLabelText('What should change?') as HTMLTextAreaElement).value).toBe('Check the last metric')
    await userEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByLabelText('What should change?') as HTMLTextAreaElement).value).toBe('Check the last metric')
    expect(sent(calls, 'tasks.send_back')).toEqual([])
  })

  it('retains task edits through expanding without saving them', async () => {
    const calls = mount(BOARD, '/board?task=t-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.type(screen.getByLabelText('Title'), ' revised')
    await userEvent.click(screen.getByRole('button', { name: 'Open full page' }))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(`${READY.title} revised`)
    expect(sent(calls, 'tasks.revise')).toEqual([])
  })

  it('retries failed full-page reads without losing the way back to the board', async () => {
    const failing = { read: true }
    mount(BOARD, '/board?task=t-6&view=full', failing)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeTruthy()
    failing.read = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: REVIEW.title })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps an unsuccessful edit and its error visible in the editor', async () => {
    mount(BOARD, '/board?task=t-1', { edit: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.type(screen.getByLabelText('Title'), ' revised')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Temporarily unavailable')
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(`${READY.title} revised`)
  })

  it('offers a ready task to you or to an agent that may file here', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByText('Sync the retry ceiling'))
    await u.click(await screen.findByRole('button', { name: 'Hand to an agent' }))
    expect(screen.getByText('needs propose here')).toBeTruthy()
    await u.type(screen.getByPlaceholderText(/Anything it should know/), 'D-12 wins')
    await u.click(screen.getByRole('button', { name: 'Hand over' }))
    await waitFor(() => expect(sent(calls, 'tasks.hand')).toHaveLength(1))
    expect(sent(calls, 'tasks.hand')[0]).toMatchObject({ task_id: 't-1', agent_id: 'scribe', note: 'D-12 wins', if_rev: 3 })
  })

  it('says why no agent can take a task that needs a person', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByText('Interview support leads'))
    expect(await screen.findByText(/No agent can take this: it needs a person/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Hand to an agent' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('files for review with an answer for every criterion', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByText('Rewrite onboarding'))
    await u.click(await screen.findByRole('button', { name: 'File for review' }))
    await u.click(screen.getByLabelText('covers three entry points'))
    await u.type(screen.getByLabelText(/What it produced/), 'Onboarding doc')
    await u.click(screen.getByRole('button', { name: 'File for review' }))
    await waitFor(() => expect(sent(calls, 'tasks.submit')).toHaveLength(1))
    expect(sent(calls, 'tasks.submit')[0]).toMatchObject({
      task_id: 't-3', criteria_met: [true, false], produced: { label: 'Onboarding doc' } })
  })

  it('answers an agent’s question so its run can resume', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByText('Reconcile the refund spec'))
    expect(await screen.findByText('D-12 or the code?')).toBeTruthy()
    const answer = screen.getByRole('button', { name: 'Answer — the run resumes' }) as HTMLButtonElement
    expect(answer.disabled).toBe(true)
    await u.type(screen.getByLabelText('Your answer'), 'The code.')
    await u.click(answer)
    await waitFor(() => expect(sent(calls, 'tasks.answer')[0]).toMatchObject({ task_id: 't-4', answer: 'The code.' }))
  })

  it('accepts on the revision read, and sends back only with a reason', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByText('Instrument the funnel'))
    await u.click(await screen.findByRole('button', { name: 'Send back…' }))
    const send = screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await u.type(screen.getByLabelText('What should change?'), 'Ratify the last metric first.')
    await u.click(send)
    await waitFor(() => expect(sent(calls, 'tasks.send_back')[0]).toMatchObject({
      task_id: 't-6', if_rev: 3, note: 'Ratify the last metric first.' }))
  })

  it('files a new task with its definition of done, one check per line', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByRole('button', { name: '+ New task' }))
    const file = screen.getByRole('button', { name: 'File task' }) as HTMLButtonElement
    expect(file.disabled).toBe(true)
    await u.type(screen.getByLabelText('Title'), 'Draft the 2.4 changelog')
    await u.type(screen.getByLabelText('What done means'), '- one entry per release{enter}{enter}cites its PRs')
    await u.click(file)
    await waitFor(() => expect(sent(calls, 'tasks.propose')).toHaveLength(1))
    expect(sent(calls, 'tasks.propose')[0]).toMatchObject({
      title: 'Draft the 2.4 changelog', criteria: ['one entry per release', 'cites its PRs'], human_only: null })
  })

  it('marks a task for a person with the box alone — no reason to write', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByRole('button', { name: '+ New task' }))
    await u.type(screen.getByLabelText('Title'), 'Interview support leads')
    await u.click(screen.getByLabelText('Only a person can do this'))
    expect(screen.queryByText('Why')).toBeNull()
    const file = screen.getByRole('button', { name: 'File task' }) as HTMLButtonElement
    expect(file.disabled).toBe(false)
    await u.click(file)
    await waitFor(() => expect(sent(calls, 'tasks.propose')).toHaveLength(1))
    expect(sent(calls, 'tasks.propose')[0]).toMatchObject({ human_only: 'only a person can do it' })
  })

  it('files a task for a member picked from the people who can work here', async () => {
    const u = userEvent.setup()
    const calls = mount()
    await u.click(await screen.findByRole('button', { name: '+ New task' }))
    await u.type(screen.getByLabelText('Title'), 'Migrate billing to the new service')
    await waitFor(() => expect((screen.getByRole('button', { name: /Assignee/ }) as HTMLButtonElement).disabled).toBe(false))
    await u.click(screen.getByRole('button', { name: /Assignee/ }))
    const list = screen.getByRole('listbox', { name: 'Assignee' })
    expect(within(list).queryByRole('option', { name: /Vic/ })).toBeNull()        // a viewer cannot work it
    await u.type(screen.getByLabelText('Search people and agents'), 'rhe')
    expect(within(list).queryByRole('option', { name: /Scribe/ })).toBeNull()      // the search narrows
    await u.click(within(list).getByRole('option', { name: /Rhea/ }))
    await u.click(screen.getByRole('button', { name: 'File task' }))
    await waitFor(() => expect(sent(calls, 'tasks.assign')).toHaveLength(1))
    expect(sent(calls, 'tasks.assign')[0]).toMatchObject({ assignee_id: 'rhea' })
  })

  it('tags agents, needs what done means for one, and unticks people-only when one is picked', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByRole('button', { name: '+ New task' }))
    await u.type(screen.getByLabelText('Title'), 'Reconcile the ledger')
    await waitFor(() => expect((screen.getByRole('button', { name: /Assignee/ }) as HTMLButtonElement).disabled).toBe(false))
    await u.click(screen.getByRole('button', { name: /Assignee/ }))
    let scribe = screen.getByRole('option', { name: /Scribe/ })
    expect(within(scribe).getByText('Agent')).toBeTruthy()
    expect(scribe.getAttribute('aria-disabled')).toBe('true')                    // nothing written for done
    expect(within(scribe).getByText('write what done means first')).toBeTruthy()
    await u.keyboard('{Escape}')
    await u.type(screen.getByLabelText('What done means'), 'one entry per release')
    await u.click(screen.getByLabelText('Only a person can do this'))
    await u.click(screen.getByRole('button', { name: /Assignee/ }))
    scribe = screen.getByRole('option', { name: /Scribe/ })
    expect(scribe.getAttribute('aria-disabled')).toBe('false')
    await u.click(scribe)
    expect((screen.getByLabelText('Only a person can do this') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(/was unticked — an agent is doing it/)).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Assignee/ })).getByText('Agent')).toBeTruthy()
  })
})

describe('adding from the lane', () => {
  it('opens the same new-task form from Ready as from the header', async () => {
    const u = userEvent.setup()
    mount()
    await u.click(await screen.findByRole('button', { name: 'Add a task to Ready' }))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByLabelText('Title')).toBeTruthy()
  })

  it('names who has each task, not just a mark', async () => {
    mount()
    await screen.findByText('Close decided flags')
    expect(within(card('Close decided flags')).getByText('Scribe')).toBeTruthy()
    expect(within(card('Rewrite onboarding')).getByText('Alex')).toBeTruthy()
  })
})

describe('the project filter', () => {
  it('shows the board for one project, picked from its colors and counts, and back to all', async () => {
    const u = userEvent.setup()
    const tag = { id: 'project-1', key: 'PRO-1', title: 'Legacy billing', color: 'violet' as const, status: 'active' as const }
    const board = { ...BOARD, tasks: BOARD.tasks.map((t, i) => i === 0 ? { ...t, projects: [tag] } : t) }
    mount(board)
    await screen.findByText('Sync the retry ceiling')
    const button = screen.getByRole('button', { name: 'Project: all' })
    await u.click(button)
    const item = screen.getByRole('menuitemradio', { name: /Legacy billing/ })
    expect(within(item).getByText('1')).toBeTruthy()
    await u.click(item)
    expect(screen.getByRole('button', { name: 'Project: Legacy billing' })).toBeTruthy()
    expect(screen.queryByText('Interview support leads')).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Project: Legacy billing' }))
    await u.click(screen.getByRole('menuitemradio', { name: /All projects/ }))
    expect(await screen.findByText('Interview support leads')).toBeTruthy()
  })
})


describe('updates', () => {
  it('posts an update on a task, apart from the comments, with whoever it tags', async () => {
    const calls = mount(BOARD, '/board?task=t-6')
    const u = userEvent.setup()
    const box = await screen.findByRole('combobox', { name: /Post an update/ })
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false))
    expect(sent(calls, 'messages.list').some(b => b.kind === 'update')).toBe(true)
    await u.type(box, 'Invoices moved over')
    await u.keyboard('{Enter}')
    await waitFor(() => expect(sent(calls, 'messages.post')).toHaveLength(1))
    expect(sent(calls, 'messages.post')[0]).toMatchObject({ subject_id: 't-6', kind: 'update', body: 'Invoices moved over' })
  })
})
