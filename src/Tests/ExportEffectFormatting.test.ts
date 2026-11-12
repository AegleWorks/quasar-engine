import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

const toOsu = (source: string): string => {
  const model = new BBCodeDocumentModel({ source, dialect: 'lyne', autoAnalyze: false })
  return new BBCodeExporter(model.tagRegistry).export(model.redRoot!, 'osu')
}

/** The text left once every tag is gone. */
const strip = (bbcode: string): string => bbcode.replace(/\[[^\]]*\]/g, '')

describe('osu! export of an effect that wraps other tags', () => {
  it('keeps a size inside a gradient', () => {
    const out = toOsu('[gradient=#6600cc, #fafafa][size=150]Thanks[/size][/gradient]')
    expect(out).toMatch(/^\[size=150\](\[color=#[0-9A-F]{6}\].\[\/color\]){6}\[\/size\]$/)
    expect(out).not.toContain('[gradient')
  })

  it('keeps bold and the line break, painting one ramp across both', () => {
    const out = toOsu('[gradient=#000000, #ffffff][b]ab[/b]\ncd[/gradient]')
    expect(out).toBe(
      '[b][color=#000000]a[/color][color=#555555]b[/color][/b]\n[color=#AAAAAA]c[/color][color=#FFFFFF]d[/color]',
    )
  })

  it('paints the same colours as the plain gradient', () => {
    const plain = toOsu('[gradient=#000000, #ffffff]abcd[/gradient]')
    const wrapped = toOsu('[gradient=#000000, #ffffff][i]abcd[/i][/gradient]')
    expect(wrapped).toBe(`[i]${plain}[/i]`)
  })

  it('leaves an image URL inside a gradient uncoloured', () => {
    const out = toOsu('[gradient=#000000, #ffffff]ab[img]https://x.y/z[/img]cd[/gradient]')
    expect(out).toContain('[img]https://x.y/z[/img]')
  })
})

describe('osu! export of a box title', () => {
  it('expands a gradient in the title', () => {
    const out = toOsu('[box=[size=125][gradient=#080808, #ffffff]About[/gradient][/size]]\nbody[/box]')
    expect(out).not.toContain('[gradient')
    expect(out.startsWith('[box=[size=125][color=')).toBe(true)
    expect(strip(out.slice(0, out.indexOf(']\nbody')))).toBe('About')
  })

  it('writes a title without effects as spelled', () => {
    expect(toOsu('[box=[b]Plain[/b]]\nx[/box]')).toBe('[box=[b]Plain[/b]]\nx[/box]')
  })
})
