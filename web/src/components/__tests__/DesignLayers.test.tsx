import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DesignLayers } from '../DesignLayers'
import type { DesignScreen } from '../../data/gateway'

const screens: DesignScreen[] = [
  { id: 'home', name: 'Home', w: 390, h: 844, elements: [
    { id: 'container', role: 'card', text: 'Account', children: [
      { id: 'label', role: 'body', text: 'Account name' },
    ] },
    { id: 'label', role: 'button', text: 'Continue' },
  ] },
  { id: 'finish', name: 'Finish', w: 390, h: 844, elements: [
    { id: 'confirmation', role: 'heading', text: 'All done' },
  ] },
]

describe('Layers', () => {
  it('defaults to the active screen and clears its local search on screen navigation', async () => {
    const u = userEvent.setup()
    const props = { screens, onSelect: vi.fn(), onJump: vi.fn() }
    const { rerender } = render(<DesignLayers {...props} currentScreen="home" />)
    expect(screen.getByRole('combobox', { name: 'Layer scope' })).toHaveProperty('value', 'current')
    expect(screen.queryByRole('button', { name: 'Go to screen Finish' })).toBeNull()
    await u.type(screen.getByRole('searchbox'), 'Account')
    rerender(<DesignLayers {...props} currentScreen="finish" />)
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: /Select heading/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Go to screen Home' })).toBeNull()
  })

  it('keeps all-screen searches when the current screen changes', async () => {
    const u = userEvent.setup()
    const props = { screens, onSelect: vi.fn(), onJump: vi.fn() }
    const { rerender } = render(<DesignLayers {...props} currentScreen="home" />)
    await u.selectOptions(screen.getByRole('combobox', { name: 'Layer scope' }), 'all')
    await u.type(screen.getByRole('searchbox'), 'heading')
    rerender(<DesignLayers {...props} currentScreen="finish" />)
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'heading')
    expect(screen.getByRole('button', { name: /Select heading/ })).toBeTruthy()
  })

  it('folds containers independently and search reveals nested matches without losing the fold', async () => {
    const u = userEvent.setup()
    const onSelect = vi.fn()
    render(<DesignLayers screens={screens} currentScreen="home" onSelect={onSelect} onJump={vi.fn()} />)
    await u.click(screen.getByRole('button', { name: 'Collapse children of Account' }))
    expect(screen.queryByRole('button', { name: /Select body/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Select button/ })).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
    await u.type(screen.getByRole('searchbox'), 'Account name')
    expect(screen.getByRole('button', { name: /Select body/ })).toBeTruthy()
    await u.clear(screen.getByRole('searchbox'))
    expect(screen.queryByRole('button', { name: /Select body/ })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Expand children of Account' }))
    expect(screen.getByRole('button', { name: /Select body/ }).title).toContain('Account name')
    expect(screen.getByRole('button', { name: 'Go to screen Home' }).getAttribute('aria-current')).toBe('page')
  })

  it('selects children and duplicate IDs by their path, not by ID', async () => {
    const onSelect = vi.fn()
    const u = userEvent.setup()
    render(<DesignLayers screens={screens} onSelect={onSelect} onJump={vi.fn()} />)
    await u.click(screen.getByRole('button', { name: 'Select body: Account name on Home' }))
    expect(onSelect).toHaveBeenLastCalledWith({ screen: 'home', path: [0, 0] })
    await u.click(screen.getByRole('button', { name: 'Select button: Continue on Home' }))
    expect(onSelect).toHaveBeenLastCalledWith({ screen: 'home', path: [1] })
  })

  it('reveals the ancestors of a layer selected on the canvas', async () => {
    const u = userEvent.setup()
    const props = { screens, onSelect: vi.fn(), onJump: vi.fn() }
    const { rerender } = render(<DesignLayers {...props} />)
    await u.click(screen.getByRole('button', { name: 'Collapse children of Account' }))
    await u.click(screen.getByRole('button', { name: 'Collapse Home' }))
    rerender(<DesignLayers {...props} selected={{ screen: 'home', path: [0, 0] }} />)
    expect(screen.getByRole('button', { name: /Select body/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('finds nested text while retaining its parent context', async () => {
    const u = userEvent.setup()
    render(<DesignLayers screens={screens} onSelect={vi.fn()} onJump={vi.fn()} />)
    await u.type(screen.getByRole('searchbox'), 'account name')
    expect(screen.getByRole('button', { name: 'Select body: Account name on Home' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select card: Account on Home' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Select button/ })).toBeNull()
  })

  it('searches across collapsed screens and reports no results', async () => {
    const u = userEvent.setup()
    render(<DesignLayers screens={screens} onSelect={vi.fn()} onJump={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Select heading/ })).toBeNull()
    await u.type(screen.getByRole('searchbox'), 'heading')
    expect(screen.queryByRole('button', { name: /Select heading/ })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Search all screens' }))
    expect(screen.getByRole('combobox', { name: 'Layer scope' })).toHaveProperty('value', 'all')
    expect(screen.getByRole('button', { name: /Select heading/ })).toBeTruthy()
    await u.clear(screen.getByRole('searchbox'))
    await u.type(screen.getByRole('searchbox'), 'nonexistent')
    expect(screen.getByText('No layers match your search.')).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Clear layer search' }))
    expect(screen.getByRole('button', { name: /Select button/ })).toBeTruthy()
  })

  it('marks the selected layer and can collapse or jump to a screen', async () => {
    const onJump = vi.fn()
    const u = userEvent.setup()
    render(<DesignLayers screens={screens} selected={{ screen: 'home', path: [0, 0] }}
      onSelect={vi.fn()} onJump={onJump} />)
    expect(screen.getByRole('button', { name: /Select body/ }).getAttribute('aria-pressed')).toBe('true')
    await u.click(screen.getByRole('button', { name: 'Collapse Home' }))
    expect(screen.queryByRole('button', { name: /Select body/ })).toBeNull()
    await u.selectOptions(screen.getByRole('combobox', { name: 'Layer scope' }), 'all')
    await u.click(screen.getByRole('button', { name: 'Go to screen Finish' }))
    expect(onJump).toHaveBeenCalledWith('finish')
  })

  it('cannot change the selection during a save', async () => {
    const onSelect = vi.fn()
    render(<DesignLayers screens={screens} disabled onSelect={onSelect} onJump={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Select body/ }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('collapses the panel without losing its search', async () => {
    const u = userEvent.setup()
    render(<DesignLayers screens={screens} onSelect={vi.fn()} onJump={vi.fn()} />)
    await u.type(screen.getByRole('searchbox'), 'account')
    await u.click(screen.getByRole('button', { name: 'Layers' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Layers' }))
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'account')
  })
})
