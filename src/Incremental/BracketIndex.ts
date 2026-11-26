/**
 * DocumentEngine — BracketDepthIndex
 *
 * Answers the incremental parser's one question about the text OUTSIDE its
 * window — "does every `[` before this offset find its `]` before it too?" —
 * without reading the text before the offset.
 *
 * ─── Why the scan had to go ─────────────────────────────────────────────────
 *
 * `bracketsCloseBefore` walked the whole prefix on every keystroke: with the
 * caret at the end of the 547 KB fixture that is 547.000 `charCodeAt` calls
 * per key, measured at 2.2 ms — more than the parse, the splice and the red
 * build of that same keystroke put together. Caching was declined once on the
 * grounds that the reasoning is subtle: an edit can expose a `]` that a
 * deleted `[` used to claim, so any cache keyed on "the prefix has not
 * changed" is wrong the moment it is asked about a prefix that has.
 *
 * ─── Why this is not that cache ─────────────────────────────────────────────
 *
 * The scan computes a CLAMPED running depth — `d ← max(0, d + a)` where `a`
 * is +1 for `[`, −1 for `]`, 0 otherwise — and a clamped running sum has an
 * exact, composable summary. Over any stretch of text with prefix sums
 * P₁…Pₙ, the depth after the stretch is a function of the depth before it:
 *
 *     d' = Pₙ + max(d, −min(0, P₁, …, Pₙ))
 *
 * so a stretch is fully described by two integers, its net sum and its lowest
 * dip. The index keeps the source as a sequence of PIECES (a few KB each),
 * each carrying that pair. An edit re-summarises only the piece(s) it touched,
 * from the NEW text, and every other piece keeps a summary that is still
 * exactly true of its (unchanged, merely displaced) characters. A query walks
 * the piece summaries up to the offset and scans only the tail of the piece
 * the offset falls in. Nothing here is a guess about what the edit exposed:
 * the touched piece is re-read verbatim, and composition is arithmetic.
 *
 * Cost per keystroke: one summary of ≤ 8 KB plus one walk over ~140 piece
 * summaries at 547 KB — a few microseconds, and independent of where the
 * caret is. Verified against the plain scan by `BracketIndex.test.ts`: 2.000
 * random edits over documents full of stray brackets, every offset agreeing.
 *
 * The index does not know which document it describes; the parser keys it on
 * the green root it was last synchronised with and rebuilds it (one scan) when
 * the root it is handed is not that one. See `IncrementalParser.reparse`.
 */

/** Pieces are re-cut to this size when an edit grows one past `MAX_PIECE`. */
const TARGET_PIECE = 4096
/** A piece may grow to this before it is split. */
const MAX_PIECE = TARGET_PIECE * 2
/** A piece that shrinks below this merges into a neighbour when that fits. */
const MIN_PIECE = TARGET_PIECE / 4
/**
 * Number of leaf pieces aggregated into each superblock summary.
 * Turns linear O(P) piece walks into O(P / SUPER_SIZE + SUPER_SIZE):
 * at 5M chars (1,221 pieces), queries touch ~39 superblocks + ≤32 pieces.
 */
const SUPER_SIZE = 32
const SUPER_SHIFT = 5 // log2(32)

export class BracketDepthIndex {
  /** Length of each piece, in characters. Pieces partition `[0, length)`. */
  private lengths: number[] = []
  /** Net bracket sum of each piece: `[` counts +1, `]` counts −1. */
  private sums: number[] = []
  /** Lowest prefix sum inside each piece, capped at 0 (see the header). */
  private dips: number[] = []
  /** Superblock summaries (each covers `SUPER_SIZE` consecutive leaf pieces). */
  private superLengths: number[] = []
  private superSums: number[] = []
  private superDips: number[] = []
  /** First superblock index needing recomputation, or `Infinity` when clean. */
  private superDirtyFrom = Number.POSITIVE_INFINITY
  private _length = 0

