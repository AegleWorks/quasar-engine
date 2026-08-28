import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { reconcileVisualDOMToBBCode } from '../Reconciler/SurgicalReconciler'

describe('SurgicalReconciler', () => {
  it('preserves untouched blocks and custom formatting during a targeted edit', () => {
    const originalBBCode = `[notice]
  Hello World!
[/notice]

[box=Changelog:#ff66aa]
  * Custom item with special indentation
[/box]`

    const doc = new BBCodeDocumentModel({ source: originalBBCode })
    const renderer = new HTMLRenderer()
    const html = renderer.render(doc.redRoot!)

    // Simulate browser contenteditable DOM container
    const container = document.createElement('div')
    container.innerHTML = html

    // Edit only the notice block inside the DOM container
    const noticeElem = container.querySelector('.notice') as HTMLElement
    expect(noticeElem).toBeTruthy()
    
    // Change inner text of the notice
    noticeElem.innerHTML = 'Hello Super World!'

    // Run reconciliation
    const result = reconcileVisualDOMToBBCode(originalBBCode, doc.redRoot, container)

    expect(result.hasChanges).toBe(true)
    expect(result.edits.length).toBe(1)
    expect(result.edits[0].text).toContain('Hello Super World!')
    
    // The untouched box with its exact title and custom indentation must be preserved
    expect(result.resultingSource).toContain('[box=Changelog:#ff66aa]\n  * Custom item with special indentation\n[/box]')
  })

  it('produces single-character micro-edits for un-tagged top-level text changes', () => {
    const original = 'Welcome to osu! community'
    const container = document.createElement('div')
    container.innerHTML = 'Welcome to osu! awesome community'

    const result = reconcileVisualDOMToBBCode(original, null, container)
    expect(result.hasChanges).toBe(true)
    expect(result.edits.length).toBe(1)
    expect(result.edits[0]).toEqual({
      start: 16,
      end: 16,
      text: 'awesome ',
    })
    expect(result.resultingSource).toBe('Welcome to osu! awesome community')
  })

  it('fills an empty line in place, without inventing blank lines', () => {
    const original = 'Paragraph 1\n\nParagraph 2'
    const doc = new BBCodeDocumentModel({ source: original })
    const renderer = new HTMLRenderer()
    const html = renderer.render(doc.redRoot!)

    const container = document.createElement('div')
    container.innerHTML = html

    const emptyLineEl = container.querySelector('.bb-empty-line') as HTMLElement
    expect(emptyLineEl).toBeTruthy()

    // User types "Middle Paragraph" into the empty line
    emptyLineEl.innerHTML = 'Middle Paragraph'

    const result = reconcileVisualDOMToBBCode(original, doc.redRoot, container)
    expect(result.hasChanges).toBe(true)
    // The blank line is a line: typing into it fills that line. It does not
    // push two new blank lines into a document the author never asked for.
    expect(result.resultingSource).toBe('Paragraph 1\nMiddle Paragraph\nParagraph 2')
  })

  it('fills the empty line between a custom separator and a notice without gluing', () => {
    const original = '[centre][color=#f472b6]━━━ ✦ ━━━[/color][/centre]\n\n[notice]Contenido[/notice]'
    const doc = new BBCodeDocumentModel({ source: original })
    const renderer = new HTMLRenderer()
    const html = renderer.render(doc.redRoot!)

    const container = document.createElement('div')
    container.innerHTML = html

    const emptyLineEl = container.querySelector('.bb-empty-line') as HTMLElement
    expect(emptyLineEl).toBeTruthy()

    // User types "Miliastry" into the empty line
    emptyLineEl.innerHTML = 'Miliastry'

    const result = reconcileVisualDOMToBBCode(original, doc.redRoot, container)
    expect(result.hasChanges).toBe(true)
    expect(result.resultingSource).toContain('Miliastry')
    expect(result.resultingSource).not.toContain('Miliastry[notice]')
    expect(result.resultingSource).toBe('[centre][color=#f472b6]━━━ ✦ ━━━[/color][/centre]\nMiliastry\n[notice]Contenido[/notice]')
  })
})
