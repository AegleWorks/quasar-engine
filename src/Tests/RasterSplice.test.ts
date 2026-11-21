import { describe, expect, it } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { collectRasterNodes, hashRasterNode, rasterImageBBCode, spliceRasterImages } from '../Raster/rasterTags'

const URL = 'https://hxovc.s-ul.eu/8maTVUz6'
const IMG = rasterImageBBCode(URL)

/** Splice every raster node of `source` with the same URL. */
function splice(source: string): string {
  const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot
  return spliceRasterImages(source, root, () => URL)
}

describe('spliceRasterImages', () => {
  it('gives back the newline [/centre] swallows, so the blank line under the card stays', () => {
    // osu! publishes `[/centre]\n\n` as `</div><br />`: one newline eaten
    // (osu-harness). The card ate none, so the image needs one more.
    expect(splice('a\n\n[profilecard user=hxovc]text[/profilecard]\n\n[size=150]b[/size]'))
      .toBe(`a\n\n${IMG}\n\n\n[size=150]b[/size]`)
  })

  it('gives back a single newline too', () => {
    expect(splice('[profilecard user=hxovc][/profilecard]\nb')).toBe(`${IMG}\n\nb`)
  })

  it('adds nothing when no newline follows the card', () => {
    expect(splice('[profilecard user=hxovc][/profilecard]b')).toBe(`${IMG}b`)
    expect(splice('a\n[progress=50][/progress]')).toBe(`a\n${IMG}`)
  })

  it('counts a CRLF as one newline', () => {
    expect(splice('[progress=50][/progress]\r\n\r\nb')).toBe(`${IMG}\n\r\n\r\nb`)
  })

  it('splices every card back to front and leaves the ones without a URL as written', () => {
    const source = '[progress=10][/progress]\n[progress=20][/progress]\nend'
    const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot
    const [first] = collectRasterNodes(root)
    const firstHash = hashRasterNode(first, source)
    const out = spliceRasterImages(source, root, (hash) => (hash === firstHash ? URL : undefined))
    expect(out).toBe(`${IMG}\n\n[progress=20][/progress]\nend`)
  })
})
