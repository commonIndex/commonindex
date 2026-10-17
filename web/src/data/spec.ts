import type { DesignElement, DesignScreen } from './gateway'

type Spec = { tokens?: unknown; screens: DesignScreen[] }

/** Where an element is, as indices into the tree: `[2]` is the third element on
 *  the screen, `[2, 0]` its first child.
 *
 *  Addressed by position rather than by id because an id does not identify an
 *  element. Nothing enforces uniqueness — the shipped marketing template uses
 *  `b1` on both of its screens — and scoping edits to one screen only narrowed
 *  the problem: two elements with one id INSIDE a screen still edited together,
 *  so the panel showed one button's text and saving rewrote the other's. With
 *  direct manipulation that stops being an edge case, because grabbing a box
 *  and watching a different box move is the first thing anybody would try. */
export type Path = number[]

export const samePath = (a: Path | undefined, b: Path | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((n, i) => n === b[i])

export function elementAt(
  spec: Spec | undefined, screenId: string, path: Path,
): DesignElement | undefined {
  const screen = spec?.screens?.find(s => s.id === screenId)
  let els = screen?.elements
  let found: DesignElement | undefined
  for (const i of path) {
    found = els?.[i]
    if (!found) return undefined
    els = found.children
  }
  return found
}

/** The list `path` lives in, rebuilt by `f`. Returns the original array when
 *  `f` reports no change, so an untouched branch keeps its identity and the
 *  diff a reviewer reads contains the edit and nothing else. */
function inList(
  els: DesignElement[], path: Path, f: (list: DesignElement[], i: number) => DesignElement[],
): DesignElement[] {
  const [i, ...rest] = path
  if (i === undefined || i < 0 || i >= els.length) return els
  if (rest.length === 0) return f(els, i)
  const kids = els[i].children
  if (!kids) return els
  const next = inList(kids, rest, f)
  if (next === kids) return els
  const out = els.slice()
  out[i] = { ...els[i], children: next }
  return out
}

function inScreen(
  spec: Spec, screenId: string, f: (els: DesignElement[]) => DesignElement[],
): Spec {
  let touched = false
  const screens = spec.screens.map(s => {
    if (s.id !== screenId) return s
    const before = s.elements ?? []
    const after = f(before)
    if (after === before) return s
    touched = true
    return { ...s, elements: after }
  })
  return touched ? { ...spec, screens } : spec
}

/** Replace one element's fields, leaving everything else exactly as it was.
 *
 *  A patch that changes nothing returns the spec it was given, by identity. The
 *  caller leans on that: a drag that ends where it started, or a resize handle
 *  nudged and put back, must not write a revision saying something happened. */
export function patchAt(
  spec: Spec, screenId: string, path: Path, patch: Partial<DesignElement>,
): Spec {
  return inScreen(spec, screenId, els => inList(els, path, (list, i) => {
    const cur = list[i]
    const keys = Object.keys(patch) as (keyof DesignElement)[]
    if (keys.every(k => cur[k] === patch[k])) return list
    const out = list.slice()
    out[i] = { ...cur, ...patch }
    return out
  }))
}

export function removeAt(spec: Spec, screenId: string, path: Path): Spec {
  return inScreen(spec, screenId, els => inList(els, path, (list, i) => {
    const out = list.slice()
    out.splice(i, 1)
    return out
  }))
}

function usedIds(els: DesignElement[], into = new Set<string>()): Set<string> {
  for (const e of els) {
    into.add(e.id)
    if (e.children?.length) usedIds(e.children, into)
  }
  return into
}

/** Copy an element in beside itself, under an id nothing else is using.
 *
 *  Ids still have to be distinct even though nothing depends on them for
 *  addressing: `goto` names a screen, `cites` names a token, and a person
 *  reading the diff needs to tell two buttons apart. */
export function duplicateAt(
  spec: Spec, screenId: string, path: Path,
): { spec: Spec; path: Path } {
  const screen = spec.screens.find(s => s.id === screenId)
  const taken = usedIds(screen?.elements ?? [])
  const fresh = (id: string) => {
    let n = 2
    let next = `${id}-copy`
    while (taken.has(next)) next = `${id}-copy${n++}`
    taken.add(next)
    return next
  }
  const rename = (e: DesignElement): DesignElement => ({
    ...e,
    id: fresh(e.id),
    children: e.children?.map(rename),
  })

  const next = inScreen(spec, screenId, els => inList(els, path, (list, i) => {
    const out = list.slice()
    out.splice(i + 1, 0, rename(list[i]))
    return out
  }))
  return { spec: next, path: [...path.slice(0, -1), path[path.length - 1] + 1] }
}

/** Where the element carrying this id currently sits, if anywhere.
 *
 *  An index path is a position, not an identity: delete something earlier and
 *  every later path now names its neighbour. A held edit addressed that way
 *  lands on whatever moved into the slot — silently, and with a revision note
 *  naming the element it did not touch. Ids are not unique enough to address
 *  by, which is why paths are used for editing; they are unique enough to
 *  CHECK with, which is all this is for. */
export function pathOfId(
  spec: Spec | undefined, screenId: string, id: string,
): Path | undefined {
  const els = spec?.screens?.find(s => s.id === screenId)?.elements ?? []
  for (let i = 0; i < els.length; i++) {
    if (els[i].id === id) return [i]
    const kids = els[i].children ?? []
    for (let j = 0; j < kids.length; j++) if (kids[j].id === id) return [i, j]
  }
  return undefined
}

/** Put a new element on a screen, or inside a container on it.
 *
 *  Several roles draw furniture when they have no children — a nav paints a
 *  mark and three grey links, a list paints rows, a tabbar paints tabs. It
 *  looks like content and is not: none of it is in the spec, so none of it can
 *  be selected, moved or recoloured. Adding a real child is how that furniture
 *  becomes something you can actually hold, because a container with children
 *  lays those out instead. */
export function addTo(
  spec: Spec, screenId: string, parent: Path | null, el: Omit<DesignElement, 'id'>,
): { spec: Spec; path: Path } {
  const screen = spec.screens.find(s => s.id === screenId)
  const taken = usedIds(screen?.elements ?? [])
  let id: string = el.role
  for (let n = 2; taken.has(id); n++) id = `${el.role}${n}`
  const made = { ...el, id } as DesignElement

  if (!parent || parent.length === 0) {
    const at = (screen?.elements ?? []).length
    return {
      spec: inScreen(spec, screenId, els => [...els, made]),
      path: [at],
    }
  }
  let at = 0
  const next = inScreen(spec, screenId, els => inList(els, parent, (list, i) => {
    const kids = list[i].children ?? []
    at = kids.length
    const out = list.slice()
    out[i] = { ...list[i], children: [...kids, made] }
    return out
  }))
  return { spec: next, path: next === spec ? parent : [...parent, at] }
}

/** Move a child to sit before the element currently at `before`.
 *
 *  What dragging means for an element in flow: its position is its container's
 *  to decide, so the thing a person can change is the order. Giving it x and y
 *  instead would take it out of the layout, which is the opposite of what the
 *  container is for.
 *
 *  `before` is an index into the list AS IT STANDS — the same index the drop
 *  indicator is drawn at — and `list.length` means the end. Splicing removes
 *  the element first, which shifts every later index down by one, so an
 *  insertion index taken straight from the indicator put the element one slot
 *  past where the indicator said. Every downward drag landed wrong and every
 *  upward one was fine, which two tests over a two-child container could not
 *  tell apart.
 */
export function reorderAt(
  spec: Spec, screenId: string, parent: Path, from: number, before: number,
): Spec {
  const move = (list: DesignElement[]): DesignElement[] => {
    if (from < 0 || from >= list.length) return list
    const where = Math.max(0, Math.min(list.length, before))
    // Before itself and before the one after it are both where it already is.
    if (where === from || where === from + 1) return list
    const out = list.slice()
    const [moved] = out.splice(from, 1)
    out.splice(where > from ? where - 1 : where, 0, moved)
    return out
  }
  if (parent.length === 0) return inScreen(spec, screenId, move)
  return inScreen(spec, screenId, els => inList(els, parent, (list, i) => {
    const kids = list[i].children
    if (!kids) return list
    const moved = move(kids)
    if (moved === kids) return list
    const out = list.slice()
    out[i] = { ...list[i], children: moved }
    return out
  }))
}

/** Add a screen, at the size of the one before it or the surface's own.
 *
 *  Nothing in the editor could add or remove a screen, and `designs.propose`
 *  accepts `screens: []` — so a design could be created in a state it could
 *  never leave: the artboard said "this spec has no screens", every tool was
 *  disabled, and there was no control anywhere to make one. */
export function addScreen(spec: Spec, size: { w: number; h: number }): Spec {
  const taken = new Set(spec.screens.map(s => s.id))
  let id = `s${spec.screens.length + 1}`
  for (let n = spec.screens.length + 2; taken.has(id); n++) id = `s${n}`
  const last = spec.screens[spec.screens.length - 1]
  return {
    ...spec,
    screens: [...spec.screens, {
      id,
      name: `Screen ${spec.screens.length + 1}`,
      w: last?.w ?? size.w,
      h: last?.h ?? size.h,
      elements: [],
    }],
  }
}

export function removeScreen(spec: Spec, screenId: string): Spec {
  const screens = spec.screens.filter(s => s.id !== screenId)
  return screens.length === spec.screens.length ? spec : { ...spec, screens }
}

export function renameScreen(spec: Spec, screenId: string, name: string): Spec {
  let touched = false
  const screens = spec.screens.map(s => {
    if (s.id !== screenId || s.name === name) return s
    touched = true
    return { ...s, name }
  })
  return touched ? { ...spec, screens } : spec
}

/** Move an element up or down the stack.
 *
 *  Everything the toolbar places carries coordinates, so nothing ever entered
 *  the reorder path and stacking was document order — settable only by
 *  deleting and redrawing. With overlapping boxes one drag away, this is the
 *  first thing anybody reaches for. */
export function restackAt(spec: Spec, screenId: string, path: Path, by: number): {
  spec: Spec; path: Path
} {
  if (path.length !== 1) return { spec, path }
  const els = spec.screens.find(s => s.id === screenId)?.elements ?? []
  const to = Math.max(0, Math.min(els.length - 1, path[0] + by))
  if (to === path[0]) return { spec, path }
  // `reorderAt` takes the index to insert BEFORE, in the list as it stands.
  return { spec: reorderAt(spec, screenId, [], path[0], to > path[0] ? to + 1 : to),
           path: [to] }
}
