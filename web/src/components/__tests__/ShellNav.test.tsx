/**
 * The sidebar on a phone. Below 700px it is hidden, and nothing brought it
 * back: another page could be reached only through search. The menu button
 * opens it as a drawer, and picking a page closes it again.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import { Shell } from '../Shell'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens the sidebar from the menu button, and closes it on a page picked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response))
  const u = userEvent.setup()
  const router = createMemoryRouter([{ path: '/', element: <Shell />, children: [
    { path: 'board', element: <p>the board</p> }, { path: 'docs', element: <p>the docs</p> },
  ] }], { initialEntries: ['/board'] })
  render(<RouterProvider router={router} />)
  const menu = screen.getByRole('button', { name: 'Menu' })
  const nav = screen.getByRole('navigation', { name: 'Workspace' })
  expect(menu.getAttribute('aria-expanded')).toBe('false')
  await u.click(menu)
  expect(menu.getAttribute('aria-expanded')).toBe('true')
  expect(nav.className).toMatch(/\bopen\b/)
  await u.click(screen.getByRole('link', { name: /Docs/ }))
  expect(await screen.findByText('the docs')).toBeTruthy()
  expect(nav.className).not.toMatch(/\bopen\b/)
})

it('shows Members only to a workspace admin', async () => {
  const shell = (role: string) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const out = String(url).endsWith('/members.list') ? { members: [], you: { id: 'me', role } } : {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    const router = createMemoryRouter([{ path: '/', element: <Shell />, children: [
      { path: 'board', element: <p>the board</p> },
    ] }], { initialEntries: ['/board'] })
    return render(<RouterProvider router={router} />)
  }
  shell('admin')
  expect(await screen.findByRole('link', { name: /Members/ })).toBeTruthy()
  cleanup()
  shell('contributor')
  await screen.findByText('the board')
  await new Promise(r => setTimeout(r, 20))
  expect(screen.queryByRole('link', { name: /Members/ })).toBeNull()
})
