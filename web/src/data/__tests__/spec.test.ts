import { describe, expect, it } from 'vitest'
import { addScreen, addTo, duplicateAt, elementAt, patchAt, removeAt, removeScreen,
         renameScreen, reorderAt, restackAt, samePath } from '../spec'
import type { DesignScreen } from '../gateway'

const spec = () => ({ screens: [{ id: 's', name: 'S', w: 390, h: 844, elements: [
  { id: 'a', role: 'button' as const, text: 'One', x: 0, y: 0, w: 10, h: 10 },
  { id: 'row', role: 'card' as const, x: 0, y: 20, w: 10, h: 10, children: [
    { id: 'b', role: 'button' as const, text: 'Two' },
    { id: 'c', role: 'button' as const, text: 'Three' }] },
]}]})

/** The case that forced paths: nothing enforces id uniqueness, and the model
 *  emits whatever it emits. Addressed by id, editing one of these edited both
 *  — the panel showed "One" and saving rewrote "Other" too. */
const twins = () => ({ screens: [{ id: 's', name: 'S', w: 10, h: 10, elements: [
  { id: 'b1', role: 'button' as const, text: 'One' },
  { id: 'b1', role: 'button' as const, text: 'Other' },
]}]})

describe('patchAt', () => {
  it('changes one element and leaves the rest identical', () => {
    const before = spec()
    const after = patchAt(before, 's', [0], { text: 'Changed' })
    expect(after.screens[0].elements![0].text).toBe('Changed')
    // the untouched branch is the SAME object, so a diff shows the edit only
    expect(after.screens[0].elements![1]).toBe(before.screens[0].elements![1])
  })

  it('reaches an element inside a container', () => {
    const after = patchAt(spec(), 's', [1, 0], { text: 'Deep' })
    expect(after.screens[0].elements![1].children![0].text).toBe('Deep')
    expect(after.screens[0].elements![1].children![1].text).toBe('Three')
  })

  it('edits exactly one of two elements sharing an id', () => {
    const after = patchAt(twins(), 's', [1], { text: 'Edited' })
    expect(after.screens[0].elements!.map(e => e.text)).toEqual(['One', 'Edited'])
  })

  it('returns the very same spec when the patch changes nothing', () => {
    // What stops a drag that lands where it started from writing a revision
    // saying something happened.
    const before = spec()
    expect(patchAt(before, 's', [0], { x: 0, y: 0 })).toBe(before)
  })

  it('leaves a spec alone when the path is not in it', () => {
    const before = spec()
    expect(patchAt(before, 's', [9], { text: 'x' })).toBe(before)
    expect(patchAt(before, 'other', [0], { text: 'x' })).toBe(before)
    expect(patchAt(before, 's', [0, 4], { text: 'x' })).toBe(before)
  })

  it('edits only the named screen', () => {
    const two = { screens: [
      { id: 'one', name: 'One', w: 10, h: 10,
        elements: [{ id: 'b1', role: 'button' as const, text: 'A' }] },
      { id: 'two', name: 'Two', w: 10, h: 10,
        elements: [{ id: 'b1', role: 'button' as const, text: 'B' }] }] }
    const after = patchAt(two, 'two', [0], { text: 'Edited' })
    expect(after.screens[0].elements![0].text).toBe('A')
    expect(after.screens[1].elements![0].text).toBe('Edited')
    expect(after.screens[0]).toBe(two.screens[0])
  })
})

describe('elementAt', () => {
  it('finds one at the top level and one nested', () => {
    expect(elementAt(spec(), 's', [0])?.text).toBe('One')
    expect(elementAt(spec(), 's', [1, 1])?.text).toBe('Three')
    expect(elementAt(spec(), 's', [5])).toBeUndefined()
    expect(elementAt(spec(), 'ghost', [0])).toBeUndefined()
  })

  it('tells twins apart, which an id cannot', () => {
    expect(elementAt(twins(), 's', [0])?.text).toBe('One')
    expect(elementAt(twins(), 's', [1])?.text).toBe('Other')
  })
})

