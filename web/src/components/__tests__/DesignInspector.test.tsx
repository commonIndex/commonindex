import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DesignInspector } from '../DesignInspector'
import { DesignSidebar, type InspectorTab } from '../DesignSidebar'
import { appliedColour, DesignScreenView, typography } from '../DesignCanvas'
import type { DesignElement, DesignTokens } from '../../data/gateway'

const tokens: DesignTokens = {
  'color.text': { $value: '#172e29', $type: 'color' },
  'color.muted': { $value: '#556e67', $type: 'color' },
  'color.accent': { $value: '#126857', $type: 'color' },
  'color.surface': { $value: '#eef5f3', $type: 'color' },
  'font.size.body': { $value: 16, $type: 'dimension' },
  'font.size.heading': { $value: '32px', $type: 'dimension' },
}
const body: DesignElement = { id: 'note', role: 'body', text: 'Review the request', tone: 'muted', cites: 'color.text', w: 350, h: 64 }

function Editor({ initial = body }: { initial?: DesignElement }) {
  const [element, setElement] = useState(initial)
  return <><DesignInspector element={element} tokens={tokens} paletteReady placed={false} canHold={false}
    screens={[]} onChange={patch => setElement(e => ({ ...e, ...patch }))} />
    <DesignScreenView screen={{ id: 's', name: 'Screen', w: 390, h: 844, elements: [element] }} tokens={tokens} />
  </>
}
const drawn = () => document.querySelector('[data-el="note"]') as HTMLElement

