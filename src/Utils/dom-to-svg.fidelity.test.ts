import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectFontUses, domToSVGResult } from './dom-to-svg'

/**
 * What a raster card needs to look the same as an SVG shown through `<img>`
 * (how osu! shows `[img]`): fonts that travel inside the file, the family
 * list rather than its first name, CSS's pill radius, translucent borders and
 * the spaces between styled words.
 */

/** jsdom does no layout: every element gets the box its inline style declares. */
function mockLayout(root: HTMLElement): () => void {
  const originals = new Map<Element, () => DOMRect>()
  const visit = (el: Element): void => {
    originals.set(el, el.getBoundingClientRect.bind(el))
    el.getBoundingClientRect = () => {
      const s = (el as HTMLElement).style
      return new DOMRect(parseFloat(s.left) || 0, parseFloat(s.top) || 0, parseFloat(s.width) || 200, parseFloat(s.height) || 20)
    }
    Array.from(el.children).forEach(visit)
  }
  visit(root)
  return () => originals.forEach((orig, el) => { el.getBoundingClientRect = orig })
}

let restore: () => void = () => {}

function snapshot(html: string, fontCSS?: string): string {
  document.body.innerHTML = `<div id="root" style="width:400px;height:100px">${html}</div>`
  const root = document.getElementById('root') as HTMLElement
  restore = mockLayout(root)
  return domToSVGResult(root, { includeBackground: false, fontCSS }).svg
}

beforeEach(() => {
  // One 120x20 line per text node.
  Range.prototype.getClientRects = (() => [new DOMRect(0, 0, 120, 20)]) as unknown as Range['getClientRects']
})

afterEach(() => {
  delete (Range.prototype as Partial<Range>).getClientRects
  restore()
  document.body.innerHTML = ''
})

describe('dom-to-svg · fidelity of raster cards', () => {
  it('rounds a 999px pill at the ends instead of drawing an ellipse', () => {
    const svg = snapshot('<span style="display:block;width:80px;height:16px;border-radius:999px;background:#B3FF66"></span>')
    expect(svg).toMatch(/<rect id="[^"]+-bg"[^>]*rx="8\.00"/)
  })

  it('keeps the alpha of a translucent border', () => {
    const svg = snapshot('<div style="width:44px;height:44px;border:4px solid rgba(255,255,255,.1);border-radius:22px"></div>')
    expect(svg).toMatch(/-border"[^>]*stroke="#ffffff" stroke-opacity="0\.100"/)
  })

  it('names the whole family list, so a viewer without the first font falls back to sans-serif', () => {
    const svg = snapshot('<span style="font-family:Torus, Inter, Arial, sans-serif">hxovc</span>')
    expect(svg).toMatch(/font-family="Torus, Inter, Arial, sans-serif"/)
  })

  it('keeps the space before a word that follows a styled one, collapsed as CSS collapses it', () => {
    const svg = snapshot('<span><b>Ghost</b>   by\n Camellia</span>')
    expect(svg).toMatch(/xml:space="preserve">Ghost<\/text>/)
    expect(svg).toMatch(/xml:space="preserve"> by Camellia<\/text>/)
  })

  it('embeds the given @font-face rules instead of importing Google Fonts', () => {
    const css = '@font-face{font-family:"Torus";src:url(data:font/otf;base64,AAAA) format("opentype");}'
    const svg = snapshot('<span style="font-family:Torus">x</span>', css)
    expect(svg).toContain(`<defs><style>${css}</style></defs>`)
    expect(svg).not.toContain('@import')
  })

  it('escapes the embedded CSS as XML text', () => {
    const svg = snapshot('<span>x</span>', 'a{content:"<&>"}')
    expect(svg).toContain('a{content:"&lt;&amp;>"}')
  })
})

describe('collectFontUses', () => {
  it('lists each family, weight and style once, with the characters drawn in it', () => {
    document.body.innerHTML = '<div id="root" style="font-family:Torus"><b style="font-weight:700">Gho st</b><span>hi</span><span>ih</span><span style="display:none">zz</span></div>'
    const uses = collectFontUses(document.getElementById('root') as HTMLElement)
    const byWeight = Object.fromEntries(uses.map((u) => [u.weight, u]))
    expect(byWeight[700].text).toBe('Ghost')
    expect(byWeight[400].text).toBe('hi')
    expect(uses.every((u) => u.family === 'Torus' && u.style === 'normal')).toBe(true)
  })
})