  /**
   * Characters read by the last `depthAt` — the tail of one piece, never the
   * prefix. Exposed so a regression back to an O(prefix) scan is something a
   * test can assert on, rather than something a profile has to notice.
   */
  lastScanned = 0

  /** The length of the text this index currently describes. */
  get length(): number {
    return this._length
  }

  /** Number of pieces — for tests; it should stay ~`length / TARGET_PIECE`. */
  get pieceCount(): number {
    return this.lengths.length
  }

  /** Describe `source` from scratch. O(n) — one scan, the same the query used to be. */
  rebuild(source: string): void {
    this.lengths.length = 0
    this.sums.length = 0
    this.dips.length = 0
    this._length = source.length
    for (let at = 0; at < source.length; at += TARGET_PIECE) {
      this.pushPiece(source, at, Math.min(source.length, at + TARGET_PIECE))
    }
    this.superDirtyFrom = 0
    this.syncSupers()
  }

  /** Recompute superblock summaries from `superDirtyFrom` onward. */
  private syncSupers(): void {
    const count = this.lengths.length
    const superCount = (count + SUPER_SIZE - 1) >> SUPER_SHIFT
    if (this.superDirtyFrom >= superCount) {
      this.superLengths.length = superCount
      this.superSums.length = superCount
      this.superDips.length = superCount
      this.superDirtyFrom = Number.POSITIVE_INFINITY
      return
    }
    this.superLengths.length = superCount
    this.superSums.length = superCount
    this.superDips.length = superCount
    for (let s = this.superDirtyFrom; s < superCount; s++) {
      this.recomputeSuper(s)
    }
    this.superDirtyFrom = Number.POSITIVE_INFINITY
  }

  /** Recompute a single superblock summary `s` from its leaf pieces. */
  private recomputeSuper(s: number): void {
    const start = s << SUPER_SHIFT
    const end = Math.min(start + SUPER_SIZE, this.lengths.length)
    let len = 0
    let sum = 0
    let dip = 0
    const lengths = this.lengths
    const sums = this.sums
    const dips = this.dips
    for (let i = start; i < end; i++) {
      len += lengths[i]
      const d = sum + dips[i]
      if (d < dip) dip = d
      sum += sums[i]
    }
    this.superLengths[s] = len
    this.superSums[s] = sum
    this.superDips[s] = dip
  }

  /**
   * Bring the index from the text before an edit to `newSource`, the text
   * after it. `start`/`endOld` bound the replaced region in OLD coordinates;
   * `insertedLength` is the length of the text that replaced it.
   *
   * Only the pieces overlapping the replaced region are re-read. They are
   * re-summarised as one piece over the same span in NEW coordinates, and
   * that piece is split if it has grown past `MAX_PIECE` — so a long paste
   * ends up as several normal pieces, not one giant one that every later
   * query near it would have to scan.
   */
  applyChange(newSource: string, start: number, endOld: number, insertedLength: number): void {
    const delta = insertedLength - (endOld - start)
    const oldLength = this._length
    if (endOld > oldLength || start > endOld || newSource.length !== oldLength + delta) {
      // The caller's picture of the previous text and ours disagree. There is
      // no way to reconcile them locally; describe the new text outright.
      this.rebuild(newSource)
      return
    }

    if (this.superDirtyFrom !== Number.POSITIVE_INFINITY) this.syncSupers()

    // Locate the piece containing `start` by skipping whole superblocks first.
    const lengths = this.lengths
    let i = 0
    let pieceStart = 0
    if (lengths.length > SUPER_SIZE) {
      const sLen = this.superLengths
      let s = 0
      while (s < sLen.length - 1 && pieceStart + sLen[s] <= start) {
        pieceStart += sLen[s]
        s++
      }
      i = s << SUPER_SHIFT
    }
    while (i < lengths.length - 1 && pieceStart + lengths[i] <= start) {
      pieceStart += lengths[i]
      i++
    }
    let j = i
    let pieceEnd = pieceStart + (lengths.length === 0 ? 0 : lengths[i])
    while (j < lengths.length - 1 && pieceEnd < endOld) {
      j++
      pieceEnd += lengths[j]
    }

    const newEnd = pieceEnd + delta
    const removed = lengths.length === 0 ? 0 : j - i + 1
    const oldCount = lengths.length
    this.spliceSummaries(i, removed, newSource, pieceStart, newEnd)
    this._length = newSource.length

    if (this.lengths.length === oldCount && removed === 1) {
      // Fast path (common keystroke): 1 piece replaced in-place, update only its superblock.
      this.recomputeSuper(i >> SUPER_SHIFT)
    } else {
      const dirty = i >> SUPER_SHIFT
      if (dirty < this.superDirtyFrom) this.superDirtyFrom = dirty
    }

    // Keep the pieces around the edit from dwindling: a piece that lost most
    // of its text merges into a neighbour so the piece count stays bounded by
    // the text length, not by the number of edits it has seen.
    this.mergeSmallAround(i)
  }

