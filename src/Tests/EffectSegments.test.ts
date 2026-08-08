import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TagRegistry, type TagHandlerContext } from '../Model/TagRegistry'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import type { NodeKind, NodeMetadata } from '../Types/core'

/**
 * The four effect tags (gradient, sinewave, grow, rainbow) serialize through
 * ONE segment function each, presented two ways (toBBCode / toRenderNode).
 * Before the consolidation, each handler carried its own copy of the math.
 *
 * The expected outputs in `EffectSegments.snapshot.json` were captured from
 * the PRE-consolidation handlers, so this suite pins the refactor to byte
 * equality with the originals — colors, sizes, word/whitespace handling,
 * globalOffset/documentLength, empty-text fallbacks, everything.
 *
 * The inputs here must stay in sync with the snapshot's cases by index.
 */

const CASES: Array<{ kind: string; text: string; metadata: NodeMetadata }> = [
  { kind: 'gradient', text: 'Hola Mundo', metadata: { colors: ['#FF0000', '#00FF00', '#0000FF'], unit: 'character', easing: 'linear' } },
  { kind: 'gradient', text: 'uno dos tres', metadata: { colors: ['#112233', '#445566'], unit: 'word', easing: 'ease-in' } },
  { kind: 'gradient', text: 'abcdef', metadata: { colors: ['#FF66AB'], unit: 'character', easing: 'linear', globalOffset: 3, documentLength: 20 } },
  { kind: 'sinewave', text: 'ola marina', metadata: { min: 30, max: 90, freq: 0.5, step: 'char' } },
  { kind: 'sinewave', text: 'una frase con olas', metadata: { min: 40, max: 120, freq: 0.8, step: 'word' } },
  { kind: 'grow', text: 'creciendo', metadata: { min: 50, max: 200, cycles: 2 } },
  { kind: 'grow', text: 'x', metadata: { min: 50, max: 150, cycles: 1, globalOffset: 5, documentLength: 12 } },
  { kind: 'rainbow', text: 'arcoiris!', metadata: { saturation: 90, lightness: 55, spread: 320, offset: 15 } },
  { kind: 'gradient', text: '', metadata: { colors: ['#FF0000', '#00FF00'] } },
]

interface SnapshotCase { kind: string; text: string; bb: string; rn: unknown }
const SNAPSHOT: SnapshotCase[] = JSON.parse(
  readFileSync(join(__dirname, 'EffectSegments.snapshot.json'), 'utf8'),
)

function effectNode(kind: string, text: string, metadata: NodeMetadata): RedNode {
  const leaf = greenLeaf('text', text)
  const parent = new RedNode(greenNode(kind, '', [leaf]), { kind: kind as NodeKind, metadata })
  parent.initChildren([new RedNode(leaf, { kind: 'text' })])
  return parent
}

describe('effect handlers match the pre-consolidation outputs exactly', () => {
  const registry = new TagRegistry()

  CASES.forEach((c, i) => {
    it(`${c.kind} ${JSON.stringify(c.text)}`, () => {
      const expected = SNAPSHOT[i]
      expect(expected.kind).toBe(c.kind)
      expect(expected.text).toBe(c.text)

      const node = effectNode(c.kind, c.text, c.metadata)
      const def = registry.getByKind(c.kind as NodeKind)!
      const ctx: TagHandlerContext = {
        node,
        source: '',
        visitChildren: () => 'FALLBACK',
        renderChild: () => ({ kind: 'text', text: '', children: [], props: {} }),
      }

      expect(def.toBBCode!(ctx)).toBe(expected.bb)
      expect(JSON.parse(JSON.stringify(def.toRenderNode!(ctx)))).toEqual(expected.rn)
    })
  })
})
