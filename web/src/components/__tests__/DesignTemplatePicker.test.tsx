import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WireDesign } from '../../data/gateway'
import { DesignTemplatePicker, isDesignSystem } from '../DesignTemplatePicker'

const web: WireDesign = {
  id: 'web', key: 'DES-1', title: 'Starter · Marketing site', state: 'approved',
  surface: 'web', template_kind: 'layout', description: 'Landing, pricing, and signup.',
  cites: [], spec: { tokens: { 'color.accent': { $value: '#145da0', $type: 'color' } }, screens: [
    { id: 'home', name: 'Landing', w: 1280, h: 900, elements: [
      { id: 'home-title', role: 'heading', text: 'Work together', x: 80, y: 80, w: 600, h: 80 },
      { id: 'signup', role: 'button', text: 'Get started', x: 80, y: 200, w: 200, h: 48, goto: 'pricing' },
      { id: 'broken', role: 'button', text: 'Broken link', x: 80, y: 260, w: 200, h: 48, goto: 'missing' },
      { id: 'note', role: 'input', text: 'Your note', x: 80, y: 320, w: 300, h: 48 },
    ] },
    { id: 'pricing', name: 'Pricing', w: 1280, h: 900, elements: [
      { id: 'plans', role: 'heading', text: 'Choose your plan', x: 80, y: 80, w: 600, h: 80 },
    ] },
  ] },
}
const mobile: WireDesign = {
  ...web, id: 'mobile', title: 'Starter · Mobile app', surface: 'mobile',
  description: 'Task review and profile.',
  spec: { screens: [{ id: 'tasks', name: 'Tasks', w: 390, h: 844, elements: [] }] },
}
// An older saved system has no catalogue metadata.
const system: WireDesign = {
  ...web, id: 'system', title: 'System · Paper', template_kind: undefined,
  spec: { tokens: { 'color.accent': { $value: '#7733cc', $type: 'color' } },
    screens: [{ id: 'specimen', name: 'Paper', w: 600, h: 420, elements: [] }] },
}
const templates = [system, web, mobile]

function Picker({ mode = 'template', disabled = false, onPick = vi.fn() }: {
  mode?: 'brief' | 'template'; disabled?: boolean; onPick?: (design: WireDesign) => void
}) {
  const [selected, setSelected] = useState<WireDesign | null>(null)
  const [styleId, setStyleId] = useState<string | null>(null)
  return <DesignTemplatePicker templates={templates} selected={selected} mode={mode}
    tokensFor={design => design.spec.tokens} disabled={disabled}
    styleId={styleId} onStylePick={setStyleId}
    onPick={design => { setSelected(design); onPick(design) }} />
}

