import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { domToSVGResult } from './dom-to-svg'

/**
 * El vectorizador del Studio Vector no debe exportar los overlays de EDICIÓN
 * del imagemap (las regiones clicables ni su tooltip de hover): son UI del
 * preview, no contenido real. Antes el skip buscaba la clase legacy
 * `bb-imagemap-area`, pero el HTMLRenderer genera `imagemap-area
 * bbcode-imap-area` — las clases no coincidían y las regiones se colaban en
 * el SVG. El contenedor y la imagen SÍ deben salir.
 */

const IMAGEMAP_HTML = `
  <div class="imagemap-container bbcode-imagemap" style="position:relative;display:inline-block;width:200px;height:100px;">
    <img src="https://example.com/map.png" alt="imagemap" style="width:200px;height:100px;display:block;">
    <a class="imagemap-area bbcode-imap-area" href="https://example.com/1" style="position:absolute;left:10%;top:10%;width:30%;height:30%;"></a>
    <a class="imagemap-area bbcode-imap-area" href="https://example.com/2" style="position:absolute;left:50%;top:10%;width:30%;height:30%;"></a>
    <div class="bb-imagemap-tooltip" style="position:absolute;">tooltip</div>
  </div>
`

/** jsdom no hace layout: rects fake según la posición/el tamaño declarados. */
function mockLayout(root: HTMLElement) {
  const rectFor = (el: HTMLElement): DOMRect => {
    const style = window.getComputedStyle(el)
    const left = parseFloat(style.left) || 0
    const top = parseFloat(style.top) || 0
    const width = parseFloat(style.width) || (el.tagName === 'IMG' ? 200 : 100)
    const height = parseFloat(style.height) || (el.tagName === 'IMG' ? 100 : 50)
    return new DOMRect(left, top, width, height)
  }

  const originals = new Map<Element, () => DOMRect>()
  const walker = (node: Element | null) => {
    if (!node) return
    originals.set(node, node.getBoundingClientRect.bind(node))
    node.getBoundingClientRect = () => rectFor(node as HTMLElement)
    Array.from(node.children).forEach(walker)
  }
  walker(root)

  return () => originals.forEach((orig, el) => {
    el.getBoundingClientRect = orig
  })
}

describe('dom-to-svg · imagemap overlays', () => {
  let restore: () => void

  beforeEach(() => {
    document.body.innerHTML = IMAGEMAP_HTML
    restore = mockLayout(document.body.firstElementChild as HTMLElement)
  })

  afterEach(() => {
    restore()
    document.body.innerHTML = ''
  })

  it('no exporta las regiones clicables (imagemap-area bbcode-imap-area)', () => {
    const result = domToSVGResult(document.body.firstElementChild as HTMLElement, {
      backgroundColor: '#1c1719',
      scale: 1,
    })
    // Las áreas llevan href de las regiones: su ausencia es la prueba.
    expect(result.svg).not.toContain('example.com/1')
    expect(result.svg).not.toContain('example.com/2')
  })

  it('no exporta el tooltip de hover (bb-imagemap-tooltip)', () => {
    const result = domToSVGResult(document.body.firstElementChild as HTMLElement, {
      backgroundColor: '#1c1719',
      scale: 1,
    })
    expect(result.svg).not.toContain('tooltip')
  })

  it('sí exporta la imagen real del imagemap', () => {
    const result = domToSVGResult(document.body.firstElementChild as HTMLElement, {
      backgroundColor: '#1c1719',
      scale: 1,
    })
    expect(result.svg).toContain('map.png')
    expect(result.svg).toContain('<image')
  })
})
