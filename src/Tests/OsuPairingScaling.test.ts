import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'

/**
 * osu! pairing used to look for each opener's closer by scanning to the end
 * of the document, so n unclosed openers cost n²: 64 000 `[b]` took ten
 * seconds. Output is pinned by the differential (`scripts/differential`);
 * this pins the cost, three orders of magnitude off the old curve.
 */
describe('osu! pairing on unclosed tags is linear', () => {
  const shapes: Record<string, string> = {
    'unclosed bold': '[b]'.repeat(64000) + 'x',
    'unclosed colours': '[color=red]x '.repeat(64000),
    'unclosed per line': '[b]x\n'.repeat(64000),
    'unclosed imagemaps': '[imagemap]\n'.repeat(20000),
  }
  for (const [name, source] of Object.entries(shapes)) {
    it(name, () => {
      const t0 = performance.now()
      new BBCodeDocumentModel({ source, pairing: 'osu', dialect: 'osu', autoAnalyze: false, maxUndo: 0 })
      expect(performance.now() - t0).toBeLessThan(2000)
    })
  }
})
