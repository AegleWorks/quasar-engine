import { describe, it, expect } from 'vitest'
import { BracketDepthIndex } from '../BracketIndex'

/**
 * The index replaces a scan, so the property is the scan's answer: for every
 * offset, `depthAt` must equal the clamped depth count over the prefix. The
 * documents are deliberately full of stray brackets — the clamp is what makes
 * the summary subtle (a `]` under depth 0 is not a −1), and an edit that
 * deletes a `[` can hand a `]` further on to a bracket that was never inside
 * the edited piece. Nothing here is a hand-picked case; it is thousands of
 * random edits checked at every offset that could possibly be asked about.
 *
 * Two things keep the suite honest about its OWN cost, because the first
 * version of this file was quadratic and ran for half an hour: the document
 * is held between `MIN_DOC` and `MAX_DOC` (the random edits are biased back
 * toward the band whenever they leave it — 7% of them paste up to 9 KB, and
 * unchecked that grew the text past a megabyte), and a sweep over every
 * offset uses `oracleTable`, one O(n) pass that answers all of them, rather
 * than an O(n) scan per offset.
 */

/**
 * The plain scan's answer for every `end` in `[0, length]`, in one pass.
 *
 * `into` is reused across calls when it is large enough — the edit loop asks
 * for a table per edit, and allocating 400 KB each time is pure GC churn.
 */
function oracleTable(source: string, into?: Int32Array): Int32Array {
  const table = into !== undefined && into.length > source.length ? into : new Int32Array(source.length + 1)
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    table[i] = depth
    const c = source.charCodeAt(i)
    if (c === 91) depth++
    else if (c === 93 && depth > 0) depth--
  }
  table[source.length] = depth
  return table
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Text with a bracket every few characters, both kinds, unbalanced. */
function noisy(rand: () => number, length: number): string {
  const parts: string[] = []
  let size = 0
  while (size < length) {
    const r = rand()
    const piece = r < 0.12 ? '[' : r < 0.24 ? ']' : r < 0.3 ? '\n' : 'abcdefgh'[Math.floor(rand() * 8)]
    parts.push(piece)
    size += piece.length
  }
  return parts.join('').slice(0, length)
}

/**
 * Compare at every `step`-th offset, without paying for an `expect` per one.
 *
 * `expect` is the expensive part of a sweep — a few microseconds each, against
 * tens of nanoseconds for the comparison — and the sweeps here run over
 * hundreds of thousands of offsets. The loop compares by hand and only builds
 * an assertion when it has something to report, which is what keeps the whole
 * file inside a normal test timeout.
 */
function expectAgreesEverywhere(index: BracketDepthIndex, source: string, step: number): void {
  const table = oracleTable(source)
  for (let end = 0; end <= source.length; end += step) {
    const got = index.depthAt(source, end)
    if (got !== table[end]) {
      expect(got, `depth at ${end} of ${source.length}`).toBe(table[end])
    }
  }
  expect(index.depthAt(source, source.length)).toBe(table[source.length])
}

const MIN_DOC = 20_000
const MAX_DOC = 100_000

