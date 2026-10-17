/**
 * The Sign-in settings page.
 *
 * Defended: an admin switches to no sign-in on this computer, after saying so
 * deliberately; a setting the deployment fixed can't be changed here; a way
 * in that is off says which settings turn it on, and Google's shows the
 * redirect URL to give it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import { SignInSettingsView } from '../SignInSettings'

const OFF = { on: false, settings: ['X_ONE', 'X_TWO'] }
const SETTINGS = {
  mode: 'required', as: null, as_name: null, locked: false, this_computer: true,
  redirect_url: 'http://localhost:8000/auth/sso/callback', public_url: 'http://localhost:5173', join_domains: [],
  methods: { google: { on: false, settings: ['COMMONINDEX_GOOGLE_CLIENT_ID', 'COMMONINDEX_GOOGLE_CLIENT_SECRET'] }, sso: OFF,
             email: { on: true, log_only: true, settings: [] }, proxy: OFF, link: { on: false } },
}

function gateway(settings: object = SETTINGS) {
  const calls: { op: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ op, body })
    const out = op === 'signin.set_mode' ? { ...settings, mode: body.mode, as: 'alex', as_name: 'Alex' } : settings
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('switches to no sign-in on this computer, once confirmed', async () => {
  const u = userEvent.setup()
  const calls = gateway()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<MemoryRouter><SignInSettingsView /></MemoryRouter>)
  await u.click(await screen.findByRole('radio', { name: /No sign-in on this computer/ }))
  expect(calls.find(c => c.op === 'signin.set_mode')!.body).toMatchObject({ mode: 'local' })
  expect(await screen.findByText(/This computer is signed in as/)).toBeTruthy()
})

it('leaves a mode the deployment fixed alone', async () => {
  gateway({ ...SETTINGS, locked: true })
  render(<MemoryRouter><SignInSettingsView /></MemoryRouter>)
  expect((await screen.findByRole('radio', { name: /No sign-in on this computer/ })).matches(':disabled')).toBe(true)
  expect(screen.getByText(/Set by this deployment/)).toBeTruthy()
})

it('says how to turn Google on, and the redirect URL to give it', async () => {
  gateway()
  render(<MemoryRouter><SignInSettingsView /></MemoryRouter>)
  expect(await screen.findByText('COMMONINDEX_GOOGLE_CLIENT_ID')).toBeTruthy()
  expect(screen.getAllByText('http://localhost:8000/auth/sso/callback').length).toBeGreaterThan(0)
  expect(screen.getByText(/written to the server log/)).toBeTruthy()
})
