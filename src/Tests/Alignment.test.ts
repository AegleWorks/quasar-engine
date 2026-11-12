import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { alignmentAt, alignmentOf, toggleAlignment, type Alignment } from '../Commands/Alignment'
import type { TextChange } from '../Incremental/ChangeTracker'
import type { RedNode } from '../Syntax/RedNode'

/**
 * La alineación como TOGGLE (`Commands/Alignment.ts`): las tres etiquetas son
 * una elección, no tres envoltorios. Casos con la selección marcada: `«…»`.
 */

function marked(input: string): { source: string; start: number; end: number } {
  const start = input.indexOf('«')
  const end = input.indexOf('»') - 1
  return { source: input.replace('«', '').replace('»', ''), start, end }
}

function apply(source: string, changes: TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

function run(input: string, tag: Alignment): string {
  const { source, start, end } = marked(input)
  const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot!
  const edit = toggleAlignment(root, { start, end }, tag)
  expect(edit).not.toBeNull()
  return apply(source, edit!.changes)
}

describe('toggleAlignment', () => {
  it('wraps a selection that has no alignment', () => {
    expect(run('«hola» mundo', 'centre')).toBe('[centre]hola[/centre] mundo')
    expect(run('«hola» mundo', 'left')).toBe('[left]hola[/left] mundo')
  })

  it('takes the alignment off when the selection already has it', () => {
    expect(run('[centre]«hola»[/centre] mundo', 'centre')).toBe('hola mundo')
    // `center` es el alias deprecado: misma familia.
    expect(run('[center]«hola»[/center] mundo', 'centre')).toBe('hola mundo')
  })

  it('renames the alignment in place instead of nesting another one', () => {
    expect(run('[centre]«hola»[/centre]', 'right')).toBe('[right]hola[/right]')
    expect(run('[left]«hola»[/left]', 'centre')).toBe('[centre]hola[/centre]')
  })

  it('finds the alignment above the selected node, not only at its edges', () => {
    // El nodo bajo el cursor es la línea; el `[centre]` es su contenedor.
    expect(run('[centre]\n«hola»\n[/centre]', 'centre')).toBe('\nhola\n')
    expect(run('[centre]\n«hola»\n[/centre]', 'right')).toBe('[right]\nhola\n[/right]')
  })

  it('switches an [align=…] by its value, and unwraps it when it matches', () => {
    // El árbol de BBCode de hoy expone `[align=…]` como texto, así que el nodo
    // se prueba en su forma mínima. La rama existe para los dialectos que sí
    // lo estructuran (el export de osu hacia markdown, por ejemplo).
    const tree = (value: string) => {
      const source = `[align=${value}]hola[/align]`
      const innerStart = source.indexOf('hola')
      const innerEnd = innerStart + 4
      const document: any = { kind: 'document', metadata: {}, range: { start: 0, end: source.length }, parent: null, children: [] }
      // El `[align=…]` cuelga del documento, como en un árbol real.
      const outer: any = {
        kind: 'align',
        metadata: { align: value },
        range: { start: 0, end: source.length },
        innerStart,
        innerEnd,
        parent: document,
        children: [],
      }
      const inner: any = { kind: 'text', metadata: {}, range: { start: innerStart, end: innerEnd }, parent: outer, children: [] }
      outer.children.push(inner)
      document.findNodeAtOffset = () => inner
      return { node: document as RedNode, selection: { start: innerStart, end: innerEnd }, end: source.length }
    }

    expect(alignmentOf(tree('right').node.children?.[0] ?? tree('right').node)).toBe(null)
    expect(alignmentOf((tree('right').node as unknown as { findNodeAtOffset: () => RedNode }).findNodeAtOffset().parent!)).toBe('right')
    expect(alignmentOf((tree('center').node as unknown as { findNodeAtOffset: () => RedNode }).findNodeAtOffset().parent!)).toBe('centre')
    expect(alignmentOf((tree('justify').node as unknown as { findNodeAtOffset: () => RedNode }).findNodeAtOffset().parent!)).toBe('centre')

    const renamed = tree('left')
    expect(toggleAlignment(renamed.node, renamed.selection, 'centre')!.changes).toEqual([
      { start: 0, end: renamed.selection.start, text: '[align=center]' },
    ])
    const stripped = tree('centre')
    expect(toggleAlignment(stripped.node, stripped.selection, 'centre')!.changes).toEqual([
      { start: 0, end: stripped.selection.start, text: '' },
      { start: stripped.selection.end, end: stripped.end, text: '' },
    ])
  })

  it('reads the alignment the offset is inside', () => {
    const source = '[centre]hola[/centre]'
    const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot!
    expect(alignmentAt(root, source.indexOf('hola') + 1)).toBe('centre')
    expect(alignmentAt(root, 0, source.length)).toBe('centre')
    expect(alignmentAt(root, 0)).toBeNull()
    expect(alignmentAt(null, 0)).toBeNull()
  })

  it('does not take the alignment of a section off from one of its lines', () => {
    // El `[centre]` envuelve dos líneas: es de la sección, no de la primera.
    const section = '[centre]\n«uno»\ndos\n[/centre]'
    // Misma alineación: no hay nada que tocar; el nodo ya se ve centrado.
    expect(run(section, 'centre')).toBe('[centre]\nuno\ndos\n[/centre]')
    // Otra: se aplica al nodo, sin quitarle el centro a la sección.
    expect(run(section, 'right')).toBe('[centre]\n[right]uno[/right]\ndos\n[/centre]')
    // Seleccionar toda la sección sí la desalinea.
    expect(run('[centre]\n«uno\ndos»\n[/centre]', 'centre')).toBe('\nuno\ndos\n')
  })

  it('answers null for a collapsed selection', () => {
    const source = 'hola'
    const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot!
    expect(toggleAlignment(root, { start: 2, end: 2 }, 'centre')).toBeNull()
  })
})
