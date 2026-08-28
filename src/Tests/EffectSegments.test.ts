import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TagRegistry, type TagHandlerContext } from '../Model/TagRegistry'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import type { NodeKind, NodeMetadata } from '../Types/core'

/**
 * The four effect tags (gradient, sinewave, grow, rainbow) serialize through
 * ONE evaluator — `evaluateEffect` in `Utils/EffectMath` — presented two ways
 * (toBBCode / toRenderNode). The same evaluator backs the HTML renderer's
 * preview and Text Studio's compiler, so this snapshot pins all three.
 *
 * `EffectSegments.snapshot.json` is byte-exact expected output: colors, sizes,
 * word/whitespace handling, globalOffset/documentLength, empty-text fallbacks.
 *
 * It was re-captured when the effect maths moved into the shared kernel. Three
 * behaviours changed deliberately and are pinned in their new form:
 *
 *  - Whitespace no longer consumes a step of a gradient, and no longer gets a
 *    `[color]` tag of its own. Colouring a space is invisible and costs 15
 *    characters of the 60 000-character budget.
 *  - `ease-in` / `ease-out` / `ease-in-out` are recognised. They used to fall
 *    through to `default: return t`, so a document asking for an eased
 *    gradient silently got a linear one.
 *  - Adjacent runs that resolve to the same style are merged, so a quantised
 *    or single-colour gradient emits one tag instead of one per character.
 *  - `unit: 'word'` measures by word as well as stepping by word. Measuring
 *    by character meant each word took the colour of its first letter, so a
 *    three-word gradient stopped 60% of the way to its end colour.
 *
 * `sinewave` is deliberately NOT expressed through the axis/waveform model:
 * its argument is the character index in radians, so its period is fixed in
 * characters rather than stretching with the text.
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
