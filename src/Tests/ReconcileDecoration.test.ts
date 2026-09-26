import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { reconcileVisualDOMToBBCode } from '../Reconciler/SurgicalReconciler'

/**
 * Typing in a quote or a list, found with the WYSIWYG gesture bench.
 *
 * The render puts markup of its own between a node's children — a quote's
 * "X wrote:" line, the newlines between list items — so pairing children one
 * to one failed and the whole quote or list was rebuilt from its HTML. The
 * reconciler now aligns the render with the children, and leaves out what
 * matches none of them, as long as it is exactly as rendered.
 */

const SOURCE = '[quote="Peppy the Dev"]Una cita famosa[/quote]\n\n[list]\n[*]Elemento uno\n[*]Elemento dos\n[/list]\n\n[quote]sin autor[/quote]'

function paint(source: string, dialect: 'miliastry' | 'osu') {
  const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
  const renderer = new HTMLRenderer({ dialect })
  const container = document.createElement('div')
  container.innerHTML = renderer.render(root)
  const reconcile = () => reconcileVisualDOMToBBCode(source, root, container, new BBCodeExporter(undefined, dialect), renderer)
  return { container, reconcile }
}

function textNode(container: HTMLElement, value: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue === value) return n as Text
  throw new Error(value)
}

describe.each(['miliastry', 'osu'] as const)('decoration between children (%s)', (dialect) => {
  it('typing in a quote with an author touches its text only', () => {
    const { container, reconcile } = paint(SOURCE, dialect)
    textNode(container, 'Una cita famosa').nodeValue = 'Una cita muy famosa'
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(SOURCE.replace('cita famosa', 'cita muy famosa'))
  })

  it('typing in a list item touches that item only', () => {
    const { container, reconcile } = paint(SOURCE, dialect)
    textNode(container, 'Elemento dos').nodeValue = 'Elemento número dos'
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(SOURCE.replace('Elemento dos', 'Elemento número dos'))
  })

  it('typing into an empty item — made by Enter — goes right after its [*]', () => {
    const source = '[list]\n[*]uno\n[*]\n[/list]'
    const { container, reconcile } = paint(source, dialect)
    const empty = container.querySelectorAll('li')[1]
    empty.insertBefore(document.createTextNode('dos'), empty.firstChild)
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe('[list]\n[*]uno\n[*]dos\n[/list]')
  })

  it('an edit to the author line is not missed by leaving the decoration out', () => {
    const { container, reconcile } = paint(SOURCE, dialect)
    textNode(container, 'Peppy the Dev wrote:').nodeValue = 'Cookiezi wrote:'
    expect(reconcile().route).not.toBe('surgical')
  })
})
