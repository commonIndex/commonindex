/**
 * The gallery cards for docs, skills and agents.
 *
 * Each card's preview is a claim about the thing it shows — a doc's own opening
 * lines, a skill's trigger and grants, an agent's reach — so what is defended
 * here is that the preview says what the record says, and links where the thing
 * actually lives.
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { DocCard } from '../DocCard'
import { SkillCard } from '../SkillCard'
import { AgentGalleryCard } from '../AgentGalleryCard'
import type { Doc, Skill } from '../../data/types'
import type { WireAgent } from '../../data/gateway'

const at = (el: React.ReactElement) => render(<MemoryRouter>{el}</MemoryRouter>)

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: 'doc-7', title: 'Refund request flow RFC', space: 'Payments', owner: 'Maya',
  excerpt: 'Proposes reworking the refund request flow.', freshness: 'fresh', proposals: 0,
  rev: 7, updated: 1, ...over,
})

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: 'sk-1', key: 'SK-109', name: 'doc-drift-sync', title: 'Doc drift sync',
  summary: 'Watch merged PRs for changes that contradict a doc.', source: 'workspace',
  author: 'Alex', agentAuthor: false, status: 'installed', rev: 14, installedOn: ['Scribe'],
  scopes: ['docs:propose', 'code:read'], tools: ['graph.query', 'docs.propose', 'docs.get'],
  triggers: ['a PR merges touching a path a doc cites', 'asked in #docs'], runs7d: 747,
  acceptance: 89, p50: '40s', cost: '$0.02', model: 'small', updated: 0, files: [], body: [],
  ...over,
} as Skill)

const agent = (over: Partial<WireAgent> = {}): WireAgent => ({
  id: 'scribe', display: 'Scribe', trust_tier: 'propose-only', owner: null,
  created_at: new Date().toISOString(), grants: [], may: ['propose'],
  tokens: { count: 1, last_used: null, next_expiry: null }, authored: { doc: 3, task: 2 },
  defined: { metrics: 2, ratified: 1 }, may_ratify_own_work: false, ...over,
})

describe('a doc card', () => {
  it('previews the doc’s own opening lines and opens where it can be read', () => {
    at(<DocCard doc={doc()} />)
    const link = screen.getByRole('link', { name: 'Open doc Refund request flow RFC' })
    expect(link.getAttribute('href')).toBe('/docs/doc-7')
    expect(within(link).getByText('Proposes reworking the refund request flow.')).toBeTruthy()
  })

  it('opens a doc written here in the editor, and says so', () => {
    at(<DocCard doc={doc({ live: true, excerpt: '' })} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/docs/edit/doc-7')
    expect(within(link).getByText('Editable doc')).toBeTruthy()
    expect(within(link).getByText('Empty — open it to start writing.')).toBeTruthy()
  })

  it('marks a stale doc where the eye lands first, and counts proposals', () => {
    at(<DocCard doc={doc({ freshness: 'stale', proposals: 2 })} />)
    expect(screen.getByText('Stale').className).toMatch(/df-stale/)
    expect(screen.getByText('2 proposals to review')).toBeTruthy()
  })
})

describe('a skill card', () => {
  it('shows its shape: the first trigger, tool and scope, and how many more', () => {
    at(<SkillCard skill={skill()} />)
    const card = screen.getByRole('link', { name: 'Open skill doc-drift-sync' })
    expect(within(card).getByText('a PR merges touching a path a doc cites')).toBeTruthy()
    expect(within(card).getByText('graph.query')).toBeTruthy()
    expect(within(card).getByText('+2')).toBeTruthy()     // two more tools
    expect(within(card).getByText('docs:propose')).toBeTruthy()
    // Everything it would be granted, on hover — never hidden entirely.
    expect(within(card).getByTitle('docs:propose, code:read')).toBeTruthy()
    expect(within(card).getByText('89%')).toBeTruthy()
    expect(within(card).getByText('747')).toBeTruthy()
  })

  it('says it has not run here rather than showing 0%', () => {
    at(<SkillCard skill={skill({ acceptance: null, runs7d: 0 })} />)
    expect(screen.getByText('Has not run here yet')).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('shows a generated skill as context any agent reads, with nothing to grant', () => {
    at(<SkillCard skill={skill({ generated: { from: { datasets: 19, definitions: 33, dashboards: 6 }, unratified: 0 } })} />)
    expect(screen.getByText('any agent that asks')).toBeTruthy()
    expect(screen.getByText('19 datasets, 33 definitions, 6 dashboards')).toBeTruthy()
    expect(screen.queryByText('Needs')).toBeNull()
  })
})

describe('an agent card', () => {
  const rungs = () => screen.getAllByText(/^(read|propose|merge|admin)$/)
    .filter(el => el.closest('.agent-ladder'))
    .map(el => `${el.textContent}${el.className.includes('on') ? '+' : ''}`)

  it('shows its grant as how far up the ladder it reaches', () => {
    at(<AgentGalleryCard agent={agent()} />)
    expect(rungs()).toEqual(['read+', 'propose+', 'merge', 'admin'])
    expect(screen.getByRole('img', { name: 'May propose in this space' })).toBeTruthy()
    expect(screen.getByText(/Its work arrives proposed/)).toBeTruthy()
  })

  it('says plainly when it holds nothing here, and when nobody answers for it', () => {
    at(<AgentGalleryCard agent={agent({ may: [] })} />)
    expect(rungs()).toEqual(['read', 'propose', 'merge', 'admin'])
    expect(screen.getByText(/No grant in this space/)).toBeTruthy()
    expect(screen.getByText('nobody answers for this')).toBeTruthy()
  })

  it('reads what it made from the record', () => {
    at(<AgentGalleryCard agent={agent({ owner: { id: 'maya', display: 'Maya', kind: 'human' } })} />)
    expect(screen.getByText('answerable to Maya')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()          // 3 docs + 2 tasks
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.getByText('never')).toBeTruthy()
  })
})
