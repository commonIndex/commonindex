/**
 * The Code Query page, reading the answer the gateway actually sends.
 *
 * `code.ask` returns the prose twice — once as the model said it, once as a
 * markdown document — and the page has to render the second. What is worth
 * defending is that the choice is not silently reversible: a reader looking at
 * "Rendered" sees the sections and the diagram, and a reader about to paste the
 * answer into a PR can see the exact bytes first.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodeQueryView } from '../CodeQuery'

const MARKDOWN = [
  '# how does order placement work',
  '',
  '*Answered by `stub-coder` from 1 file excerpt(s) in 1 of 1 searched repositories.*',
  '',
  '## Answer',
  '',
  'Checkout posts to the orders handler.',
  '',
  '## Flow — Order placement',
  '',
  '```mermaid',
  'flowchart TD',
  '%% title: Order placement',
  '  n0(["Checkout"])',
  '  n1[("orders")]',
  '  n0 -->|"insert"| n1',
  '```',
  '',
  '## Sources',
  '',
  '- `example/storefront/app/checkout.py:L10-L48`',
].join('\n')

const ANSWER = {
  answer: 'Checkout posts to the orders handler.',
  markdown: MARKDOWN,
  citations: ['example/storefront/app/checkout.py:L10-L48'],
  model: 'stub-coder',
  diagram: null,
  context: {
    query: 'how does order placement work', engine: 'zoekt',
    context: [{ citation: 'example/storefront/app/checkout.py:L10-L48',
                repo: 'example/storefront', path: 'app/checkout.py',
                snippet: 'def place_order():\n    pass' }],
    routing: 'searched 1 readable repository; 1 answered',
    searched_repos: ['example/storefront'],
    selected_repos: [{ repo: 'example/storefront', files: 1, score: 240 }],
  },
}

/** The page, where a link can reach it. */
const view = (at = '/code') => render(<MemoryRouter initialEntries={[at]}><CodeQueryView /></MemoryRouter>)

function mount(answer: object = ANSWER) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const op = String(url).split('/api/v1/')[1]
    return {
      ok: true, status: 200,
      json: async () => (op === 'code.list_repos'
        ? { repos: [{ repo: 'example/storefront', repo_id: 'code_repo-example-storefront-main',
                      branch: 'main', health: 'ok', last_indexed_at: '2026-09-01T00:00:00Z' }],
            count: 1 }
        : answer),
    } as Response
  }))
  return view()
}

async function ask(container: HTMLElement) {
  await userEvent.type(screen.getByRole('textbox'), 'how does order placement work')
  await userEvent.click(screen.getByRole('button', { name: /^ask$/i }))
  await waitFor(() => expect(container.querySelector('.code-answer')).not.toBeNull())
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the answer', () => {
  it('keeps the answered question attached when the next question is being drafted', async () => {
    const { container } = mount()
    await ask(container)
    await userEvent.clear(screen.getByRole('textbox', { name: 'Question' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Question' }), 'A different question')
    expect(container.querySelector('.cq-question p')?.textContent).toBe('how does order placement work')
  })

  it('supports keyboard navigation between answer formats', async () => {
    const { container } = mount()
    await ask(container)
    const rendered = screen.getByRole('tab', { name: 'Rendered' })
    await userEvent.click(rendered)
    await userEvent.keyboard('{ArrowRight}')
    const source = screen.getByRole('tab', { name: 'Markdown source' })
    expect(document.activeElement).toBe(source)
    expect(source.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(source.id)
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(rendered)
    expect(rendered.getAttribute('aria-selected')).toBe('true')
  })

  it('does not report zero indexed repositories when listing them fails', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail) throw new Error('offline')
      return { ok: true, status: 200, json: async () => ({ repos: [], count: 0 }) } as Response
    }))
    view()
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load repositories')
    expect(screen.queryByText(/Nothing is indexed/)).toBeNull()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByText('Loading searchable repositories…')).toBeNull()
  })

  it('renders the document, with the flow drawn as a diagram', async () => {
    const { container } = mount()
    await ask(container)

    expect(screen.getByRole('heading', { level: 2, name: 'Answer' })).toBeTruthy()
    const svg = container.querySelector('.mermaid-flow svg')!
    expect(svg.getAttribute('aria-label')).toBe('Order placement')
    expect([...svg.querySelectorAll('.mf-label')].map(n => n.textContent))
      .toEqual(['Checkout', 'orders'])
    // Rendered, not printed as the fence it arrived in.
    expect(container.querySelector('.code-answer-source')).toBeNull()
  })

  it('shows the same bytes on request, because the document is the deliverable', async () => {
    const { container } = mount()
    await ask(container)
    await userEvent.click(screen.getByRole('tab', { name: /markdown source/i }))

    expect(container.querySelector('.code-answer-source')!.textContent).toBe(MARKDOWN)
    expect(container.querySelector('.mermaid-flow')).toBeNull()
  })

  it('falls back to the prose when a response carries no document', async () => {
    // The unformatted answer is the fallback rather than the other way round: a
    // response with no document still has something to say.
    const { container } = mount({ ...ANSWER, markdown: undefined })
    await ask(container)

    expect(container.querySelector('.code-answer-doc')!.textContent)
      .toContain('Checkout posts to the orders handler.')
  })

  it('keeps the retrieved excerpts to hand, folded away', async () => {
    // What the citations point AT. Needed when one is being checked, noise when
    // it is not — so it is a fold, not a section.
    const { container } = mount()
    await ask(container)

    const fold = container.querySelector('.code-excerpts')!
    expect(fold.querySelector('summary')!.textContent).toBe('1 excerpt the answer was built from')
    expect(fold.querySelector('pre')!.textContent).toContain('def place_order():')
  })

  it('asks for the diagram by default, since the flow is the point of asking', async () => {
    const { container } = mount()
    await ask(container)

    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('code.ask'))!
    expect(JSON.parse((call[1] as RequestInit).body as string).include_diagram).toBe(true)
  })
})

