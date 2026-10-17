import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DesignScreenNavigator, DesignTools, DesignZoomControls, EditorPopover } from '../DesignEditorControls'
import { designScreenScale } from '../DesignCanvas'

const screens = [
  { id: 'home', name: 'Home', w: 1280, h: 900, elements: [] },
  { id: 'review', name: 'Review details', w: 1280, h: 900, elements: [] },
]

describe('editor controls', () => {
  it('closes a disclosure on Escape and returns focus to its trigger', async () => {
    const u = userEvent.setup()
    render(<EditorPopover label="Export">{() => <button>Download</button>}</EditorPopover>)
    const trigger = screen.getByRole('button', { name: 'Export' })
    await u.click(trigger)
    await u.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Download' }))
    await u.keyboard('{Escape}')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on outside interaction and when focus leaves', async () => {
    const u = userEvent.setup()
    render(<><EditorPopover label="Help">{() => <button>Inside</button>}</EditorPopover><button>Outside</button></>)
    const trigger = screen.getByRole('button', { name: 'Help' })
    await u.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await u.click(trigger)
    await u.tab()
    await u.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses friendly names while passing the existing role to the drawing tool', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    render(<DesignTools tool={null} onChange={onChange} disabled={false} />)
    await u.click(screen.getByRole('button', { name: 'Text' }))
    await u.click(screen.getByRole('button', { name: 'Paragraph' }))
    expect(onChange).toHaveBeenCalledWith('body')
    expect(screen.queryByRole('button', { name: 'Paragraph' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Text' }))
  })

  it('searches and navigates screens with the keyboard', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    render(<DesignScreenNavigator screens={screens} current="home" onChange={onChange}
      overview={false} onOverview={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Previous screen' })).toHaveProperty('disabled', true)
    await u.click(screen.getByTitle('Choose a screen'))
    const search = screen.getByRole('searchbox', { name: 'Search screens' })
    expect(document.activeElement).toBe(search)
    await u.type(search, 'review')
    await u.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('review')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('shows an empty result without changing screens', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    render(<DesignScreenNavigator screens={screens} current="review" onChange={onChange}
      overview={false} onOverview={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Next screen' })).toHaveProperty('disabled', true)
    await u.click(screen.getByTitle('Choose a screen'))
    await u.type(screen.getByRole('searchbox'), 'missing{Enter}')
    expect(screen.getByText(/No screens match/)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables navigation and overview for an empty design', () => {
    render(<DesignScreenNavigator screens={[]} onChange={vi.fn()} overview={false} onOverview={vi.fn()} />)
    for (const button of screen.getAllByRole('button')) expect(button).toHaveProperty('disabled', true)
  })

  it('offers fit and actual-size zoom with bounded incremental steps', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<DesignZoomControls zoom="screen" scale={.55} onChange={onChange} disabled={false} />)
    await u.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(onChange).toHaveBeenLastCalledWith(.65)
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: 'Fit width' }))
    expect(onChange).toHaveBeenLastCalledWith('width')
    await u.click(screen.getByTitle('Canvas zoom'))
    await u.click(screen.getByRole('button', { name: '100%' }))
    expect(onChange).toHaveBeenLastCalledWith(1)
    rerender(<DesignZoomControls zoom={.1} scale={.1} onChange={onChange} disabled={false} />)
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveProperty('disabled', true)
    rerender(<DesignZoomControls zoom={3} scale={3} onChange={onChange} disabled={false} />)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true)
  })

  it('fits the whole screen including browser or device chrome', () => {
    expect(designScreenScale(screens[0], 'web', 640)).toBe(.5)
    expect(designScreenScale(screens[0], 'web', 640, 234)).toBe(.25)
    expect(designScreenScale({ ...screens[0], w: 390, h: 844 }, 'mobile', 416, 460)).toBe(.5)
  })
})
