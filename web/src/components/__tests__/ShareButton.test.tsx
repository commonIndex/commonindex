/**
 * Sharing one item. Owners add workspace members by email, change roles and
 * who can see it; anyone who can see it sees who else can, and a refusal is
 * said where it was made.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShareButton } from '../ShareButton'

const OWNER = { id: 'alex', name: 'Alex', email: 'alex@example.com', kind: 'human', role: 'owner' }

function gateway(you: 'manage' | 'view') {
  const calls: { op: string; body: Record<string, unknown> }[] = []
  let people = [OWNER]
  let visibility = 'private'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    if (op === 'items.share' && body.email === 'stranger@example.com') {
      return { ok: false, status: 422, json: async () => ({ error: {
        code: 'not_a_member', message: 'stranger@example.com is not in this workspace', field: 'email' } }) } as Response
    }
    if (op === 'items.share') people = [...people, { id: 'maya', name: 'Maya', email: body.email, kind: 'human', role: body.role }]
    if (op === 'items.set_visibility') visibility = body.visibility
    const out = op === 'items.access' ? { id: 'doc-1', type: 'doc', title: 'Runbook', visibility, you, people,
        general: visibility === 'workspace' ? 'view' : null }
      : op === 'actors.me' ? { id: 'alex', display: 'Alex', kind: 'human', space: 'pay', may: ['admin'] }
      : op === 'people.list' ? { people: [{ id: 'maya', display: 'Maya', email: 'maya@example.com', agents_owned: 0 }] }
      : { people }
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('sharing an item', () => {
  it('lets an owner add a member by email, and open it to the workspace', async () => {
    const u = userEvent.setup()
    const calls = gateway('manage')
    render(<ShareButton id="doc-1" title="Runbook" />)
    await u.click(screen.getByRole('button', { name: /Share/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Share Runbook' })
    await u.type(await within(dialog).findByRole('combobox', { name: 'Email of a workspace member' }), 'maya@example.com')
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Access to give' }), 'edit')
    await u.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(within(dialog).getByText('Maya')).toBeTruthy())
    expect(calls.find(c => c.op === 'items.share')!.body).toMatchObject({ id: 'doc-1', email: 'maya@example.com', role: 'edit' })
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Who can open this' }), 'workspace')
    await waitFor(() => expect(calls.some(c => c.op === 'items.set_visibility' && c.body.visibility === 'workspace')).toBe(true))
  })

  it('says why a share was refused', async () => {
    const u = userEvent.setup()
    gateway('manage')
    render(<ShareButton id="doc-1" title="Runbook" />)
    await u.click(screen.getByRole('button', { name: /Share/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Share Runbook' })
    await u.type(await within(dialog).findByRole('combobox', { name: 'Email of a workspace member' }), 'stranger@example.com')
    await u.click(within(dialog).getByRole('button', { name: 'Share' }))
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/not in this workspace/)
  })

  it('shows a non-owner who has access, and nothing to change it with', async () => {
    const u = userEvent.setup()
    gateway('view')
    render(<ShareButton id="doc-1" title="Runbook" />)
    await u.click(screen.getByRole('button', { name: /Share/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Share Runbook' })
    await waitFor(() => expect(within(dialog).getByText('Alex')).toBeTruthy())
    expect(within(dialog).queryByRole('combobox', { name: 'Email of a workspace member' })).toBeNull()
    expect(within(dialog).getByText(/Only its owners can change who has access/)).toBeTruthy()
  })
})
