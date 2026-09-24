/**
 * Quasar — composing edits across optimizer passes
 *
 * `optimizeBBCodeFully` reaches a fixpoint by re-parsing and re-running
 * `optimizeBBCode` over its own output, because a single pass is not a
 * fixpoint (arbitration defers edits, and an applied edit can expose more
 * work — an emptied `[b][/b]`, two tags that just became adjacent). Each pass
 * therefore returns a `SurgicalEdit[]` addressed to a DIFFERENT string: the
 * output of the pass before it, not the original `source`.
 *
 * The in-place applier only gets one shot at the buffer — Monaco needs ONE
 * `SurgicalEdit[]` addressed to what is actually on screen, applied as a
 * single undo stop. This module bridges that gap: it composes a chain of
 * passes, each addressed to the previous pass's output, into one edit list
 * addressed to the very first `source`.
 *
 * ## Approach — a piece table
 *
 * The text after N passes is represented as an ordered list of segments,
 * each either a slice `{ from, to }` of the ORIGINAL source or an opaque
 * inserted string `{ text }` contributed by some earlier pass. Folding in one
 * more pass means splitting segments at that pass's edit boundaries and
 * replacing whatever they cover — the bytes of `source` itself are never
 * touched, so no pass ever needs to be re-run or re-diffed against it.
 *
 * Once every pass has been folded in, the final segment list is walked once
 * more: a `{ from, to }` segment that continues exactly where the walk
 * already reached (`segment.from` equals the original offset accounted for
 * so far) needs no edit — it survived untouched. Anything else — a jump
 * forward over original bytes that never reappear, or inserted text with
 * nothing to anchor it — becomes one composed edit. This walk is only valid
 * because a `SurgicalEdit` always replaces a CONTIGUOUS span with an opaque
 * string: no pass can swap the relative order of two characters that both
 * survive it, so the offsets of surviving original text stay non-decreasing
 * across the whole chain, pass after pass.
 *
 * ## Minimality
 *
 * A naive composition can restate bytes that never actually changed — pass 2
 * re-inserting exactly what pass 1 deleted composes, before trimming, to
 * "replace this original slice with an identical string". Every composed
 * edit is trimmed to its minimal common-prefix/suffix-free form before it is
 * returned, and one that trims down to nothing is dropped rather than kept as
 * a no-op.
 */

import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

// ── Piece table ───────────────────────────────────────────────────

/** A slice of the ORIGINAL source that survives, verbatim, at this point. */
interface OriginalSegment {
  readonly from: number
  readonly to: number
}

/** Text contributed by some pass. Not attributable to any original offset. */
interface InsertedSegment {
  readonly text: string
}

type Segment = OriginalSegment | InsertedSegment

function isInserted(segment: Segment): segment is InsertedSegment {
  return 'text' in segment
}

function segmentLength(segment: Segment): number {
  return isInserted(segment) ? segment.text.length : segment.to - segment.from
}

/** The sub-segment covering local offsets `[from, to)` of `segment`. */
function sliceSegment(segment: Segment, from: number, to: number): Segment {
  return isInserted(segment)
    ? { text: segment.text.slice(from, to) }
    : { from: segment.from + from, to: segment.from + to }
}

/**
 * Fold one pass's edits into the current piece table.
 *
 * `edits` must be sorted and pairwise non-overlapping — exactly what
 * `optimizeBBCode` already returns. Mirrors the merge sweep in
 * `applyEditsToSource`, except it advances over segments instead of a flat
 * string, splitting one when an edit boundary lands inside it, so a single
 * edit may consume parts of several segments — including a whole insertion a
 * previous pass made — in one go.
 *
 * O(segments.length + edits.length): `segIndex`/`segOffset`/`pos` only ever
 * move forward.
 */
function applyPassToSegments(segments: readonly Segment[], edits: readonly SurgicalEdit[]): readonly Segment[] {
  if (edits.length === 0) return segments

  const out: Segment[] = []
  let segIndex = 0
  let segOffset = 0 // bytes already emitted/consumed from segments[segIndex]
  let pos = 0 // current-text offset at (segIndex, segOffset)

  // Advances the cursor from `pos` to `target`, either copying what it
  // crosses into `out` (the untouched span before an edit, and the trailing
  // span after the last one) or discarding it (the span an edit replaces).
  const advanceTo = (target: number, keep: boolean) => {
    while (pos < target) {
      const segment = segments[segIndex]
      const remaining = segmentLength(segment) - segOffset
      const take = Math.min(remaining, target - pos)
      if (keep && take > 0) out.push(sliceSegment(segment, segOffset, segOffset + take))
      segOffset += take
      pos += take
      if (segOffset >= segmentLength(segment)) {
        segIndex++
        segOffset = 0
      }
    }
  }

  for (const edit of edits) {
    advanceTo(edit.start, true)
    if (edit.text.length > 0) out.push({ text: edit.text })
    advanceTo(edit.end, false)
  }

  const totalLength = segments.reduce((sum, segment) => sum + segmentLength(segment), 0)
  advanceTo(totalLength, true)

  return out
}

