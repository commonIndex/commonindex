import { describe, expect, it } from 'vitest'
import { ROLE_CATALOGUE, designToHtml, designToPackage, slug,
         type ExportMeta } from '../exportDesign'

const meta = (over: Partial<ExportMeta> = {}): ExportMeta => ({
  title: 'Checkout — mobile', surface: 'mobile', state: 'draft',
  builtOn: 'Starter · Mobile app', onSystem: { on: 2, total: 3 },
  exportedAt: '2026-09-15', ...over,
})

const vars = { '--sans': 'Helvetica', '--text': '#111', '--muted': '#888' }

describe('designToHtml', () => {
  it('carries the DOM the renderer already drew, not a redrawing of it', () => {
    const html = designToHtml([{ id: 'Cart'.toLowerCase(), name: 'Cart', html: '<div id="drawn"></div>' }], meta(), vars)
    expect(html).toContain('<div id="drawn"></div>')
    expect(html).toContain('Cart')
  })

  it('says what produced it, so a file in a deck traces back to an object', () => {
    const html = designToHtml([], meta(), vars)
    expect(html).toContain('built on Starter · Mobile app')
    expect(html).toContain('exported 2026-09-15 from CommonIndex')
  })

  it('reports drift rather than presenting a draft as finished', () => {
    expect(designToHtml([], meta(), vars))
      .toContain('2 of 3 elements cite a token in this palette; 1 cite nothing')
    expect(designToHtml([], meta({ onSystem: { on: 3, total: 3 } }), vars))
      .toContain('on-system: every element cites a token in this palette')
  })

  it('keeps an unverifiable citation apart from no citation at all', () => {
    // A file that folded them together would say a component citation is drift.
    expect(designToHtml([], meta({ onSystem: { on: 1, total: 3, unverified: 1 } }), vars))
      .toContain('1 of 3 elements cite a token in this palette; '
                 + '1 cite something it does not define; 1 cite nothing')
  })

  it('is standalone: no script, and no network to reach', () => {
    const html = designToHtml([{ id: 'Cart'.toLowerCase(), name: 'Cart', html: '<div></div>' }], meta(), vars)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('resolves the palette into the file', () => {
    expect(designToHtml([], meta(), vars)).toContain('--text: #111;')
  })

  it('escapes a title rather than letting it close a tag', () => {
    const html = designToHtml([], meta({ title: '</title><img onerror=x>' }), vars)
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;/title&gt;')
  })
})

describe('slug', () => {
  it('makes a filename out of a title', () => {
    expect(slug('Checkout — mobile')).toBe('checkout-mobile')
    expect(slug('!!!')).toBe('design')
  })
})

describe('designToPackage', () => {
  const design = {
    id: 'design-abc', title: 'Checkout', surface: 'mobile', state: 'draft',
    current_rev: 3, spec: { screens: [{ id: 's', name: 'Cart', w: 390, h: 844 }] },
  }

  it('carries the exact spec and revision, not a rendering of them', () => {
    const pkg = designToPackage(design, { 'color.accent': { $value: '#0f766e' } },
                                'House style', { on: 3, total: 3 }, '2026-09-15')
    expect(pkg.spec).toBe(design.spec)
    expect(pkg.design.rev).toBe(3)
    expect(pkg.tokensFrom).toBe('House style')
  })

  it('names the closed role vocabulary, so an implementer knows it is the whole list', () => {
    const pkg = designToPackage(design, undefined, null, { on: 0, total: 0 }, '2026-09-15')
    expect(pkg.roles).toContain('button')
    expect(pkg.roles).toContain('tabbar')
    expect(pkg.roles.length).toBe(ROLE_CATALOGUE.length)
  })

  it('tells an agent how to fetch the same thing live rather than trust a file', () => {
    const pkg = designToPackage(design, undefined, null, { on: 0, total: 0 }, '2026-09-15')
    expect(pkg.fetchedWith).toContain('designs.get')
    expect(pkg.fetchedWith).toContain('design-abc')
  })
})

describe('a prototype that still works in the file', () => {
  it('gives each screen an id to be linked to', () => {
    const html = designToHtml(
      [{ id: 'home', name: 'Home', html: '<div></div>' },
       { id: 'pricing', name: 'Pricing', html: '<div></div>' }], meta(), vars)
    expect(html).toContain('<figure id="screen-home">')
    expect(html).toContain('<figure id="screen-pricing">')
  })

  it('escapes an id rather than letting it write markup', () => {
    const html = designToHtml(
      [{ id: 'a"><script>x</script>', name: 'X', html: '' }], meta(), vars)
    expect(html).not.toContain('<script>x')
  })
})
