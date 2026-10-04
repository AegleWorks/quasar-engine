import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { reconcileVisualDOMToBBCode } from '../Reconciler/SurgicalReconciler'
import { domPointOfSourceOffset, sourceOffsetOfDomPoint } from '../Reconciler/CanvasPositions'

/**
 * An effect paints its one text leaf as many text nodes — a solid colour per
 * letter. Typing in it must stay an edit of that leaf: rebuilding the element
 * from its DOM exported one `[color]` per letter and dropped the effect tag.
 */

const SOURCE = '[gradient=#E8B4D4,#B07090,#8A2BE2;wave=sine]Hola[/gradient]'

function canvasOf(source: string) {
  const model = new BBCodeDocumentModel({ source, dialect: 'miliastry' })
  const renderer = new HTMLRenderer({ dialect: 'miliastry' })
  const container = document.createElement('div')
  container.innerHTML = renderer.render(model.redRoot!)
  const root = model.redRoot!
  const reconcile = () => reconcileVisualDOMToBBCode(
    source,
    model.redRoot,
    container,
    new BBCodeExporter(model.tagRegistry, 'miliastry'),
    renderer,
  )
  return { container, root, reconcile }
}

function letterSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.bb-effect-gradient span[style]'))
}

describe('reconciling a leaf the render split into letters', () => {
  it('renders one span per letter (the premise)', () => {
    const { container } = canvasOf(SOURCE)
    expect(letterSpans(container).length).toBe(4)
  })

  it('types into a letter as an edit of the leaf, keeping the effect tag', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    const last = letterSpans(container).at(-1)!
    last.firstChild!.nodeValue = 'a mundo'

    const result = reconcile()
    expect(result.resultingSource).toBe('[gradient=#E8B4D4,#B07090,#8A2BE2;wave=sine]Hola mundo[/gradient]')
    expect(result.route).toBe('surgical')
    // Only what was typed, so the caret lands after it and not at the effect's end.
    expect(result.edits).toEqual([{ start: 48, end: 48, text: ' mundo' }])
  })

  it('types in the middle as an insertion there', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    const second = letterSpans(container)[1]
    second.firstChild!.nodeValue = 'oX'

    expect(reconcile().edits).toEqual([{ start: 46, end: 46, text: 'X' }])
  })

  it('types before the first letter', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    const first = letterSpans(container)[0]
    first.firstChild!.nodeValue = '¡H'

    expect(reconcile().resultingSource).toBe('[gradient=#E8B4D4,#B07090,#8A2BE2;wave=sine]¡Hola[/gradient]')
  })

  it('deletes a letter whose span the browser removed', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    letterSpans(container)[1].remove()

    const result = reconcile()
    expect(result.resultingSource).toBe('[gradient=#E8B4D4,#B07090,#8A2BE2;wave=sine]Hla[/gradient]')
    expect(result.route).toBe('surgical')
  })

  it('empties the effect\'s paragraph without leaving an empty effect tag', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    container.querySelector('.bb-paragraph')!.replaceChildren()

    expect(reconcile().resultingSource).toBe('')
  })

  it('leaves formatting the user added to the coarser path', () => {
    const { container, reconcile } = canvasOf(SOURCE)
    const span = letterSpans(container)[1]
    const bold = document.createElement('b')
    bold.textContent = span.textContent
    span.replaceChildren(bold)

    expect(reconcile().route).not.toBe('surgical')
  })
})

describe('caret positions in a leaf the render split into letters', () => {
  // "Hola" starts at 44, right after the opener.
  it('reads a DOM point in a letter as its offset in the leaf', () => {
    const { container, root } = canvasOf(SOURCE)
    const third = letterSpans(container)[2].firstChild!
    expect(sourceOffsetOfDomPoint(root, container, third, 0)).toBe(46)
    expect(sourceOffsetOfDomPoint(root, container, third, 1)).toBe(47)
  })

  it('puts an offset in the letter that holds it, the earlier one on a seam', () => {
    const { container, root } = canvasOf(SOURCE)
    const letters = letterSpans(container)
    expect(domPointOfSourceOffset(root, container, 44)).toEqual({ node: letters[0].firstChild, offset: 0 })
    expect(domPointOfSourceOffset(root, container, 46)).toEqual({ node: letters[1].firstChild, offset: 1 })
    expect(domPointOfSourceOffset(root, container, 48)).toEqual({ node: letters[3].firstChild, offset: 1 })
  })
})

describe('an empty effect exported for osu!', () => {
  // The handlers fall back to `visitChildren(node)` when there is no text;
  // the exporter used to hand them `exportNode`, so the node exported itself.
  it.each(['gradient=#E8B4D4,#8A2BE2', 'rainbow'])('[%s] exports without recursing', (opener) => {
    const tag = opener.split('=')[0]
    const model = new BBCodeDocumentModel({ source: `[${opener}][/${tag}]`, dialect: 'miliastry' })
    expect(new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)).toBe('')
  })
})
