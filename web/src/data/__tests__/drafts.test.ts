import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, loadDraft, saveDraft, type DesignDraft } from '../drafts'

const KEY = 'commonindex.designs.draft.v1'

const generated = {
  title: 'Settings', surface: 'mobile' as const,
  spec: { screens: [{ id: 's1', name: 'Settings', w: 390, h: 844, elements: [] }] },
  cites: [], grounded_in: null, rationale: '', generated_by: 'claude-opus-5',
  usage: { input_tokens: 10, output_tokens: 20 }, note: '',
}

const draft = (over: Partial<DesignDraft> = {}): Omit<DesignDraft, 'at'> => ({
  mode: 'brief', brief: 'a settings screen', title: '', surface: 'mobile' as const,
  screens: 1, pickId: null, turns: ['a settings screen'], generated,
  ...over,
})

/** Write a stored value directly, to stand in for an older build, a hand edit,
 *  or a half-written key — every way real storage differs from one this test
 *  just filled in itself. */
const stored = (v: unknown) => localStorage.setItem(KEY, JSON.stringify(v))

beforeEach(() => localStorage.clear())

describe('the unfiled draft', () => {
  it('keeps an independent layout style by ID, including when selected before a layout', () => {
    saveDraft(draft({ mode: 'template', brief: '', generated: null, turns: [], styleId: 'system-ink' }))
    expect(loadDraft()?.styleId).toBe('system-ink')
    expect(loadDraft()?.pickId).toBeNull()
    expect(JSON.parse(localStorage.getItem(KEY)!)).not.toHaveProperty('tokens')
  })

  it('reads older drafts without an independent style and rejects a non-string style ID', () => {
    stored({ ...draft(), at: new Date().toISOString() })
    expect(loadDraft()?.styleId).toBeNull()
    stored({ ...draft(), at: new Date().toISOString(), styleId: { id: 'system-ink' } })
    expect(loadDraft()?.styleId).toBeNull()
  })

  it('comes back after a reload', () => {
    saveDraft(draft())
    const back = loadDraft()
    expect(back?.brief).toBe('a settings screen')
    expect(back?.generated?.spec.screens[0].id).toBe('s1')
    expect(back?.turns).toEqual(['a settings screen'])
  })

  it('records when it was saved, so the banner can say how old it is', () => {
    saveDraft(draft())
    expect(Date.now() - Date.parse(loadDraft()!.at)).toBeLessThan(5_000)
  })

  it('keeps the template as an id, not a copy of the template', () => {
    saveDraft(draft({ pickId: 'design-abc' }))
    expect(loadDraft()?.pickId).toBe('design-abc')
    // A citation resolves against the live object; a stored copy would be the
    // drift the citation exists to prevent.
    expect(JSON.parse(localStorage.getItem(KEY)!)).not.toHaveProperty('pick')
  })

  it('is gone once it is filed', () => {
    saveDraft(draft())
    clearDraft()
    expect(loadDraft()).toBeNull()
  })

  it('is not written at all when there is nothing to resume', () => {
    saveDraft(draft({ brief: '', generated: null, turns: [] }))
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('stops being stored when the panel is emptied', () => {
    saveDraft(draft())
    saveDraft(draft({ brief: '', generated: null, turns: [] }))
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('keeps a template and a name with no brief, which is the whole of that panel', () => {
    saveDraft(draft({ mode: 'template', brief: '', generated: null, turns: [],
                      title: 'Refunds flow', pickId: 'design-tmpl' }))
    const back = loadDraft()
    // Restored into the half it was typed in: the name field does not exist in
    // the other one, so the mode is part of the draft rather than a preference.
    expect(back?.mode).toBe('template')
    expect(back?.title).toBe('Refunds flow')
    expect(back?.pickId).toBe('design-tmpl')
  })

  it('falls back to describing it when the stored mode is not one of the two', () => {
    stored({ ...draft(), at: new Date().toISOString(), mode: 'freehand' })
    expect(loadDraft()?.mode).toBe('brief')
  })
})

describe('what comes back is untrusted', () => {
  it('drops a key that is not JSON', () => {
    localStorage.setItem(KEY, '{"brief": "half a wr')
    expect(loadDraft()).toBeNull()
  })

  it('forgets it, rather than failing to parse it again on every reload', () => {
    localStorage.setItem(KEY, 'not json')
    loadDraft()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('drops a draft older than the window', () => {
    stored({ ...draft(), at: new Date(Date.now() - 15 * 86_400_000).toISOString() })
    expect(loadDraft()).toBeNull()
  })

  it('keeps one inside it', () => {
    stored({ ...draft(), at: new Date(Date.now() - 13 * 86_400_000).toISOString() })
    expect(loadDraft()?.brief).toBe('a settings screen')
  })

  it('drops a surface the renderer has no frame for', () => {
    stored({ ...draft(), at: new Date().toISOString(), surface: 'watch' })
    expect(loadDraft()).toBeNull()
  })

  it('drops a spec with no screens array, which would render as nothing', () => {
    stored({ ...draft(), at: new Date().toISOString(),
             generated: { ...generated, spec: { tokens: {} } } })
    expect(loadDraft()?.generated).toBeNull()
  })

  it('keeps the brief when only the generated half is unusable', () => {
    // The brief cost nothing and the generation cost tokens, but a brief that
    // survives is a panel you can press Generate in.
    stored({ brief: 'a settings screen', at: new Date().toISOString(),
             surface: 'mobile', screens: 1, pickId: null, turns: [], generated: 'nope' })
    const back = loadDraft()
    expect(back?.brief).toBe('a settings screen')
    expect(back?.generated).toBeNull()
  })

  it('clamps a screen count that would be refused by the gateway', () => {
    stored({ ...draft(), at: new Date().toISOString(), screens: 99 })
    expect(loadDraft()?.screens).toBe(6)
  })

  it('drops non-strings out of the turn list', () => {
    stored({ ...draft(), at: new Date().toISOString(), turns: ['one', 2, null, 'three'] })
    expect(loadDraft()?.turns).toEqual(['one', 'three'])
  })

  it('reports nothing rather than an empty draft when every field is junk', () => {
    stored({ at: new Date().toISOString(), surface: 'mobile' })
    expect(loadDraft()).toBeNull()
  })
})

describe('a browser that refuses storage', () => {
  it('does not take the panel down when reading throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(() => loadDraft()).not.toThrow()
    expect(loadDraft()).toBeNull()
    spy.mockRestore()
  })

  it('does not take the panel down when the quota is full', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(() => saveDraft(draft())).not.toThrow()
    spy.mockRestore()
  })

  it('does not take the panel down when clearing throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(() => clearDraft()).not.toThrow()
    spy.mockRestore()
  })
})
