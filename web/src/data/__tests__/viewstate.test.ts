/**
 * A dashboard view you can paste into a thread.
 *
 * Filter to EMEA over 90 days, send the link, and the person opening it saw
 * the unfiltered 30-day default — while both of you believed you were looking
 * at the same page. Same class as an uncertified badge: two readers, one
 * number, no way to tell they disagree.
 */
import { describe, expect, it } from 'vitest'

import { isRange, parseView, previousSpan, rangeDays, rangeLabel, spanWords, writeView } from '../viewstate'

const p = (s: string) => new URLSearchParams(s)
const str = (v: URLSearchParams) => v.toString()

describe('reading a link', () => {
  it('takes the range and the filters', () => {
    expect(parseView(p('range=90d&f=region~eq~emea'), '30d')).toEqual({
      range: '90d', compare: false, filters: [{ dimension: 'region', op: 'eq', values: ['emea'] }],
    })
  })

  it('takes several filters, and a list inside one', () => {
    const v = parseView(p('f=region~eq~emea&f=arm~in~control|variant'), '30d')
    expect(v.filters).toEqual([
      { dimension: 'region', op: 'eq', values: ['emea'] },
      { dimension: 'arm', op: 'in', values: ['control', 'variant'] },
    ])
  })

  it('takes an operator that binds no value', () => {
    expect(parseView(p('f=region~is_null'), '30d').filters)
      .toEqual([{ dimension: 'region', op: 'is_null', values: [] }])
  })

  it('falls back to the caller default for a window the server would refuse', () => {
    // Offering a range the server 422s on turns a stale link into an error page.
    expect(parseView(p('range=7000d'), '30d').range).toBe('30d')
    expect(parseView(p('range=notanumber'), '30d').range).toBe('30d')
    expect(parseView(p(''), '30d').range).toBe('30d')
    expect(parseView(p('range=2026-08-31..2026-08-01'), '30d').range).toBe('30d')   // backwards
    expect(parseView(p('range=2026-02-30..2026-03-01'), '30d').range).toBe('30d')   // no such day
  })

  it('drops a filter it cannot parse rather than failing the page', () => {
    // A URL is untrusted input that people hand-edit and chat clients truncate.
    // A broken link should open the dashboard, not an error.
    expect(parseView(p('f=&f=region&f=~eq~x'), '30d').filters).toEqual([])
  })

  it('refuses an operator that is not in the table', () => {
    // The one thing parsing is NOT forgiving about: a hand-edited URL must not
    // introduce an operator the compiler would not accept.
    expect(parseView(p("f=region~OR 1=1~x"), '30d').filters).toEqual([])
    expect(parseView(p('f=region~DROP~x'), '30d').filters).toEqual([])
  })

  it('survives a value containing the characters a naive separator would use', () => {
    // `:` and `,` both appear in real values — timestamps and lists — which is
    // why they are not the separators.
    expect(parseView(p('f=label~eq~12:30, sharp'), '30d').filters)
      .toEqual([{ dimension: 'label', op: 'eq', values: ['12:30, sharp'] }])
  })
})

describe('writing a link', () => {
  it('round-trips what it wrote', () => {
    const view = {
      range: '2026-08-01..2026-08-31', compare: true,
      filters: [{ dimension: 'region', op: 'eq' as const, values: ['emea'] },
                { dimension: 'arm', op: 'in' as const, values: ['a', 'b'] }],
    }
    expect(parseView(writeView(p(''), view), '30d')).toEqual(view)
  })

  it('replaces the old filters rather than appending to them', () => {
    // Otherwise removing a filter leaves it in the URL, and reloading brings
    // back a filter the reader deleted.
    const out = writeView(p('range=7d&f=old~eq~1'), { range: '30d', filters: [] })
    expect(str(out)).toBe('range=30d')
  })

  it('leaves anything else on the URL alone', () => {
    const out = writeView(p('tab=panels'), { range: '30d', filters: [] })
    expect(out.get('tab')).toBe('panels')
  })

  it('writes a valueless operator without a trailing separator', () => {
    expect(str(writeView(p(''), {
      range: '30d', filters: [{ dimension: 'region', op: 'is_null', values: [] }],
    }))).toBe('range=30d&f=region%7Eis_null')
  })
})

describe('ranges beyond the presets', () => {
  it('takes a calendar period to date and a span of dates', () => {
    expect(parseView(p('range=mtd&cmp=1'), '30d')).toMatchObject({ range: 'mtd', compare: true })
    expect(parseView(p('range=2026-08-01..2026-08-31'), '30d').range).toBe('2026-08-01..2026-08-31')
    expect(isRange('qtd') && isRange('7d') && !isRange('7 days')).toBe(true)
  })

  it('says each one in words, and counts its days with both ends included', () => {
    expect(rangeLabel('30d')).toBe('Last 30 days')
    expect(rangeLabel('mtd')).toBe('Month to date')
    expect(rangeLabel('2026-08-01..2026-08-31')).toBe('Aug 1 – Aug 31, 2026')
    expect(rangeDays('2026-08-01..2026-08-31')).toBe(31)
    expect(rangeDays('mtd', new Date('2026-09-29T15:00:00Z'))).toBe(29)
  })
})

describe('the previous period, named', () => {
  const now = new Date('2026-10-14T12:00:00Z')
  it('is as long as the range and ends the day before it starts', () => {
    expect(previousSpan('30d', now)).toEqual({ from: '2026-08-16', to: '2026-09-14' })
    expect(previousSpan('2026-09-06..2026-10-14', now)).toEqual({ from: '2026-07-29', to: '2026-09-05' })
    expect(spanWords(previousSpan('30d', now), now)).toBe('Aug 16 – Sep 14')
  })
})
