import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesignReviewBar } from '../DesignReviewBar'
import type { DesignReview, WireDesign } from '../../data/gateway'

const DESIGN = { id: 'd1', title: 'Checkout', surface: 'mobile', state: 'draft', current_rev: 4,
  cites: [], spec: { screens: [] } } as unknown as WireDesign

const you = (over: Partial<DesignReview['you']> = {}): DesignReview['you'] => ({
  id: 'alex', made_this: false, may_request: false, may_approve: false,
  may_self_approve: false, may_request_changes: false, ...over,
})

let status: DesignReview
let calls: { op: string; body: Record<string, unknown> }[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ op, body })
    const out = op === 'designs.review' ? status : { state: 'review', rev: 5 }
    return { ok: true, status: 200, json: async () => out } as Response
  }))
})
afterEach(() => vi.unstubAllGlobals())

function mount(over: Partial<DesignReview> = {}, blocked: string | null = null) {
  status = { design_id: 'd1', state: 'draft', rev: 4, review: null, contributors: [],
    names: { maya: 'Maya', rhea: 'Rhea' }, you: you(), ...over }
  const onChanged = vi.fn(async () => {})
  render(<DesignReviewBar design={DESIGN} blocked={blocked} onChanged={onChanged} />)
  return onChanged
}

const sent = (op: string) => calls.filter(c => c.op === op)

describe('the review bar', () => {
  it('sends a draft for review at the revision on screen', async () => {
    const u = userEvent.setup()
    const onChanged = mount({ you: you({ may_request: true, made_this: true }) })
    await u.click(await screen.findByRole('button', { name: /Request review/ }))
    await u.type(screen.getByLabelText('Send for review — note'), 'look at the empty state')
    await u.click(screen.getByRole('button', { name: 'Send for review' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(sent('designs.request_review')[0].body).toMatchObject(
      { design_id: 'd1', if_rev: 4, note: 'look at the empty state' })
  })

  it('offers Approve only when the gateway says this viewer may', async () => {
    const u = userEvent.setup()
    mount({ state: 'review', review: { requested_by: 'maya' },
      you: you({ may_approve: true, may_request_changes: true }) })
    expect(await screen.findByText(/asked by Maya/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: /^Approve/ }))
    await u.click(screen.getByRole('button', { name: 'Approve rev 4' }))
    await waitFor(() => expect(sent('designs.approve')).toHaveLength(1))
    expect(sent('designs.approve')[0].body).toMatchObject({ if_rev: 4 })
    expect(sent('designs.approve')[0].body.self_approve).toBeUndefined()
  })

  it('tells the author why they cannot approve their own, instead of a button that fails', async () => {
    mount({ state: 'review', review: { requested_by: 'alex' }, you: you({ made_this: true }) })
    expect(await screen.findByText(/someone else with approve access reviews it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
  })

  it('makes an admin say why before approving their own', async () => {
    const u = userEvent.setup()
    mount({ state: 'review', you: you({ made_this: true, may_self_approve: true }) })
    await u.click(await screen.findByRole('button', { name: /Approve my own/ }))
    const go = screen.getByRole('button', { name: 'Self-approve' })
    expect(go).toHaveProperty('disabled', true)
    await u.type(screen.getByLabelText('Self-approve — reason'), 'solo team this sprint')
    await u.click(go)
    await waitFor(() => expect(sent('designs.approve')).toHaveLength(1))
    expect(sent('designs.approve')[0].body).toMatchObject(
      { self_approve: true, note: 'solo team this sprint', if_rev: 4 })
  })

  it('will not send changes back without saying what', async () => {
    const u = userEvent.setup()
    mount({ state: 'review', you: you({ may_approve: true, may_request_changes: true }) })
    await u.click(await screen.findByRole('button', { name: /Request changes/ }))
    expect(screen.getByRole('button', { name: 'Send back' })).toHaveProperty('disabled', true)
    await u.type(screen.getByLabelText('Send back — reason'), 'CTA is too quiet')
    await u.click(screen.getByRole('button', { name: 'Send back' }))
    await waitFor(() => expect(sent('designs.request_changes')[0]?.body)
      .toMatchObject({ note: 'CTA is too quiet' }))
  })

  it('waits for unsaved edits, because review covers what is saved', async () => {
    mount({ you: you({ may_request: true }) }, 'Save or discard your changes first.')
    expect(await screen.findByRole('button', { name: /Request review/ })).toHaveProperty('disabled', true)
    // On the bar's one line, not a row of its own: a row that came and went
    // with every unsaved edit moved the whole canvas under the pointer.
    expect(screen.getByText(/Save or discard your changes first\./).closest('.dreview-line')).toBeTruthy()
  })

  it('says who approved it, and that editing reopens it', async () => {
    mount({ state: 'approved', review: { decided_by: 'rhea', decision: 'approved', self_approved: false } })
    expect(await screen.findByText(/Approved by Rhea/)).toBeTruthy()
    expect(screen.getByText(/Editing it returns it to draft/)).toBeTruthy()
  })

  it('shows the reason changes were asked for', async () => {
    mount({ state: 'draft', review: { decision: 'changes_requested', decided_by: 'rhea',
      decision_note: 'CTA is too quiet' }, you: you({ may_request: true }) })
    expect(await screen.findByText(/Changes requested by Rhea/)).toBeTruthy()
    expect(screen.getByText('CTA is too quiet')).toBeTruthy()
  })
})
