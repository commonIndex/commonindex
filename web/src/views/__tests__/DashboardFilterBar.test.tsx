/**
 * The filter bar, on the page.
 *
 * The server half of this has its own tests and they pass. That was also true
 * of the refresh button, which was absent from the rendered page while its
 * import sat at the top of the file, and of the SQL panel, which was verified
 * against a live warehouse while being unreachable in a browser. So: does the
 * control exist, does using it re-query, and does what comes back reach the
 * page.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDetail } from '../Dashboards'

/** Mutable, so a test can change the route the way navigation would. */
const params = { id: 'dash-board-9f2c1a' }
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => params,
}))
vi.mock('../../components/Shell', () => ({ useToast: () => vi.fn() }))

const ROW = {
  id: 'dash-board-9f2c1a', key: 'DASH-1', title: 'Board', panel_count: 2, certified: true,
  unratified: 0, metrics: ['m.conversion'], owner: 'alex',
  connection_id: 'conn-a', updated_at: null,
}

/** What each column holds, as `columns.values` reports it. */
const COLUMN_VALUES: Record<string, unknown> = {
  arm: { column: 'arm', kind: 'string', from: ['d.wide'], truncated: false,
         min: null, max: null, errors: [],
         values: [{ value: 'control', rows: 4000 }, { value: 'variant', rows: 4000 }] },
  region: { column: 'region', kind: 'string', from: ['d.wide'], truncated: false,
            min: null, max: null, errors: [],
            values: [{ value: 'emea', rows: 88 }, { value: 'amer', rows: 88 },
                     { value: 'apac', rows: 88 }] },
  amount: { column: 'amount', kind: 'number', from: ['d.wide'], truncated: false,
            min: 3.014, max: 29.81, errors: [], values: [] },
}

/** A second dashboard to navigate to. The live list is cached module-side, so
 *  both have to be in the first response. */
const OTHER = { ...ROW, id: 'dash-other-4b1e77', key: 'DASH-2', title: 'Other' }

function chart(id: string, title: string, extra: object = {}) {
  return {
    panel: { id, title, mark: 'line', metric_id: 'm.conversion',
             dataset_id: 'd.wide', grain: 'day' },
    label: title, unit: 'pct', better: 'up',
    series: [{ name: 'all', points: [['2026-08-01T00:00:00Z', 0.1]] }],
    filters_applied: [], filters_skipped: [], ...extra,
  }
}

/** Unfiltered: two healthy panels and two columns to slice by. */
const plain = {
  dashboard: { id: 'dash-board-9f2c1a', title: 'Board', range: '30d',
               connection_id: 'conn-a', dataset_id: 'd.wide' },
  certified: true, unratified: [], window_days: 30,
  filters: [], filters_partial: [],
  filterable: [{ name: 'arm', kind: 'string' }, { name: 'region', kind: 'string' },
                { name: 'user_id', kind: 'string' }, { name: 'amount', kind: 'number' }],
  panels: [chart('p-wide', 'Conversion'), chart('p-narrow', 'Spend')],
}

/** Filtered to EMEA, which only one of the two datasets can answer. */
const sliced = {
  ...plain,
  filters: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
  filters_partial: ['p-narrow'],
  panels: [
    chart('p-wide', 'Conversion', {
      filters_applied: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
    }),
    chart('p-narrow', 'Spend', {
      filters_skipped: [{ dimension: 'region', op: 'eq', values: ['emea'],
                          why: 'd.narrow has no filterable column \'region\'' }],
    }),
  ],
}