  /**
   * The clamped bracket depth just before `end` — what the plain scan of
   * `[0, end)` would return. `end === 0` is depth 0; `end > length` is
   * clamped to the text.
   */
  depthAt(source: string, end: number): number {
    if (end > this._length) end = this._length
    if (this.superDirtyFrom !== Number.POSITIVE_INFINITY) this.syncSupers()
    const lengths = this.lengths
    let depth = 0
    let pos = 0
    let i = 0
    // Whole superblocks before `end`: compose their summaries.
    if (lengths.length > SUPER_SIZE) {
      const sLen = this.superLengths
      const sSum = this.superSums
      const sDip = this.superDips
      let s = 0
      for (; s < sLen.length && pos + sLen[s] <= end; s++) {
        const dip = sDip[s]
        depth = sSum[s] + (depth > -dip ? depth : -dip)
        pos += sLen[s]
      }
      i = s << SUPER_SHIFT
    }
    // Whole pieces before `end`: compose their summaries.
    for (; i < lengths.length && pos + lengths[i] <= end; i++) {
      const dip = this.dips[i]
      depth = this.sums[i] + (depth > -dip ? depth : -dip)
      pos += lengths[i]
    }
    // The tail of the piece `end` falls in: scan it.
    this.lastScanned = end - pos
    for (let k = pos; k < end; k++) {
      const c = source.charCodeAt(k)
      if (c === 91 /* [ */) depth++
      else if (c === 93 /* ] */ && depth > 0) depth--
    }
    return depth
  }

  /**
   * The lowest UNCLAMPED running bracket sum over `[from, length)`, starting
   * from 0 at `from` (so never above 0). It is −k exactly when some `]` after
   * `from` would close the k-th bracket left open before `from` — the
   * question `IncrementalParser` asks when a `[` before its window has no
   * `]` before it (see `unmatchedStayUnmatched`).
   *
   * Scans the rest of the piece `from` falls in, then composes the summaries
   * of the pieces after it: a piece whose running sum starts at `r` dips to
   * exactly `r + dip`.
   */
  suffixMin(source: string, from: number): number {
    if (this.superDirtyFrom !== Number.POSITIVE_INFINITY) this.syncSupers()
    const lengths = this.lengths
    let pos = 0
    let i = 0
    if (lengths.length > SUPER_SIZE) {
      const sLen = this.superLengths
      let s = 0
      while (s < sLen.length && pos + sLen[s] <= from) pos += sLen[s++]
      i = s << SUPER_SHIFT
    }
    while (i < lengths.length && pos + lengths[i] <= from) pos += lengths[i++]
    let run = 0
    let min = 0
    const pieceEnd = i < lengths.length ? pos + lengths[i] : pos
    for (let k = from; k < pieceEnd; k++) {
      const c = source.charCodeAt(k)
      if (c === 91 /* [ */) run++
      else if (c === 93 /* ] */ && --run < min) min = run
    }
    // Finish the current superblock piece-by-piece, then compose remaining superblocks.
    const nextSuper = ((i >> SUPER_SHIFT) + 1) << SUPER_SHIFT
    const leafLimit = Math.min(nextSuper, lengths.length)
    for (i++; i < leafLimit; i++) {
      if (run + this.dips[i] < min) min = run + this.dips[i]
      run += this.sums[i]
    }
    for (let s = nextSuper >> SUPER_SHIFT; s < this.superSums.length; s++) {
      if (run + this.superDips[s] < min) min = run + this.superDips[s]
      run += this.superSums[s]
    }
    return min
  }