describe('compact element properties', () => {
  it('lets a decimal line height be typed without changing intermediate digits', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    const input = screen.getByLabelText('Line height')
    await u.type(input, '0.9')
    expect(input).toHaveProperty('value', '0.9')
    expect(drawn().style.lineHeight).toBe('0.9')
  })

  it('preserves decimal sizes during entry and normalizes out-of-range input on blur', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    const input = screen.getByLabelText('Size (px)')
    await u.type(input, '12.5')
    expect(input).toHaveProperty('value', '12.5')
    expect(drawn().style.fontSize).toBe('12.5px')
    await u.clear(input)
    await u.type(input, '999')
    expect(input).toHaveProperty('value', '999')
    expect(drawn().style.fontSize).toBe('240px')
    await u.tab()
    expect(input).toHaveProperty('value', '240')
    await u.clear(input)
    expect(drawn().style.fontSize).toBe('16px')
  })

  it('normalizes the visible input when saving with the keyboard', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    const input = screen.getByLabelText('Line height')
    await u.type(input, '0.4')
    expect(input).toHaveProperty('value', '0.4')
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    expect(input).toHaveProperty('value', '0.8')
    expect(drawn().style.lineHeight).toBe('0.8')
  })

  it('does not lose a leading minus sign in a position field', async () => {
    const u = userEvent.setup()
    const onChange = vi.fn()
    render(<DesignInspector element={{ ...body, x: 0, y: 0 }} tokens={tokens} paletteReady placed canHold={false}
      screens={[]} onChange={onChange} />)
    const input = screen.getByLabelText('X')
    await u.clear(input)
    await u.type(input, '-24')
    expect(input).toHaveProperty('value', '-24')
    expect(onChange).toHaveBeenLastCalledWith({ x: -24 })
  })


  it('reports the applied muted token separately from the provenance citation', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    const applied = screen.getByLabelText('Applied colour')
    expect(within(applied).getByText('color.muted')).toBeTruthy()
    expect(drawn().style.color).toBe('rgb(85, 110, 103)')
    await u.click(screen.getByText(/^Provenance/))
    expect(screen.getByLabelText('Cites')).toHaveProperty('value', 'color.text')
    expect(screen.getByText(/This does not set colour or typography/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Accent' }))
    expect(screen.getByLabelText('Cites')).toHaveProperty('value', 'color.text')
    expect(within(applied).getByText('color.accent')).toBeTruthy()
  })

  it('edits paragraphs with line breaks and previews them immediately', () => {
    render(<Editor />)
    const input = screen.getByRole('textbox', { name: 'Text' })
    expect(input.tagName).toBe('TEXTAREA')
    fireEvent.change(input, { target: { value: 'First line\nSecond line' } })
    expect(drawn().textContent).toBe('First line\nSecond line')
    expect(drawn().style.whiteSpace).toBe('pre-wrap')
    expect(input.style.height).toBe('76px')
  })

  it('links a px size token, overrides it, and restores it when size is cleared', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    await u.selectOptions(screen.getByLabelText('Text style'), 'font.size.heading')
    expect(drawn().style.fontSize).toBe('32px')
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '24' } })
    expect(drawn().style.fontSize).toBe('24px')
    expect(screen.getByText(/Custom size/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Size (px)'), { target: { value: '' } })
    expect(drawn().style.fontSize).toBe('32px')
    expect(screen.getByLabelText('Text style')).toHaveProperty('value', 'font.size.heading')
  })

  it('controls weight, alignment and line height and can reset just typography', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    await u.selectOptions(screen.getByLabelText('Weight'), '700')
    await u.selectOptions(screen.getByLabelText('Alignment'), 'right')
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.8' } })
    expect(drawn().style.fontWeight).toBe('700')
    expect(drawn().style.textAlign).toBe('right')
    expect(drawn().style.lineHeight).toBe('1.8')
    await u.click(screen.getByRole('button', { name: 'Reset typography' }))
    expect(drawn().style.fontWeight).toBe('400')
    expect(drawn().style.textAlign).toBe('left')
    expect(drawn().textContent).toBe(body.text)
    expect(screen.getByLabelText('Cites')).toHaveProperty('value', 'color.text')
  })

  it('explains missing colour and typography tokens instead of claiming a live link', () => {
    render(<Editor initial={{ ...body, color: 'color.missing', textStyle: 'font.size.missing' }} />)
    expect(screen.getByText(/Size token unavailable/)).toBeTruthy()
    expect(screen.getByText(/color.missing is unavailable/)).toBeTruthy()
    expect(drawn().style.fontSize).toBe('16px')
    expect(within(screen.getByLabelText('Applied colour')).getByText('color.muted')).toBeTruthy()
  })

  it('uses compact layout and prototype labels without indented field rows', async () => {
    const u = userEvent.setup()
    render(<Editor />)
    expect(screen.getByText('Position managed by parent.')).toBeTruthy()
    expect(screen.queryByLabelText('X')).toBeNull()
    await u.click(screen.getByText(/^Prototype/))
    expect(screen.getByRole('option', { name: 'No link' })).toBeTruthy()
    expect(screen.getByLabelText('Links to').closest('.fld-row')).toBeNull()
    expect(screen.getByRole('button', { name: 'On accent' })).toBeTruthy()
  })

  it('keeps image alt text editable and does not pretend to tint image pixels', () => {
    render(<Editor initial={{ ...body, role: 'image', src: 'https://example.com/image.png' }} />)
    expect(screen.getByLabelText('Alt text')).toHaveProperty('value', body.text)
    expect(screen.getByText(/Colour comes from the image/)).toBeTruthy()
    expect(screen.queryByLabelText('Applied colour')).toBeNull()
  })

  it('does not produce a fake edit when the active colour role is chosen', () => {
    const onChange = vi.fn()
    render(<DesignInspector element={{ ...body, tone: 'accent' }} tokens={tokens} paletteReady
      placed={false} canHold={false} screens={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accent' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('renderer and inspector share applied styles', () => {
  it.each([
    ['body', undefined, 'color.muted'], ['heading', undefined, 'color.text'],
    ['button', 'muted', 'color.surface'], ['badge', 'muted', 'color.surface'],
    ['logo', undefined, 'color.accent'], ['card', undefined, 'color.border'],
  ] as const)('resolves %s / %s to %s', (role, tone, source) => {
    expect(appliedColour({ ...body, role, tone }, tokens).source).toBe(source)
  })

  it('follows changes to linked tokens but preserves an explicit size override', () => {
    const element = { ...body, textStyle: 'font.size.heading' }
    const changed = { ...tokens, 'font.size.heading': { $value: 40 } }
    expect(typography(element, tokens).fontSize).toBe(32)
    expect(typography(element, changed).fontSize).toBe(40)
    expect(typography({ ...element, fontSize: 20 }, changed).fontSize).toBe(20)
    expect(typography({ ...element, fontSize: NaN }, changed).fontSize).toBe(40)
  })

  it('applies typography inside a container, not just to absolute elements', () => {
    const { container } = render(<DesignScreenView tokens={tokens} screen={{ id: 's', name: 'Nested', w: 390, h: 844,
      elements: [{ id: 'card', role: 'card', children: [{ ...body, fontSize: 21, fontWeight: 500, textAlign: 'center' }] }] }} />)
    const child = container.querySelector('[data-path="0.0"]') as HTMLElement
    expect(child.style.fontSize).toBe('21px')
    expect(child.style.fontWeight).toBe('500')
    expect(child.style.textAlign).toBe('center')
  })
})

describe('sidebar navigation', () => {
  function Sidebar() {
    const [tab, setTab] = useState<InspectorTab>('layers')
    return <DesignSidebar active={tab} onChange={setTab} selectionKey="screen:0" header={<b>Selected element</b>}
      notices={null} layers={<span>Layer tree</span>} properties={<Editor />} design={<span>History</span>} />
  }

  it('supports arrow/Home/End navigation with one active accessible panel', async () => {
    const u = userEvent.setup()
    render(<Sidebar />)
    const layers = screen.getByRole('tab', { name: 'Layers' })
    layers.focus()
    await u.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Properties' }))
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByRole('tabpanel', { name: 'Properties' })).toBeTruthy()
    await u.keyboard('{End}')
    expect(screen.getByRole('tabpanel', { name: 'Design' })).toBeTruthy()
    await u.keyboard('{Home}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Design' }).getAttribute('aria-selected')).toBe('true')
    expect(document.querySelectorAll('.drail-scroll')).toHaveLength(1)
  })

  it('keeps edits mounted when changing tabs', async () => {
    const u = userEvent.setup()
    render(<Sidebar />)
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Text' }), { target: { value: 'Still here' } })
    await u.click(screen.getByRole('tab', { name: 'Layers' }))
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull()
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveProperty('value', 'Still here')
  })

  it('restores each tab’s scroll position instead of restarting the layer tree', async () => {
    const u = userEvent.setup()
    render(<Sidebar />)
    const scroll = document.querySelector('.drail-scroll') as HTMLDivElement
    scroll.scrollTop = 240
    fireEvent.scroll(scroll)
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    expect(scroll.scrollTop).toBe(0)
    scroll.scrollTop = 80
    fireEvent.scroll(scroll)
    await u.click(screen.getByRole('tab', { name: 'Layers' }))
    expect(scroll.scrollTop).toBe(240)
    await u.click(screen.getByRole('tab', { name: 'Properties' }))
    expect(scroll.scrollTop).toBe(80)
  })
})