function mount(bodies: unknown[], mountIt = true) {
  let n = 0
  const sent: unknown[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/v1/')[1]
    sent.push({ op, ...JSON.parse(String(init?.body ?? '{}')) })
    if (op === 'dashboards.render') {
      return { ok: true, status: 200,
               json: async () => bodies[Math.min(n++, bodies.length - 1)] } as Response
    }
    // The picker reads a column's values the moment one is chosen. Answering
    // it here keeps these tests about the bar rather than about the fetch.
    if (op === 'columns.values') {
      const col = JSON.parse(String(init?.body ?? '{}')).column
      return { ok: true, status: 200, json: async () => COLUMN_VALUES[col]
        ?? { column: col, kind: 'string', values: [], min: null, max: null,
             from: [], truncated: false, errors: [] } } as Response
    }
    return { ok: true, status: 200,
             json: async () => ({ dashboards: [ROW, OTHER] }) } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  if (mountIt) render(<MemoryRouter><DashboardDetail /></MemoryRouter>)
  return sent
}

/** Only the renders. The picker also calls `columns.values`, so counting every
 *  request would count the wrong thing. */
const renders = (sent: unknown[]) =>
  sent.filter(b => (b as { op: string }).op === 'dashboards.render')

afterEach(() => { vi.unstubAllGlobals(); params.id = 'dash-board-9f2c1a' })

describe('the column picker', () => {
  it('finds a column by typing, and Enter takes the first match', async () => {
    mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.type(screen.getByRole('textbox', { name: 'Search columns' }), 'reg{Enter}')
    expect(screen.getByText('region', { selector: '.fcol-picked .fcol-n' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: /How to compare/ })).toBeTruthy()
  })
})

describe('the dashboard filter bar', () => {
  it('offers the control at all', async () => {
    mount([plain])
    expect(await screen.findByRole('button', { name: /\+ Filter/ })).toBeTruthy()
  })

  it('opens as a panel under its button, so the bar never reflows', async () => {
    mount([plain])
    const user = userEvent.setup()
    const add = await screen.findByRole('button', { name: /\+ Filter/ })
    expect(screen.queryByRole('dialog', { name: 'Add a filter' })).toBeNull()
    await user.click(add)
    const panel = screen.getByRole('dialog', { name: 'Add a filter' })
    expect(add.getAttribute('aria-expanded')).toBe('true')
    // The button stays where it was; the fields are in the panel, not the bar.
    expect(panel.contains(screen.getByRole('listbox', { name: /Column to filter/ }))).toBe(true)
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)  // no column yet
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Add a filter' })).toBeNull()
    await user.click(add)
    await user.click(document.body)                                 // a click elsewhere closes it
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a filter' })).toBeNull())
  })

  it('offers only the columns the dashboard can actually be sliced by', async () => {
    mount([plain])
    await userEvent.setup().click(await screen.findByRole('button', { name: /\+ Filter/ }))
    // Read off the render, not introspected again — and `ts` is not among them,
    // because the range control already owns that axis.
    expect(screen.getByRole('option', { name: 'arm' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'region' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'ts' })).toBeNull()
  })

  it('sends the filter to the server rather than slicing what it already has', async () => {
    const sent = mount([plain, sliced])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'emea')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(renders(sent).length).toBe(2))
    // A dashboard panel is a query, not a slice of something already fetched:
    // filtering client-side would show a filtered chart over an unfiltered
    // aggregate, which is a different and wrong number.
    expect((renders(sent)[1] as { filters: unknown[] }).filters)
      .toEqual([{ dimension: 'region', op: 'eq', values: ['emea'] }])
  })

  it('says how many panels could not honour it', async () => {
    mount([sliced])
    // A short tag in the bar; the whole sentence on hover.
    const tag = await screen.findByText(/1 panel unfiltered/)
    expect(tag.getAttribute('title')).toMatch(/1 panel is not filtered/)
  })

  it('says it on the card too, where the number is', async () => {
    mount([sliced])
    // The headline count is up by the caption; a reader looking at one number
    // is looking at the card.
    expect(await screen.findByText(/not filtered by region/)).toBeTruthy()
    expect(screen.getByText(/region filtered/)).toBeTruthy()
  })

  it('drops a filter and re-queries without it', async () => {
    // The bar is local state, not the server's echo: a chip only exists
    // because this browser asked for it. So the filter is added first.
    const sent = mount([plain, sliced, plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'emea')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(renders(sent).length).toBe(2))

    await user.click(await screen.findByRole('button', { name: /Remove filter on region/ }))
    await waitFor(() => expect(renders(sent).length).toBe(3))
    expect((renders(sent)[2] as { filters: unknown[] }).filters).toEqual([])
  })
})

// ── bugs the bar introduced ────────────────────────────────────────────────

describe('switching dashboards', () => {
  it('does not carry the filter to the next one', async () => {
    // Filters name COLUMNS and the next dashboard is on a different dataset,
    // so a carried-over bar arrives full of columns nothing has — and the page
    // opens saying "3 panels are not filtered" about a filter nobody set here.
    const sent = mount([plain, sliced, plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'emea')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(renders(sent).length).toBe(2))

    expect(screen.getByRole('button', { name: /Remove filter on region/ })).toBeTruthy()

    // The id is what the route changes; the effect keyed on it is what has to
    // clear the bar.
    cleanup()
    params.id = OTHER.id
    render(<MemoryRouter><DashboardDetail /></MemoryRouter>)

    await waitFor(() => expect(renders(sent).length).toBeGreaterThan(2))
    expect((renders(sent).at(-1) as { filters: unknown[] }).filters).toEqual([])
    expect(screen.queryByRole('button', { name: /Remove filter on region/ })).toBeNull()
  })
})

