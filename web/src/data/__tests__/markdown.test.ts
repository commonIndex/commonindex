/**
 * The markdown parser, which exists because a Code Query answer is a document
 * and a model wrote part of it.
 *
 * So the tests split in two. The ordinary ones check that the constructs the
 * gateway actually emits survive the round trip — headings, the routing table,
 * fenced excerpts, a `[!WARNING]` about a degraded index. The rest check the
 * property that made a parser preferable to a library: nothing in the input can
 * become markup, because the output is data whose leaves are strings.
 */
import { describe, expect, it } from 'vitest'

import { inline, parse, type Block } from '../markdown'

const kinds = (blocks: Block[]) => blocks.map(block => block.kind)

/** The text of a block tree, however it is nested. */
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    return [record.spans, record.blocks, record.items, record.head, record.rows]
      .filter(Boolean).map(text).join('')
  }
  return ''
}

describe('blocks', () => {
  it('reads a heading at its own level, so the document keeps its shape', () => {
    const [heading] = parse('## Sources')
    expect(heading).toMatchObject({ kind: 'heading', level: 2 })
    expect(text(heading)).toBe('Sources')
  })

  it('keeps a hard-wrapped paragraph as one paragraph', () => {
    const blocks = parse('one line\nand its continuation\n\na second paragraph')
    expect(kinds(blocks)).toEqual(['para', 'para'])
    expect(text(blocks[0])).toContain('and its continuation')
  })

  it('reads a fenced block as code, with its language', () => {
    const [block] = parse('```python\ndef f():\n    pass\n```')
    expect(block).toMatchObject({ kind: 'code', lang: 'python' })
    expect(text(block)).toBe('def f():\n    pass')
  })

  it('lets a longer fence hold a snippet that contains one', () => {
    // How the gateway quotes a file that itself contains a fence. A parser that
    // closed on the first ``` would spill the rest of the file into the page.
    const [block] = parse('````md\n```sh\nmake code-index\n```\n````')
    expect(block.kind).toBe('code')
    expect(text(block)).toBe('```sh\nmake code-index\n```')
  })

  it('reads a mermaid fence as a diagram rather than as code', () => {
    const [block] = parse('```mermaid\nflowchart TD\n  a --> b\n```')
    expect(block.kind).toBe('mermaid')
  })

  it('reads a pipe table, and only when a delimiter row says it is one', () => {
    const [table] = parse('| Repo | Score |\n| --- | --- |\n| `a/b` | 240.0 |')
    expect(table).toMatchObject({ kind: 'table' })
    expect(text(table)).toBe('RepoScorea/b240.0')

    // A sentence with a pipe in it is a sentence.
    expect(kinds(parse('grep foo | wc -l'))).toEqual(['para'])
  })

  it('keeps an escaped pipe inside its cell', () => {
    // `one_line` escapes pipes, so a repository named `a|b` arrives this way and
    // must not shift every later column of its row one cell left.
    const [table] = parse('| Repo | Branch |\n| --- | --- |\n| a\\|b | main |')
    expect(table.kind === 'table' && table.rows[0]).toHaveLength(2)
    expect(text(table)).toContain('a|b')
  })

  it('reads a GitHub alert as a toned quote, which is how a warning gets seen', () => {
    const [quote] = parse('> [!WARNING]\n> The index was unavailable.')
    expect(quote).toMatchObject({ kind: 'quote', tone: 'warn' })
    expect(text(quote)).toContain('The index was unavailable.')
    // The marker itself is consumed rather than rendered as prose.
    expect(text(quote)).not.toContain('[!WARNING]')
  })

  it('reads both list flavours, and continues a wrapped item', () => {
    const [bullets, numbers] = parse(
      '- first\n- second\n  wrapped on\n\n1. one\n2. two')
    expect(bullets).toMatchObject({ kind: 'list', ordered: false })
    expect(bullets.kind === 'list' && bullets.items).toHaveLength(2)
    expect(text(bullets)).toContain('second wrapped on')
    expect(numbers).toMatchObject({ kind: 'list', ordered: true })
  })

  it('parses the document the gateway actually sends', () => {
    const blocks = parse([
      '# How does order placement work?', '',
      '*Answered by `m` from 1 file excerpt(s).*', '',
      '> [!WARNING]', '> degraded', '',
      '## Answer', '', 'It starts in `checkout.py`.', '',
      '## Flow — Order placement', '', '```mermaid', 'flowchart TD', '  n0["a"]', '```', '',
      '## Sources', '', '- `a/b/c.py:L1-L2`', '',
      '## How this answer was reached', '', '|  |  |', '| --- | --- |', '| Engine | `zoekt` |',
    ].join('\n'))

    expect(kinds(blocks)).toEqual([
      'heading', 'para', 'quote', 'heading', 'para', 'heading', 'mermaid',
      'heading', 'list', 'heading', 'table',
    ])
  })
})

describe('inline', () => {
  it('reads code, emphasis and links', () => {
    expect(inline('a `snippet`, **bold**, *slanted*'))
      .toMatchObject([{ kind: 'text' }, { kind: 'code', text: 'snippet' }, { kind: 'text' },
                      { kind: 'strong' }, { kind: 'text' }, { kind: 'em' }])
  })

  it('does not read emphasis inside a citation', () => {
    // `code_file-abc_def` and `a/b/__init__.py` are the common case here, and
    // treating the underscores as emphasis would silently delete them.
    expect(inline('`a/b/__init__.py`')).toMatchObject([{ kind: 'code', text: 'a/b/__init__.py' }])
    expect(inline('object_id_here')).toMatchObject([{ kind: 'text', text: 'object_id_here' }])
  })

  it('keeps a link whose scheme is one a browser should follow', () => {
    expect(inline('[docs](https://example.com/x)'))
      .toMatchObject([{ kind: 'link', href: 'https://example.com/x' }])
  })

  it('renders a link the model should not have written as its own text', () => {
    // The answer is model text. An allowlist of schemes is the guard, and a
    // rejected href degrades to the label rather than disappearing.
    const spans = inline('[click me](javascript:alert(1))')
    expect(spans).toMatchObject([{ kind: 'text', text: 'click me' }])
    expect(JSON.stringify(spans)).not.toContain('javascript')
  })

  it('leaves markup as the characters it is', () => {
    // Nothing downstream renders HTML, so this is what a reader sees — which is
    // also what they should see: what the model actually said.
    expect(inline('<img src=x onerror=alert(1)>'))
      .toMatchObject([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  })
})