describe('reorderAt', () => {
  it('moves a child within its container', () => {
    const before = spec()
    const after = reorderAt(before, 's', [1], 1, 0)
    expect(after.screens[0].elements![1].children!.map(c => c.id)).toEqual(['c', 'b'])
    // the sibling branch is untouched, by identity
    expect(after.screens[0].elements![0]).toBe(before.screens[0].elements![0])
  })

  it('moves a top-level element when the parent is the screen itself', () => {
    // `before` is an index in the list as it stands, so moving the first
    // element to the END is "before index 2", not "before index 1".
    const after = reorderAt(spec(), 's', [], 0, 2)
    expect(after.screens[0].elements!.map(e => e.id)).toEqual(['row', 'a'])
  })

  it('is a no-op when it would land back where it came from', () => {
    // Before itself, and before the one after it, are both where it already is.
    const before = spec()
    expect(reorderAt(before, 's', [], 0, 0)).toBe(before)
    expect(reorderAt(before, 's', [], 0, 1)).toBe(before)
  })

  it('does nothing, by identity, when it would land where it started', () => {
    const before = spec()
    expect(reorderAt(before, 's', [1], 0, 0)).toBe(before)
  })

  it('clamps rather than dropping an element off the end', () => {
    const after = reorderAt(spec(), 's', [1], 0, 99)
    expect(after.screens[0].elements![1].children!.map(c => c.id)).toEqual(['c', 'b'])
  })
})

describe('reorderAt, dragged downwards', () => {
  const four = () => ({ screens: [{ id: 's', name: 'S', w: 10, h: 10, elements: [
    { id: 'box', role: 'card' as const, x: 0, y: 0, w: 10, h: 10, children: [
      { id: 'A', role: 'body' as const }, { id: 'B', role: 'body' as const },
      { id: 'C', role: 'body' as const }, { id: 'D', role: 'body' as const }] }] }] })
  const order = (s: { screens: DesignScreen[] }) =>
    s.screens[0].elements![0].children!.map(c => c.id).join('')

  it('lands where the drop indicator said it would', () => {
    // The indicator is drawn on C's leading edge, so the element belongs
    // between B and C. Splicing removes first, which shifts every later index
    // down by one — so inserting at the index the indicator named put it one
    // slot too far, past C. Upward drags were unaffected, which is why two
    // tests over a two-child container never saw it.
    expect(order(reorderAt(four(), 's', [0], 0, 2))).toBe('BACD')
  })

  it('still reaches the end', () => {
    expect(order(reorderAt(four(), 's', [0], 0, 4))).toBe('BCDA')
  })

  it('is unchanged going the other way', () => {
    expect(order(reorderAt(four(), 's', [0], 3, 1))).toBe('ADBC')
  })
})

describe('removeAt', () => {
  it('takes one out and leaves its siblings alone', () => {
    const after = removeAt(spec(), 's', [1, 0])
    expect(after.screens[0].elements![1].children!.map(c => c.id)).toEqual(['c'])
    expect(after.screens[0].elements![0].text).toBe('One')
  })

  it('removes exactly one of two sharing an id', () => {
    const after = removeAt(twins(), 's', [0])
    expect(after.screens[0].elements!.map(e => e.text)).toEqual(['Other'])
  })
})

describe('duplicateAt', () => {
  it('puts the copy next to the original and hands back where it went', () => {
    const { spec: after, path } = duplicateAt(spec(), 's', [0])
    expect(after.screens[0].elements!.map(e => e.id)).toEqual(['a', 'a-copy', 'row'])
    expect(path).toEqual([1])
    expect(elementAt(after, 's', path)?.text).toBe('One')
  })

  it('renames the children too, so a copied container carries no duplicates', () => {
    const { spec: after } = duplicateAt(spec(), 's', [1])
    const copy = after.screens[0].elements![2]
    expect(copy.id).toBe('row-copy')
    expect(copy.children!.map(c => c.id)).toEqual(['b-copy', 'c-copy'])
  })

  it('keeps going past a name already taken', () => {
    const once = duplicateAt(spec(), 's', [0]).spec
    const twice = duplicateAt(once, 's', [0]).spec
    expect(twice.screens[0].elements!.map(e => e.id)).toEqual(['a', 'a-copy2', 'a-copy', 'row'])
  })
})

describe('samePath', () => {
  it('is false for undefined, so nothing is selected by default', () => {
    expect(samePath(undefined, [0])).toBe(false)
    expect(samePath([0], undefined)).toBe(false)
  })

  it('distinguishes a parent from its first child', () => {
    expect(samePath([1], [1, 0])).toBe(false)
    expect(samePath([1, 0], [1, 0])).toBe(true)
  })
})

