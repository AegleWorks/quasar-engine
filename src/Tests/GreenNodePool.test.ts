/**
 * Structural sharing (roadmap point 5 / S2).
 *
 * The interner used to be broken in a way no test could catch, because the
 * tests only asserted that identical leaves came back as the same object —
 * which they did. What they never checked was the thing that made it unusable:
 * the shared node carried the FIRST occurrence's offsets, so switching it on
 * made every position in the document lie.
 *
 * That failure is not expressible any more (green nodes have no positions),
 * but the property it violated is what these tests assert: interning must be
 * INVISIBLE. Same tree, same offsets, same output — just fewer objects.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { GreenNodePool, internGreenLeaf } from '../Syntax/GreenNodePool'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { parseBBCode } from '../BBCode/Parser'
import { GreenNode } from '../Syntax/GreenNode'
import { greenToRedNode } from '../BBCode/BBCodeToGreenNode'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { TagRegistry } from '../Model/TagRegistry'
import type { RedNode } from '../Syntax/RedNode'

const registry = new TagRegistry()
const renderer = new HTMLRenderer({ registry })
const stripIds = (h: string) => h.replace(/ data-node-id="[^"]*"/g, '')

/** Structural equality that deliberately ignores object identity. */
function sameShape(a: GreenNode, b: GreenNode): boolean {
  if (a.kind !== b.kind || a.text !== b.text) return false
  if (a.width !== b.width) return false
  if (a.leadingWidth !== b.leadingWidth || a.trailingWidth !== b.trailingWidth) return false
  if (a.children.length !== b.children.length) return false
  for (let i = 0; i < a.children.length; i++) {
    if (!sameShape(a.children[i] as GreenNode, b.children[i] as GreenNode)) return false
  }
  return true
}

function countObjects(root: GreenNode): { reachable: number; distinct: number } {
  let reachable = 0
  const seen = new Set<GreenNode>()
  const stack: GreenNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    reachable++
    seen.add(n)
    for (const c of n.children as GreenNode[]) stack.push(c)
  }
  return { reachable, distinct: seen.size }
}

function allRanges(root: RedNode): string[] {
  const out: string[] = []
  const visit = (n: RedNode): void => {
    out.push(`${n.kind}[${n.range.start}..${n.range.end}]`)
    for (const c of n.children) visit(c)
  }
  visit(root)
  return out
}

describe('GreenNodePool — structural sharing', () => {
  beforeEach(() => {
    GreenNodePool.instance.clear()
  })

  it('returns the exact same object for identical leaves', () => {
    const leaf1 = internGreenLeaf('text', 'Miliastry')
    const leaf2 = internGreenLeaf('text', 'Miliastry')

    expect(leaf1).toBe(leaf2)
    expect(GreenNodePool.instance.stats.hits).toBe(1)
    expect(GreenNodePool.instance.stats.misses).toBe(1)
  })

  it('creates distinct nodes for different text payloads', () => {
    expect(internGreenLeaf('text', 'Hola')).not.toBe(internGreenLeaf('text', 'Mundo'))
    expect(GreenNodePool.instance.stats.size).toBe(2)
  })

  it('keeps leaves of the same text but different width apart', () => {
    // `spacing` carries no text but occupies 1 character for `\n` and 2 for
    // `\r\n`. Keying on text alone would merge them and shorten the document.
    const lf = internGreenLeaf('spacing', '', 1)
    const crlf = internGreenLeaf('spacing', '', 2)

    expect(lf).not.toBe(crlf)
    expect(lf.width).toBe(1)
    expect(crlf.width).toBe(2)
  })

  const SOURCES = [
    '[b]x[/b][b]x[/b][b]x[/b]',
    '[color=#e8b04b]A[/color][color=#e8b04b]B[/color][color=#e8b04b]A[/color]',
    '[centre][b]hola[/b] mundo[/centre]\n\notro parrafo\n\n[/b]huerfano',
    '[list][*]uno[*]dos[/list][quote]cita[/quote]',
    'texto plano sin etiquetas',
    '',
  ]

  for (const mode of ['leaves', 'full'] as const) {
    describe(`mode '${mode}'`, () => {
      for (const source of SOURCES) {
        it(`is invisible for ${JSON.stringify(source.slice(0, 40))}`, () => {
          const plain = parseBBCode(source)
          const interned = parseBBCode(source, { interner: GreenNodePool.create(mode) })

          // The tree must be structurally identical...
          expect(sameShape(plain, interned)).toBe(true)
          // ...the offsets the red tree derives must be identical...
          expect(allRanges(greenToRedNode(interned))).toEqual(allRanges(greenToRedNode(plain)))
          // ...and so must the rendered output.
          expect(stripIds(renderer.render(greenToRedNode(interned))))
            .toBe(stripIds(renderer.render(greenToRedNode(plain))))
        })
      }
    })
  }

  it('actually shares objects on a repetitive document', () => {
    const source = '[b]x[/b][b]x[/b][b]x[/b][b]x[/b]'

    const plain = countObjects(parseBBCode(source))
    const leaves = countObjects(parseBBCode(source, { interner: GreenNodePool.create('leaves') }))
    const full = countObjects(parseBBCode(source, { interner: GreenNodePool.create('full') }))

    expect(plain.distinct).toBe(plain.reachable)      // nothing shared
    expect(leaves.distinct).toBeLessThan(plain.distinct)
    expect(full.distinct).toBeLessThan(leaves.distinct) // internal nodes too
  })

  it('is off by default on the document model', () => {
    // It is a memory/latency trade and this engine's budget is latency, so it
    // must stay opt-in. See `BBCodeDocumentModelOptions.interning`.
    const source = '[b]x[/b][b]x[/b]'
    const plain = new BBCodeDocumentModel({ source, autoAnalyze: false })
    const shared = new BBCodeDocumentModel({ source, autoAnalyze: false, interning: 'full' })

    expect(countObjects(plain.greenRoot!).distinct).toBe(countObjects(plain.greenRoot!).reachable)
    expect(countObjects(shared.greenRoot!).distinct)
      .toBeLessThan(countObjects(shared.greenRoot!).reachable)
    // Same offsets either way — that is the whole contract.
    expect(allRanges(shared.redRoot!)).toEqual(allRanges(plain.redRoot!))
  })

  it('computes correct RedNode offsets even when green nodes are deduplicated', () => {
    const source = 'Hola Mundo Hola'
    const doc = new BBCodeDocumentModel({ source, interning: 'full' })

    expect(doc.redRoot!.range).toEqual({ start: 0, end: source.length })
  })
})
