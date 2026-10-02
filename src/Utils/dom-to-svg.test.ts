import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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


/**
 * The cut (`maxHeight`). A thumbnail of a very large preview draws only its top
 * band, so the work around it must stay in that band too: no style resolved for
 * what is below, and no `<details>` below it forced open (which re-lays out the
 * whole document twice).
 */
describe('domToSVGResult — maxHeight cut', () => {
  let root: HTMLElement

  /** jsdom has no layout: `data-top` is where each box starts, relative to the root. */
  function layoutFromDataTop(el: HTMLElement) {
    for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      node.getBoundingClientRect = () => {
        const hidden = node.closest('details:not([open])') && node.tagName !== 'DETAILS' && node.tagName !== 'SUMMARY'
        if (hidden) return new DOMRect(0, 0, 0, 0)
        const top = Number(node.dataset.top ?? 0)
        return new DOMRect(0, top, 100, 40)
      }
    }
  }

  beforeEach(() => {
    root = document.createElement('div')
    root.dataset.top = '0'
    root.innerHTML = `
      <div class="near" data-top="10"></div>
      <details class="d-near" data-top="60"><summary data-top="60"></summary><div class="inner" data-top="100"></div></details>
      <div class="far" data-top="5000"></div>
      <details class="d-far" data-top="6000"><summary data-top="6000"></summary><div class="inner" data-top="6040"></div></details>
    `
    document.body.appendChild(root)
    layoutFromDataTop(root)
  })

  afterEach(() => {
    root.remove()
    vi.restoreAllMocks()
  })

  it('opens only the <details> that start inside the cut, and restores them', () => {
    const opened: string[] = []
    const original = Element.prototype.setAttribute
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name === 'open' && this.tagName === 'DETAILS') opened.push(this.className)
      return original.call(this, name, value)
    })

    domToSVGResult(root, { maxHeight: 600 })

    expect(opened).toEqual(['d-near'])
    expect(root.querySelector('.d-near')!.hasAttribute('open')).toBe(false)
    expect(root.querySelector('.d-far')!.hasAttribute('open')).toBe(false)
  })

  it('without maxHeight it still opens every closed <details>', () => {
    const opened: string[] = []
    const original = Element.prototype.setAttribute
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name === 'open' && this.tagName === 'DETAILS') opened.push(this.className)
      return original.call(this, name, value)
    })

    domToSVGResult(root, {})

    expect(opened.sort()).toEqual(['d-far', 'd-near'])
  })

  it('resolves no computed style for elements below the cut', () => {
    const styled: string[] = []
    const original = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      styled.push((el as HTMLElement).className)
      return original(el, pseudo)
    })

    domToSVGResult(root, { maxHeight: 600 })

    expect(styled).toContain('near')
    expect(styled).not.toContain('far')
    expect(styled).not.toContain('d-far')
  })
})
