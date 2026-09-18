import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLDocumentModel } from '../HTML/HTMLDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

/**
 * A copied osu! userpage carries only osu-web's markup: no node ids, no
 * `<details>`. Rendering under `dialect: 'osu'` produces that same markup, so
 * reading it back must return the source.
 */
function roundTrip(source: string): string {
  const root = new BBCodeDocumentModel({ source }).redRoot!
  const html = new HTMLRenderer({ dialect: 'osu' }).render(root).replace(/ data-node-id="[^"]*"/g, '')
  return new BBCodeExporter().export(HTMLDocumentModel.fromHTML(html).redRoot!)
}

describe('osu-web HTML back to BBCode', () => {
  it.each([
    '[box=Title]content[/box]',
    '[spoilerbox]hidden[/spoilerbox]',
    '[notice]note[/notice]',
    '[centre]hi[/centre]',
    '[b]bold[/b] [color=#ff0000]red[/color]',
    '[youtube]dQw4w9WgXcQ[/youtube]',
  ])('%s', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it('reads an osu! imagemap', () => {
    const out = roundTrip('[imagemap]\nhttps://a.b/c.png\n0 0 50 50 https://osu.ppy.sh Home\n50 0 50 50 # Nothing\n[/imagemap]')
    expect(out).toContain('https://a.b/c.png')
    expect(out).toContain('0 0 50 50 https://osu.ppy.sh Home')
    expect(out).toContain('50 0 50 50 # Nothing')
  })
})