describe('asking', () => {
  it('sends on ⌘/Ctrl+Enter from the question, as a composer does', async () => {
    const { container } = mount()
    await userEvent.type(screen.getByRole('textbox'), 'how does order placement work')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(container.querySelector('.code-answer')).not.toBeNull())
    // A plain Enter is a new line in the question, never a send.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('how does order placement work')
  })

  it('says nothing is indexed only when the list says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ repos: [], count: 0 }) }) as Response))
    view()
    expect(await screen.findByText(/No repositories are indexed yet/)).toBeTruthy()
    expect(screen.getByText('make code-index REPOS="path/to/clone"').tagName).toBe('CODE')
  })

  it('names the repositories it searches, before anyone asks', async () => {
    mount()
    const list = await screen.findByLabelText('Searchable repositories')
    expect(list.textContent).toContain('example/storefront')
    expect(screen.queryByText(/No repositories are indexed yet/)).toBeNull()
  })
})

describe('adding a repository', () => {
  function gateway(listings: object[], extra: Record<string, unknown> = {}) {
    const calls: { op: string; body: Record<string, unknown> }[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const op = String(url).split('/api/v1/')[1]
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls.push({ op, body })
      const out = op === 'code.list_repos' ? listings[Math.min(n++, listings.length - 1)] : extra[op] ?? {}
      return { ok: true, status: 200, json: async () => out } as Response
    }))
    return calls
  }
  const JOB = { path: '/src/storefront', repo: 'storefront', state: 'indexing', started_at: '2026-09-27T10:00:00Z',
                finished_at: null, error: null }

  it('indexes a repository by its URL, and says so until it is searchable', async () => {
    const calls = gateway([
      { repos: [], count: 0, may_index: true, indexing: [] },
      { repos: [], count: 0, may_index: true, indexing: [{ ...JOB, step: 'cloning' }] },
    ], { 'code.index': { job: JOB, already: false } })
    view()
    await userEvent.type(await screen.findByRole('textbox', { name: 'Repository URL' }), 'https://github.com/example/storefront')
    await userEvent.click(screen.getByRole('button', { name: 'Index it' }))
    await waitFor(() => expect(calls.find(c => c.op === 'code.index')?.body).toMatchObject(
      { url: 'https://github.com/example/storefront' }))
    const sent = calls.find(c => c.op === 'code.index')!.body
    expect(sent.path).toBeUndefined()
    expect(sent.token).toBeUndefined()                       // nothing typed, nothing sent
    expect((await screen.findByText(/becomes searchable here when it finishes/)).textContent)
      .toMatch(/Indexing storefront — cloning/)
    // Nothing to search yet, so nothing to send.
    expect((screen.getByRole('button', { name: /^ask$/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends a private repository\'s token and branch, and forgets the token after', async () => {
    const calls = gateway([{ repos: [], count: 0, may_index: true, indexing: [] }],
                          { 'code.index': { job: JOB, already: false } })
    view()
    await userEvent.type(await screen.findByRole('textbox', { name: 'Repository URL' }), 'github.com/example/private')
    await userEvent.click(screen.getByRole('button', { name: /Private repository or another branch/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Branch' }), 'release')
    const token = screen.getByLabelText('Access token') as HTMLInputElement
    expect(token.type).toBe('password')
    await userEvent.type(token, 'ghp_secret')
    await userEvent.click(screen.getByRole('button', { name: 'Index it' }))
    await waitFor(() => expect(calls.find(c => c.op === 'code.index')?.body).toMatchObject(
      { url: 'github.com/example/private', branch: 'release', token: 'ghp_secret' }))
    await waitFor(() => expect(document.body.innerHTML).not.toContain('ghp_secret'))
  })

  it('takes a folder only where the operator allows folders', async () => {
    const calls = gateway([{ repos: [], count: 0, may_index: true, may_index_paths: true, indexing: [] }],
                          { 'code.index': { job: JOB, already: false } })
    view()
    await userEvent.type(await screen.findByRole('textbox', { name: 'Repository URL' }), '~/src/storefront')
    expect(screen.queryByRole('button', { name: /Private repository/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Index it' }))
    await waitFor(() => expect(calls.find(c => c.op === 'code.index')?.body.path).toBe('~/src/storefront'))
  })

  it('says why a repository could not be indexed', async () => {
    gateway([{ repos: [], count: 0, may_index: true,
               indexing: [{ ...JOB, state: 'failed', error: 'GitError: no HEAD to read' }] }])
    view()
    expect((await screen.findByText(/Could not index storefront/)).closest('[role=status]')!.textContent)
      .toMatch(/GitError: no HEAD to read/)
  })

  it('tells someone who may not index who can', async () => {
    gateway([{ repos: [], count: 0, may_index: false, indexing: [] }])
    view()
    expect(await screen.findByText(/A workspace admin can add one here by its/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Repository URL' })).toBeNull()
  })
})

describe('checking an answer', () => {
  const CITED = { ...ANSWER, context: { ...ANSWER.context, context: [{ ...ANSWER.context.context[0],
    object_id: 'code_file-1', start_line: 10, end_line: 12 }] } }
  const FILE = { object_id: 'code_file-1', repo: 'example/storefront', path: 'app/checkout.py', sha: 'abc',
    start_line: 1, end_line: 20, truncated: false, citation: 'example/storefront/app/checkout.py:L1-L20',
    body: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' }

  function gateway() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const op = String(url).split('/api/v1/')[1]
      const out = op === 'code.list_repos'
        ? { repos: [{ repo: 'example/storefront', repo_id: 'r', branch: 'main', health: 'ok',
                      last_indexed_at: '2026-09-01T00:00:00Z' }], count: 1 }
        : op === 'code.get_file' ? FILE : CITED
      return { ok: true, status: 200, json: async () => out } as Response
    }))
  }

  it('opens a cited file at the lines the citation names', async () => {
    gateway()
    const { container } = view()
    await ask(container)
    const cite = container.querySelector('.code-answer-doc code[data-cite]') as HTMLElement
    expect(cite.textContent).toBe('example/storefront/app/checkout.py:L10-L48')
    await userEvent.click(cite)
    const file = await screen.findByRole('dialog', { name: 'app/checkout.py, lines 10–12' })
    await waitFor(() => expect(file.querySelectorAll('.hit')).toHaveLength(3))
    expect([...file.querySelectorAll('.hit')].map(l => l.getAttribute('data-line'))).toEqual(['10', '11', '12'])
    await userEvent.click(screen.getByRole('button', { name: 'Close the file' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The excerpt's own citation opens it too.
    await userEvent.click(container.querySelector('.code-excerpts .cq-cite') as HTMLElement)
    expect(await screen.findByRole('dialog', { name: 'app/checkout.py, lines 10–12' })).toBeTruthy()
  })

  it('opens the file a link names, at its lines — a search result', async () => {
    gateway()
    view('/code?file=code_file-1&path=app%2Fcheckout.py&repo=example%2Fstorefront&lines=4-5')
    const file = await screen.findByRole('dialog', { name: 'app/checkout.py, lines 4–5' })
    await waitFor(() => expect([...file.querySelectorAll('.hit')].map(l => l.getAttribute('data-line')))
      .toEqual(['4', '5']))
    await userEvent.click(screen.getByRole('button', { name: 'Close the file' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers questions to start with, and asks one when picked', async () => {
    gateway()
    const { container } = view()
    const start = await screen.findByLabelText('Questions to start with')
    await userEvent.click(start.querySelector('button')!)
    await waitFor(() => expect(container.querySelector('.code-answer')).not.toBeNull())
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('code.ask'))!
    expect(JSON.parse((call[1] as RequestInit).body as string).q).toBe('Trace a request from its API route to the database')
  })
})