// ── taking the numbers out ─────────────────────────────────────────────────

describe('a link that carries the view', () => {
  it('opens on the slice the link names', async () => {
    // The whole point of putting the filters in the URL. Without this the
    // person opening a shared link sees the unfiltered default while both
    // parties believe they are looking at the same page.
    const sent = mount([sliced], false)
    render(<MemoryRouter initialEntries={['/d?range=90d&f=region~eq~emea']}>
      <DashboardDetail />
    </MemoryRouter>)
    await waitFor(() => expect(renders(sent).length).toBeGreaterThan(0))
    const first = renders(sent).at(-1) as { range: string; filters: unknown[] }
    expect(first.filters).toEqual([{ dimension: 'region', op: 'eq', values: ['emea'] }])
    expect(first.range).toBe('90d')
  })
})

describe('exporting', () => {
  /** The DOM half of `download`, captured rather than performed. */
  function captureDownloads() {
    const files: { name: string; text: string }[] = []
    let pending = ''
    // Only the two blob helpers: replacing `URL` whole broke the router, which
    // builds `new URL(...)` whenever it writes the address bar.
    const made = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const realBlob = globalThis.Blob
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { pending = parts.join('') }
    } as unknown as typeof realBlob)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        files.push({ name: this.download, text: pending })
      })
    return { files, restore: () => { click.mockRestore(); made.mockRestore(); revoked.mockRestore() } }
  }

  it('offers the control once there is something to export', async () => {
    mount([plain])
    expect(await screen.findByRole('button', { name: /Download CSV/ })).toBeTruthy()
  })

  it('writes the window and the certification into the file', async () => {
    const { files, restore } = captureDownloads()
    mount([plain])
    await userEvent.setup().click(await screen.findByRole('button', { name: /Download CSV/ }))
    expect(files).toHaveLength(1)
    expect(files[0].text).toMatch(/# window: last 30 days/)
    expect(files[0].text).toMatch(/# certified: yes/)
    restore()
  })

  it('writes the slice, and which panels it did not reach', async () => {
    const { files, restore } = captureDownloads()
    mount([sliced])
    await userEvent.setup().click(await screen.findByRole('button', { name: /Download CSV/ }))
    // The whole point of exporting provenance: in a spreadsheet, a filtered
    // row and an unfiltered one look identical.
    expect(files[0].text).toMatch(/# NOT filtered: Spend/)
    restore()
  })
})

// ── a refusal is not an outage ─────────────────────────────────────────────

describe('when the server refuses a request', () => {
  function mountRefusing(status: number, body: unknown) {
    let n = 0
    const fetchMock = vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      if (op === 'dashboards.render') {
        // First render succeeds so the page exists; the next one is refused.
        if (n++ === 0) return { ok: true, status: 200, json: async () => plain } as Response
        return { ok: false, status, json: async () => body } as Response
      }
      if (op === 'columns.values') {
        return { ok: true, status: 200, json: async () => COLUMN_VALUES.region } as Response
      }
      return { ok: true, status: 200,
               json: async () => ({ dashboards: [ROW, OTHER] }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><DashboardDetail /></MemoryRouter>)
  }

  it('says what was refused instead of blaming the network', async () => {
    mountRefusing(422, { error: { code: 'bad_filter', field: 'filters[0].values',
                                  message: 'between needs exactly 2 values, got 3' } })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'emea')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    // The server answered precisely — a code, a message and the field. All
    // three used to be thrown away and replaced with "start uvicorn".
    expect(await screen.findByText(/That request was refused/)).toBeTruthy()
    expect(screen.getByText(/needs exactly 2 values/)).toBeTruthy()
    expect(screen.getByText(/filters\[0\]\.values/)).toBeTruthy()
    expect(screen.queryByText(/uvicorn/)).toBeNull()
  })

  it('says the numbers on screen are from before it', async () => {
    // They are not cleared, so without saying so the filter chip shows the new
    // slice while the cards show the old one.
    mountRefusing(422, { error: { code: 'bad_filter', message: 'nope' } })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'emea')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText(/from the previous read/)).toBeTruthy()
  })
})

// ── destroying something ───────────────────────────────────────────────────

