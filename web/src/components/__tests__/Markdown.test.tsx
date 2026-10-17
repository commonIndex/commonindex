/**
 * Rendering a Code Query answer.
 *
 * The document is written partly by a model, so the two things worth asserting
 * are that it arrives as a document — headings, a table, a drawn diagram — and
 * that none of it arrives as markup. The second is checked by looking for the
 * element a successful injection would have produced, rather than by trusting
 * that React escapes children.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Markdown } from '../Markdown'

const ANSWER = [
  '# How does order placement work?',
  '',
  '*Answered by `qwen2.5-coder:1.5b` from 2 file excerpt(s).*',
  '',
  '> [!WARNING]',
  '> The precise code index was unavailable.',
  '',
  '## Answer',
  '',
  'Checkout posts to the orders handler, which writes one row.',
  '',
  '## Flow — Order placement',
  '',
  '```mermaid',
  'flowchart TD',
  '%% title: Order placement',
  '  n0(["Checkout page"])',
  '  n1["POST /orders"]',
  '  n2[("orders table")]',
  '  n0 -->|"submits"| n1',
  '  n1 -->|"insert"| n2',
  '```',
  '',
  '## Sources',
  '',
  '- `example/storefront/app/checkout.py:L10-L48`',
  '',
  '## How this answer was reached',
  '',
  '|  |  |',
  '| --- | --- |',
  '| Routing | searched 2 readable repositories; 1 answered |',
  '| Engine | `zoekt` |',
].join('\n')

describe('an answer document', () => {
  it('renders its sections as headings a reader can scan', () => {
    render(<Markdown source={ANSWER} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toBe('How does order placement work?')
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent))
      .toEqual(['Answer', 'Flow — Order placement', 'Sources', 'How this answer was reached'])
  })

  it('draws the mermaid fence as a diagram, with every node labelled', () => {
    const { container } = render(<Markdown source={ANSWER} />)

    const svg = container.querySelector('.mermaid-flow svg')!
    expect(svg.getAttribute('aria-label')).toBe('Order placement')
    const labels = [...svg.querySelectorAll('.mf-label')].map(node => node.textContent)
    expect(labels.join(' ')).toContain('Checkout page')
    expect(labels.join(' ')).toContain('orders table')
    // One path per edge, plus the arrowhead marker's own path.
    expect(svg.querySelectorAll('.mf-edge')).toHaveLength(2)
    expect([...svg.querySelectorAll('.mf-edge-label')].map(n => n.textContent))
      .toEqual(['submits', 'insert'])
    // The fence is drawn, not also printed.
    expect(container.querySelector('pre[data-lang="mermaid"]')).toBeNull()
  })

  it('shapes a node by its kind, so a store does not read as another step', () => {
    const { container } = render(<Markdown source={ANSWER} />)

    expect(container.querySelector('.mf-stadium')).not.toBeNull()
    expect(container.querySelector('.mf-store')).not.toBeNull()
  })

  it('renders the routing block as a table, without a row of empty headers', () => {
    const { container } = render(<Markdown source={ANSWER} />)

    const table = container.querySelector('.md-table')!
    expect(table.querySelector('thead')).toBeNull()
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table.textContent).toContain('searched 2 readable repositories; 1 answered')
  })

  it('gives a degraded index the callout treatment rather than a line of prose', () => {
    const { container } = render(<Markdown source={ANSWER} />)

    const quote = container.querySelector('blockquote.md-warn')!
    expect(quote.textContent).toContain('The precise code index was unavailable.')
  })

  it('keeps a citation intact, underscores and all', () => {
    const { container } = render(<Markdown source={'- `code_file-abc_def`'} />)
    expect(container.querySelector('li code')!.textContent).toBe('code_file-abc_def')
  })
})

describe('what the document cannot do', () => {
  it('renders markup in an answer as text, not as elements', () => {
    const { container } = render(<Markdown source={
      'Then it calls <script>alert(1)</script> and <img src=x onerror=alert(1)>.'} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('drops a link scheme a browser should not follow, keeping the text', () => {
    const { container } = render(<Markdown source={'[click](javascript:alert(1))'} />)

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
  })

  it('shows a diagram it cannot draw as the text it is', () => {
    // Mermaid this parser does not understand is a fence it renders as code:
    // visible and honest, where half a drawing would be neither.
    const { container } = render(<Markdown source={
      '```mermaid\nsequenceDiagram\n  Alice->>Bob: hi\n```'} />)

    expect(container.querySelector('.mermaid-flow')).toBeNull()
    expect(container.querySelector('pre[data-lang="mermaid"]')!.textContent)
      .toContain('sequenceDiagram')
  })
})
