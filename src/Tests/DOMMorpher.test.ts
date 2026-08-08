import { describe, it, expect } from 'vitest'
import { morphHTML } from '../Visitors/DOMMorpher'

/**
 * The morpher had no tests at all, which is uncomfortable for something that
 * mutates the DOM the user is looking at.
 *
 * The central property is simple: after morphing, the container must be
 * structurally identical to what `innerHTML = newHTML` would have produced.
 * Anything else means the preview silently disagrees with the renderer. That is
 * asserted below over hand-picked edit shapes plus a seeded random corpus.
 */

function container(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

function expected(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

/** Morph `from` into `to` and assert the result matches a fresh render. */
function expectMorphMatches(from: string, to: string): HTMLElement {
  const el = container(from)
  morphHTML(el, to)
  expect(el.innerHTML).toBe(expected(to).innerHTML)
  return el
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('DOMMorpher', () => {
  it('produces the same DOM as a fresh render, for every edit shape', () => {
    const base = '<p>uno</p><p>dos</p><p>tres</p>'

    expectMorphMatches(base, base)                                        // sin cambios
    expectMorphMatches(base, '<p>UNO</p><p>dos</p><p>tres</p>')           // cambio al principio
    expectMorphMatches(base, '<p>uno</p><p>dos</p><p>TRES</p>')           // cambio al final
    expectMorphMatches(base, '<p>uno</p><p>DOS</p><p>tres</p>')           // cambio en medio
    expectMorphMatches(base, '<p>cero</p><p>uno</p><p>dos</p><p>tres</p>')// inserción al principio
    expectMorphMatches(base, '<p>uno</p><p>dos</p><p>tres</p><p>cuatro</p>') // al final
    expectMorphMatches(base, '<p>uno</p><p>nuevo</p><p>dos</p><p>tres</p>')  // en medio
    expectMorphMatches(base, '<p>dos</p><p>tres</p>')                     // borrado al principio
    expectMorphMatches(base, '<p>uno</p><p>dos</p>')                      // borrado al final
    expectMorphMatches(base, '<p>uno</p><p>tres</p>')                     // borrado en medio
    expectMorphMatches(base, '')                                          // vaciado
    expectMorphMatches(base, '<div>otra cosa</div>')                      // etiqueta distinta
    expectMorphMatches(base, '<p>uno</p>texto suelto<p>tres</p>')         // elemento → texto
    expectMorphMatches('<b>a</b>', '<b><i>a</i></b>')                     // anidamiento nuevo
  })

  it('inserts before the preserved suffix, not at the end', () => {
    // Regression: trimming a common suffix means a plain `appendChild` would
    // put the new node in the wrong place.
    expectMorphMatches('<p>a</p><p>z</p>', '<p>a</p><p>m</p><p>z</p>')
    expectMorphMatches('<p>z</p>', '<p>a</p><p>z</p>')
  })

  it('keeps the identical prefix as the very same DOM nodes', () => {
    // This is the point of the morpher: untouched nodes must not be replaced,
    // or the runtime state they hold is lost.
    const el = container('<p id="a">uno</p><p id="b">dos</p>')
    const first = el.children[0]
    morphHTML(el, '<p id="a">uno</p><p id="b">DOS</p>')
    expect(el.children[0]).toBe(first)
  })

  it('does not rewrite every sibling when a node is inserted at the front', () => {
    // This is the A8 defect, pinned. Pairing children by index means inserting
    // one node shifts every following sibling, so each compares against the
    // wrong counterpart and gets its content rewritten in place.
    //
    // Measured against the previous implementation: of 200 paragraphs, it left
    // 0 intact. Suffix trimming brings that to 200 — the insert is the only
    // DOM operation performed.
    const from = Array.from({ length: 200 }, (_, i) => `<p>l${i}</p>`).join('')
    const el = container(from)
    const original = Array.from(el.children).map(n => ({ node: n, text: n.textContent }))

    morphHTML(el, '<p>nueva</p>' + from)

    const intact = original.filter(o => o.node.textContent === o.text).length
    expect(intact).toBe(200)
    expect(el.innerHTML).toBe(expected('<p>nueva</p>' + from).innerHTML)
  })

  it('preserves an open <details> across a morph', () => {
    const el = container('<details><summary>s</summary><p>uno</p></details>')
    const details = el.querySelector('details')!
    details.setAttribute('open', '')

    morphHTML(el, '<details><summary>s</summary><p>DOS</p></details>')

    expect(el.querySelector('details')).toBe(details)
    expect(el.querySelector('details')!.hasAttribute('open')).toBe(true)
    expect(el.querySelector('p')!.textContent).toBe('DOS')
  })

  it('syncs attributes, adding and removing', () => {
    const el = container('<p class="viejo" data-x="1">t</p>')
    morphHTML(el, '<p class="nuevo">t</p>')
    const p = el.children[0]
    expect(p.getAttribute('class')).toBe('nuevo')
    expect(p.hasAttribute('data-x')).toBe(false)
  })

  it('matches a fresh render across a seeded random corpus', () => {
    const rnd = mulberry32(1234)
    const piezas = [
      '<p>a</p>', '<p>b</p>', '<b>x</b>', '<i>y</i>', 'texto ',
      '<div class="n">n</div>', '<span data-node-id="n1">s</span>',
      '<details><summary>s</summary><p>d</p></details>', '<br>',
    ]
    const build = () => {
      let h = ''
      const n = Math.floor(rnd() * 10)
      for (let i = 0; i < n; i++) h += piezas[Math.floor(rnd() * piezas.length)]
      return h
    }

    for (let i = 0; i < 2000; i++) {
      const from = build()
      const to = build()
      const el = container(from)
      morphHTML(el, to)
      // `morphHTML` short-circuits to innerHTML when the container starts empty,
      // which is trivially correct; the interesting case is the incremental one.
      expect(el.innerHTML).toBe(expected(to).innerHTML)
    }
  })
})
