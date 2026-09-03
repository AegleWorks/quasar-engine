import { describe, it, expect } from 'vitest'
import {
  classifyOverlap,
  editsConflict,
  compareEditPriority,
  resolveEditConflicts,
  type PlannedEdit,
} from '../Edits/EditPlan'

/**
 * The conflict contract behind the BBCode optimizer.
 *
 * The optimizer emits ONE set of `SurgicalEdit`s over the original source and
 * two appliers consume it (Monaco in-place, string rewrite for export). Monaco
 * refuses to arbitrate overlapping ranges, so the guarantee has to be proven
 * here: whatever the rules emit, `resolveEditConflicts` returns a pairwise
 * disjoint set, and it returns the SAME set no matter what order the rules ran
 * in.
 */

const edit = (
  start: number,
  end: number,
  text: string,
  ruleId = 'r',
  priority = 0,
): PlannedEdit => ({ start, end, text, ruleId, priority })

// ── Geometry ──────────────────────────────────────────────────────

describe('classifyOverlap — ranges are half-open', () => {
  it('treats touching ranges as disjoint', () => {
    // [0,5) and [5,10) share no byte: two adjacent replacements are legal.
    expect(classifyOverlap(edit(0, 5, 'a'), edit(5, 10, 'b'))).toBe('disjoint')
  })

  it('treats separated ranges as disjoint', () => {
    expect(classifyOverlap(edit(0, 5, 'a'), edit(9, 12, 'b'))).toBe('disjoint')
  })

  it('classifies proper containment as subsumption', () => {
    expect(classifyOverlap(edit(0, 20, 'a'), edit(5, 10, 'b'))).toBe('subsumption')
  })

  it('classifies containment as subsumption regardless of argument order', () => {
    expect(classifyOverlap(edit(5, 10, 'b'), edit(0, 20, 'a'))).toBe('subsumption')
  })

  it('classifies identical ranges as subsumption', () => {
    // Not "disjoint" and not "straddle": one of the two has to go.
    expect(classifyOverlap(edit(3, 8, 'a'), edit(3, 8, 'b'))).toBe('subsumption')
  })

  it('classifies shared-edge containment as subsumption', () => {
    expect(classifyOverlap(edit(0, 10, 'a'), edit(0, 4, 'b'))).toBe('subsumption')
    expect(classifyOverlap(edit(0, 10, 'a'), edit(6, 10, 'b'))).toBe('subsumption')
  })

  it('classifies partial overlap as straddle', () => {
    expect(classifyOverlap(edit(0, 10, 'a'), edit(5, 15, 'b'))).toBe('straddle')
    expect(classifyOverlap(edit(5, 15, 'b'), edit(0, 10, 'a'))).toBe('straddle')
  })
})

describe('classifyOverlap — zero-width insertions', () => {
  it('conflicts with another insertion at the same offset', () => {
    // Empty intersection, but both write at one point with no defined order.
    expect(classifyOverlap(edit(7, 7, 'x'), edit(7, 7, 'y'))).toBe('subsumption')
  })

  it('does not conflict with an insertion at a different offset', () => {
    expect(classifyOverlap(edit(7, 7, 'x'), edit(8, 8, 'y'))).toBe('disjoint')
  })

  it('conflicts when strictly inside a replacement', () => {
    // The replacement destroys the bytes the insertion point refers to.
    expect(classifyOverlap(edit(5, 5, 'x'), edit(0, 10, 'a'))).toBe('subsumption')
    expect(classifyOverlap(edit(0, 10, 'a'), edit(5, 5, 'x'))).toBe('subsumption')
  })

  it('stays disjoint at a replacement boundary', () => {
    // Unambiguously before / after, and both appliers agree.
    expect(classifyOverlap(edit(0, 0, 'x'), edit(0, 10, 'a'))).toBe('disjoint')
    expect(classifyOverlap(edit(10, 10, 'x'), edit(0, 10, 'a'))).toBe('disjoint')
  })

  it('editsConflict agrees with classifyOverlap', () => {
    expect(editsConflict(edit(0, 5, 'a'), edit(5, 9, 'b'))).toBe(false)
    expect(editsConflict(edit(0, 5, 'a'), edit(4, 9, 'b'))).toBe(true)
  })
})

// ── Priority ──────────────────────────────────────────────────────

