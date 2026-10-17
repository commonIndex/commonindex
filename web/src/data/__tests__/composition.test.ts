/** Editing a composition without code: scenes, timing, words. */
import { describe, expect, it } from 'vitest'
import { duplicate, move, parse, remove, setDuration, setText } from '../composition'

const HTML = `<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">
  <div class="clip" data-start="0" data-duration="10"><div class="ground"></div></div>
  <section class="clip" data-start="0" data-duration="3"><h1>Hello</h1><p>first</p></section>
  <section class="clip" data-start="3" data-duration="4"><h2>Middle</h2><div><span>nested <b>bold</b></span></div></section>
  <section class="clip" data-start="7" data-duration="3"><h1>Goodbye</h1></section>
</div>`

describe('a composition, as scenes', () => {
  it('reads scenes in time order, leaving the backdrop out', () => {
    const p = parse(HTML)!
    expect(p.duration).toBe(10)
    expect(p.scenes.map(s => [s.label, s.start, s.duration])).toEqual([['Hello', 0, 3], ['Middle', 3, 4], ['Goodbye', 7, 3]])
    expect(parse(HTML.replace('<h1>Hello</h1>', '<h1>One <span>two</span></h1>'))!.scenes[0].label).toBe('One two')
    expect(parse(HTML.replace('<h1>Hello</h1>', '<h1><span style="display:block">One</span><span>two</span>, three.</h1>'))!.scenes[0].label).toBe('One two, three.')
    expect(p.scenes[0].texts.map(t => t.text)).toEqual(['Hello', 'first'])
  })

  it('lengthening a scene moves the ones after it, and the end, and the backdrop', () => {
    const p = parse(setDuration(HTML, 1, 6))!
    expect(p.scenes.map(s => [s.start, s.duration])).toEqual([[0, 3], [3, 6], [9, 3]])
    expect(p.duration).toBe(12)
    expect(setDuration(HTML, 1, 6)).toContain('data-start="0" data-duration="12"')
  })

  it('reorders, duplicates and deletes, keeping scenes end to end', () => {
    expect(parse(move(HTML, 2, -1))!.scenes.map(s => [s.label, s.start])).toEqual([['Hello', 0], ['Goodbye', 3], ['Middle', 6]])
    expect(parse(duplicate(HTML, 0))!.scenes.map(s => [s.label, s.start])).toEqual([['Hello', 0], ['Hello', 3], ['Middle', 6], ['Goodbye', 10]])
    const gone = parse(remove(HTML, 1))!
    expect([gone.scenes.map(s => s.label), gone.duration]).toEqual([['Hello', 'Goodbye'], 6])
  })

  it('changes a scene’s words and nothing else', () => {
    const scene = parse(HTML)!.scenes[0]
    const next = setText(HTML, 0, scene.texts[0].index, 'Hi there')
    expect(parse(next)!.scenes[0].texts.map(t => t.text)).toEqual(['Hi there', 'first'])
    expect(parse(next)!.scenes[1].label).toBe('Middle')
  })

  it.each([false, true])('preserves styles, scripts, and siblings for full document=%s', full => {
    const head = '<style>h1 { color: red }</style><script>window.example = 1</script>'
    const html = full ? '<!doctype html><html lang="en"><head>' + head + '</head><body>' + HTML + '<!--after--></body></html>' : head + HTML + '<!--after-->'
    for (const result of [setText(html, 0, 0, 'Changed'), setDuration(html, 0, 5), duplicate(html, 0), remove(html, 0), move(html, 0, 1)]) {
      expect(result).toContain(head)
      expect(result).toContain('<!--after-->')
      if (full) expect(result).toContain('<html lang="en">')
    }
  })

  it('keeps cleared heading and span fields editable at the same index', () => {
    let html = HTML.replace('<h1>Hello</h1>', '<h1><span>Hello</span></h1>')
    const index = parse(html)!.scenes[0].texts[0].index
    html = setText(html, 0, index, '')
    expect(parse(html)!.scenes[0].texts[0]).toMatchObject({ index, text: '' })
    expect(parse(setText(html, 0, index, 'Back'))!.scenes[0].label).toBe('Back')
  })

  it('does not hide a remaining scene as a full-duration background', () => {
    const html = remove(remove(HTML, 2), 1)
    expect(parse(html)!.scenes).toHaveLength(1)
    expect(parse(setDuration(html, 0, 5))!.scenes[0]).toMatchObject({ label: 'Hello', duration: 5 })
    expect(parse('<div data-composition-id="main" data-duration="3"><section data-start="0" data-duration="3"><h1>Only scene</h1></section></div>')!.scenes).toHaveLength(1)
  })

  it('assigns unique duplicate IDs and rewires local label, SVG, and anchor references', () => {
    const html = HTML.replace('<h1>Hello</h1>', '<h1 id="title">Hello</h1><label for="field">Name</label><input id="field"><a href="#title">Top</a><svg aria-labelledby="title"><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect></svg>')
      .replace('<section class="clip"', '<section id="scene" class="clip"')
    const doc = new DOMParser().parseFromString(duplicate(duplicate(html, 0), 0), 'text/html')
    const ids = [...doc.querySelectorAll('[id]')].map(el => el.id)
    expect(new Set(ids).size).toBe(ids.length)
    const copy = doc.querySelector('#scene-copy-3')!
    expect(copy.querySelector('label')!.htmlFor).toBe('field-copy-3')
    expect(copy.querySelector('a')!.getAttribute('href')).toBe('#title-copy-3')
    expect(copy.querySelector('svg')!.getAttribute('aria-labelledby')).toBe('title-copy-3')
    expect(copy.querySelector('rect')!.getAttribute('fill')).toBe('url(#paint-copy-3)')
  })

  it('ignores non-finite duration input', () => {
    expect(setDuration(HTML, 0, NaN)).toBe(HTML)
    expect(setDuration(HTML, 0, Infinity)).toBe(HTML)
  })

  it('exposes each part of a mixed heading in reading order without flattening its span', () => {
    let html = HTML.replace('<h1>Hello</h1>', '<h1>Agents work <span class="accent">beside you.</span> Today.</h1>')
    const fields = parse(html)!.scenes[0].texts
    expect(fields.slice(0, 3).map(t => t.text)).toEqual(['Agents work ', 'beside you.', ' Today.'])
    const prefix = fields[0]
    html = setText(html, 0, prefix.index, '', prefix.node)
    expect(parse(html)!.scenes[0].texts[0]).toMatchObject({ text: '', node: 0 })
    html = setText(html, 0, prefix.index, ' ', prefix.node)
    expect(parse(html)!.scenes[0].texts[0].text).toBe(' ')
    html = setText(html, 0, prefix.index, 'People work ', prefix.node)
    expect(parse(html)!.scenes[0].label).toBe('People work beside you. Today.')
    expect(html).toContain('<span class="accent">beside you.</span> Today.')
  })
})
