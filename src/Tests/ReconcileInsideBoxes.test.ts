import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { reconcileVisualDOMToBBCode } from '../Reconciler/SurgicalReconciler'
import { domPointOfSourceOffset, revealLine, sourceOffsetOfDomPoint } from '../Reconciler/CanvasPositions'

/**
 * Editing inside a box, found with the WYSIWYG gesture bench.
 *
 * A box renders its content inside markup of its own (a heading, a body
 * `<div>`), so the reconciler could not pair the box's children with the DOM
 * and re-exported the whole box from its HTML: on osu! that lost the author's
 * newlines around the content, and a blank line typed into could not be filled
 * in place. And opening the box — the `open` a click gives a `<details>` —
 * counted as a change, so every keystroke anywhere rebuilt it.
 */

const SOURCE = '[box=Mi Caja]\n  Primera línea\n\n  Segunda\n[/box]\n\nfin'

function paint(dialect: 'miliastry' | 'osu') {
  const root = new BBCodeDocumentModel({ source: SOURCE, dialect, autoAnalyze: false }).redRoot!
  const renderer = new HTMLRenderer({ dialect })
  const container = document.createElement('div')
  container.innerHTML = renderer.render(root)
  const reconcile = () => reconcileVisualDOMToBBCode(SOURCE, root, container, new BBCodeExporter(undefined, dialect), renderer)
  const body = container.querySelector('.bbcode-box-body, .bbcode-spoilerbox__body')!
  return { container, body, reconcile }
}

describe.each(['miliastry', 'osu'] as const)('inside a box (%s)', (dialect) => {
  it('typing in a line of the body touches that line only, and the box keeps its newlines', () => {
    const { body, reconcile } = paint(dialect)
    const line = Array.from(body.childNodes).find(n => n.nodeValue?.includes('Primera'))!
    line.nodeValue = '  PriWmera línea'
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(SOURCE.replace('Primera', 'PriWmera'))
  })

  it('typing into a blank line of the body fills that line', () => {
    const { body, reconcile } = paint(dialect)
    const blank = body.querySelector('.bb-empty-line')!
    blank.textContent = 'Z'
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(SOURCE.replace('línea\n\n', 'línea\nZ\n'))
  })

  it('an edit to the heading is not missed by descending into the body', () => {
    const { container, reconcile } = paint(dialect)
    const heading = container.querySelector('.bb-box-heading, .bbcode-spoilerbox__link-text')!
    heading.textContent = 'Otra Caja'
    expect(reconcile().resultingSource).toContain('Otra Caja')
  })
})

describe('an opened box is not an edit', () => {
  it('a keystroke elsewhere leaves an open box alone', () => {
    const { container, reconcile } = paint('miliastry')
    ;(container.querySelector('details') as HTMLDetailsElement).open = true
    const fin = container.querySelector('.bb-paragraph')!
    fin.textContent = 'finX'
    const r = reconcile()
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(SOURCE.replace('fin', 'finX'))
  })
})

describe('a line with no layout yet (revealLine)', () => {
  // After Enter at the end of a notice the new line is in the source but the
  // renderer draws a swallowed newline's hidden marker for it, so the canvas
  // opens one to type into.
  const cases = [
    ['[notice]aviso\n\n[/notice]\nfin', '[notice]aviso\n'.length, '[notice]aviso\nZ\n[/notice]\nfin'],
  ] as const

  for (const dialect of ['miliastry', 'osu'] as const) {
    it.each(cases)(`${dialect}: %j, caret at %i, typing lands on the new line`, (source, caret, expected) => {
      const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
      const renderer = new HTMLRenderer({ dialect })
      const container = document.createElement('div')
      container.innerHTML = renderer.render(root)

      const point = domPointOfSourceOffset(root, container, caret)!
      const line = revealLine(root, point, caret)!
      expect(line, 'a line was opened').not.toBeNull()
      // Opened and left empty, it is no edit at all.
      expect(reconcileVisualDOMToBBCode(source, root, container, new BBCodeExporter(undefined, dialect), renderer).resultingSource).toBe(source)
      // And the caret there reads back as the same offset.
      expect(sourceOffsetOfDomPoint(root, container, line.node, line.offset)).toBe(caret)

      ;(line.node as Element).textContent = 'Z'
      const r = reconcileVisualDOMToBBCode(source, root, container, new BBCodeExporter(undefined, dialect), renderer)
      expect(r.route).toBe('surgical')
      expect(r.resultingSource).toBe(expected)
    })
  }
})

describe('the line after the last newline (terminalLines)', () => {
  const cases = [
    ['uno\nfin\n', 'uno\nfin\n'.length, 'uno\nfin\nZ'],
    ['uno\n\n', 'uno\n\n'.length, 'uno\n\nZ'],
    ['\n', 1, '\nZ'],
    ['[b]uno\n[/b]', '[b]uno\n'.length, '[b]uno\nZ[/b]'],
  ] as const

  for (const dialect of ['miliastry', 'osu'] as const) {
    it.each(cases)(`${dialect}: %j is on screen whole, and a caret there reads back`, (source, caret, expected) => {
      const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
      const renderer = new HTMLRenderer({ dialect, terminalLines: true })
      const container = document.createElement('div')
      container.innerHTML = renderer.render(root)

      const point = domPointOfSourceOffset(root, container, caret)!
      expect((point.node as Element).hasAttribute('data-bb-tail'), 'the caret is on the painted line').toBe(true)
      expect(sourceOffsetOfDomPoint(root, container, point.node, point.offset)).toBe(caret)
      // Painted and left empty, it is no edit at all.
      const exporter = new BBCodeExporter(undefined, dialect)
      expect(reconcileVisualDOMToBBCode(source, root, container, exporter, renderer).resultingSource).toBe(source)

      point.node.insertBefore(document.createTextNode('Z'), point.node.childNodes[point.offset])
      const r = reconcileVisualDOMToBBCode(source, root, container, exporter, renderer)
      expect(r.route).toBe('surgical')
      expect(r.resultingSource).toBe(expected)
    })
  }

  it('is the editable surface\'s alone: a published render ends where its text ends', () => {
    const root = new BBCodeDocumentModel({ source: 'uno\n', dialect: 'osu', autoAnalyze: false }).redRoot!
    expect(new HTMLRenderer({ dialect: 'osu' }).render(root)).not.toContain('data-bb-tail')
  })
})