describe('starter catalogue', () => {
  it('separates system palettes from real screen layouts', () => {
    render(<Picker />)
    expect(within(screen.getByRole('region', { name: 'Starter layouts' }))
      .queryByRole('button', { name: 'System · Paper' })).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Layout style' }))
      .getByRole('button', { name: 'System · Paper' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose Starter · Marketing site' })).toBeTruthy()
    expect(screen.getByText('2 screens')).toBeTruthy()
    expect(screen.getByText('Landing, pricing, and signup.')).toBeTruthy()
  })

  it('keeps compact palettes available when generating from a brief', async () => {
    const onPick = vi.fn()
    render(<Picker mode="brief" onPick={onPick} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'System · Paper' }))
    expect(onPick).toHaveBeenCalledWith(system)
    expect(screen.getByRole('button', { name: 'System · Paper' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('region', { name: 'Template preview' })).toBeNull()
  })

  it('searches descriptions, filters by surface, and recovers from no results', async () => {
    const u = userEvent.setup()
    render(<Picker />)
    await u.click(screen.getByRole('button', { name: 'Mobile' }))
    expect(screen.queryByRole('button', { name: 'Choose Starter · Marketing site' })).toBeNull()
    await u.type(screen.getByRole('searchbox'), 'pricing')
    expect(screen.getByText('No layouts match these filters.')).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Show all layouts' }))
    await u.type(screen.getByRole('searchbox'), 'signup')
    expect(screen.getByRole('button', { name: 'Choose Starter · Marketing site' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Choose Starter · Mobile app' })).toBeNull()
  })

  it('browses every screen without changing the selected template', async () => {
    const u = userEvent.setup()
    const onPick = vi.fn()
    render(<Picker onPick={onPick} />)
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    const preview = screen.getByRole('region', { name: 'Template preview' })
    expect(preview.querySelector('[data-el="home-title"]')).toBeTruthy()
    await u.click(within(preview).getByRole('button', { name: '2. Pricing' }))
    expect(preview.querySelector('[data-el="plans"]')).toBeTruthy()
    expect(preview.querySelector('[data-el="home-title"]')).toBeNull()
    expect(onPick).toHaveBeenCalledTimes(1)
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Mobile app' }))
    expect(screen.getByRole('button', { name: '1. Tasks' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('supports keyboard selection and does not expose inert thumbnail controls', async () => {
    const u = userEvent.setup()
    const onPick = vi.fn()
    render(<Picker onPick={onPick} />)
    const card = screen.getByRole('button', { name: 'Choose Starter · Marketing site' })
    card.focus()
    await u.keyboard(' ')
    expect(onPick).toHaveBeenCalledWith(web)
    expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull()
    expect(document.querySelector('.dtemplate-thumb')?.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('.dtemplate-stage')?.hasAttribute('inert')).toBe(true)
  })

  it('prevents changing templates while a request is in progress', async () => {
    const u = userEvent.setup()
    const onPick = vi.fn()
    render(<Picker disabled onPick={onPick} />)
    const card = screen.getByRole('button', { name: 'Choose Starter · Marketing site' })
    await u.click(card)
    card.focus()
    await u.keyboard('{Enter}')
    expect(onPick).not.toHaveBeenCalled()
    expect(card.tabIndex).toBe(-1)
  })

  it('uses explicit metadata over the legacy title convention', () => {
    expect(isDesignSystem(system)).toBe(true)
    expect(isDesignSystem({ ...system, template_kind: 'layout' })).toBe(false)
    expect(isDesignSystem({ ...web, template_kind: 'system' })).toBe(true)
  })

  it('explains an empty layout library without treating a palette as a layout', () => {
    render(<DesignTemplatePicker templates={[system]} selected={system} mode="template"
      tokensFor={() => undefined} disabled={false} onPick={vi.fn()} />)
    expect(screen.getByText(/No starter layouts are available/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Template preview' })).toBeNull()
  })

  it('changes styles independently without replacing the chosen layout or screen', async () => {
    const u = userEvent.setup()
    const onPick = vi.fn()
    render(<Picker onPick={onPick} />)
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    await u.click(screen.getByRole('button', { name: 'System · Paper' }))
    const preview = screen.getByRole('region', { name: 'Template preview' })
    expect((preview.querySelector('[data-el="signup"]') as HTMLElement).style.background).toBe('rgb(119, 51, 204)')
    await u.click(screen.getByRole('button', { name: '2. Pricing' }))
    await u.click(screen.getByRole('button', { name: /Original style/ }))
    expect(screen.getByRole('button', { name: '2. Pricing' }).getAttribute('aria-pressed')).toBe('true')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('plays links with back/restart, expands, and leaves the source spec untouched', async () => {
    const u = userEvent.setup()
    const original = JSON.stringify(web)
    const onPick = vi.fn()
    render(<Picker onPick={onPick} />)
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    await u.click(screen.getByRole('button', { name: 'Try prototype' }))
    expect(document.querySelector('.dtemplate-stage')?.hasAttribute('inert')).toBe(false)
    await u.type(screen.getByRole('textbox', { name: 'Your note' }), 'Sample feedback')
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveProperty('value', 'Sample feedback')
    await u.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('status').textContent).toContain('Pricing')
    await u.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Get started' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Expand preview' }))
    expect(screen.getByRole('region', { name: 'Template preview' }).className).toContain('expanded')
    await u.click(screen.getByRole('button', { name: 'Get started' }))
    await u.click(screen.getByRole('button', { name: 'Restart' }))
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Get started' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Stop prototype' }))
    expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull()
    expect(JSON.stringify(web)).toBe(original)
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('explains a broken prototype link without leaving the screen', async () => {
    const u = userEvent.setup()
    render(<Picker />)
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Marketing site' }))
    await u.click(screen.getByRole('button', { name: 'Try prototype' }))
    await u.click(screen.getByRole('button', { name: 'Broken link' }))
    expect(screen.getByRole('alert').textContent).toContain('missing')
    expect(screen.getByRole('button', { name: 'Get started' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Choose Starter · Mobile app' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try prototype' })).toBeTruthy()
  })
})
