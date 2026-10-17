/**
 * Projects: a tag with a page.
 *
 * Defended: the list shows how far each project has got and hides what is
 * archived until asked; a project's page lays its tasks out by state, lists
 * every other kind of work, counts what is not shared with you without naming
 * it, and takes an item out on ×; the chip picker files an item into a
 * project, or names a new one and files it there.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectChips } from '../../components/ProjectChips'
import { ProjectDetail, ProjectsView } from '../Projects'

type Call = { op: string; body: Record<string, unknown> }

const MIGRATION = { id: 'project-1', key: 'PRO-1', title: 'Legacy billing → new services', color: 'violet',
  status: 'active', description: 'Move billing off the monolith.', items: 5, tasks: { total: 4, done: 1 }, updated_at: '2026-10-11T10:00:00Z',
  kinds: { task: 4, doc: 1 }, recent: [{ id: 'doc-1', type: 'doc', key: 'DOC-1', title: 'Cut-over plan' }] }
const OLD = { ...MIGRATION, id: 'project-2', key: 'PRO-2', title: 'Old rewrite', status: 'archived', items: 1, tasks: { total: 0, done: 0 } }
const CONTENTS = {
  project: MIGRATION,
  items: {
    task: [
      { id: 't-1', type: 'task', key: 'T-1', title: 'Move invoices', status: 'ready', updated_at: '', assignee: { id: 'rhea', name: 'Rhea', kind: 'human' } },
      { id: 't-2', type: 'task', key: 'T-2', title: 'Move refunds', status: 'flight', updated_at: '', assignee: null },
      { id: 't-3', type: 'task', key: 'T-3', title: 'Move payouts', status: 'done', updated_at: '', assignee: null },
    ],
    doc: [{ id: 'doc-1', type: 'doc', key: 'DOC-1', title: 'Cut-over plan', status: 'fresh', updated_at: '' }],
  },
  tasks: { ready: 1, flight: 1, review: 0, done: 2, total: 4 },
  hidden: 1,
}

function fake(answers: Record<string, (b: Record<string, unknown>) => unknown>) {
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

describe('the projects list', () => {
  it('shows how far each active project has got, and the archived ones only when asked', async () => {
    const u = userEvent.setup()
    fake({ 'projects.list': () => ({ projects: [MIGRATION, OLD], total: 2 }) })
    render(<MemoryRouter><ProjectsView /></MemoryRouter>)
    const title = await screen.findByRole('link', { name: /Legacy billing/ })
    const card = title.closest('li') as HTMLElement
    expect(within(card).getByRole('img', { name: '1 of 4 tasks done' })).toBeTruthy()
    expect(within(card).getByText('4 tasks')).toBeTruthy()
    expect(within(card).getByText('1 doc')).toBeTruthy()
    // What is in it is named on the card — the doc, a link of its own.
    expect(within(card).getByRole('link', { name: /Cut-over plan/ }).getAttribute('href')).toBe('/docs/edit/doc-1')
    expect(screen.queryByRole('link', { name: /Old rewrite/ })).toBeNull()
    await u.click(screen.getByRole('tab', { name: /Archived/ }))
    expect(screen.getByRole('link', { name: /Old rewrite/ })).toBeTruthy()
  })
})

describe("a project's page", () => {
  it('lays tasks out by state, lists the rest, and counts what you cannot see without naming it', async () => {
    const u = userEvent.setup()
    const calls = fake({ 'projects.items': () => CONTENTS, 'projects.untag': () => ({ tagged: false, already: false }) })
    render(<MemoryRouter initialEntries={['/projects/project-1']}><Routes>
      <Route path="/projects/:id" element={<ProjectDetail />} /></Routes></MemoryRouter>)
    await screen.findByRole('heading', { name: /Legacy billing/ })
    expect(within(screen.getByLabelText('Ready')).getByText('Move invoices')).toBeTruthy()
    expect(within(screen.getByLabelText('Ready')).getByText('Rhea')).toBeTruthy()
    expect(within(screen.getByLabelText('In progress')).getByText('Move refunds')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Docs' })).getByText('Cut-over plan')).toBeTruthy()
    expect(screen.getByText(/1 more item is in this project but not shared with you/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Remove Cut-over plan from the project' }))
    await waitFor(() => expect(sent(calls, 'projects.untag')).toEqual([expect.objectContaining({ project_id: 'project-1', object_id: 'doc-1' })]))
  })
})

describe('the project chips', () => {
  it('files an item into a project picked by name', async () => {
    const u = userEvent.setup()
    const calls = fake({
      'projects.of': () => ({ projects: { 'doc-1': [] } }),
      'projects.list': () => ({ projects: [MIGRATION], total: 1 }),
      'projects.tag': () => ({ tagged: true, already: false }),
    })
    render(<MemoryRouter><ProjectChips about={{ id: 'doc-1', type: 'doc' }} /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: '+ Project' }))
    await u.click(await screen.findByRole('button', { name: /Legacy billing/ }))
    await waitFor(() => expect(sent(calls, 'projects.tag')).toEqual([expect.objectContaining({ project_id: 'project-1', object_id: 'doc-1' })]))
    expect(screen.getByRole('link', { name: /Legacy billing/ })).toBeTruthy()
  })

  it('names a new project and files the item into it', async () => {
    const u = userEvent.setup()
    const calls = fake({
      'projects.of': () => ({ projects: { 'doc-2': [] } }),
      'projects.list': () => ({ projects: [MIGRATION], total: 1 }),
      'projects.propose': () => ({ id: 'project-9', created: true }),
      'projects.tag': () => ({ tagged: true, already: false }),
    })
    render(<MemoryRouter><ProjectChips about={{ id: 'doc-2', type: 'doc' }} /></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: '+ Project' }))
    await u.type(screen.getByLabelText('Find or name a project'), 'Search revamp')
    await u.click(screen.getByRole('button', { name: /New project “Search revamp”/ }))
    await waitFor(() => expect(sent(calls, 'projects.tag')).toEqual([expect.objectContaining({ project_id: 'project-9', object_id: 'doc-2' })]))
    expect(sent(calls, 'projects.propose')[0]).toMatchObject({ title: 'Search revamp', status: 'active' })
  })
})
