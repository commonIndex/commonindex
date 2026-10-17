/**
 * Parsing a mermaid flowchart back into a graph.
 *
 * The round trip is the contract: the gateway writes the diagram as mermaid so
 * the document is portable, and this reads it back so the web client can draw it
 * itself rather than shipping a diagram engine. Anything lost here is lost from
 * the picture, so the shapes — which carry whether a hop is a store, a gate or a
 * step — are tested as carefully as the edges.
 */
import { describe, expect, it } from 'vitest'

import { parseFlowchart } from '../mermaid'

/** What the gateway emits, verbatim in shape. */
const GATEWAY = [
  'flowchart TD',
  '%% title: Order placement',
  '  n0(["Checkout page"])',
  '  n1["POST /orders"]',
  '  n2{"Validate cart"}',
  '  n3[("orders table")]',
  '  n0 -->|"submits"| n1',
  '  n1 --> n2',
  '  n2 -->|"insert"| n3',
].join('\n')

describe('the gateway’s own diagrams', () => {
  it('reads the title, the shapes and the labelled edges', () => {
    const flow = parseFlowchart(GATEWAY)!

    expect(flow.title).toBe('Order placement')
    expect(flow.direction).toBe('TD')
    expect(flow.nodes).toMatchObject([
      { id: 'n0', label: 'Checkout page', shape: 'stadium' },
      { id: 'n1', label: 'POST /orders', shape: 'box' },
      { id: 'n2', label: 'Validate cart', shape: 'decision' },
      { id: 'n3', label: 'orders table', shape: 'store' },
    ])
    expect(flow.edges).toMatchObject([
      { from: 'n0', to: 'n1', label: 'submits' },
      { from: 'n1', to: 'n2', label: '' },
      { from: 'n2', to: 'n3', label: 'insert' },
    ])
  })

  it('decodes the entities mermaid needs for a quote or a hash', () => {
    // How a label carries `"` or `#` through mermaid text at all. Left encoded,
    // a reader sees `#quot;` in the picture.
    const flow = parseFlowchart('flowchart TD\n  a["say #quot;hi#quot; #35;1"]')!
    expect(flow.nodes[0].label).toBe('say "hi" #1')
  })
})

describe('mermaid written by someone else', () => {
  it('takes LR as a left-to-right layout', () => {
    expect(parseFlowchart('graph LR\n  a --> b')!.direction).toBe('LR')
  })

  it('reads nodes declared inline on the edge', () => {
    const flow = parseFlowchart('flowchart TD\n  a["Handler"] --> b[(Postgres)]')!
    expect(flow.nodes).toMatchObject([{ id: 'a', label: 'Handler', shape: 'box' },
                                      { id: 'b', label: 'Postgres', shape: 'store' }])
    expect(flow.edges).toMatchObject([{ from: 'a', to: 'b' }])
  })

  it('reads a chain, giving each edge the label of the arrow behind it', () => {
    const flow = parseFlowchart('flowchart TD\n  a -->|one| b -->|two| c')!
    expect(flow.edges).toMatchObject([{ from: 'a', to: 'b', label: 'one' },
                                      { from: 'b', to: 'c', label: 'two' }])
  })

  it('reads the `-- label -->` spelling too', () => {
    expect(parseFlowchart('flowchart TD\n  a -- writes --> b')!.edges)
      .toMatchObject([{ from: 'a', to: 'b', label: 'writes' }])
  })

  it('marks a dotted edge, which is how an async hop is usually drawn', () => {
    expect(parseFlowchart('flowchart TD\n  a -.->|later| b')!.edges)
      .toMatchObject([{ from: 'a', to: 'b', label: 'later', dashed: true }])
  })

  it('does not let a bare edge rename a node that was declared with a label', () => {
    const flow = parseFlowchart('flowchart TD\n  b["Postgres"]\n  a --> b')!
    expect(flow.nodes.find(node => node.id === 'b')!.label).toBe('Postgres')
  })

  it('ignores styling and grouping instead of refusing the block', () => {
    const flow = parseFlowchart([
      'flowchart TD',
      '  subgraph gateway',
      '  a["Handler"] --> b["Store"]',
      '  end',
      '  classDef hot fill:#f00',
      '  class a hot',
    ].join('\n'))!
    expect(flow.nodes.map(node => node.id)).toEqual(['a', 'b'])
  })

  it('settles on a cycle rather than reading forever', () => {
    const flow = parseFlowchart('flowchart TD\n  a --> b\n  b --> a')!
    expect(flow.nodes).toHaveLength(2)
    expect(flow.edges).toHaveLength(2)
  })
})

describe('what it refuses', () => {
  it('refuses a diagram type it cannot draw', () => {
    // A sequence diagram is not a flowchart, and drawing its participants as a
    // flow would be a picture of something nobody described.
    expect(parseFlowchart('sequenceDiagram\n  Alice->>Bob: hi')).toBeNull()
    expect(parseFlowchart('')).toBeNull()
  })

  it('refuses a flowchart that is mostly lines it does not understand', () => {
    // Half a diagram is worse than none: a reader cannot tell which half is
    // missing, and `Markdown` shows the fence as code instead.
    expect(parseFlowchart([
      'flowchart TD',
      '  a --> b',
      '  a@{ shape: rect, label: "new syntax" }',
      '  a e1@--> b',
      '  x&y --> z&w',
    ].join('\n'))).toBeNull()
  })
})