describe('compareEditPriority — the order is total', () => {
  it('ranks higher priority first', () => {
    expect(compareEditPriority(edit(0, 5, 'a', 'x', 10), edit(0, 5, 'b', 'y', 1))).toBeLessThan(0)
  })

  it('ranks the wider claim first at equal priority', () => {
    expect(compareEditPriority(edit(0, 20, 'a'), edit(0, 5, 'b'))).toBeLessThan(0)
  })

  it('ranks the earlier claim first at equal priority and width', () => {
    expect(compareEditPriority(edit(0, 5, 'a'), edit(9, 14, 'b'))).toBeLessThan(0)
  })

  it('breaks a full tie on ruleId, then text', () => {
    expect(compareEditPriority(edit(0, 5, 'a', 'aaa'), edit(0, 5, 'a', 'bbb'))).toBeLessThan(0)
    expect(compareEditPriority(edit(0, 5, 'a', 'r'), edit(0, 5, 'b', 'r'))).toBeLessThan(0)
  })

  it('returns 0 only for genuinely identical edits', () => {
    expect(compareEditPriority(edit(0, 5, 'a', 'r', 3), edit(0, 5, 'a', 'r', 3))).toBe(0)
  })

  it('never returns 0 for two distinguishable edits', () => {
    // Totality is the property that keeps the outcome independent of the order
    // rules were registered in. A partial order would leave ties to sort
    // stability, i.e. to registration order.
    const all = [
      edit(0, 5, 'a', 'r1', 1), edit(0, 5, 'b', 'r1', 1),
      edit(0, 5, 'a', 'r2', 1), edit(0, 9, 'a', 'r1', 1),
      edit(2, 7, 'a', 'r1', 1), edit(0, 5, 'a', 'r1', 2),
    ]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(compareEditPriority(all[i], all[j])).not.toBe(0)
      }
    }
  })
})

// ── Resolution ────────────────────────────────────────────────────

describe('resolveEditConflicts — invalid ranges', () => {
  it('drops a range past the end of the source without throwing', () => {
    const { accepted, rejected } = resolveEditConflicts([edit(0, 99, 'x')], 10)
    expect(accepted).toHaveLength(0)
    expect(rejected[0].reason).toBe('invalid-range')
    expect(rejected[0].winner).toBeUndefined()
  })

  it('drops inverted and negative ranges', () => {
    const { accepted, rejected } = resolveEditConflicts([edit(8, 3, 'x'), edit(-1, 4, 'y')], 10)
    expect(accepted).toHaveLength(0)
    expect(rejected.map(r => r.reason)).toEqual(['invalid-range', 'invalid-range'])
  })

  it('drops non-integer offsets', () => {
    const { accepted } = resolveEditConflicts([edit(1.5, 4, 'x')], 10)
    expect(accepted).toHaveLength(0)
  })

  it('keeps the rest of the batch when one rule emits garbage', () => {
    // One broken rule must not destroy an otherwise good minify run.
    const { accepted } = resolveEditConflicts([edit(0, 99, 'bad'), edit(0, 3, 'good')], 10)
    expect(accepted.map(e => e.text)).toEqual(['good'])
  })
})

describe('resolveEditConflicts — arbitration', () => {
  it('keeps every disjoint edit', () => {
    const { accepted, rejected } = resolveEditConflicts(
      [edit(0, 5, 'a'), edit(5, 10, 'b'), edit(12, 14, 'c')],
      20,
    )
    expect(accepted).toHaveLength(3)
    expect(rejected).toHaveLength(0)
  })

  it('returns accepted edits sorted by start', () => {
    const { accepted } = resolveEditConflicts(
      [edit(12, 14, 'c'), edit(0, 5, 'a'), edit(5, 10, 'b')],
      20,
    )
    expect(accepted.map(e => e.start)).toEqual([0, 5, 12])
  })

  it('lets the higher priority edit win a subsumption', () => {
    const wide = edit(0, 20, 'WIDE', 'merge', 10)
    const narrow = edit(5, 10, 'narrow', 'hex', 1)
    const { accepted, rejected } = resolveEditConflicts([wide, narrow], 30)

    expect(accepted).toEqual([wide])
    expect(rejected[0].edit).toBe(narrow)
    expect(rejected[0].reason).toBe('subsumed')
    expect(rejected[0].winner).toBe(wide)
  })

  it('drops the containing edit when the inner one outranks it', () => {
    // Priority is the rule's declaration, not a function of range size: a
    // narrow winner takes the whole wide edit down with it.
    const wide = edit(0, 20, 'WIDE', 'merge', 1)
    const narrow = edit(5, 10, 'narrow', 'hex', 10)
    const { accepted, rejected } = resolveEditConflicts([wide, narrow], 30)

    expect(accepted).toEqual([narrow])
    expect(rejected[0].edit).toBe(wide)
    expect(rejected[0].reason).toBe('subsumed')
  })

  it('reports a partial overlap as straddle, not subsumed', () => {
    // Same resolution, different diagnosis. Two maximal rules should never
    // straddle, so this reason is how that bug becomes visible.
    const left = edit(0, 10, 'L', 'ruleA', 5)
    const right = edit(5, 15, 'R', 'ruleB', 1)
    const { accepted, rejected } = resolveEditConflicts([left, right], 20)

    expect(accepted).toEqual([left])
    expect(rejected[0].reason).toBe('straddle')
    expect(rejected[0].winner).toBe(left)
  })

  it('dedupes byte-identical edits from different rules', () => {
    const a = edit(0, 5, 'same', 'ruleA', 1)
    const b = edit(0, 5, 'same', 'ruleB', 1)
    const { accepted, rejected } = resolveEditConflicts([a, b], 10)

    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe('subsumed')
  })

  it('arbitrates two insertions at the same offset', () => {
    const keep = edit(4, 4, 'first', 'ruleA', 9)
    const drop = edit(4, 4, 'second', 'ruleB', 2)
    const { accepted, rejected } = resolveEditConflicts([drop, keep], 10)

    expect(accepted).toEqual([keep])
    expect(rejected[0].edit).toBe(drop)
  })

  it('lets a chain of conflicts collapse to the single best edit', () => {
    const { accepted } = resolveEditConflicts(
      [edit(0, 10, 'a', 'r1', 1), edit(8, 18, 'b', 'r2', 5), edit(16, 26, 'c', 'r3', 3)],
      30,
    )
    // r2 wins outright, and it straddles both neighbours, so both go.
    expect(accepted.map(e => e.ruleId)).toEqual(['r2'])
  })
})