/**
 * `source.slice(start, end)` trimmed of the prefix/suffix it shares with
 * `text`, or `null` when that leaves nothing — the two were the same string.
 */
function minimalEdit(source: string, start: number, end: number, text: string): SurgicalEdit | null {
  const original = source.slice(start, end)

  let prefix = 0
  const maxPrefix = Math.min(original.length, text.length)
  while (prefix < maxPrefix && original.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++

  // Bounded by what the prefix trim left on each side, so the two trims can
  // never claim the same character twice.
  let suffix = 0
  const maxSuffix = Math.min(original.length - prefix, text.length - prefix)
  while (
    suffix < maxSuffix &&
    original.charCodeAt(original.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)
  ) {
    suffix++
  }

  const newStart = start + prefix
  const newEnd = end - suffix
  const newText = text.slice(prefix, text.length - suffix)

  return newStart === newEnd && newText === '' ? null : { start: newStart, end: newEnd, text: newText }
}

/**
 * Walk the final piece table into a composed `SurgicalEdit[]` against
 * `source`.
 *
 * `expected` is the original offset the walk would be at if nothing had
 * changed. An `OriginalSegment` starting exactly there is a survivor — no
 * edit needed, just advance past it. Anything buffered since the last
 * survivor (a gap before this one, inserted text with no survivor to anchor
 * it, or both) is flushed as one edit, trimmed to its minimal form.
 * Consecutive changes with no surviving text between them naturally merge
 * into a single edit, since nothing flushes the pending region until a
 * survivor is found.
 */
function segmentsToEdits(source: string, segments: readonly Segment[]): SurgicalEdit[] {
  const edits: SurgicalEdit[] = []
  let expected = 0
  let pendingText = ''

  const flush = (upTo: number) => {
    const edit = minimalEdit(source, expected, upTo, pendingText)
    if (edit) edits.push(edit)
    pendingText = ''
  }

  for (const segment of segments) {
    if (isInserted(segment)) {
      if (segment.text.length > 0) pendingText += segment.text
      continue
    }

    if (segment.from < expected) {
      // Cannot happen for edits that only ever replace a contiguous span
      // with an opaque string — see the module doc. Surfaced loudly rather
      // than silently emitting a wrong edit list.
      throw new Error(
        `composeEditPasses: surviving text reordered (expected original offset ${expected}, got ${segment.from}). ` +
          'A pass must replace a contiguous span with an opaque string, never reorder what it leaves untouched.',
      )
    }

    flush(segment.from)
    expected = segment.to
  }

  flush(source.length)
  return edits
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Compose a chain of optimizer passes into ONE edit list addressed to
 * `source`.
 *
 * `passes[0]` is addressed to `source`; `passes[i]` (`i > 0`) is addressed to
 * the text `passes[0..i-1]` produce when applied in order. Every pass must
 * already be sorted and pairwise non-overlapping — `resolveEditConflicts`'s
 * output, which is what `optimizeBBCode` returns on every iteration of
 * `optimizeBBCodeFully`'s loop.
 *
 * The result is sorted, pairwise non-overlapping, minimal (no edit restates
 * bytes that end up unchanged), and satisfies:
 *
 *     applyEditsToSource(source, composeEditPasses(source, passes))
 *       === passes.reduce((text, pass) => applyEditsToSource(text, pass), source)
 *
 * An empty pass contributes nothing; an empty `passes` array, or one whose
 * passes cancel out completely, composes to `[]`.
 */
export function composeEditPasses(source: string, passes: readonly (readonly SurgicalEdit[])[]): SurgicalEdit[] {
  let segments: readonly Segment[] = source.length > 0 ? [{ from: 0, to: source.length }] : []

  for (const pass of passes) {
    if (pass.length === 0) continue
    segments = applyPassToSegments(segments, pass)
  }

  return segmentsToEdits(source, segments)
}
