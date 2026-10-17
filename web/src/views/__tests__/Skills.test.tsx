/**
 * A skill's page, as a place to talk.
 *
 * Skills are not stored by the gateway, so a conversation about one has to say
 * what the skill is — its name as the page shows it — or a notification about
 * it would name nothing. What is defended: the page has its comments, and they
 * are about this skill, by the name on the page.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillDetail } from '../Skills'
import { forgetLiveSkills } from '../../data/api'
import { forgetMentionables } from '../../components/discussion/mentions'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a skill', () => {
  it('can be talked about, under the name its page shows', async () => {
    const u = userEvent.setup()
    // The workspace's own skill: the generated warehouse context.
    const skill = { id: 'skill-warehouse-context', key: 'SK-CTX', name: 'warehouse-context' }
    forgetMentionables(); forgetLiveSkills()
    const listed: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const op = String(url).split('/api/v1/')[1]
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (op === 'messages.list') listed.push(body)
      const out = op === 'messages.list'
        ? { subject: { id: skill.id, ...body.subject }, messages: [], waiting: {} }
        : op === 'messages.counts' ? { counts: {} }
        : op === 'context.skill' ? { name: skill.name, generated: 'now', files: { 'SKILL.md': '# Warehouse context' } }
        : op === 'dashboards.list' ? { dashboards: [] }
        : op === 'metrics.list' ? { metrics: [] } : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    render(<MemoryRouter initialEntries={[`/skills/${skill.id}`]}>
      <Routes><Route path="/skills/:id" element={<SkillDetail />} /></Routes></MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: 'Comments' }))
    expect(screen.getByRole('dialog', { name: `Comments on ${skill.name}` })).toBeTruthy()
    await waitFor(() => expect(listed[0]).toEqual({
      subject_id: skill.id, subject: { type: 'skill', title: skill.name, key: skill.key } }))
  })
})
