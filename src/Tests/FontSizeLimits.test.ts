import { afterEach, describe, expect, it } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { FONT_SIZE_LIMIT, clampFontSizeValue, maxFontSizeFor } from '../Utils/FontSizeLimits'

/**
 * osu! renders `[size]` up to 200. Miliastry follows it; Lyne keeps its range.
 * The ceiling is an engine switch (`FONT_SIZE_LIMIT`), honoured by the renderer
 * and the exporter — never by `sanitizeFontSize`, which every dialect shares.
 */

type Dialect = 'osu' | 'miliastry' | 'lyne'

function render(source: string, dialect: Dialect): string {
  const root = new BBCodeDocumentModel({ source }).redRoot!
  return new HTMLRenderer({ dialect }).render(root)
}

function exportAs(source: string, target: Dialect): string {
  const doc = new BBCodeDocumentModel({ source })
  return new BBCodeExporter(undefined, target).export(doc.root!)
}

describe('font size ceiling', () => {
  const snapshot = { ...FONT_SIZE_LIMIT }
  afterEach(() => {
    Object.assign(FONT_SIZE_LIMIT, snapshot)
  })

  describe('maxFontSizeFor / clampFontSizeValue', () => {
    it('caps osu! and Miliastry at 200 and leaves Lyne without a ceiling', () => {
      expect(maxFontSizeFor('osu')).toBe(200)
      expect(maxFontSizeFor('miliastry')).toBe(200)
      expect(maxFontSizeFor('lyne')).toBeNull()
    })

    it('only lowers values above the ceiling', () => {
      expect(clampFontSizeValue('300', 'osu')).toBe('200')
      expect(clampFontSizeValue('150', 'osu')).toBe('150')
      expect(clampFontSizeValue('200', 'miliastry')).toBe('200')
      expect(clampFontSizeValue('300', 'lyne')).toBe('300')
    })

    it('leaves anything that is not a plain number to the caller', () => {
      expect(clampFontSizeValue('$titleSize', 'osu')).toBe('$titleSize')
    })
  })

  describe('HTML renderer', () => {
    it('renders [size=300] at 200% under osu! and Miliastry', () => {
      expect(render('[size=300]big[/size]', 'osu')).toContain('font-size:200%')
      expect(render('[size=300]big[/size]', 'miliastry')).toContain('font-size:200%')
    })

    it('keeps sizes within the ceiling as written', () => {
      expect(render('[size=150]mid[/size]', 'osu')).toContain('font-size:150%')
    })

    it('does not cap Lyne', () => {
      expect(render('[size=300]big[/size]', 'lyne')).toContain('font-size:300%')
    })
  })

  describe('BBCode exporter', () => {
    it('exports the size the published page will show', () => {
      expect(exportAs('[size=300]big[/size]', 'osu')).toBe('[size=200]big[/size]')
      expect(exportAs('[size=300]big[/size]', 'miliastry')).toBe('[size=200]big[/size]')
    })

    it('keeps Lyne and in-range sizes untouched', () => {
      expect(exportAs('[size=300]big[/size]', 'lyne')).toBe('[size=300]big[/size]')
      expect(exportAs('[size=85]small[/size]', 'osu')).toBe('[size=85]small[/size]')
    })
  })

  describe('the engine switch', () => {
    it('removes the ceiling everywhere when disabled', () => {
      FONT_SIZE_LIMIT.enabled = false
      expect(maxFontSizeFor('osu')).toBeNull()
      expect(render('[size=300]big[/size]', 'osu')).toContain('font-size:300%')
      expect(exportAs('[size=300]big[/size]', 'osu')).toBe('[size=300]big[/size]')
    })
  })
})
