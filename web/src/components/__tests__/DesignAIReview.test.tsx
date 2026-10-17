import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GeneratedDesign, WireDesign } from '../../data/gateway'
import { DesignAIReview, designChangeSummary, type AIProposal } from '../DesignAIReview'

const base: WireDesign['spec'] = { tokens: { 'color.bg': { $value: '#fff', $type: 'color' } }, screens: [
  { id: 'first', name: 'First', w: 600, h: 400, elements: [{ id: 'heading', role: 'heading', text: 'Original' }] },
  { id: 'removed', name: 'Removed screen', w: 600, h: 400, elements: [] },
] }
const after: WireDesign['spec'] = { tokens: {}, screens: [
  { ...base.screens[0], elements: [{ ...base.screens[0].elements![0], text: 'Proposed heading' }] },
  { id: 'added', name: 'New screen', w: 600, h: 400, elements: [] },
] }
const proposal: AIProposal = { base, revision: 3, brief: 'Improve this design', scope: 'Whole design',
  generated: { spec: after, rationale: 'An explanation' } as GeneratedDesign }

describe('AI proposal comparison', () => {
  it('computes actual changed, added, removed screens and token changes', () => {
    const summary = designChangeSummary(base, after)
    expect(summary.changed.map(s => s.id)).toEqual(['first'])
    expect(summary.added.map(s => s.id)).toEqual(['added'])
    expect(summary.removed.map(s => s.id)).toEqual(['removed'])
    expect(summary.tokensChanged).toBe(true)
    expect(summary.hasChanges).toBe(true)
  })

  it('ignores object property order but detects screen and element reordering', () => {
    const reorderedKeys = JSON.parse(JSON.stringify(base))
    reorderedKeys.screens[0] = { elements: base.screens[0].elements, h: 400, w: 600, name: 'First', id: 'first' }
    expect(designChangeSummary(base, reorderedKeys).hasChanges).toBe(false)
    expect(designChangeSummary(base, { ...base, screens: [...base.screens].reverse() }).reordered).toBe(true)
    const multiple = { ...base, screens: [{ ...base.screens[0], elements: [
      ...base.screens[0].elements!, { id: 'second', role: 'body' as const, text: 'Second' },
    ] }] }
    const reversed = { ...multiple, screens: [{ ...multiple.screens[0], elements: [...multiple.screens[0].elements!].reverse() }] }
    expect(designChangeSummary(multiple, reversed).changed).toHaveLength(1)
    expect(designChangeSummary({ screens: [] }, { tokens: {}, screens: [] }).hasChanges).toBe(false)
  })

  it('compares every affected screen, including additions and removals, with accessible exact specs', async () => {
    const u = userEvent.setup(), onAccept = vi.fn(), onDiscard = vi.fn()
    render(<DesignAIReview proposal={proposal} surface="web" busy={false} outdated={false} error={null}
      onAccept={onAccept} onDiscard={onDiscard} />)
    expect(screen.getByText('1 screen changed')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Compare screen' })).toHaveProperty('value', 'first')
    expect(document.querySelectorAll('.dai-compare-stage[inert][aria-hidden="true"]')).toHaveLength(2)
    await u.selectOptions(screen.getByRole('combobox', { name: 'Compare screen' }), 'added')
    expect(screen.getByText('Screen not present')).toBeTruthy()
    await u.selectOptions(screen.getByRole('combobox', { name: 'Compare screen' }), 'removed')
    expect(screen.getByText('Screen removed')).toBeTruthy()
    await u.click(screen.getByText('Read the exact specs'))
    expect(within(screen.getByRole('region', { name: 'Before spec' })).getByText(/Original/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Proposed spec' })).getByText(/Proposed heading/)).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Accept AI changes' }))
    expect(onAccept).toHaveBeenCalledOnce()
    await u.click(screen.getByRole('button', { name: 'Discard AI changes' }))
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('disables both actions while saving and prevents stale acceptance', () => {
    const props = { proposal, surface: 'web' as const, onAccept: vi.fn(), onDiscard: vi.fn(), error: null }
    const { rerender } = render(<DesignAIReview {...props} busy outdated={false} />)
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Discard AI changes' })).toHaveProperty('disabled', true)
    rerender(<DesignAIReview {...props} busy={false} outdated />)
    expect(screen.getByRole('button', { name: 'Accept AI changes' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Discard AI changes' })).toHaveProperty('disabled', false)
  })
})
