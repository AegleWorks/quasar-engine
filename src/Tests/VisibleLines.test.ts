import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { NAMED_COLORS, normalizeCssColor } from './support/cssColor'
import { visibleLines } from './support/visibleLines'

describe('normalizeCssColor', () => {
  it.each([
    ['red', '#ff0000'], ['RED', '#ff0000'], ['  Pink ', '#ffc0cb'], ['#F00', '#ff0000'], ['#ff0000', '#ff0000'],
    ['#ABCDEF', '#abcdef'], ['rgb(255, 0, 0)', '#ff0000'], ['rgb(255 0 0)', '#ff0000'], ['rgba(0,128,0,1)', '#008000'],
    ['#ff0000ff', '#ff0000'],
  ])('%s -> %s', (input, expected) => expect(normalizeCssColor(input)).toBe(expected))

  it('leaves what it cannot reduce alone, so a real difference stays visible', () => {
    expect(normalizeCssColor('rgba(255,0,0,0.5)')).toBe('rgba(255,0,0,0.5)')
    expect(normalizeCssColor('var(--x)')).toBe('var(--x)')
    expect(normalizeCssColor('notacolor')).toBe('notacolor')
  })

  it('tells different colours apart', () => {
    expect(normalizeCssColor('red')).not.toBe(normalizeCssColor('#ff0001'))
    expect(normalizeCssColor('gray')).toBe(normalizeCssColor('grey'))
    expect(normalizeCssColor('green')).toBe('#008000') // CSS green, not X11 green (#00ff00)
  })

  // The table is typed by hand, so it is checked against the `color-name` package when the monorepo's
  // node_modules is around (Quasar itself has no dependencies); standalone checkouts skip this.
  const colorName = (() => {
    try { return createRequire(join(__dirname, '../../../../noop.js'))('color-name') as Record<string, number[]> } catch { return null }
  })()
  it.skipIf(!colorName)('has exactly the names and values of the CSS keyword table', () => {
    const hex = (rgb: number[]) => '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('')
    const reference = Object.fromEntries(Object.entries(colorName!).map(([name, rgb]) => [name, hex(rgb)]))
    const mine = Object.fromEntries(Object.keys(NAMED_COLORS).map((name) => [name, normalizeCssColor(name)]))
    expect(mine).toEqual(reference)
  })
})

describe('visibleLines', () => {
  const lines = (html: string) => visibleLines(html)

  it('reads a named colour and its hex as the same colour', () => {
    expect(lines('<span style="color:red;">a</span>')).toEqual(lines('<span style="color:#ff0000;">a</span>'))
    expect(lines('<span style="color:#F00;">a</span>')).toEqual(lines('<span style="color:Red;">a</span>'))
  })

  it('still tells two different colours apart', () => {
    expect(lines('<span style="color:red;">a</span>')).not.toEqual(lines('<span style="color:#ff0001;">a</span>'))
  })

  it('keeps a changed font size visible', () => {
    expect(lines('<span style="font-size:10%;">a</span>')).not.toEqual(lines('<span style="font-size:30%;">a</span>'))
  })
})