  /** Summarise `[from, to)` of `source` and append it as a piece. */
  private pushPiece(source: string, from: number, to: number): void {
    let sum = 0
    let dip = 0
    for (let k = from; k < to; k++) {
      const c = source.charCodeAt(k)
      if (c === 91 /* [ */) sum++
      else if (c === 93 /* ] */) {
        sum--
        if (sum < dip) dip = sum
      }
    }
    this.lengths.push(to - from)
    this.sums.push(sum)
    this.dips.push(dip)
  }

  /**
   * Replace `count` pieces at `index` with the summaries of `[from, to)` of
   * `source`, cut into pieces of at most `MAX_PIECE`.
   */
  private spliceSummaries(index: number, count: number, source: string, from: number, to: number): void {
    const savedLengths = this.lengths
    const savedSums = this.sums
    const savedDips = this.dips
    this.lengths = []
    this.sums = []
    this.dips = []
    const span = to - from
    if (span > MAX_PIECE) {
      const parts = Math.ceil(span / TARGET_PIECE)
      const step = Math.ceil(span / parts)
      for (let at = from; at < to; at += step) this.pushPiece(source, at, Math.min(to, at + step))
    } else if (span > 0 || savedLengths.length === 0) {
      // An empty document keeps one empty piece so `applyChange` always has
      // a piece to anchor on; anywhere else an emptied piece simply goes.
      this.pushPiece(source, from, to)
    }
    const fresh = this.lengths
    const freshSums = this.sums
    const freshDips = this.dips
    savedLengths.splice(index, count, ...fresh)
    savedSums.splice(index, count, ...freshSums)
    savedDips.splice(index, count, ...freshDips)
    this.lengths = savedLengths
    this.sums = savedSums
    this.dips = savedDips
  }

  /**
   * Merge the piece at `index` (and the one after it) into a neighbour when
   * it has shrunk below `MIN_PIECE` and the pair stays under `MAX_PIECE`.
   *
   * Merging two summaries is the composition from the header applied to the
   * pair: the sum adds, and the dip of the second is measured from the end of
   * the first. No text is read.
   */
  private mergeSmallAround(index: number): void {
    for (let pass = 0; pass < 2; pass++) {
      const i = Math.min(index, this.lengths.length - 1)
      if (i < 0) return
      if (this.lengths[i] >= MIN_PIECE || this.lengths.length < 2) return
      // Prefer the previous neighbour (it keeps `index` valid for the next pass).
      const left = i > 0 && this.lengths[i - 1] + this.lengths[i] <= MAX_PIECE
      const right = i + 1 < this.lengths.length && this.lengths[i] + this.lengths[i + 1] <= MAX_PIECE
      if (left) this.mergePair(i - 1)
      else if (right) this.mergePair(i)
      else return
    }
  }

  /** Fold piece `i + 1` into piece `i`. */
  private mergePair(i: number): void {
    const sumA = this.sums[i]
    const dipB = this.dips[i + 1] + sumA
    this.dips[i] = Math.min(this.dips[i], dipB)
    this.sums[i] = sumA + this.sums[i + 1]
    this.lengths[i] += this.lengths[i + 1]
    this.lengths.splice(i + 1, 1)
    this.sums.splice(i + 1, 1)
    this.dips.splice(i + 1, 1)
    const dirty = i >> SUPER_SHIFT
    if (dirty < this.superDirtyFrom) this.superDirtyFrom = dirty
  }
}
