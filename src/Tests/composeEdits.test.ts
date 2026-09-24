import { describe, it, expect } from 'vitest'
import { composeEditPasses } from '../Edits/composeEdits'
import { applyEditsToSource } from '../Edits/applyEdits'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

/**
 * `composeEditPasses` folds the chain of passes `optimizeBBCodeFully` runs
 * into ONE `SurgicalEdit[]` addressed to the very first source — what lets
 * the in-place minifier reach the same fixpoint the export does, in a single
 * undo stop. These cases are plain strings, not BBCode: the composer only
 * ever sees offsets and opaque replacement text, never tags.
 */

describe('composeEditPasses — trivial inputs', () => {
  it('returns no edits for an empty pass list', () => {
    expect(composeEditPasses('hello world', [])).toEqual([])
  })

  it('returns no edits when every pass is empty', () => {
    expect(composeEditPasses('hello', [[], []])).toEqual([])
  })

  it('handles an empty source with no passes', () => {
    expect(composeEditPasses('', [])).toEqual([])
  })

  it('ignores an empty pass mixed in with real ones', () => {
    const real: SurgicalEdit[] = [{ start: 0, end: 0, text: '>' }]
    expect(composeEditPasses('hello', [[], real, []])).toEqual(real)
  })
})

describe('composeEditPasses — deletion/insertion interplay', () => {
  const SOURCE = '0123456789'

  it('pass 2 deleting exactly what pass 1 inserted composes to nothing', () => {
    // pass 1: '01234' + 'abc' + '56789'  (insert before '5')
    const pass1: SurgicalEdit[] = [{ start: 5, end: 5, text: 'abc' }]
    // pass 2, over the 13-char pass-1 output: delete the 'abc' just inserted
    const pass2: SurgicalEdit[] = [{ start: 5, end: 8, text: '' }]

    const composed = composeEditPasses(SOURCE, [pass1, pass2])

    expect(composed).toEqual([])
    expect(applyEditsToSource(SOURCE, composed)).toBe(SOURCE)
  })

  it('pass 2 re-inserting exactly what pass 1 deleted composes to NO edit', () => {
    // pass 1: delete '567' -> '01234' + '89'
    const pass1: SurgicalEdit[] = [{ start: 5, end: 8, text: '' }]
    // pass 2, over the 7-char pass-1 output: re-insert '567' right before '8'
    const pass2: SurgicalEdit[] = [{ start: 5, end: 5, text: '567' }]

    const composed = composeEditPasses(SOURCE, [pass1, pass2])

    expect(composed).toEqual([])
    expect(applyEditsToSource(SOURCE, composed)).toBe(SOURCE)
  })

  it('composes a pass-2 edit that straddles a pass-1 insertion boundary', () => {
    // pass 1: insert 'XY' before '5' -> '01234' + 'XY' + '56789' (12 chars)
    const pass1: SurgicalEdit[] = [{ start: 5, end: 5, text: 'XY' }]
    // pass 2, over that 12-char text: replace [3,9) = '34XY56' with 'Z'.
    // That span covers original '34' (offsets 3-4), all of pass 1's 'XY',
    // and original '56' (offsets 5-6) — straddling the insertion on both sides.
    const pass2: SurgicalEdit[] = [{ start: 3, end: 9, text: 'Z' }]

    const composed = composeEditPasses(SOURCE, [pass1, pass2])

    // Minimal composed form: original[3,7) ('3456') replaced by 'Z' — the
    // inserted 'XY' never touched the original source, so it disappears
    // entirely rather than showing up as a separate edit.
    expect(composed).toEqual([{ start: 3, end: 7, text: 'Z' }])
    expect(applyEditsToSource(SOURCE, composed)).toBe('012Z789')
  })

  it('deletions that meet across two passes merge into one composed edit', () => {
    const source = 'abcdefgh'
    // pass 1: delete 'cde' -> 'ab' + 'fgh'
    const pass1: SurgicalEdit[] = [{ start: 2, end: 5, text: '' }]
    // pass 2, over the 5-char 'abfgh': delete 'fgh' -> 'ab'
    const pass2: SurgicalEdit[] = [{ start: 2, end: 5, text: '' }]

    const composed = composeEditPasses(source, [pass1, pass2])

    expect(composed).toEqual([{ start: 2, end: 8, text: '' }])
    expect(applyEditsToSource(source, composed)).toBe('ab')
  })

  it('composes insertions at the start and end across two passes', () => {
    const source = 'hello'
    // pass 1: prepend '[' -> '[hello' (6 chars)
    const pass1: SurgicalEdit[] = [{ start: 0, end: 0, text: '[' }]
    // pass 2, over the 6-char '[hello': append ']' at the very end
    const pass2: SurgicalEdit[] = [{ start: 6, end: 6, text: ']' }]

    const composed = composeEditPasses(source, [pass1, pass2])

    // Both insertions are addressed back to the ORIGINAL offsets (0 and 5),
    // not the 6 that pass 2 saw.
    expect(composed).toEqual([
      { start: 0, end: 0, text: '[' },
      { start: 5, end: 5, text: ']' },
    ])
    expect(applyEditsToSource(source, composed)).toBe('[hello]')
  })
})

