/**
 * Work from where it was noticed, and back.
 *
 * Tasks could only be filed on the Board, and a task could not point at what
 * it was about: a comment, a failing panel, a decision had no way to become
 * work where it was seen. What is defended: an object's page lists the tasks
 * linked to it and says how; a task made from a thing is linked back to it;
 * a comment becomes a task prefilled from what was said, and the thread is
 * told; a task panel links to anything the workspace can find, and unlinks.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MakeTaskDialog, TasksButton } from '../TaskLinks'
import { TaskPanel } from '../TaskPanel'
import { taskPrefill, Thread } from '../discussion/Thread'
import { forgetMentionables } from '../discussion/mentions'
import type { WireMessage, WireTask } from '../../data/gateway'

const ALEX = { id: 'alex', name: 'Alex', kind: 'human' as const }
const MAYA = { id: 'maya', name: 'Maya', kind: 'human' as const }
const YOU = { own: false, may_start: false, may_hand: false, may_release: false, may_submit: false,
  may_accept: false, may_self_accept: false, may_send_back: false, may_ask: false, may_answer: false,
  may_edit: true, may_delete: true }

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

type Call = { op: string; body: Record<string, unknown> }
function gateway(answers: Record<string, (body: Record<string, unknown>) => unknown>) {
  forgetMentionables()
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    const out = answers[op] ? answers[op](body) : {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
const sent = (calls: Call[], op: string) => calls.filter(c => c.op === op).map(c => c.body)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const MADE = task({ id: 't-9', title: 'Fix the spend panel' })

describe("an object's tasks", () => {
  it('lists the work linked to it and how, and makes more linked back to it', async () => {
    const u = userEvent.setup()
    let linked = [{ ...task({ id: 't-1', title: 'Rename the dashboard', state: 'flight' }), rel: ['touches'] }]
    const calls = gateway({
      'tasks.linked': () => ({ object_id: 'dash-1', tasks: linked, total: linked.length }),
      'tasks.propose': () => ({ task: MADE, created: true }),
      'tasks.link': () => { linked = [...linked, { ...MADE, rel: ['caused'] }]; return { task: MADE } },
    })
    render(<MemoryRouter><TasksButton about={{ id: 'dash-1', type: 'dashboard', title: 'Two warehouses' }} /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Tasks 1' }))
    expect(screen.getByRole('link', { name: /T-1Rename the dashboardtouches this/ }).getAttribute('href'))
      .toBe('/board?task=t-1')

    await u.click(screen.getByRole('button', { name: 'Make a task' }))
    const dialog = screen.getByRole('dialog', { name: 'Make a task' })
    expect(dialog.textContent).toMatch(/from Two warehouses/)
    await u.type(screen.getByRole('textbox', { name: 'Title' }), 'Fix the spend panel')
    await u.type(screen.getByRole('textbox', { name: 'What done means' }), 'the panel runs')
    await u.click(screen.getByRole('button', { name: 'Make the task' }))

    await waitFor(() => expect(sent(calls, 'tasks.link')).toEqual([
      expect.objectContaining({ task_id: 't-9', object_id: 'dash-1', rel: 'caused' })]))
    expect(sent(calls, 'tasks.propose')[0]).toMatchObject({ title: 'Fix the spend panel', criteria: ['the panel runs'] })
    // The button follows: it re-reads once the task exists.
    expect(await screen.findByRole('button', { name: 'Tasks 2' })).toBeTruthy()
  })

  it('files a task about a skill without a link — a skill is not an object here', async () => {
    const u = userEvent.setup()
    const calls = gateway({ 'tasks.propose': () => ({ task: MADE, created: true }) })
    render(<MakeTaskDialog about={{ id: 'skill-7', type: 'skill', title: 'doc-drift-sync' }}
      prefill={{ title: 'Retire doc-drift-sync' }} onClose={() => {}} />)
    await u.click(screen.getByRole('button', { name: 'Make the task' }))
    await waitFor(() => expect(sent(calls, 'tasks.propose')).toHaveLength(1))
    expect(sent(calls, 'tasks.link')).toEqual([])
  })
})

describe('a comment', () => {
  const said = (over: Partial<WireMessage> & { id: string }): WireMessage => ({
    parent_id: null, author: MAYA, body: 'hello', mentions: [], created_at: '2026-09-26T10:00:00Z',
    edited_at: null, deleted: false, you: { may_edit: false, may_delete: false }, ...over,
  })

  it('is prefilled from what was said: its first line, with names, and where', () => {
    const m = said({ id: 'm1', body: '@alex the spend panel double-counts EU refunds\nsee the 12th',
      mentions: [ALEX] })
    expect(taskPrefill(m, { type: 'dashboard', title: 'Two warehouses' })).toEqual({
      title: 'the spend panel double-counts EU refunds',
      detail: '“@Alex the spend panel double-counts EU refunds\nsee the 12th”\n— Maya, in the comments on Two warehouses',
    })
    expect(taskPrefill(said({ id: 'm2', body: 'x'.repeat(120) }), { type: 'channel', title: 'refunds' }).title)
      .toHaveLength(88)
  })

  it('becomes a task linked to what the conversation is about, and the thread is told', async () => {
    const u = userEvent.setup()
    const calls = gateway({
      'messages.list': () => ({ subject: { id: 'dash-1', type: 'dashboard', key: 'DASH-1', title: 'Two warehouses' },
        messages: [said({ id: 'm1', body: 'The spend panel double-counts EU refunds' })], waiting: {} }),
      'messages.post': body => ({ message: said({ id: 'm2', body: String(body.body), parent_id: 'm1' }),
        asked: [], not_asked: [] }),
      'tasks.propose': () => ({ task: MADE, created: true }),
      'tasks.link': () => ({ task: MADE }),
    })
    render(<MemoryRouter><Thread subjectId="dash-1" /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Make a task' }))
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value)
      .toBe('The spend panel double-counts EU refunds')
    await u.click(screen.getByRole('button', { name: 'Make the task' }))
    await waitFor(() => expect(sent(calls, 'messages.post')).toEqual([expect.objectContaining({
      subject_id: 'dash-1', parent_id: 'm1', body: 'Made a task from this: T-9 — Fix the spend panel' })]))
    expect(sent(calls, 'tasks.link')[0]).toMatchObject({ object_id: 'dash-1', rel: 'caused' })
  })
})

describe("a task's links", () => {
  it('links to anything the workspace finds, saying how, and unlinks', async () => {
    const u = userEvent.setup()
    const t = task({ id: 't-1', links: [{ rel: 'caused', object: { id: 'doc-1', type: 'doc', key: 'DOC-1', title: 'Refund spec' } }] })
    const calls = gateway({
      'tasks.get': () => ({ task: { ...t, history: [], routes: [] } }),
      'search.query': () => ({ q: 'two', hits: [
        { kind: 'object', type: 'dashboard', id: 'dash-1', key: 'DASH-1', title: 'Two warehouses', snippet: null, at: null },
        { kind: 'object', type: 'task', id: 't-1', key: 'T-1', title: 'this very task', snippet: null, at: null },
        { kind: 'agent', type: 'agent', id: 'scribe', key: null, title: 'scribe', snippet: null, at: null }] }),
      'tasks.link': () => ({ task: t }),
      'tasks.unlink': () => ({ task: t }),
    })
    render(<MemoryRouter><TaskPanel taskId="t-1" intent={null} onClose={() => {}} onChanged={() => {}}
      onGone={() => {}} toast={() => {}} /></MemoryRouter>)
    // A doc's link opens it in the editor, like everywhere else.
    expect((await screen.findByRole('link', { name: 'DOC-1Refund spec' })).getAttribute('href')).toBe('/docs/edit/doc-1')

    await u.click(screen.getByRole('button', { name: 'Link to…' }))
    await u.selectOptions(screen.getByRole('combobox', { name: 'How it relates' }), 'depends')
    await u.type(screen.getByRole('textbox', { name: 'Find what to link' }), 'two')
    const matches = await screen.findByRole('list', { name: 'Matches' })
    // Only objects, and never the task itself.
    expect(matches.textContent).toBe('DASH-1Two warehouses')
    await u.click(screen.getByRole('button', { name: 'DASH-1Two warehouses' }))
    await waitFor(() => expect(sent(calls, 'tasks.link')[0]).toMatchObject(
      { task_id: 't-1', object_id: 'dash-1', rel: 'depends' }))

    await u.click(screen.getByRole('button', { name: 'Remove the link to DOC-1' }))
    await waitFor(() => expect(sent(calls, 'tasks.unlink')[0]).toMatchObject(
      { task_id: 't-1', object_id: 'doc-1', rel: 'caused' }))
  })
})