// ── The invariants the appliers depend on ─────────────────────────

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** A messy, deliberately collision-heavy edit set over a 200-char source. */
function messyBatch(): PlannedEdit[] {
  const rules = ['merge-colors', 'shorten-hex', 'drop-empty', 'reorder-wrappers']
  const out: PlannedEdit[] = []
  let state = 7
  for (let i = 0; i < 120; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const start = state % 190
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const width = state % 14 // width 0 exercises the insertion paths
    out.push({
      start,
      end: start + width,
      text: `t${i}`,
      ruleId: rules[i % rules.length],
      priority: i % 5,
    })
  }
  return out
}

describe('resolveEditConflicts — invariants', () => {
  it('never returns two conflicting edits', () => {
    const { accepted } = resolveEditConflicts(messyBatch(), 200)
    expect(accepted.length).toBeGreaterThan(0)

    for (let i = 0; i < accepted.length; i++) {
      for (let j = i + 1; j < accepted.length; j++) {
        expect(classifyOverlap(accepted[i], accepted[j])).toBe('disjoint')
      }
    }
  })

  it('accounts for every input edit exactly once', () => {
    const batch = messyBatch()
    const { accepted, rejected } = resolveEditConflicts(batch, 200)
    expect(accepted.length + rejected.length).toBe(batch.length)
  })

  it('produces the same result whatever order the rules ran in', () => {
    // The property the whole contract exists for. If this can fail, the
    // minified output depends on rule registration order.
    const batch = messyBatch()
    const baseline = resolveEditConflicts(batch, 200)
    const fingerprint = (r: ReturnType<typeof resolveEditConflicts>) =>
      r.accepted.map(e => `${e.start}-${e.end}:${e.ruleId}:${e.text}`).join('|')

    for (const seed of [1, 42, 1337, 90210, 5]) {
      const shuffled = resolveEditConflicts(shuffle(batch, seed), 200)
      expect(fingerprint(shuffled)).toBe(fingerprint(baseline))
    }
  })
})

// ── The case that motivated the contract ──────────────────────────

describe('merge run + shorten hex', () => {
  /**
   *   [color=#FF0000]a[/color][color=#FF0000]b[/color]
   *   0              15       23             38      46
   *
   * `merge-colors` claims the whole run; `shorten-hex` claims each `#FF0000`
   * inside it. Both are correct in isolation and they collide.
   */
  const SOURCE = '[color=#FF0000]a[/color][color=#FF0000]b[/color]'

  it('gives the region to the rule that owns its normal form', () => {
    const merge = edit(0, SOURCE.length, '[color=#F00]ab[/color]', 'merge-colors', 100)
    const hexA = edit(7, 14, '#F00', 'shorten-hex', 10)
    const hexB = edit(31, 38, '#F00', 'shorten-hex', 10)

    const { accepted, rejected } = resolveEditConflicts([hexA, merge, hexB], SOURCE.length)

    expect(accepted.map(e => e.ruleId)).toEqual(['merge-colors'])
    expect(rejected.every(r => r.reason === 'subsumed')).toBe(true)
    // The merge already emitted the shortened form, so nothing is lost by
    // dropping the hex edits — a rule that rewrites a region owns that
    // region's normal form.
    expect(accepted[0].text).toContain('#F00')
  })

  it('still shortens a colour no other rule claimed', () => {
    const merge = edit(0, 24, '[color=#F00]a[/color]', 'merge-colors', 100)
    const hexOutside = edit(31, 38, '#F00', 'shorten-hex', 10)

    const { accepted } = resolveEditConflicts([merge, hexOutside], SOURCE.length)
    expect(accepted.map(e => e.ruleId)).toEqual(['merge-colors', 'shorten-hex'])
  })
})
