import { afterEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Publish } from '../DocEdit'

afterEach(() => { vi.unstubAllGlobals() })

const LINK = { url: 'http://127.0.0.1:8000/share/tok_abcdefghijklmnopqrstuvwxyz', token: 'tok',
               created_by: 'maya', created_at: '2026-09-26T08:00:00Z' }

function gateway() {
  const calls: string[] = []
  let shared = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = url.split('/').pop()!
    calls.push(name)
    const body = name === 'docs.sharing' ? { doc_id: 'd', link: shared ? LINK : null }
      : name === 'docs.share' ? (shared = true, { doc_id: 'd', link: LINK })
      : name === 'docs.unshare' ? (shared = false, { doc_id: 'd', revoked: 1 })
      : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { calls, writeText }
}

it('creates a link, copies it, and turns it off', async () => {
  const { calls, writeText } = gateway()
  render(<Publish docId="d" />)
  await act(async () => {})

  fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link and copy' })) })

  expect(writeText).toHaveBeenCalledWith(LINK.url)
  expect((screen.getByLabelText('Share link') as HTMLInputElement).value).toBe(LINK.url)
  expect(screen.getByText('Published — anyone with the link can view')).toBeTruthy()

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn off link' })) })
  expect(calls).toEqual(['docs.sharing', 'docs.share', 'docs.unshare'])
  expect(screen.getByRole('button', { name: 'Create link and copy' })).toBeTruthy()
})
