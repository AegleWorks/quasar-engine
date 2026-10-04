import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * A plain gradient previews as one CSS-gradient span in every dialect that has\n * the tag (osu! does not; there it is text): typing
 * into it changes a text node instead of recolouring a span per letter. What
 * CSS cannot express (a waveform, steps) is still painted per letter.
 */

const SOURCE = '[gradient=#FF0000,#0000FF]hello[/gradient]'

function render(dialect: 'miliastry' | 'lyne', source = SOURCE): string {
  const model = new BBCodeDocumentModel({ source, dialect })
  return new HTMLRenderer({ dialect }).render(model.redRoot!)
}

const text = (html: string) => html.replace(/<[^>]*>/g, '')

describe('gradient preview', () => {
  for (const dialect of ['miliastry', 'lyne'] as const) {
    it(`paints a plain gradient as one CSS span in ${dialect}`, () => {
      const html = render(dialect)
      expect(html).toContain('linear-gradient(to right')
      expect(html).toContain('background-clip: text')
      expect(html).not.toMatch(/color:#[0-9a-fA-F]{6}/)
      expect(text(html)).toBe('hello')
    })
  }

  it('keeps line breaks, each with its node id', () => {
    const html = render('miliastry', '[gradient=#FF0000,#0000FF]uno\ndos\n[/gradient]')
    expect(html).toContain('linear-gradient')
    expect(html.match(/<br data-node-id="[^"]+">/g)?.length).toBe(2)
  })

  it('draws a gradient CSS cannot express per letter', () => {
    const html = render('miliastry', '[gradient=#FF0000,#0000FF;wave=sine]hello[/gradient]')
    expect(html).not.toContain('linear-gradient')
    expect(text(html)).toBe('hello')
    expect(html.match(/color:#[0-9a-fA-F]{6}/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('gives each painted break of a per-letter gradient its node id', () => {
    const html = render('miliastry', '[gradient=#FF0000,#0000FF;wave=sine]hola\n[/gradient]')
    expect(html).toMatch(/<br data-node-id="[^"]+">/)
  })
})
