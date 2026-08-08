import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { ASTOptimizer } from '../Transformers/ASTOptimizer'
import { TagRegistry } from '../Model/TagRegistry'

/**
 * Regression: ASTOptimizer must be idempotent — optimizing its own output has to
 * be a no-op.
 *
 * The fuzz suite originally found this but could not report it: it ran on an
 * unseeded `Math.random()`, so the failure showed up in ~50% of runs and the
 * payload that caused it was discarded. Seeding the fuzzer made CI
 * deterministic, but the default seed happens to miss this case, so the
 * minimized repro is pinned here.
 *
 * The bug: paragraphs exist because a block element splits inline content. When
 * a rule deleted that block — here an empty `[notice]` — the two halves were
 * left as adjacent `paragraph` siblings with nothing between them, and
 * `paragraph` is unmergeable. Exporting that tree emits no separator, so
 * re-parsing folded the paragraphs back into one and a *second* optimizer pass
 * found more work. Fixed by `ASTOptimizer.isOrphanedParagraphPair`, which merges
 * that specific shape — one the parser itself never produces.
 *
 * Other seeds that reproduced it: 2, 7, 42, 99999.
 * Repro a whole corpus with: QUASAR_FUZZ_SEED=2 npm test
 */
describe('ASTOptimizer — idempotence', () => {
  const registry = new TagRegistry()
  const REPRO = '[url=https://osu.ppy.sh][/url][notice][/notice][url=https://osu.ppy.sh]'

  /** Optimize → export → re-parse → re-optimize. Should need zero mutations. */
  function reoptimizationOps(source: string): number {
    const model = new BBCodeDocumentModel({ source, strictMode: false })
    new ASTOptimizer().transform(model)

    const exported = new BBCodeExporter(registry).export(model.redRoot!)

    const reparsed = new BBCodeDocumentModel({ source: exported, strictMode: false })
    const { transaction } = new ASTOptimizer().transform(reparsed)
    return transaction?.operations.length ?? 0
  }

  function optimizeAndExport(source: string): string {
    const model = new BBCodeDocumentModel({ source, strictMode: false })
    new ASTOptimizer().transform(model)
    return new BBCodeExporter(registry).export(model.redRoot!)
  }

  it('optimizing already-optimized output is a no-op', () => {
    expect(reoptimizationOps(REPRO)).toBe(0)
  })

  it('reaches its fixed point in a single pass', () => {
    const pass1 = optimizeAndExport(REPRO)
    expect(optimizeAndExport(pass1)).toBe(pass1)
  })

  it('never loses or alters visible text', () => {
    const model = new BBCodeDocumentModel({ source: REPRO, strictMode: false })
    const before = model.redRoot!.green.text
    new ASTOptimizer().transform(model)
    expect(model.redRoot!.green.text).toBe(before)
  })

  // The fix is deliberately narrow: only paragraphs with *nothing* between them
  // collapse. An authored blank line is a real break and must survive.
  it('preserves paragraphs separated by a blank line', () => {
    const source = '[b]uno[/b]\n\n[b]dos[/b]'
    const optimized = optimizeAndExport(source)
    expect(optimized).toContain('uno')
    expect(optimized).toContain('dos')
    expect(optimized).toMatch(/\n/)
    // And it is still a fixed point.
    expect(optimizeAndExport(optimized)).toBe(optimized)
  })
})