describe('deleting a dashboard', () => {
  it('asks first, and names what goes', async () => {
    // One click used to delete the dashboard and every panel on it and
    // navigate away, with the toast arriving after the fact. The backend
    // tombstones rather than hard-deletes, which is a recovery path for an
    // operator with psql, not for the person who clicked.
    mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }))
    await user.click(screen.getByRole('button', { name: /^Delete$/ }))

    expect(screen.getByText(/Delete Board and its/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Delete it/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Keep it/ })).toBeTruthy()
  })

  it('sends nothing until the second click', async () => {
    const sent = mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }))
    await user.click(screen.getByRole('button', { name: /^Delete$/ }))
    await user.click(screen.getByRole('button', { name: /Keep it/ }))

    // Backing out leaves the dashboard alone and the button un-primed.
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeTruthy()
    expect(sent.every(b => !JSON.stringify(b).includes('delete'))).toBe(true)
  })
})

// ── resizing a panel ───────────────────────────────────────────────────────

describe('the resize handle', () => {
  /** A dashboard in edit mode, with one panel to grab. */
  async function editing() {
    mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }))
    return user
  }

  it('does not let the card start a reorder drag while it is being resized', async () => {
    // The card is `draggable`, so a pointer-drag on the edge started an HTML5
    // drag as well: the panel resized AND tried to reorder itself at once,
    // which is most of what "buggy" looked like.
    await editing()
    const card = document.querySelector('.pv') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('true')

    const edge = card.querySelector('.pv-edge') as HTMLElement
    await act(async () => {
      edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 400 }))
    })
    expect(card.getAttribute('draggable')).toBe('false')

    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup')) })
    expect(card.getAttribute('draggable')).toBe('true')
  })

  it('offers a keyboard path that is not the drag handle', async () => {
    // A drag handle with no alternative is a layout only a mouse can author.
    await editing()
    expect(screen.getAllByRole('button', { name: 'Wider' })[0]).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Narrower' })[0]).toBeTruthy()
  })

  it('resizes height as well as width', async () => {
    // Width was resizable and height was not, so a table of thirty rows could
    // only be made wider — which moves its scrollbar and shows no more rows.
    await editing()
    expect(screen.getAllByRole('button', { name: 'Taller' })[0]).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Shorter' })[0]).toBeTruthy()
  })

  it('offers a grip for each axis and one for both', async () => {
    await editing()
    const card = document.querySelector('.pv') as HTMLElement
    expect(card.querySelector('.pv-edge-x')).toBeTruthy()
    expect(card.querySelector('.pv-edge-y')).toBeTruthy()
    expect(card.querySelector('.pv-corner')).toBeTruthy()
  })

  it('sends a height the server will accept', async () => {
    const sent = mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }))
    await user.click(screen.getAllByRole('button', { name: 'Taller' })[0])

    await waitFor(() => expect(sent.some(b =>
      (b as { op: string }).op === 'panels.resize')).toBe(true))
    const resize = sent.find(b => (b as { op: string }).op === 'panels.resize') as
      { heights: Record<string, number> }
    const [h] = Object.values(resize.heights)
    // The column refuses anything outside 160..900, so a client that can send
    // one is a client that produces a 422 nobody asked for.
    expect(h).toBeGreaterThanOrEqual(160)
    expect(h).toBeLessThanOrEqual(900)
  })

  it('sends the new width when the buttons are used', async () => {
    const sent = mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Edit$/ }))

    const before = sent.length
    await user.click(screen.getAllByRole('button', { name: 'Wider' })[0])
    await waitFor(() => expect(sent.length).toBeGreaterThan(before))
  })

  // Not tested here: the grips being anchored to the CARD rather than to the
  // grid row that stretches around it, and the panel's Chart/Table toggle
  // being hidden in edit mode. Both are layout, jsdom does none, and asserting
  // the stylesheet text would be checking the fix's spelling rather than its
  // effect. They were verified in a browser.
})

// ── more than one filter ───────────────────────────────────────────────────

