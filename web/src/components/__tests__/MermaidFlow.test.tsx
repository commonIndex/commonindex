/**
 * The layout, as geometry.
 *
 * A diagram is only worth drawing if it is readable, and the failures that make
 * one unreadable are all arithmetic: boxes on top of each other, a node outside
 * the viewBox, a branch drawn as a chain. None of those show up in a test that
 * only asserts the labels are present, so this one reads the coordinates.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MermaidFlow } from '../MermaidFlow'
import { parseFlowchart } from '../../data/mermaid'

const W = 176
const H = 58

function draw(source: string) {
  const { container } = render(<MermaidFlow flow={parseFlowchart(source)!} />)
  const svg = container.querySelector('svg')!
  const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
  const boxes = [...svg.querySelectorAll('.mf-shape')].map(node => {
    const points = node.getAttribute('points')
    if (points) {
      const pairs = points.split(' ').map(pair => pair.split(',').map(Number))
      return { x: Math.min(...pairs.map(p => p[0])), y: Math.min(...pairs.map(p => p[1])) }
    }
    return { x: Number(node.getAttribute('x')), y: Number(node.getAttribute('y')) }
  })
  return { svg, width, height, boxes }
}

const overlapping = (boxes: { x: number; y: number }[]) => boxes.flatMap((a, i) =>
  boxes.slice(i + 1).filter(b => Math.abs(a.x - b.x) < W && Math.abs(a.y - b.y) < H))

describe('layout', () => {
  it('puts a chain in one column, a step per layer', () => {
    const { boxes, width } = draw('flowchart TD\n  a --> b\n  b --> c')

    expect(boxes.map(box => box.x)).toEqual([boxes[0].x, boxes[0].x, boxes[0].x])
    expect(boxes[1].y).toBeGreaterThan(boxes[0].y + H)
    expect(boxes[2].y).toBeGreaterThan(boxes[1].y + H)
    expect(width).toBeLessThan(W * 2)
  })

  it('puts a branch side by side, centred under what it came from', () => {
    // The whole reason to lay a flow out rather than list it: two paths out of
    // one decision are two paths, and a column of four would not say so.
    const { boxes } = draw('flowchart TD\n  a --> b\n  a --> c')

    const [root, left, right] = boxes
    expect(left.y).toBe(right.y)
    expect(right.x - left.x).toBeGreaterThanOrEqual(W)
    expect(root.x + W / 2).toBeCloseTo((left.x + right.x + W) / 2, 5)
  })

  it('lays a left-to-right flow out along the other axis', () => {
    const { boxes, width, height } = draw('graph LR\n  a --> b\n  b --> c')

    expect(boxes.map(box => box.y)).toEqual([boxes[0].y, boxes[0].y, boxes[0].y])
    expect(boxes[2].x).toBeGreaterThan(boxes[0].x + W)
    expect(width).toBeGreaterThan(height)
  })

  it('keeps a left-to-right flow apart and inside its frame', () => {
    // Stepped by the box's height rather than its width, each box landed 112px
    // after one 176px wide: every neighbour overlapping, and the last one drawn
    // past the edge of the viewBox.
    const { boxes, width, height } = draw('flowchart LR\n  a --> b\n  b --> c\n  c --> d\n  b --> e')

    expect(overlapping(boxes)).toEqual([])
    for (const box of boxes) {
      expect(box.x + W).toBeLessThanOrEqual(width)
      expect(box.y + H).toBeLessThanOrEqual(height)
    }
  })

  it('never puts two boxes on top of each other', () => {
    const { boxes } = draw([
      'flowchart TD',
      '  cron[/"codequery cron"/] --> pull(["Connector.pull"])',
      '  pull --> hash{"content hash changed?"}',
      '  hash -->|"yes"| upsert["_upsert_code_file"]',
      '  upsert --> objects[("objects")]',
      '  upsert --> chunks[("chunks")]',
      '  chunks --> zoekt[["Zoekt shard"]]',
    ].join('\n'))

    expect(boxes).toHaveLength(7)
    expect(overlapping(boxes)).toEqual([])
  })

  it('keeps every box inside the viewBox it declares', () => {
    // A node outside it is simply invisible, and nothing else in the page shows
    // that something is missing.
    const { boxes, width, height } = draw(
      'flowchart TD\n  a --> b\n  a --> c\n  a --> d\n  b --> e')

    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + W).toBeLessThanOrEqual(width)
      expect(box.y + H).toBeLessThanOrEqual(height)
    }
  })

  it('settles a cycle instead of laying out forever', () => {
    // A retry loop is a legitimate flow, and a longest-path layering has no
    // answer for one — so it stops rather than not terminating.
    const { boxes } = draw('flowchart TD\n  a --> b\n  b --> c\n  c --> a')

    expect(boxes).toHaveLength(3)
    expect(overlapping(boxes)).toEqual([])
  })
})

describe('labels', () => {
  it('wraps a long label rather than letting it leave its box', () => {
    const { svg } = draw('flowchart TD\n  a["replace_code_chunks writes one chunk per span"]')

    const lines = [...svg.querySelectorAll('.mf-label')].map(node => node.textContent!)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(23)
  })

  it('breaks an unbreakable token across lines rather than overflowing', () => {
    // A path or a qualified symbol is the common long label here, and it has no
    // spaces to break on.
    const { svg } = draw('flowchart TD\n  a["commonindex/workers/codequery.py::_upsert_code_file"]')

    const lines = [...svg.querySelectorAll('.mf-label')].map(node => node.textContent!)
    expect(lines.join('')).toBe('commonindex/workers/codequery.py::_upsert_code_file')
    expect(lines.length).toBeLessThanOrEqual(3)
  })

  it('marks a label it had to cut, so a truncation does not read as a name', () => {
    const { svg } = draw(
      `flowchart TD\n  a["${'commonindex/gateway/codesearch.py::_authorized_hits'.repeat(3)}"]`)

    const lines = [...svg.querySelectorAll('.mf-label')].map(node => node.textContent!)
    expect(lines).toHaveLength(3)
    expect(lines[2].endsWith('…')).toBe(true)
  })

  it('draws an arrowhead whose marker id is its own', () => {
    // Two diagrams on one page sharing a marker id is how the second one loses
    // its arrows when the first is removed from the DOM.
    const one = draw('flowchart TD\n  a --> b').svg
    const two = draw('flowchart TD\n  c --> d').svg
    const idOf = (svg: SVGElement) => svg.querySelector('marker')!.getAttribute('id')

    expect(idOf(one)).not.toBe(idOf(two))
    expect(one.querySelector('.mf-edge')!.getAttribute('marker-end'))
      .toBe(`url(#${idOf(one)})`)
  })
})