// ── Seeded random property test ─────────────────────────────────────
//
// Deterministic PRNG, no `Math.random()` — see `Fuzzer.test.ts` for why a
// fuzz test that cannot be replayed is not a fuzz test. Override with
// QUASAR_FUZZ_SEED to reproduce a specific failing run.

const FUZZ_SEED = Number(process.env.QUASAR_FUZZ_SEED ?? 0x5EED_1A57)

/** mulberry32 — small, fast, good enough distribution for this generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = 'abcdefgh[]/= \n'

function randomText(rand: () => number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return out
}

/**
 * One random, valid pass over a text of `length` characters: sorted and
 * pairwise non-overlapping, exactly the precondition `composeEditPasses`
 * documents.
 */
function randomPass(rand: () => number, length: number): SurgicalEdit[] {
  const count = Math.floor(rand() * 4) // 0..3 edits per pass
  const edits: SurgicalEdit[] = []
  let cursor = 0
  let previousWasInsertionHere = false

  for (let i = 0; i < count; i++) {
    const start = cursor + Math.floor(rand() * (length - cursor + 1))
    const maxWidth = length - start
    let width = Math.floor(rand() * (maxWidth + 1))

    // Two zero-width edits at the exact same offset are an unresolvable
    // conflict (ambiguous insertion order), not a valid non-overlapping
    // pass — widen this one when there is room, otherwise drop it.
    if (width === 0 && start === cursor && previousWasInsertionHere) {
      if (maxWidth === 0) continue
      width = 1
    }

    const end = start + width
    edits.push({ start, end, text: randomText(rand, Math.floor(rand() * 5)) })
    previousWasInsertionHere = width === 0
    cursor = end
  }

  return edits
}

describe('composeEditPasses — seeded random property', () => {
  it('matches sequential application for random chains of random passes', () => {
    const rand = mulberry32(FUZZ_SEED)

    for (let trial = 0; trial < 300; trial++) {
      const source = randomText(rand, Math.floor(rand() * 40))
      const passCount = 1 + Math.floor(rand() * 4) // 1..4 passes

      const passes: SurgicalEdit[][] = []
      let current = source
      for (let p = 0; p < passCount; p++) {
        const pass = randomPass(rand, current.length)
        passes.push(pass)
        current = applyEditsToSource(current, pass)
      }

      const composed = composeEditPasses(source, passes)

      // Sorted, pairwise non-overlapping, and free of no-op edits.
      for (let i = 0; i < composed.length; i++) {
        const edit = composed[i]
        expect(edit.start).toBeLessThanOrEqual(edit.end)
        expect(edit.start === edit.end && edit.text === '').toBe(false)
        if (i > 0) expect(composed[i - 1].end).toBeLessThanOrEqual(edit.start)
      }

      expect(applyEditsToSource(source, composed)).toBe(current)
    }
  })
})