describe('several filters at once', () => {
  async function openPicker() {
    const sent = mount([plain, plain, plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    return { sent, user }
  }

  async function addFilter(user: ReturnType<typeof userEvent.setup>,
                           column: string, op: string, value?: string) {
    await user.click(screen.getByRole('option', { name: column }))
    await user.selectOptions(screen.getByRole('combobox', { name: /How to compare/ }), op)
    if (value !== undefined) await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), value)
    await user.click(screen.getByRole('button', { name: 'Apply' }))
  }

  it('sends every one of them, and they narrow together', async () => {
    const { sent, user } = await openPicker()
    await addFilter(user, 'arm', 'eq', 'variant')
    await waitFor(() => expect(renders(sent).length).toBe(2))

    await user.click(screen.getByRole('button', { name: /\+ Filter/ }))
    await addFilter(user, 'region', 'eq', 'emea')
    await waitFor(() => expect(renders(sent).length).toBe(3))

    expect((renders(sent)[2] as { filters: { dimension: string }[] }).filters
      .map(f => f.dimension)).toEqual(['arm', 'region'])
  })

  it('allows two on ONE column, which is what a range is', async () => {
    const { sent, user } = await openPicker()
    await addFilter(user, 'amount', 'gt', '100')
    await waitFor(() => expect(renders(sent).length).toBe(2))

    await user.click(screen.getByRole('button', { name: /\+ Filter/ }))
    await addFilter(user, 'amount', 'lt', '500')
    await waitFor(() => expect(renders(sent).length).toBe(3))

    expect((renders(sent)[2] as { filters: { dimension: string; op: string }[] }).filters)
      .toEqual([{ dimension: 'amount', op: 'gt', values: ['100'] },
                { dimension: 'amount', op: 'lt', values: ['500'] }])
  })

  it('removes one without disturbing the rest', async () => {
    const { sent, user } = await openPicker()
    await addFilter(user, 'arm', 'eq', 'variant')
    await waitFor(() => expect(renders(sent).length).toBe(2))
    await user.click(screen.getByRole('button', { name: /\+ Filter/ }))
    await addFilter(user, 'region', 'eq', 'emea')
    await waitFor(() => expect(renders(sent).length).toBe(3))

    await user.click(screen.getByRole('button', { name: /Remove filter on arm/ }))
    await waitFor(() => expect(renders(sent).length).toBe(4))
    expect((renders(sent)[3] as { filters: { dimension: string }[] }).filters
      .map(f => f.dimension)).toEqual(['region'])
  })
})

describe('the operator list', () => {
  async function pick(column: string) {
    mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: column }))
    return Array.from(
      screen.getByRole('combobox', { name: /How to compare/ }).querySelectorAll('option'),
    ).map(o => o.textContent)
  }

  it('offers comparisons for a number and not "contains"', async () => {
    // All thirteen used to be offered for every column, so the list included
    // `contains` on a float — a reader had to know the schema to tell which of
    // them meant anything, and picking wrong runs and answers nothing.
    const ops = await pick('amount')
    expect(ops).toContain('more than')
    expect(ops).toContain('between')
    expect(ops).not.toContain('contains')
  })

  it('offers text operators for a string and not "between"', async () => {
    const ops = await pick('arm')
    expect(ops).toContain('contains')
    expect(ops).toContain('is one of')
    expect(ops).not.toContain('between')
  })

  it('does not leave an operator the new column cannot use', async () => {
    // Picking a different column can strip the operator out from under you.
    mount([plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'arm' }))
    const cmp = () => screen.getByRole('combobox', { name: /How to compare/ }) as HTMLSelectElement
    await user.selectOptions(cmp(), 'contains')
    expect(cmp().value).toBe('contains')

    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(screen.getByRole('option', { name: 'amount' }))
    await waitFor(() => expect(cmp().value).not.toBe('contains'))
  })
})

// ── choosing a value instead of typing one ─────────────────────────────────

