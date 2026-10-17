/**
 * Signing in, as the page offers it.
 *
 * Defended: where single sign-on is set up, the page offers the company
 * account and sends the person to the gateway to start it; a sign-in link's
 * code is traded for a session cookie (credentials included), not kept; a
 * single sign-on that came back refused says why in words; a token for the
 * CLI is shown once, and only after it is made.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SignIn } from '../SignIn'
import { TokensView } from '../Tokens'
import { forgetWhoAmI, sessionToken } from '../../data/gateway'

type Call = { url: string; init?: RequestInit }

function gateway(methods: object, answers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const out = path === '/auth/config' ? { methods }
      : path === '/auth/redeem' ? { id: 'rhea', display: 'Rhea' }
      : answers[path] ?? {}
    return { ok: true, status: 200, json: async () => out } as Response
  }))
  return calls
}
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); localStorage.clear(); forgetWhoAmI()
  window.history.replaceState(null, '', '/')
})

const page = () => render(<MemoryRouter initialEntries={['/signin']}><Routes>
  <Route path="/signin" element={<SignIn />} /><Route path="/" element={<p>the workspace</p>} />
</Routes></MemoryRouter>)

describe('signing in', () => {
  it('offers the company account where single sign-on is set up', async () => {
    gateway({ google: false, sso: { name: 'Okta' }, email: false, proxy: false, code: false })
    page()
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, hash: '', search: '' })
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue with Okta' }))
    expect(assign.mock.calls[0][0]).toMatch(/\/auth\/sso\/start\?provider=sso&return_to=%2F$/)
  })

  it('trades a sign-in link for a session, and keeps no credential in the page', async () => {
    const calls = gateway({ google: false, sso: null, email: false, proxy: false, code: true })
    window.history.replaceState(null, '', '/signin#code=ehc_once')
    page()
    expect(await screen.findByText('the workspace')).toBeTruthy()
    const redeem = calls.find(c => c.url.endsWith('/auth/redeem'))!
    expect(JSON.parse(String(redeem.init?.body))).toEqual({ code: 'ehc_once' })
    expect(redeem.init?.credentials).toBe('include')
    expect(localStorage.getItem('commonindex.token')).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('says why a single sign-on came back refused', async () => {
    gateway({ google: false, sso: { name: 'Okta' }, email: false, proxy: false, code: false })
    window.history.replaceState(null, '', '/signin?error=not_invited')
    page()
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t in this workspace yet/)
  })

  it('still takes a token, for a workspace that has one', async () => {
    gateway({ google: false, sso: null, email: false, proxy: false, code: true }, { '/api/v1/actors.me': { id: 'alex', display: 'Alex' } })
    window.history.replaceState(null, '', '/signin#token=ci_dev')
    page()
    expect(await screen.findByText('the workspace')).toBeTruthy()
    await waitFor(() => expect(sessionToken()).toBe('ci_dev'))
  })
})

describe('signing in like other tools', () => {
  it('offers Google and email, with an “or” between', async () => {
    gateway({ google: true, sso: null, email: true, proxy: false, code: false })
    page()
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy()
    expect(screen.getByText('or')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy()
    expect(screen.queryByLabelText('Sign-in link')).toBeNull()       // tucked away, not offered first
  })

  it('sends a code to the email, then signs in with it', async () => {
    const u = userEvent.setup()
    const calls = gateway({ google: false, sso: null, email: true, proxy: false, code: false }, {
      '/auth/email/start': { sent: true, email: 'maya@example.test', minutes: 10 },
      '/auth/email/verify': { id: 'maya', display: 'Maya' },
    })
    page()
    await u.type(await screen.findByRole('textbox', { name: 'Email' }), 'maya@example.test')
    await u.click(screen.getByRole('button', { name: 'Continue with email' }))
    expect(await screen.findByText('Check your email')).toBeTruthy()
    await u.type(screen.getByLabelText('6-digit code'), '12a3456')     // digits only
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('the workspace')).toBeTruthy()
    const verify = calls.find(c => c.url.endsWith('/auth/email/verify'))!
    expect(JSON.parse(String(verify.init?.body))).toEqual({ email: 'maya@example.test', code: '123456' })
    expect(verify.init?.credentials).toBe('include')
  })

  it('signs in from the link in the email', async () => {
    const calls = gateway({ google: false, sso: null, email: true, proxy: false, code: false },
      { '/auth/email/verify': { id: 'maya', display: 'Maya' } })
    window.history.replaceState(null, '', '/signin#email=ehe_once')
    page()
    expect(await screen.findByText('the workspace')).toBeTruthy()
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/auth/email/verify'))!.init?.body))).toEqual({ link: 'ehe_once' })
  })
})

describe('tokens for CLI and MCP', () => {
  it('shows a new token once, and lists it', async () => {
    const u = userEvent.setup()
    let made = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      const out = path === '/api/v1/tokens.create'
        ? (made = true, { id: 'tok-1', label: 'Laptop CLI', token: 'ci_secret', expires_at: '2027-01-01T00:00:00Z' })
        : path === '/api/v1/tokens.list'
          ? { tokens: made ? [{ id: 'tok-1', label: 'Laptop CLI', created_at: '2026-10-03T00:00:00Z', last_used: null, expires_at: '2027-01-01T00:00:00Z' }] : [] }
          : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    render(<MemoryRouter><TokensView /></MemoryRouter>)
    expect(await screen.findByText('No tokens yet.')).toBeTruthy()
    await u.type(screen.getByRole('textbox', { name: 'What it’s for' }), 'Laptop CLI')
    await u.click(screen.getByRole('button', { name: 'Make token' }))
    expect(await screen.findByText('ci_secret')).toBeTruthy()
    expect(await screen.findByRole('list', { name: 'Your tokens' })).toBeTruthy()
  })
})
