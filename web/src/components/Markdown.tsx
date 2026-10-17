import { type Block, parse, type Span } from '../data/markdown'
import { parseFlowchart } from '../data/mermaid'
import { MermaidFlow } from './MermaidFlow'

/** Renders a markdown document as elements.
 *
 *  Every leaf below is a React text child, so the markdown becomes a heading, a
 *  table or a code block and never becomes markup. That is the property worth
 *  stating plainly: this component is what lets the gateway send a *document*
 *  written partly by a model without any of it reaching the DOM as HTML.
 *
 *  A ```mermaid fence is the exception that proves the rule — it is not passed
 *  to a diagram engine either. It is parsed into nodes and edges and drawn by
 *  `MermaidFlow`; a block that will not parse renders as code, so a diagram this
 *  app cannot draw is visible as the text it is rather than silently missing.
 */

function Spans({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, index) => {
    if (span.kind === 'text') return span.text
    if (span.kind === 'code') return <code key={index}>{span.text}</code>
    if (span.kind === 'strong') return <strong key={index}><Spans spans={span.spans} /></strong>
    if (span.kind === 'em') return <em key={index}><Spans spans={span.spans} /></em>
    return <a key={index} href={span.href} target="_blank" rel="noreferrer noopener">
      <Spans spans={span.spans} />
    </a>
  })}</>
}

function Fence({ block }: { block: Extract<Block, { kind: 'mermaid' }> }) {
  const flow = parseFlowchart(block.text)
  if (!flow) {
    return <pre className="md-code" data-lang="mermaid"><code>{block.text}</code></pre>
  }
  return <MermaidFlow flow={flow} />
}

function One({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      // The document's own levels are kept rather than flattened: the gateway
      // writes `#` for the question and `##` per section, and a reader scanning
      // for "Sources" is using that shape.
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as 'h1'
      return <Tag className={`md-h md-h${block.level}`}><Spans spans={block.spans} /></Tag>
    }
    case 'para':
      return <p className="md-p"><Spans spans={block.spans} /></p>
    case 'code':
      return <pre className="md-code" data-lang={block.lang || undefined}>
        <code>{block.text}</code>
      </pre>
    case 'mermaid':
      return <Fence block={block} />
    case 'rule':
      return <hr className="md-rule" />
    case 'quote':
      return <blockquote className={`md-quote md-${block.tone}`}>
        <Blocks blocks={block.blocks} />
      </blockquote>
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return <Tag className="md-list">
        {block.items.map((item, index) =>
          <li key={index} data-depth={item.depth || undefined}>
            <Spans spans={item.spans} />
          </li>)}
      </Tag>
    }
    case 'table': {
      // The routing table's header cells are empty by design — it is a
      // label/value list, not a grid — so the header row is dropped rather than
      // rendered as a band of nothing.
      const titled = block.head.some(cell => cell.length > 0)
      return <div className="md-table-wrap">
        <table className="md-table">
          {titled && <thead><tr>
            {block.head.map((cell, index) => <th key={index}><Spans spans={cell} /></th>)}
          </tr></thead>}
          <tbody>
            {block.rows.map((row, rowIndex) => <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}><Spans spans={cell} /></td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    }
  }
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((block, index) => <One key={index} block={block} />)}</>
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className ? `md ${className}` : 'md'}>
    <Blocks blocks={parse(source)} />
  </div>
}