describe('the value picker', () => {
  async function openOn(column: string) {
    const sent = mount([plain, plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: column }))
    return { sent, user }
  }

  it('shows what the column actually holds', async () => {
    // It was a free-text box: to slice by region you had to already know the
    // column holds `emea` and not `EMEA` or `eu-west`, and a typo returns an
    // empty chart rather than an error.
    await openOn('region')
    expect(await screen.findByRole('button', { name: /emea/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /apac/ })).toBeTruthy()
  })

  it('says how many rows each value has', async () => {
    // Which of three regions is the one with the data is a question the list
    // can answer for free.
    await openOn('arm')
    expect(await screen.findByRole('button', { name: /control.*4,000/ })).toBeTruthy()
  })

  it('says which datasets the values came from', async () => {
    // A dashboard spans them, and a value in one is not in another — the
    // panels without the column still report the filter as skipped.
    await openOn('region')
    // Split across a <span>, so matched on the container's text.
    await screen.findByRole('button', { name: /emea/ })
    const note = document.querySelector('.fvals-note') as HTMLElement
    expect(note.textContent).toMatch(/from\s+d\.wide/)
  })

  it('applies a chosen value without typing it', async () => {
    const { sent, user } = await openOn('region')
    await user.click(await screen.findByRole('button', { name: /emea/ }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(renders(sent).length).toBe(2))
    expect((renders(sent)[1] as { filters: unknown[] }).filters)
      .toEqual([{ dimension: 'region', op: 'eq', values: ['emea'] }])
  })

  it('turns two chosen values into one `in`, not two filters', async () => {
    // "region is emea or apac" is what somebody means by clicking both, and
    // the alternative is making them switch operator and type both out.
    const { sent, user } = await openOn('region')
    await user.click(await screen.findByRole('button', { name: /emea/ }))
    await user.click(screen.getByRole('button', { name: /apac/ }))
    // Says what Apply will do: both, as one filter.
    expect(screen.getByText(/2 picked — any of them/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Apply 2 values' }))
    await waitFor(() => expect(renders(sent).length).toBe(2))
    expect((renders(sent)[1] as { filters: unknown[] }).filters)
      .toEqual([{ dimension: 'region', op: 'in', values: ['emea', 'apac'] }])
  })

  it('narrows the values by what is typed in the one value box', async () => {
    const { user } = await openOn('region')
    await screen.findByRole('button', { name: /emea/ })
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'ap')
    expect(screen.getByRole('button', { name: /apac/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /emea/ })).toBeNull()
  })

  it('shows a number\'s range rather than a list of floats', async () => {
    // The distinct values of a float are not a list anyone wants; what you
    // need to write `amount > 100` is to know the column runs from 3 to 30.
    await openOn('amount')
    expect(await screen.findByText(/3\.01/)).toBeTruthy()
    expect(screen.getByText(/29\.81/)).toBeTruthy()
  })

  it('still lets a value be typed when the column has none to offer', async () => {
    // A column the scan could not read, or one with more values than anybody
    // wants listed, must not become unfilterable.
    const { user } = await openOn('user_id')
    expect(await screen.findByText(/no values read/)).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: /Value to filter by/ }), 'u-1')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
  })
})

// ── narrowing one filter to some panels ────────────────────────────────────

describe('scoping a filter by hand', () => {
  async function withFilter() {
    const sent = mount([plain, plain, plain])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /\+ Filter/ }))
    await user.click(screen.getByRole('option', { name: 'region' }))
    await user.click(await screen.findByRole('button', { name: /emea/ }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(renders(sent).length).toBe(2))
    return { sent, user }
  }

  it('is not required — the dataset decides until you say otherwise', async () => {
    const { sent } = await withFilter()
    // The default carries no scope at all, which is what makes this an
    // override rather than a step.
    expect((renders(sent)[1] as { filters: { panels?: string[] }[] }).filters[0].panels)
      .toBeUndefined()
  })

  it('narrows to the panels left on', async () => {
    const { sent, user } = await withFilter()
    await user.click(screen.getByRole('button', { name: /Limit region to some panels/ }))
    // Turning one off leaves the rest.
    await user.click(await screen.findByRole('button', { name: 'Spend' }))
    await waitFor(() => expect(renders(sent).length).toBe(3))
    expect((renders(sent)[2] as { filters: { panels?: string[] }[] }).filters[0].panels)
      .toEqual(['p-wide'])
  })

  it('drops the scope again when every panel is back on', async () => {
    // A list that happens to name them all and "every panel that has the
    // column" behave the same today and diverge the moment a panel is added.
    const { sent, user } = await withFilter()
    await user.click(screen.getByRole('button', { name: /Limit region to some panels/ }))
    await user.click(await screen.findByRole('button', { name: 'Spend' }))
    await waitFor(() => expect(renders(sent).length).toBe(3))
    await user.click(screen.getByRole('button', { name: 'Spend' }))
    await waitFor(() => expect(renders(sent).length).toBe(4))
    expect((renders(sent)[3] as { filters: { panels?: string[] }[] }).filters[0].panels)
      .toBeUndefined()
  })

  it('says on the chip that it was narrowed', async () => {
    // A filter reaching four of eight panels for a reason nobody can see is
    // the failure this bar reports its way out of; doing it deliberately
    // should not be the one case that goes unlabelled.
    const { user } = await withFilter()
    await user.click(screen.getByRole('button', { name: /Limit region to some panels/ }))
    await user.click(await screen.findByRole('button', { name: 'Spend' }))
    expect(await screen.findByText(/1 panel$/)).toBeTruthy()
  })
})
