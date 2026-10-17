/**
 * Choosing where the numbers come from.
 *
 * "Write SQL instead" had been moved once already — out of a chip in the
 * filter row, because a primary path was dressed as a filter — and landed as a
 * full-width dashed block under the search box. Dashed borders are how this UI
 * draws empty states and placeholders, so the action still read as a caption:
 * moved, restyled as a different kind of non-action, still unfound.
 *
 * These assert the shape that fixes it rather than the copy: a control that
 * looks like a choice, at the top, before the list — and both options reachable
 * without discovering anything.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardNew } from '../DashboardNew'

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const CONN = {
  id: 'conn-a', name: 'warehouse', kind: 'postgres', dsn: 'postgresql://x/y',
  read_only: true, impersonation: false, checked_at: null, last_error: null,
}
const TABLE = {
  id: 'public.events', physical: 'public.events', is_virtual: false,
  time_column: 'ts', times: ['ts'], grains: ['day'],
  columns: [{ name: 'ts', kind: 'time' }, { name: 'amount', kind: 'number' }],
  measures: ['amount'], slices: ['arm'],
}

function mount() {
  const fetchMock = vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const body = op === 'connections.list' ? { connections: [CONN] }
      : op === 'datasets.introspect' ? { datasets: [TABLE] }
      : {}
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MemoryRouter><DashboardNew /></MemoryRouter>)
  return fetchMock
}

/** Step 2 is where the choice lives, and step 1 is the connection picker. */
async function toTableStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /warehouse/ }))
  await screen.findByRole('button', { name: 'Write SQL' })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('choosing a table or a query', () => {
  it('gives SQL a full source card above search, with its purpose always visible', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    const sources = screen.getByRole('group', { name: 'Source type' })
    expect(within(screen.getByRole('navigation', { name: 'Progress' })).getByText('Source')).toBeTruthy()
    const sql = within(sources).getByRole('button', { name: 'Write SQL' })
    const table = within(sources).getByRole('button', { name: 'Pick a table' })
    expect(sql.className).toBe('dashboard-source-choice')
    expect(table.className).toBe(sql.className)
    expect(sql.hasAttribute('disabled')).toBe(false)
    expect(within(sql).getByText('Join tables, filter rows, or calculate new columns.')).toBeTruthy()
    expect(sql.getAttribute('aria-describedby')).toBe('sql-source-description')
    expect(sources.closest('.coll-tools')).toBeNull()
    expect(sources.compareDocumentPosition(screen.getByRole('searchbox', { name: 'Search tables' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search tables' }).hasAttribute('autofocus')).toBe(false)
  })

  it('lets a keyboard user choose SQL and makes the new selection explicit', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    const table = screen.getByRole('button', { name: 'Pick a table' })
    const sql = screen.getByRole('button', { name: 'Write SQL' })
    table.focus()
    await user.tab()
    expect(document.activeElement).toBe(sql)
    await user.keyboard('{Enter}')
    expect(sql.getAttribute('aria-pressed')).toBe('true')
    expect(table.getAttribute('aria-pressed')).toBe('false')
    expect(await screen.findByPlaceholderText(/select/i)).toBeTruthy()
    expect(screen.queryByRole('searchbox', { name: 'Search tables' })).toBeNull()
  })

  it('shows progress and matching source cards, with a recoverable empty search', async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.getByRole('heading', { name: 'New dashboard' })).toBeTruthy()
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    await toTableStep(user)
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pick a table' }).getAttribute('aria-pressed')).toBe('true')
    await user.type(screen.getByRole('searchbox', { name: 'Search tables' }), 'not-found')
    expect(screen.getByRole('heading', { name: 'No matching tables' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear table search' }))
    expect(await screen.findByText('public.events')).toBeTruthy()
  })

  it('offers a retry when table discovery fails instead of leaving a spinner', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByRole('button', { name: /warehouse/ })
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Discovery unavailable'))
    await user.click(screen.getByRole('button', { name: /warehouse/ }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Discovery unavailable'))
    expect(screen.queryByText('Introspecting…')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry tables' }))
    expect(await screen.findByText('public.events')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers both as a choice, not one as a footnote to the other', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    // Both are buttons in one control. The failing shape was a table list with
    // a block of prose under the search box.
    expect(screen.getByRole('button', { name: 'Pick a table' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Write SQL' })).toBeTruthy()
  })

  it('opens the editor from the choice', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    expect(await screen.findByPlaceholderText(/select/i)).toBeTruthy()
  })

  it('shows the tables only while picking one', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    expect(await screen.findByText('public.events')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    // Two dozen table rows under a SQL editor is a list that answers a question
    // nobody is asking any more.
    await waitFor(() => expect(screen.queryByText('public.events')).toBeNull())
  })

  it('drops the table filter while writing a query', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    expect(screen.getByPlaceholderText('Filter tables…')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    expect(screen.queryByPlaceholderText('Filter tables…')).toBeNull()
  })

  it('says what each choice is for, next to the choice', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    expect(screen.getByText(/discovered by introspection/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    expect(screen.getByText(/no single table has what you need/)).toBeTruthy()
  })

  it('can go back to the tables', async () => {
    const user = userEvent.setup()
    mount()
    await toTableStep(user)
    await user.click(screen.getByRole('button', { name: 'Write SQL' }))
    await user.click(screen.getByRole('button', { name: 'Pick a table' }))
    expect(await screen.findByText('public.events')).toBeTruthy()
  })
})

// ── and adding more than one ───────────────────────────────────────────────

const PREVIEW = {
  expr: 'COUNT(*)', unit: 'count', better: 'up', rows: 5,
  series: [{ name: 'all', points: [['2026-08-01T00:00:00Z', 1]] }],
}

function mountAtBuilder() {
  const scrolled: string[] = []
  Element.prototype.scrollIntoView = function () { scrolled.push(this.className) }
  const fetchMock = vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    const body = op === 'connections.list' ? { connections: [CONN] }
      : op === 'datasets.introspect' ? { datasets: [TABLE] }
      : op === 'panels.preview' ? PREVIEW
      : {}
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MemoryRouter><DashboardNew /></MemoryRouter>)
  return scrolled
}

describe('adding a second panel', () => {
  /** Step 1 → 2 → 3, landing on the panel workbench. */
  async function toBuilder(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /warehouse/ }))
    await user.click(await screen.findByText('public.events'))
    // The button is disabled until the preview lands, and clicking a disabled
    // button is a no-op that leaves the test asserting against an unchanged
    // page. Wait for the thing that enables it.
    await screen.findByText(/This ran against/)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add (this|another) panel/ })
        .hasAttribute('disabled')).toBe(false))
  }

  it('brings the form back into view after adding, so there is somewhere to go', async () => {
    const user = userEvent.setup()
    const scrolled = mountAtBuilder()
    await toBuilder(user)
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))

    // The canvas grows BELOW the form, so without this the form is pushed off
    // the top and the reader is left looking at a finished dashboard and a
    // Create button — with nothing on screen saying a second panel is possible.
    await waitFor(() => expect(scrolled.some(c => c.includes('wiz-panel'))).toBe(true))
  })

  it('says the button adds another once one is staged', async () => {
    const user = userEvent.setup()
    mountAtBuilder()
    await toBuilder(user)
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    expect(await screen.findByRole('button', { name: 'Add another panel' })).toBeTruthy()
  })

  it('offers the way back beside Create, where the reader actually is', async () => {
    const user = userEvent.setup()
    const scrolled = mountAtBuilder()
    await toBuilder(user)
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))

    const again = await screen.findByRole('button', { name: /\+ Add another panel/ })
    scrolled.length = 0
    await user.click(again)
    expect(scrolled.some(c => c.includes('wiz-panel'))).toBe(true)
  })

  it('keeps both panels rather than replacing the first', async () => {
    const user = userEvent.setup()
    mountAtBuilder()
    await toBuilder(user)
    await user.click(screen.getByRole('button', { name: 'Add this panel' }))
    // Adding clears the preview, so the button goes back to disabled until the
    // next one lands. Clicking through that gap adds nothing and the test would
    // have read it as "the second panel replaced the first".
    const another = await screen.findByRole('button', { name: 'Add another panel' })
    await waitFor(() => expect(another.hasAttribute('disabled')).toBe(false))
    await user.click(another)
    expect(await screen.findByRole('button', { name: /Create dashboard with 2 panels/ })).toBeTruthy()
  })
})
