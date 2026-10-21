import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { Formatter } from '../Formatter/Formatter'
import type { FormatOptions } from '../Formatter/Formatter'

const formatter = new Formatter()

function format(source: string, options: FormatOptions = {}): string {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  return formatter.format(model.redRoot!, options)
}

describe('Formatter — markup is not deleted', () => {
  it('keeps a single inline tag', () => {
    expect(format('[b]Hello[/b]')).toBe('[b]Hello[/b]')
  })

  it('keeps nested tags and attributes', () => {
    expect(format('[color=#ff0000][b]Hi[/b] there[/color]'))
      .toBe('[color=#ff0000][b]Hi[/b] there[/color]')
  })

  it('keeps list items and quotes', () => {
    expect(format('[list][*]one[*]two[/list]')).toBe('[list][*]one[*]two[/list]')
    // The exporter quotes a free-text attribute; that is its canonical form.
    expect(format('[quote=Ana]hola[/quote]')).toBe('[quote="Ana"]hola[/quote]')
  })

  it('preserves blank lines by default', () => {
    expect(format('one\n\ntwo')).toBe('one\n\ntwo')
  })

  it('canonicalises tag casing and keeps content', () => {
    expect(format('[B]Hola[/B]')).toBe('[b]Hola[/b]')
  })

  it('returns an empty string for an empty document', () => {
    expect(format('')).toBe('')
  })
})

describe('Formatter — options', () => {
  const source = 'intro\n\n\n\n[heading]Title[/heading]\ntext  here\n\nnext'

  it('collapseEmptyLines keeps one blank line outside code', () => {
    expect(format('a\n\n\n\nb', { collapseEmptyLines: true })).toBe('a\n\nb')
  })

  it('collapseEmptyLines does not touch a code block', () => {
    const code = '[code]a\n\n\n\nb[/code]'
    expect(format(code, { collapseEmptyLines: true })).toBe(code)
  })

  it('normalizeInlineWhitespace collapses runs outside tags only', () => {
    expect(format('[b]a    b[/b]   c', { normalizeInlineWhitespace: true }))
      .toBe('[b]a b[/b] c')
    expect(format('[box=A    Title]x[/box]', { normalizeInlineWhitespace: true }))
      .toBe('[box=A    Title]x[/box]')
  })

  it('normalizeInlineWhitespace leaves code indentation alone', () => {
    const code = '[code]    indented[/code]'
    expect(format(code, { normalizeInlineWhitespace: true })).toBe(code)
  })

  it('blockNewlines separates a block from preceding text', () => {
    expect(format('intro[heading]Title[/heading]', { blockNewlines: true }))
      .toBe('intro\n\n[heading]Title[/heading]')
  })

  it('blockNewlines does not insert into a code block', () => {
    const source = 'x\n[code][heading]literal[/heading][/code]'
    expect(format(source, { blockNewlines: true }))
      .toBe('x\n[code][heading]literal[/heading][/code]')
  })

  it('combines options independently', () => {
    const formatted = format(source, {
      collapseEmptyLines: true,
      normalizeInlineWhitespace: true,
      blockNewlines: true,
    })
    expect(formatted).toContain('[heading]Title[/heading]')
    expect(formatted).not.toMatch(/\n{3,}/)
    expect(formatted).toContain('text here')
  })
})

describe('Formatter — determinism and idempotence', () => {
  const docs = [
    '[b]a[/b] [i]b[/i]\n\n[c]x  y[/c]',
    '[quote=Ana][list][*]one[*]two[/list][/quote]',
    '[box=My Title]\n\n[heading]H[/heading]\n\nbody\n\n[/box]',
    '[code]  spaced\n\n\ncode[/code]',
  ]
  const optionSets: FormatOptions[] = [
    {},
    { collapseEmptyLines: true },
    { normalizeInlineWhitespace: true },
    { blockNewlines: true },
    { collapseEmptyLines: true, normalizeInlineWhitespace: true, blockNewlines: true },
  ]

  it.each(docs)('is a fixed point: %s', source => {
    for (const options of optionSets) {
      const once = format(source, options)
      const twice = format(once, options)
      expect(twice, JSON.stringify(options)).toBe(once)
    }
  })

  it('produces byte-identical output across repeated runs', () => {
    for (const source of docs) {
      expect(format(source, { blockNewlines: true })).toBe(format(source, { blockNewlines: true }))
    }
  })
})
