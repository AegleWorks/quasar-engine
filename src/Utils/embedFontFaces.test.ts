import { describe, expect, it } from 'vitest'
import { embedFontFaces, familyNames, parseUnicodeRange, selectFontFaces, weightRank, type FontFaceSource } from './embedFontFaces'

const face = (over: Partial<FontFaceSource>): FontFaceSource => ({
  family: 'Torus', weight: [400, 400], style: 'normal', ranges: [], url: 'https://x/Torus-Regular.otf', format: 'opentype', ...over,
})

const SOURCES: FontFaceSource[] = [
  face({}),
  face({ weight: [600, 600], url: 'https://x/Torus-SemiBold.otf' }),
  face({ weight: [800, 800], url: 'https://x/Torus-Heavy.otf' }),
  face({ family: 'Noto', ranges: [[0x0000, 0x00ff]], url: 'https://x/noto-latin.woff2', format: 'woff2' }),
  face({ family: 'Noto', ranges: [[0x3040, 0x309f]], url: 'https://x/noto-kana.woff2', format: 'woff2' }),
]

describe('embedFontFaces', () => {
  it('reads family lists and unicode ranges as CSS writes them', () => {
    expect(familyNames('"Torus", Inter , sans-serif')).toEqual(['torus', 'inter', 'sans-serif'])
    expect(parseUnicodeRange('U+0000-00FF, U+0131, U+4??')).toEqual([[0, 0xff], [0x131, 0x131], [0x400, 0x4ff]])
  })

  it('takes the first family the page defines, at the weight CSS would pick', () => {
    const pick = (weight: number) =>
      selectFontFaces({ family: 'Missing, Torus, sans-serif', weight, style: 'normal', text: 'Ghost' }, SOURCES).map((f) => f.url)
    expect(pick(600)).toEqual(['https://x/Torus-SemiBold.otf'])
    // Above 500 a missing weight looks heavier first, below 400 lighter
    // first, and 400–500 up to 500, then lighter (CSS Fonts 4).
    expect(pick(700)).toEqual(['https://x/Torus-Heavy.otf'])
    expect(pick(500)).toEqual(['https://x/Torus-Regular.otf'])
    expect(pick(300)).toEqual(['https://x/Torus-Regular.otf'])
  })

  it('ranks a weight range that covers the wanted weight first', () => {
    expect(weightRank(650, [100, 900])).toBe(0)
    expect(weightRank(450, [500, 500])).toBeLessThan(weightRank(450, [400, 400]))
  })

  it('keeps only the unicode-range slices the text falls in', () => {
    const picked = selectFontFaces({ family: 'Noto', weight: 400, style: 'normal', text: 'abc' }, SOURCES)
    expect(picked.map((f) => f.url)).toEqual(['https://x/noto-latin.woff2'])
  })

  it('inlines each file once as a data URI and leaves out the ones that fail', async () => {
    const fetched: string[] = []
    const fakeFetch = (async (url: string) => {
      fetched.push(url)
      if (url.includes('Heavy')) return new Response(null, { status: 404 })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'font/otf' } })
    }) as unknown as typeof fetch
    const css = await embedFontFaces([
      { family: 'Torus', weight: 400, style: 'normal', text: 'a' },
      { family: 'Torus', weight: 500, style: 'normal', text: 'b' },
      { family: 'Torus', weight: 900, style: 'normal', text: 'c' },
    ], fakeFetch, SOURCES)
    expect(fetched.sort()).toEqual(['https://x/Torus-Heavy.otf', 'https://x/Torus-Regular.otf'])
    expect(css).toBe('@font-face{font-family:"Torus";font-style:normal;font-weight:400;src:url(data:font/otf;base64,AQID) format("opentype");}')
  })
})
