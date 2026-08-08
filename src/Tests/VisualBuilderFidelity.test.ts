import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { processStudioAST } from '@miliastry/quasar-studio'

/**
 * Every tag the visual builder can produce must reach the HTML with the
 * element the preview's stylesheet expects.
 *
 * This file used to hold a 6 KB hardcoded "expected HTML" that was never
 * compared against anything — it was written to `visual-builder-expected.html`
 * and `visual-builder-actual.html` in the repo root (tracked files, dirtied on
 * every run) for a human to eyeball. The only assertions were that the output
 * contained `class="bb-text"` and `data-node-id`. The first stopped being true
 * when text leaves lost their wrapper span, which is what prompted writing
 * real assertions instead.
 */
describe('Visual Builder HTML Fidelity', () => {
  const bbcode = `[heading]Quasar Engine Test[/heading]

[b]Bold[/b], [i]Italic[/i], [u]Underline[/u], [s]Strikethrough[/s]

[color=#61afef]Colored text[/color] and [size=150]Large text[/size]

[quote="Author"]This is a quote block with [b]formatting[/b] inside[/quote]

[code]
function hello() {
  console.log("Hello World!")
}
[/code]

[list]
[*]Item one
[*]Item two
[*]Item three
[/list]

[centre][b]Centered content[/b][/centre]

[notice]This is an important notice![/notice]

[spoiler]Hidden content revealed on hover[/spoiler]

[url=https://osu.ppy.sh]osu! website[/url]

Esto

Y esto`

  const render = () => {
    const registry = new TagRegistry()
    const renderer = new HTMLRenderer({ registry })
    const { redRoot } = processStudioAST(bbcode, [], {})
    return renderer.render(redRoot)
  }

  it('maps every tag to its expected element', () => {
    const html = render()

    const cases: Array<[string, RegExp]> = [
      ['heading', /<h2[^>]*>Quasar Engine Test<\/h2>/],
      ['bold', /<strong[^>]*>Bold<\/strong>/],
      ['italic', /<em[^>]*>Italic<\/em>/],
      ['underline', /<u[^>]*>Underline<\/u>/],
      ['strikethrough', /<s[^>]*>Strikethrough<\/s>/],
      ['color', /<span[^>]*style="color:#61afef;"[^>]*>Colored text<\/span>/],
      ['size', /<span[^>]*style="font-size:150%;"[^>]*>Large text<\/span>/],
      ['quote', /<blockquote[^>]*>/],
      ['code', /<pre[^>]*><code>/],
      ['list', /<ul[^>]*>/],
      ['list item', /<li[^>]*>Item one/],
      ['centre', /<div[^>]*style="text-align:center;"[^>]*>/],
      ['notice', /<div[^>]*class="notice"[^>]*>/],
      ['spoiler', /<span[^>]*class="spoiler"[^>]*>/],
      ['url', /<a[^>]*href="https:\/\/osu\.ppy\.sh"[^>]*>osu! website<\/a>/],
    ]

    for (const [label, pattern] of cases) {
      expect(pattern.test(html), `${label} — no encontrado en el HTML`).toBe(true)
    }
  })

  it('keeps the quote author and the raw code content', () => {
    const html = render()
    expect(html).toContain('Author')
    expect(html).toContain('function hello()')
    // Code content is raw text, so its quotes must be escaped, not parsed.
    expect(html).toContain('&quot;Hello World!&quot;')
  })

  it('carries data-node-id on blocks, so preview clicks map back to nodes', () => {
    const html = render()
    // Blocks are id-bearing; text leaves deliberately are not.
    expect(html).toMatch(/<h2 data-node-id="[^"]+"/)
    expect(html).toMatch(/<blockquote data-node-id="[^"]+"/)
    expect(html).toMatch(/<div data-node-id="[^"]+" class="notice"/)
  })

  it('renders trailing prose after the last tag', () => {
    const html = render()
    expect(html).toContain('Esto')
    expect(html).toContain('Y esto')
  })
})
