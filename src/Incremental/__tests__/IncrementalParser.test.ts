import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../../BBCode/BBCodeDocumentModel'
import { GreenNode } from '../../Syntax/GreenNode'
import { checkPartition } from '../../Syntax/partition'
import { IncrementalParser } from '../IncrementalParser'

/**
 * The contract of an incremental reparse is not "it is fast" — it is "you
 * cannot tell". Every test here compares the incrementally updated tree
 * against a full rebuild of the same final text and demands they be identical,
 * because the failure mode of the old implementation was precisely a tree that
 * looked plausible and rendered wrong.
 *
 * Note that RedNode identity is deliberately NOT preserved: the red tree is
 * derived from the new green root, exactly as a full rebuild would derive it.
 * The previous implementation kept ids for untouched siblings by splicing red
 * nodes in place, which is also how it ended up with ranges that no longer
 * described the text. Nothing depends on those ids — `DOMMorpher` matches on
 * structure (`isEqualNode`), not on `data-node-id`.
 */

/** First structural difference between two green trees, or null if identical. */
function firstDiff(a: GreenNode, b: GreenNode, path = a.kind): string | null {
  if (a.kind !== b.kind) return `${path}: kind ${a.kind} vs ${b.kind}`
  if (a.text !== b.text) return `${path}: text ${JSON.stringify(a.text)} vs ${JSON.stringify(b.text)}`
  if (a.width !== b.width) return `${path}: width ${a.width} vs ${b.width}`
  if (a.leadingWidth !== b.leadingWidth || a.trailingWidth !== b.trailingWidth) {
    return `${path}: widths ${a.leadingWidth}/${a.trailingWidth} vs ${b.leadingWidth}/${b.trailingWidth}`
  }
  if (a.children.length !== b.children.length) {
    return `${path}: ${a.children.length} children vs ${b.children.length}`
  }
  for (let i = 0; i < a.children.length; i++) {
    const child = a.children[i] as GreenNode
    const d = firstDiff(child, b.children[i] as GreenNode, `${path}/${child.kind}[${i}]`)
    if (d) return d
  }
  return null
}

/**
 * Apply `edits` incrementally and assert the result matches a full rebuild.
 *
 * The size thresholds are lifted so these documents stay short and readable:
 * they are performance tuning, and what is under test here is the splice.
 */
function expectMatchesRebuild(source: string, edits: string[]): BBCodeDocumentModel {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  ;(model as { incrementalParser: IncrementalParser }).incrementalParser =
    new IncrementalParser({ minSourceLength: 0, maxRegionFraction: 1 })
  for (const text of edits) model.applyTextUpdate(text)

  const final = edits[edits.length - 1]
  const truth = new BBCodeDocumentModel({ source: final, autoAnalyze: false })

  expect(firstDiff(model.greenRoot!, truth.greenRoot!)).toBeNull()
  expect(checkPartition(model.greenRoot!, final.length, { limit: 5 })).toEqual([])
  // The red tree must describe the same text as the green one it came from.
  expect(model.redRoot!.range).toEqual({ start: 0, end: final.length })
  return model
}

describe('IncrementalParser', () => {
  it('reparses only the affected container', () => {
    const source = '[quote]Hello[/quote][box]World[/box]'
    const model = expectMatchesRebuild(source, ['[quote]Hello![/quote][box]World[/box]'])

    expect(model.lastReparsePath).toBe('incremental')
    const quote = model.redRoot!.children.find(c => c.kind === 'quote')!
    expect(quote.children[0].text).toContain('Hello!')
  })

  it('shifts the ranges of everything after the edit', () => {
    // The defect this pins: siblings and ancestors used to keep stale ranges.
    const model = expectMatchesRebuild(
      '[quote]ab[/quote][box]cd[/box]',
      ['[quote]abXYZ[/quote][box]cd[/box]'],
    )

    expect(model.lastReparsePath).toBe('incremental')
    const box = model.redRoot!.children.find(c => c.kind === 'box')!
    // '[quote]abXYZ[/quote]' is 20 chars, so [box] must start at 20, not 17.
    expect(box.range.start).toBe(20)
  })

  it('keeps green and red describing the same tree', () => {
    // `reparse` used to return the OLD green root while returning a NEW red
    // one, leaving the model permanently desynchronised.
    const model = expectMatchesRebuild('[notice]uno[/notice]', ['[notice]uno dos[/notice]'])

    expect(model.greenRoot).toBe(model.redRoot!.green)
    expect(model.greenRoot!.width).toBe('[notice]uno dos[/notice]'.length)
  })

  it('survives a long sequence of edits in the same container', () => {
    const base = '[centre][b]hola[/b] mundo[/centre]'
    const edits: string[] = []
    let text = base
    for (const ch of 'abcdefghij') {
      text = text.slice(0, 15) + ch + text.slice(15)
      edits.push(text)
    }
    const model = expectMatchesRebuild(base, edits)
    expect(model.lastReparsePath).toBe('incremental')
  })

  describe('edita a nivel de raíz sin caer a rebuild', () => {
    // Escribir al final de un post es la posición de caret más común que hay, y
    // durante mucho tiempo fue la que peor se comportaba: ningún contenedor de
    // bloque la envolvía, así que cada pulsación reconstruía el documento
    // entero. Con la ventana de hermanos, el padre es el propio `document`.
    it('añadir al final', () => {
      const model = expectMatchesRebuild('[quote]hola[/quote]', ['[quote]hola[/quote]cola'])
      expect(model.lastReparsePath).toBe('incremental')
    })

    it('escribir dentro de un párrafo suelto', () => {
      const model = expectMatchesRebuild(
        'primer parrafo\n\nsegundo parrafo',
        ['primer parrafo\n\nsegundo parrafoX'],
      )
      expect(model.lastReparsePath).toBe('incremental')
    })

    it('una línea en blanco nueva PARTE el párrafo', () => {
      // El caso que obliga a que `paragraph` sea opaco: la división solo es
      // visible reparseando a nivel de raíz, no dentro del párrafo.
      expectMatchesRebuild('uno dos tres', ['uno\n\ndos tres'])
    })

    it('borrar la línea en blanco FUNDE los párrafos', () => {
      // El caso que obliga a ensanchar la ventana: el cambio solo toca el nodo
      // de en medio, y la fusión ocurre entre sus dos vecinos.
      expectMatchesRebuild('uno\n\ndos', ['uno\ndos', 'unodos'])
    })
  })

  it('handles deletions as well as insertions', () => {
    expectMatchesRebuild('[quote]abcdefgh[/quote]tail', [
      '[quote]abcdefg[/quote]tail',
      '[quote]abcdef[/quote]tail',
      '[quote]abc[/quote]tail',
    ])
  })

  describe('declines to splice when it cannot be sure', () => {
    const cases: [string, string, string][] = [
      // A nested container of the same kind would steal the closing delimiter.
      ['un [centre] anidado', '[centre]hola[/centre]', '[centre]ho[centre]la[/centre]'],
      // A half-typed tag leaves a bracket the region cannot resolve alone.
      ['un [ a medias', '[quote]hola[/quote]', '[quote]ho[la[/quote]'],
      // An unclosed [code] would swallow past the region.
      ['un [code] sin cerrar', '[quote]hola[/quote]', '[quote]ho[code]la[/quote]'],
    ]

    for (const [name, source, edited] of cases) {
      it(name, () => {
        const model = expectMatchesRebuild(source, [edited])
        expect(model.lastReparsePath).toBe('full_rebuild')
        expect(model.lastReparseFallbackReason).not.toBeNull()
      })
    }
  })
})
