import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { sourceOffsetOfDomPoint, domPointOfSourceOffset } from '../Reconciler/CanvasPositions'
import { toggleInlineFormat } from '../Commands/InlineFormat'

/**
 * Canvas positions (`Reconciler/CanvasPositions.ts`): a DOM point in a
 * painted canvas is a source offset, and back, in every dialect — including
 * text the renderer made up (a box heading, a quote's author line), which has
 * no offset of its own and resolves to the nearest text that does.
 */

const SOURCE = [
  'Hola a todos, esto es un párrafo normal.',
  '',
  '[b]Negrita inicial[/b] y luego [color=#ABCDEF]texto en color[/color] al final.',
  '',
  '[box=Mi Caja]',
  '  Primera línea del box',
  '  Segunda con [i]cursiva[/i]',
  '[/box]',
  '',
  '[quote="Peppy"]Una cita[/quote]',
  '',
  '[list]',
  '[*]Elemento uno',
  '[/list]',
].join('\n')

function paint(source: string, dialect: 'miliastry' | 'osu' | 'lyne') {
  const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
  const container = document.createElement('div')
  container.innerHTML = new HTMLRenderer({ dialect }).render(root)
  return { root, container }
}

function textNodes(container: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

describe.each(['miliastry', 'osu', 'lyne'] as const)('canvas positions — %s', (dialect) => {
  const { root, container } = paint(SOURCE, dialect)

  it('every character of every text the source holds maps to itself and back', () => {
    let checked = 0
    for (const needle of ['párrafo', 'Negrita', 'texto en color', 'Primera línea', 'cursiva', 'Una cita', 'Elemento uno']) {
      const at = SOURCE.indexOf(needle)
      for (let k = 0; k <= needle.length; k++) {
        const point = domPointOfSourceOffset(root, container, at + k)!
        expect(point, `${needle}+${k}`).not.toBeNull()
        expect(sourceOffsetOfDomPoint(root, container, point.node, point.offset)).toBe(at + k)
        checked++
      }
    }
    expect(checked).toBe(75)
  })

  it('a point in the DOM text lands on the same character in the source', () => {
    for (const t of textNodes(container)) {
      const value = t.nodeValue ?? ''
      const at = SOURCE.indexOf(value)
      if (value.trim().length < 4 || at === -1 || SOURCE.indexOf(value, at + 1) !== -1) continue
      // Inside a tag (`[box=Mi Caja]`'s heading) it is an attribute, not text: made up, see below.
      if (SOURCE.lastIndexOf('[', at) > SOURCE.lastIndexOf(']', at)) continue
      expect(sourceOffsetOfDomPoint(root, container, t, 2), JSON.stringify(value)).toBe(at + 2)
    }
  })

  it('made-up text resolves to real text next to it, never to markup', () => {
    for (const t of textNodes(container)) {
      const offset = sourceOffsetOfDomPoint(root, container, t, 0)!
      expect(offset).not.toBeNull()
      // Never inside a tag's own brackets — except text the tag really holds,
      // a box heading, which lands on its own characters (see below).
      const before = SOURCE.lastIndexOf('[', offset - 1)
      const closer = SOURCE.lastIndexOf(']', offset - 1)
      const itsOwnText = SOURCE.startsWith(t.nodeValue ?? '', offset) && (t.nodeValue ?? '').trim() !== ''
      expect(before <= closer || itsOwnText, JSON.stringify(t.nodeValue)).toBe(true)
    }
  })

  it('a point outside the canvas is not a position', () => {
    expect(sourceOffsetOfDomPoint(root, container, document.createTextNode('x'), 0)).toBeNull()
  })
})

describe('the toolbar loop, end to end', () => {
  it('select in the DOM → format in the source → repaint → the selection comes back on the same text', () => {
    for (const dialect of ['miliastry', 'osu'] as const) {
      const { root, container } = paint(SOURCE, dialect)
      const text = textNodes(container).find(t => t.nodeValue?.includes('párrafo'))!
      const i = text.nodeValue!.indexOf('párrafo')
      const start = sourceOffsetOfDomPoint(root, container, text, i)!
      const end = sourceOffsetOfDomPoint(root, container, text, i + 7)!

      const edit = toggleInlineFormat(root, SOURCE, { start, end }, 'bold')!
      let next = SOURCE
      for (const c of [...edit.changes].reverse()) next = next.slice(0, c.start) + c.text + next.slice(c.end)
      expect(next).toBe(SOURCE.replace('párrafo', '[b]párrafo[/b]'))

      const repainted = paint(next, dialect)
      const a = domPointOfSourceOffset(repainted.root, repainted.container, edit.selection.start)!
      const b = domPointOfSourceOffset(repainted.root, repainted.container, edit.selection.end)!
      const range = document.createRange()
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
      expect(range.toString()).toBe('párrafo')
      expect(a.node.parentElement!.tagName).toBe('STRONG')
    }
  })
})

describe('a box heading is its opener\'s attribute', () => {
  it.each(['miliastry', 'osu'] as const)('%s: a caret in "Mi Caja" is inside `[box=Mi Caja]`', (dialect) => {
    const source = '[box=Mi Caja]\n  Primera\n[/box]'
    const { root, container } = paint(source, dialect)
    const heading = textNodes(container).find(t => t.nodeValue === 'Mi Caja')!
    expect(sourceOffsetOfDomPoint(root, container, heading, 2)).toBe(source.indexOf('Mi Caja') + 2)
  })
})
