// jsdom implements neither of these, and the chart components use both. Without
// them a test renders fine right up until a panel mounts, then throws from a
// ref callback — which surfaces as "element not found" somewhere unrelated and
// sends you looking in the wrong file.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver

// Charts measure their container; jsdom reports every box as zero, so a width
// of 0 makes marks collapse and disappear from queries. One plausible width
// keeps the geometry real enough to assert against.
if (!Element.prototype.getBoundingClientRect.toString().includes('[native code]0')) {
  const zero = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    const r = zero.call(this)
    return r.width || r.height ? r : ({ ...r.toJSON?.() ?? {}, x: 0, y: 0, top: 0, left: 0,
      right: 800, bottom: 300, width: 800, height: 300, toJSON: () => ({}) } as DOMRect)
  }
}

// The doc editor scrolls its selection into view after a change, and measures
// the text by the cursor with a Range to know where that is. jsdom's Range has
// no geometry at all, so the measurement throws — and when the scroll lands
// after a test's last assertion, it throws outside any test: an unhandled
// error that fails the whole run, blamed on whichever test ran last, and only
// under load. An empty box is the true answer on a page with no layout.
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList }
  Range.prototype.getBoundingClientRect = function () { return new DOMRect() }
}

// jsdom 29 exposes `window.localStorage` as a bare object with none of the
// Storage methods on it, while `Storage` itself is present and looks fine. So
// anything that saves a draft throws `setItem is not a function` from inside
// the catch-everything guard the real code has for browsers that refuse
// storage — the test would pass for the wrong reason and prove nothing.
//
// The methods go on `Storage.prototype` rather than on a lookalike object, so a
// test can still make storage fail the way a private window does by spying on
// the prototype.
if (typeof globalThis.localStorage?.setItem !== 'function') {
  const backing = new WeakMap<object, Map<string, string>>()
  const of = (s: object) => {
    let m = backing.get(s)
    if (!m) backing.set(s, (m = new Map()))
    return m
  }
  const on = (name: string, value: unknown) =>
    Object.defineProperty(Storage.prototype, name, { value, configurable: true, writable: true })

  on('getItem', function (this: object, k: string) { return of(this).get(String(k)) ?? null })
  on('setItem', function (this: object, k: string, v: string) { of(this).set(String(k), String(v)) })
  on('removeItem', function (this: object, k: string) { of(this).delete(String(k)) })
  on('clear', function (this: object) { of(this).clear() })
  on('key', function (this: object, i: number) { return [...of(this).keys()][i] ?? null })
  Object.defineProperty(Storage.prototype, 'length', {
    get(this: object) { return of(this).size }, configurable: true,
  })

  for (const name of ['localStorage', 'sessionStorage']) {
    const s = Object.create(Storage.prototype)
    Object.defineProperty(globalThis, name, { value: s, configurable: true, writable: true })
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, name, { value: s, configurable: true, writable: true })
    }
  }
}

// ProseMirror scrolls the cursor into view after focusing, which measures a
// Range — and jsdom implements neither measuring method on Range. Any test
// that moves the selection programmatically then throws from inside the
// editor's dispatch, after the assertion it was making has already passed.
if (typeof Range !== 'undefined') {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
                        toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect ??= rect
}