describe('addTo', () => {
  it('puts a new element on the screen and says where it went', () => {
    const { spec: after, path } = addTo(spec(), 's', null,
      { role: 'button', text: 'New', x: 24, y: 24, w: 160, h: 44 })
    expect(path).toEqual([2])
    expect(elementAt(after, 's', path)?.text).toBe('New')
    expect(after.screens[0].elements!.map(e => e.id)).toEqual(['a', 'row', 'button'])
  })

  it('puts one inside the container that was selected', () => {
    // What makes a nav's three painted grey links into something you can hold:
    // a container with children lays those out instead of drawing furniture.
    const { spec: after, path } = addTo(spec(), 's', [1], { role: 'body', text: 'Link' })
    expect(path).toEqual([1, 2])
    expect(after.screens[0].elements![1].children!.map(c => c.id)).toEqual(['b', 'c', 'body'])
    expect(elementAt(after, 's', path)?.text).toBe('Link')
  })

  it('names it something nothing else on the screen is using', () => {
    let s: ReturnType<typeof addTo>['spec'] = spec()
    for (let i = 0; i < 3; i++) s = addTo(s, 's', null, { role: 'button' }).spec
    expect(s.screens[0].elements!.map(e => e.id))
      .toEqual(['a', 'row', 'button', 'button2', 'button3'])
  })

  it('leaves the rest of the screen identical', () => {
    const before = spec()
    const { spec: after } = addTo(before, 's', null, { role: 'badge' })
    expect(after.screens[0].elements![0]).toBe(before.screens[0].elements![0])
    expect(after.screens[0].elements![1]).toBe(before.screens[0].elements![1])
  })
})

describe('screens', () => {
  const two = () => ({ screens: [
    { id: 's1', name: 'One', w: 390, h: 844, elements: [] },
    { id: 's2', name: 'Two', w: 390, h: 844, elements: [] }] })

  it('adds one at the size of the last, so a set stays consistent', () => {
    const after = addScreen(two(), { w: 10, h: 10 })
    expect(after.screens).toHaveLength(3)
    expect([after.screens[2].w, after.screens[2].h]).toEqual([390, 844])
  })

  it('falls back to the surface size when there is nothing to copy', () => {
    // The case that had no way out at all: a design proposed with no screens.
    const after = addScreen({ screens: [] }, { w: 1280, h: 860 })
    expect([after.screens[0].w, after.screens[0].h]).toEqual([1280, 860])
  })

  it('names it something no other screen is using', () => {
    const odd = { screens: [{ id: 's3', name: 'x', w: 1, h: 1, elements: [] }] }
    expect(addScreen(odd, { w: 1, h: 1 }).screens[1].id).not.toBe('s3')
  })

  it('removes one, and does nothing for an id that is not there', () => {
    expect(removeScreen(two(), 's1').screens.map(s => s.id)).toEqual(['s2'])
    const before = two()
    expect(removeScreen(before, 'ghost')).toBe(before)
  })

  it('renames one, by identity when the name is unchanged', () => {
    expect(renameScreen(two(), 's2', 'Checkout').screens[1].name).toBe('Checkout')
    const before = two()
    expect(renameScreen(before, 's2', 'Two')).toBe(before)
  })
})

describe('restackAt', () => {
  const three = () => ({ screens: [{ id: 's', name: 'S', w: 10, h: 10, elements: [
    { id: 'a', role: 'card' as const, x: 0, y: 0, w: 5, h: 5 },
    { id: 'b', role: 'card' as const, x: 0, y: 0, w: 5, h: 5 },
    { id: 'c', role: 'card' as const, x: 0, y: 0, w: 5, h: 5 }] }] })
  const order = (s: { screens: DesignScreen[] }) =>
    s.screens[0].elements!.map(e => e.id).join('')

  it('brings one forward, and says where it went', () => {
    const { spec: after, path } = restackAt(three(), 's', [0], 1)
    expect(order(after)).toBe('bac')
    expect(path).toEqual([1])
  })

  it('sends one back', () => {
    expect(order(restackAt(three(), 's', [2], -1).spec)).toBe('acb')
  })

  it('stops at the ends rather than falling off them', () => {
    const before = three()
    expect(restackAt(before, 's', [0], -1).spec).toBe(before)
    expect(restackAt(before, 's', [2], 1).spec).toBe(before)
  })

  it('leaves a child alone — its order belongs to its container', () => {
    const nested = { screens: [{ id: 's', name: 'S', w: 10, h: 10, elements: [
      { id: 'box', role: 'card' as const, x: 0, y: 0, w: 5, h: 5,
        children: [{ id: 'k', role: 'body' as const }] }] }] }
    expect(restackAt(nested, 's', [0, 0], 1).spec).toBe(nested)
  })
})
