import { describe, expect, it } from 'vitest'
import { collapseSpaces, measure, spaceWidth, type RunStyle } from './OsuTextMeasurer'
import chrome from './__fixtures__/chromeWidths.json'

/**
 * The measurer against Chrome itself: `scripts/composition/measure-chrome.sh`
 * lays every sample out in Inter (osu!'s own files) at osu!'s size and records
 * the span width. One of them, "Unless you dont have a pfp", was also measured
 * on a live osu! userpage: 180.28 px, the same as here.
 *
 * Chrome snaps layout to 1/64 px, so the tolerance is a few of those.
 */
const STYLES: Record<string, RunStyle> = {
  regular: { px: 14 },
  italic: { px: 14, italic: true },
  bold: { px: 14, bold: true },
  boldItalic: { px: 14, bold: true, italic: true },
  size150: { px: 21 },
  size50bold: { px: 7, bold: true },
}


describe('OsuTextMeasurer', () => {
  it.each(chrome.map((c) => [c.style, c.text, c.width] as const))('%s %j is %f px in Chrome', (style, text, width) => {
    // Chrome collapses `'  '` to one space; the samples include such a run.
    const m = measure(collapseSpaces(text), STYLES[style])
    expect(m.unmapped).toEqual([])
    expect(Math.abs(m.width - width)).toBeLessThan(0.08)
  })

  it('counts U+200B as nothing and reports characters Inter lacks', () => {
    expect(measure('a​b', { px: 14 }).width).toBeCloseTo(measure('ab', { px: 14 }).width, 6)
    expect(measure('a一', { px: 14 }).unmapped).toEqual(['一'])
  })

  it('pads in steps of the Inter space', () => {
    expect(spaceWidth()).toBeCloseTo((792 / 2816) * 14, 6)
  })
})