describe('BracketDepthIndex', () => {
  it('rebuild agrees with the scan at every offset', () => {
    const rand = mulberry32(11)
    for (const size of [0, 1, 7, 4095, 4096, 4097, 20_000]) {
      const source = noisy(rand, size)
      const index = new BracketDepthIndex()
      index.rebuild(source)
      expect(index.length).toBe(size)
      expectAgreesEverywhere(index, source, 1)
    }
  })

  it('2.000 random edits: every offset agrees with the scan, and only one piece is ever read', () => {
    const rand = mulberry32(0x5eed)
    let source = noisy(rand, 60_000)
    const index = new BracketDepthIndex()
    index.rebuild(source)
    // One table per edit answers every offset the edit is checked at — the
    // first version asked `oracle` per offset, which rescanned the prefix each
    // time and turned the loop quadratic.
    let table = oracleTable(source)

    for (let edit = 0; edit < 2_000; edit++) {
      const kind = rand()
      const start = Math.floor(rand() * (source.length + 1))
      let endOld = start
      let text = ''
      // The size band: a document past `MAX_DOC` only shrinks, one under
      // `MIN_DOC` only grows, so the run never wanders into a size where the
      // checks below stop being cheap.
      const tooBig = source.length > MAX_DOC
      const tooSmall = source.length < MIN_DOC
      if (kind < 0.45 && !tooBig) {
        // Insert 1..12 characters, bracket-heavy.
        text = noisy(rand, 1 + Math.floor(rand() * 12))
      } else if (kind < 0.9 && !tooSmall) {
        // Delete 1..12 characters.
        endOld = Math.min(source.length, start + 1 + Math.floor(rand() * 12))
      } else if (kind < 0.97 && !tooBig) {
        // Replace a longer span with a shorter or longer one (a paste).
        endOld = Math.min(source.length, start + Math.floor(rand() * 3000))
        text = noisy(rand, Math.floor(rand() * 9000))
      } else if (!tooSmall) {
        // A big delete, to shrink pieces below the merge threshold.
        endOld = Math.min(source.length, start + Math.floor(rand() * 12_000))
      }
      const next = source.slice(0, start) + text + source.slice(endOld)
      index.applyChange(next, start, endOld, text.length)
      source = next

      if (index.length !== source.length) expect(index.length).toBe(source.length)
      table = oracleTable(source, table)
      // Around the edit, where a wrong summary would show first, and a few
      // far away offsets; a full sweep every 100 edits.
      for (const end of [start, Math.min(source.length, start + text.length), Math.max(0, start - 5000), Math.min(source.length, start + 5000)]) {
        const got = index.depthAt(source, end)
        if (got !== table[end]) expect(got, `depth at ${end} after edit ${edit}`).toBe(table[end])
        if (index.lastScanned > 8192) expect(index.lastScanned).toBeLessThanOrEqual(8192)
      }
      if (edit % 100 === 0) expectAgreesEverywhere(index, source, 97)
    }
    expect(source.length).toBeLessThanOrEqual(MAX_DOC + 9000)
    expectAgreesEverywhere(index, source, 1)
    // The piece count stays proportional to the text, not to the edit count.
    expect(index.pieceCount).toBeLessThanOrEqual(Math.ceil(source.length / 1024) + 2)
  }, 30_000)

  it('a caller whose picture of the previous text disagrees gets a rebuild, not a wrong answer', () => {
    const rand = mulberry32(3)
    const index = new BracketDepthIndex()
    const a = noisy(rand, 10_000)
    index.rebuild(a)
    const b = noisy(rand, 12_000)
    // Claims a 2-char insert on a text that is 2.000 chars longer.
    index.applyChange(b, 5, 5, 2)
    expect(index.length).toBe(b.length)
    expectAgreesEverywhere(index, b, 13)
  })

  it('edits at the very ends and on an empty document', () => {
    const index = new BracketDepthIndex()
    index.rebuild('')
    expect(index.depthAt('', 0)).toBe(0)
    let s = ''
    for (let i = 0; i < 200; i++) {
      const next = s + (i % 3 === 0 ? '[' : i % 3 === 1 ? 'x' : ']')
      index.applyChange(next, s.length, s.length, 1)
      s = next
      expectAgreesEverywhere(index, s, 1)
    }
    for (let i = 0; i < 200; i++) {
      const next = ']' + s
      index.applyChange(next, 0, 0, 1)
      s = next
    }
    expectAgreesEverywhere(index, s, 1)
    while (s.length > 0) {
      const next = s.slice(1)
      index.applyChange(next, 0, 1, 0)
      s = next
    }
    expect(index.length).toBe(0)
    expect(index.depthAt('', 0)).toBe(0)
  })
})
