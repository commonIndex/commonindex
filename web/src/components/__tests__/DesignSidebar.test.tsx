import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSidebar, type InspectorTab } from '../DesignSidebar'

function media(compact: boolean) {
  const listeners = new Set<() => void>()
  const query = { matches: compact, addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return (matches: boolean) => { query.matches = matches; act(() => listeners.forEach(fn => fn())) }
}
function Sidebar({ selectionKey, reviewing = false }: { selectionKey?: string; reviewing?: boolean }) {
  const [tab, setTab] = useState<InspectorTab>('properties')
  return <DesignSidebar active={tab} onChange={setTab} selectionKey={selectionKey} reviewing={reviewing}
    ai={<section aria-label="AI">AI prompt</section>} header={<b>Selection</b>}
    actions={<button>Duplicate</button>} notices={null} layers={<p>Layer list</p>}
    properties={<textarea aria-label="Edit text" defaultValue="Draft" />} design={<p>History</p>} />
}
afterEach(() => vi.unstubAllGlobals())

describe('collapsible design inspector', () => {
  it('collapses on compact viewports and preserves drafts when reopened', async () => {
    media(true)
    const u = userEvent.setup()
    render(<Sidebar />)
    expect(screen.queryByRole('textbox', { name: 'Edit text' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Show inspector' }))
    const field = screen.getByRole('textbox', { name: 'Edit text' })
    fireEvent.change(field, { target: { value: 'Keep this draft' } })
    await u.click(screen.getByRole('button', { name: 'Hide inspector' }))
    expect(screen.queryByRole('textbox', { name: 'Edit text' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Show inspector' }))
    expect(screen.getByRole('textbox', { name: 'Edit text' })).toBe(field)
    expect(field).toHaveProperty('value', 'Keep this draft')
  })

  it('opens for a new selection and makes room for the AI review on compact screens', () => {
    media(true)
    const { rerender } = render(<Sidebar />)
    rerender(<Sidebar selectionKey="screen:0" />)
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeTruthy()
    rerender(<Sidebar selectionKey="screen:0" reviewing />)
    expect(screen.getByRole('button', { name: 'Show inspector' })).toBeTruthy()
    rerender(<Sidebar selectionKey="screen:1" />)
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeTruthy()
  })

  it('collapses with Escape outside text fields and returns focus to its toggle', async () => {
    media(true)
    const u = userEvent.setup()
    render(<Sidebar selectionKey="screen:0" />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit text' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    await u.keyboard('{Escape}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show inspector' }))
  })

  it('responds to viewport changes and keeps selection actions outside the scroll area', () => {
    const resize = media(false)
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Selection actions' }).closest('.drail-scroll')).toBeNull()
    resize(true)
    expect(screen.getByRole('button', { name: 'Show inspector' })).toBeTruthy()
    resize(false)
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeTruthy()
  })
})
