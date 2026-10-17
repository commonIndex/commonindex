/**
 * Naming the columns.
 *
 * The collection lists had no header. A row ends in unlabelled numbers —
 * `89%`, `+33.2%`, `−10.9%` — and a reader infers what each one is from the
 * values, which works until two of them are percentages.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { VirtualList } from '../VirtualList'

const rows = [{ id: 'a', n: 89 }, { id: 'b', n: 95 }]

function list(columns?: (string | { label: string; className?: string })[]) {
  return render(
    <VirtualList
      items={rows} rowHeight={40} loading={false} hasMore={false}
      onEndReached={vi.fn()} listClass="list-skill" emptyText="none"
      columns={columns}
      render={r => (<><span className="cell">{r.id}</span>
        <span className="cell r num">{r.n}%</span></>)}
    />,
  )
}

describe('the header', () => {
  it('names each column', () => {
    list(['skill', 'accepted'])
    expect(screen.getByText('skill')).toBeTruthy()
    expect(screen.getByText('accepted')).toBeTruthy()
  })

  it('shares the row grid, so it cannot drift out of alignment', () => {
    // Both carry `.vrow`, and the column template hangs off `.list-* .vrow` —
    // a header with its own widths would line up until somebody changed one.
    const { container } = list(['skill', 'accepted'])
    const head = container.querySelector('.vrow.vhead')!
    expect(head.classList.contains('vrow')).toBe(true)
    expect(head.querySelectorAll('.cell')).toHaveLength(2)
  })

  it('sits outside the scroller, so it does not slide away', () => {
    const { container } = list(['skill', 'accepted'])
    const head = container.querySelector('.vhead')!
    expect(head.closest('[data-testid="vlist"]')).toBeNull()
  })

  it('mirrors the alignment of the column it names', () => {
    // Otherwise `accepted` and `updated` both start at their track's left edge
    // and run into each other — which is how they printed as ACCEPTEDPDATED.
    const { container } = list(['skill', { label: 'accepted', className: 'r' }])
    const cells = container.querySelectorAll('.vhead .cell')
    expect(cells[1].classList.contains('r')).toBe(true)
  })

  it('is hidden from assistive tech, which reads the rows not the chrome', () => {
    const { container } = list(['skill', 'accepted'])
    expect(container.querySelector('.vhead')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('is absent when no columns are named', () => {
    const { container } = list()
    expect(container.querySelector('.vhead')).toBeNull()
  })

  it('is absent over an empty list', () => {
    // Column names above "No skills match this view" label nothing. The empty
    // state is a sentence, not a table.
    const { container } = render(
      <VirtualList
        items={[]} rowHeight={40} loading={false} hasMore={false}
        onEndReached={vi.fn()} listClass="list-skill" emptyText="No skills match this view."
        columns={['skill', 'accepted']} render={() => null}
      />,
    )
    expect(container.querySelector('.vhead')).toBeNull()
    expect(screen.getByText('No skills match this view.')).toBeTruthy()
  })
})
