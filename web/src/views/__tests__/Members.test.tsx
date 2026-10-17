/**
 * Bringing people into the workspace, and signing in.
 *
 * Defended: an admin invites by name, email and role and is shown the
 * sign-in link once; a member who is not an admin is told the page is an
 * admin's and shown no one; and a sign-in link signs its person in and keeps the
 * token for this browser.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MembersView } from '../Members'
import { SignIn } from '../SignIn'
import { forgetWhoAmI, sessionToken, type Member } from '../../data/gateway'

const ALEX: Member = { id: 'alex', name: 'Alex', email: 'alex@example.com', role: 'admin', joined: null, last_seen: null }
const MAYA: Member = { id: 'maya', name: 'Maya', email: 'maya@example.com', role: 'contributor', joined: null, last_seen: '2026-09-28T10:00:00Z' }

function gateway(role: 'admin' | 'viewer', token: string | null = 'ci_secret', extra: (op: string, body: Record<string, unknown>) => unknown = () => undefined) {
  const calls: { op: string; body: Record<string, unknown>; auth: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body, auth: String((init?.headers as Record<string, string>)?.authorization ?? '') })
    if (op === 'members.list' && role !== 'admin') {
      return { ok: false, status: 403, json: async () => ({ error: { code: 'denied', message: 'needs admin' } }) } as Response
    }
    const custom = await extra(op, body)
    const out = custom ?? (op === 'members.list' ? { members: [ALEX], you: { id: 'alex', role } }
      : op === 'members.invite' ? { person_id: 'rhea', name: body.name, email: body.email, role: body.role, token }
      : op === 'actors.me' ? { id: 'rhea', display: 'Rhea', kind: 'human', space: 'pay', may: ['propose'] }
      : {})
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); forgetWhoAmI() })

const page = () => render(<MemoryRouter><MembersView /></MemoryRouter>)

describe('members', () => {
  it('lets an admin invite someone and shows the sign-in link once', async () => {
    const u = userEvent.setup()
    const calls = gateway('admin')
    page()
    await u.click(await screen.findByRole('button', { name: '+ Invite people' }))
    const dialog = screen.getByRole('dialog', { name: 'Invite people' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Rhea Kapoor')
    await u.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'rhea@example.test')
    await u.click(within(dialog).getByRole('radio', { name: /Reviewer/ }))
    await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
    const link = await screen.findByRole('dialog', { name: 'Rhea Kapoor has access' })
    expect((within(link).getByRole('textbox', { name: 'Private sign-in link' }) as HTMLInputElement).value).toMatch(/\/signin#token=ci_secret$/)
    expect(within(link).getByText(/No email was sent/)).toBeTruthy()
    expect(calls.find(c => c.op === 'members.invite')!.body).toMatchObject({ name: 'Rhea Kapoor', email: 'rhea@example.test', role: 'reviewer' })
    await u.click(within(link).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('textbox', { name: 'Private sign-in link' })).toBeNull()
  })

  it('shows no link for someone who already has a sign-in', async () => {
    const u = userEvent.setup()
    const calls = gateway('admin', null)
    page()
    await u.click(await screen.findByRole('button', { name: '+ Invite people' }))
    const dialog = screen.getByRole('dialog', { name: 'Invite people' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Maya')
    await u.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'maya@example.test')
    await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite people' })).toBeNull())
    expect(calls.some(c => c.op === 'members.invite')).toBe(true)
    const result = await screen.findByRole('dialog', { name: 'Maya has access' })
    expect(within(result).getByText('They can use their existing sign-in.')).toBeTruthy()
    expect(within(result).queryByRole('textbox', { name: 'Private sign-in link' })).toBeNull()
  })

  it('tells a member who is not an admin that the page is for admins, and shows no one', async () => {
    gateway('viewer')
    page()
    expect(await screen.findByText(/Only workspace admins can see and manage members/)).toBeTruthy()
    expect(screen.queryByText('Alex')).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Invite people' })).toBeNull()
  })
})

describe('signing in', () => {
  it('signs in from the invitation link and keeps the token for this browser', async () => {
    const calls = gateway('viewer')
    window.location.hash = '#token=ci_rhea'
    render(<MemoryRouter initialEntries={['/signin']}><Routes>
      <Route path="/signin" element={<SignIn />} /><Route path="/" element={<p>the workspace</p>} />
    </Routes></MemoryRouter>)
    expect(await screen.findByText('the workspace')).toBeTruthy()
    await waitFor(() => expect(sessionToken()).toBe('ci_rhea'))
    expect(calls.find(c => c.op === 'actors.me')!.auth).toBe('Bearer ci_rhea')
  })
})

const memberList = (members = [ALEX, MAYA]) => ({ members, you: { id: 'alex', role: 'admin' } })
async function openInvite(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole('button', { name: '+ Invite people' }))
  return screen.getByRole('dialog', { name: 'Invite people' })
}
async function fillInvite(u: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Rhea Kapoor')
  await u.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'rhea@example.test')
}

it('filters the directory by email, role, and recorded activity without changing access', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin', null, op => op === 'members.list' ? memberList() : undefined)
  page()
  const table = await screen.findByRole('table', { name: 'Members' })
  expect(within(table).getAllByRole('row')).toHaveLength(3)
  await u.type(screen.getByRole('searchbox', { name: 'Search members' }), 'MAYA@EXAMPLE')
  expect(within(table).getAllByRole('row')).toHaveLength(2)
  expect(within(table).queryByText('Alex')).toBeNull()
  await u.selectOptions(screen.getByRole('combobox', { name: 'Filter by role' }), 'admin')
  expect(screen.getByText('No matching members')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Show all members' }))
  await u.click(screen.getByRole('button', { name: 'Not signed in 1' }))
  expect(within(screen.getByRole('table')).queryByText('Maya')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('1 of 2 members')
  expect(calls.every(c => c.op === 'members.list')).toBe(true)
})

it('validates required fields, malformed addresses, and duplicate members before submitting', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin')
  page()
  const dialog = await openInvite(u)
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  const name = within(dialog).getByRole('textbox', { name: 'Name' })
  const email = within(dialog).getByRole('textbox', { name: 'Email' })
  expect(document.activeElement).toBe(name)
  expect(name.getAttribute('aria-invalid')).toBe('true')
  await u.type(name, 'Another Alex')
  await u.type(email, 'not-an-email')
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  expect(document.activeElement).toBe(email)
  expect(within(dialog).getByRole('alert').textContent).toContain('Enter a valid email')
  await u.clear(email)
  await u.type(email, 'ALEX@example.com')
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  expect(within(dialog).getByRole('alert').textContent).toContain('already a workspace member')
  expect(calls.some(c => c.op === 'members.invite')).toBe(false)
})

it('contains keyboard focus and returns it to the invite button on cancellation', async () => {
  const u = userEvent.setup()
  gateway('admin')
  const { container } = page()
  const trigger = await screen.findByRole('button', { name: '+ Invite people' })
  const dialog = await openInvite(u)
  expect(container.getAttribute('aria-hidden')).toBe('true')
  expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }))
  const close = within(dialog).getByRole('button', { name: 'Close' })
  close.focus()
  expect(document.activeElement).toBe(close)
  await u.tab({ shift: true })
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Add member' }))
  await u.tab()
  expect(document.activeElement).toBe(close)
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(container.hasAttribute('aria-hidden')).toBe(false)
})

it('prevents duplicate invites and keeps the dialog open while access is being created', async () => {
  const u = userEvent.setup()
  let finish!: (value: unknown) => void
  const calls = gateway('admin', 'ci_secret', op => op === 'members.invite' ? new Promise(resolve => { finish = resolve }) : undefined)
  page()
  const dialog = await openInvite(u)
  await fillInvite(u, dialog)
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  fireEvent.submit(dialog)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  fireEvent.click(dialog.parentElement!)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('textbox', { name: 'Name' }).matches(':disabled')).toBe(true)
  expect(within(dialog).getByRole('button', { name: 'Close' }).matches(':disabled')).toBe(true)
  expect(calls.filter(c => c.op === 'members.invite')).toHaveLength(1)
  await act(async () => finish({ name: 'Rhea Kapoor', email: 'rhea@example.test', role: 'contributor', token: 'ci_test' }))
  expect(await screen.findByRole('dialog', { name: 'Rhea Kapoor has access' })).toBeTruthy()
})

it('keeps invitation inputs after a request fails and supports retrying', async () => {
  const u = userEvent.setup()
  let fail = true
  gateway('admin', 'ci_test', op => { if (op === 'members.invite' && fail) throw new Error('Connection lost'); return undefined })
  page()
  const dialog = await openInvite(u)
  await fillInvite(u, dialog)
  await u.click(within(dialog).getByRole('radio', { name: 'Reviewer' }))
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('Connection lost')
  expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Rhea Kapoor')
  expect((within(dialog).getByRole('radio', { name: 'Reviewer' }) as HTMLInputElement).checked).toBe(true)
  fail = false
  await u.click(within(dialog).getByRole('button', { name: 'Add member' }))
  await screen.findByRole('dialog', { name: 'Rhea Kapoor has access' })
})

it('copies a one-time link and selects it for manual copy if the clipboard fails', async () => {
  const u = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce()
  gateway('admin')
  page()
  const invite = await openInvite(u)
  await fillInvite(u, invite)
  await u.click(within(invite).getByRole('button', { name: 'Add member' }))
  const dialog = await screen.findByRole('dialog', { name: 'Rhea Kapoor has access' })
  await u.keyboard('{Escape}')
  fireEvent.click(dialog.parentElement!)
  expect(screen.getByRole('dialog')).toBe(dialog)
  await u.click(within(dialog).getByRole('button', { name: 'Copy link' }))
  const field = within(dialog).getByRole('textbox', { name: 'Private sign-in link' }) as HTMLInputElement
  expect((await within(dialog).findByRole('alert')).textContent).toContain('Couldn’t copy automatically')
  expect(document.activeElement).toBe(field)
  expect(field.selectionStart).toBe(0)
  expect(field.selectionEnd).toBe(field.value.length)
  await u.click(within(dialog).getByRole('button', { name: 'Copy link' }))
  expect((await within(dialog).findByRole('status')).textContent).toContain('Link copied')
  expect(copy).toHaveBeenLastCalledWith(field.value)
  expect(localStorage.length).toBe(0)
})

it('saves role changes only after explicit confirmation', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin', null, (op, body) => op === 'members.list' ? memberList()
    : op === 'members.set_role' ? { members: [ALEX, { ...MAYA, role: body.role }] } : undefined)
  page()
  await u.click(await screen.findByRole('button', { name: 'Manage Maya' }))
  const dialog = screen.getByRole('dialog', { name: 'Manage Maya' })
  await u.click(within(dialog).getByRole('radio', { name: 'Admin' }))
  expect(within(dialog).getByText(/permission to manage workspace access/)).toBeTruthy()
  expect(calls.some(c => c.op === 'members.set_role')).toBe(false)
  await u.click(within(dialog).getByRole('button', { name: 'Save role' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.find(c => c.op === 'members.set_role')?.body).toMatchObject({ person_id: 'maya', role: 'admin' })
  expect(within(screen.getByRole('table')).getAllByText('Admin')).toHaveLength(2)
})

it('protects the last admin and never offers self-removal', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin')
  page()
  await u.click(await screen.findByRole('button', { name: 'Manage Alex' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/only admin/)).toBeTruthy()
  expect(within(dialog).getByRole('radio', { name: 'Viewer' }).matches(':disabled')).toBe(true)
  expect(within(dialog).getByRole('button', { name: 'Save role' }).matches(':disabled')).toBe(true)
  expect(within(dialog).queryByRole('button', { name: /Remove from workspace/ })).toBeNull()
  fireEvent.submit(dialog)
  expect(calls.some(c => c.op === 'members.set_role')).toBe(false)
})

it('requires confirmation before replacing a token and keeps API errors visible', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin', null, op => {
    if (op === 'members.list') return memberList()
    if (op === 'members.new_token') throw new Error('Their sign-in belongs to other workspaces too')
    return undefined
  })
  page()
  await u.click(await screen.findByRole('button', { name: 'Manage Maya' }))
  await u.click(screen.getByRole('button', { name: /Replace sign-in link For a lost link/ }))
  const dialog = screen.getByRole('dialog', { name: 'Replace sign-in link?' })
  expect(within(dialog).getByText(/previous sign-in will stop working/)).toBeTruthy()
  expect(document.activeElement).toBe(dialog)
  expect(calls.some(c => c.op === 'members.new_token')).toBe(false)
  await u.click(within(dialog).getByRole('button', { name: 'Replace sign-in link' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('other workspaces')
  expect(calls.filter(c => c.op === 'members.new_token')).toHaveLength(1)
})

it('requires confirmation for removal and updates the directory afterward', async () => {
  const u = userEvent.setup()
  const calls = gateway('admin', null, op => op === 'members.list' ? memberList()
    : op === 'members.remove' ? { members: [ALEX], items_passed_to_you: 2 } : undefined)
  page()
  await u.click(await screen.findByRole('button', { name: 'Manage Maya' }))
  await u.click(screen.getByRole('button', { name: /Remove from workspace/ }))
  const dialog = screen.getByRole('dialog', { name: 'Remove workspace access?' })
  expect(within(dialog).getByText(/Their work stays/)).toBeTruthy()
  expect(calls.some(c => c.op === 'members.remove')).toBe(false)
  await u.click(within(dialog).getByRole('button', { name: 'Remove member' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(within(screen.getByRole('table')).queryByText('Maya')).toBeNull()
  expect(calls.find(c => c.op === 'members.remove')?.body).toMatchObject({ person_id: 'maya' })
})

it('shows a retryable initial load failure instead of an endless loading state', async () => {
  const u = userEvent.setup()
  let fail = true
  gateway('admin', null, op => { if (op === 'members.list' && fail) throw new Error('Offline'); return undefined })
  page()
  await screen.findByRole('alert')
  expect(screen.queryByText('Loading members…')).toBeNull()
  fail = false
  await u.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('table')).toBeTruthy()
})
