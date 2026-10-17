/**
 * The query editor.
 *
 * Two copies of this existed, both a bare `<textarea rows={5}>` — about a
 * hundred and thirty pixels, which is four lines of a query and a scrollbar.
 * A saved query joining two tables does not fit in it, and the thing you are
 * editing is the thing you cannot see.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { SqlEditor, type SqlError } from '../SqlEditor'

/** Controlled, like both real callers. */
function Editor({ initial = '', error = null, onRun = () => {} }: {
  initial?: string; error?: SqlError | null; onRun?: () => void
}) {
  const [v, setV] = useState(initial)
  return <SqlEditor label="Query warehouse" value={v} onChange={setV}
    onRun={onRun} error={error} />
}

const box = () => screen.getByRole('textbox', { name: /Query warehouse/ })

describe('room to write in', () => {
  it('opens taller than the four lines it used to give', () => {
    render(<Editor />)
    expect(Number(box().getAttribute('rows'))).toBeGreaterThanOrEqual(9)
  })

  it('grows with the query rather than scrolling it out of sight', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    render(<Editor initial={twenty} />)
    expect(Number(box().getAttribute('rows'))).toBeGreaterThan(20)
  })

  it('stops growing before it takes the whole page', () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    render(<Editor initial={many} />)
    expect(Number(box().getAttribute('rows'))).toBeLessThanOrEqual(30)
  })
})

describe('the parse error', () => {
  const at: SqlError = {
    message: 'Invalid expression / Unexpected token',
    at: { line: 3, col: 5, token: 'fro' },
  }

  it('says where, not just that', () => {
    // The parser knows exactly where it stopped. Repeating "could not parse
    // that SQL" and leaving somebody to find it throws away the one thing it
    // was certain about.
    render(<Editor initial={'select a,\n  b\n  fro t'} error={at} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Line 3, column 5/)
    expect(alert.textContent).toMatch(/near\s*fro/)
  })

  it('marks the line in the gutter', () => {
    const { container } = render(<Editor initial={'a\nb\nc\nd'} error={at} />)
    const marked = container.querySelectorAll('.sqlw-gutter > div.on')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe('3')
  })

  it('marks the box itself, so the eye lands there first', () => {
    const { container } = render(<Editor error={at} />)
    expect(container.querySelector('.sqlw-box.has-error')).toBeTruthy()
    expect(box().getAttribute('aria-invalid')).toBe('true')
  })

  it('still says something when the parser has no position', () => {
    render(<Editor error={{ message: 'relation "t" does not exist' }} />)
    expect(screen.getByRole('alert').textContent).toMatch(/does not exist/)
  })
})

describe('the keyboard', () => {
  it('runs on the shortcut every SQL console has', async () => {
    const onRun = vi.fn()
    render(<Editor initial="select 1" onRun={onRun} />)
    await userEvent.setup().type(box(), '{Meta>}{Enter}{/Meta}')
    expect(onRun).toHaveBeenCalled()
  })

  it('indents with Tab', async () => {
    render(<Editor initial="" />)
    const user = userEvent.setup()
    await user.click(box())
    await user.keyboard('{Tab}x')
    expect((box() as HTMLTextAreaElement).value).toBe('  x')
  })

  it('lets Escape release Tab, so it is not a keyboard trap', async () => {
    // A textarea that swallows Tab is one you can get into and not out of.
    render(<Editor initial="" />)
    const user = userEvent.setup()
    await user.click(box())
    await user.keyboard('{Escape}{Tab}')
    expect(document.activeElement).not.toBe(box())
  })
})

describe('what it tells you about itself', () => {
  it('counts the lines', () => {
    render(<Editor initial={'a\nb\nc'} />)
    expect(screen.getByText(/3 lines/)).toBeTruthy()
  })

  it('numbers only the lines that exist', () => {
    const { container } = render(<Editor initial={'a\nb'} />)
    const nums = Array.from(container.querySelectorAll('.sqlw-gutter > div'))
      .map(d => d.textContent).filter(Boolean)
    expect(nums).toEqual(['1', '2'])
  })
})
