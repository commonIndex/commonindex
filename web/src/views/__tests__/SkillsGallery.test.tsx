import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillsView } from '../Skills'
import { forgetLiveSkills } from '../../data/api'

beforeEach(() => { forgetLiveSkills() })
afterEach(() => { cleanup(); forgetLiveSkills(); vi.unstubAllGlobals() })

function gateway(failing = () => false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (failing()) throw new Error('offline')
    const op = String(url).split('/api/v1/')[1]
    const out = op === 'context.skill' ? { name: 'warehouse-context', files: { 'SKILL.md': '# Context' }, generated: 'now' }
      : op === 'dashboards.list' ? { dashboards: [] } : { metrics: [] }
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  render(<MemoryRouter><SkillsView /></MemoryRouter>)
}

it('uses human-readable titles, offers search, and no status filters until skills have statuses', async () => {
  gateway()
  await screen.findByRole('heading', { name: 'What this warehouse holds and what its numbers mean' })
  // The one skill is generated: Installed / Available / Proposed would filter nothing.
  expect(screen.queryByRole('button', { name: 'Filters' })).toBeNull()
  expect(screen.queryByLabelText('Skill status')).toBeNull()
  await userEvent.type(screen.getByLabelText('Search skills'), 'nothing like it')
  await screen.findByText('No skills match')
  await userEvent.click(screen.getAllByRole('button', { name: /Clear|Show all skills/ })[0])
  await screen.findByRole('link', { name: 'Open skill warehouse-context' })
})

it('retries a failed registry read instead of caching an empty collection', async () => {
  let fail = true
  gateway(() => fail)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText('No skills yet')).toBeNull()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('link', { name: 'Open skill warehouse-context' })
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
