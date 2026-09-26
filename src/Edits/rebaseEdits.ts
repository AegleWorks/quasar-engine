/**
 * Quasar — carrying edits computed on one text over to a later one.
 *
 * A fix is computed on the text its diagnostic was found in. Analysis runs
 * after the user stops typing, so by the time someone takes the fix the text
 * may have moved on: a letter typed before a `[box]` shifts every offset
 * after it by one. Applied as they are, the fix's edits land one character
 * off, and a quick fix that corrupts the document is worse than none.
 *
 * Roslyn answers this by computing fixes against the diagnostic's own
 * snapshot and mapping the result forward. Here the two texts are compared
 * once (their common prefix and suffix: one changed region), edits entirely
 * before it stay, edits entirely after it move by its length, and an edit the
 * change touches has nothing it can safely mean — the whole set is refused.
 */

import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

/** The region `from` and `to` differ in: `[start, end)` in `from`, and how long it became. */
export interface ChangedRegion {
  start: number
  /** End in the OLD text. */
  end: number
  /** Length of the replacement in the new text. */
  length: number
}

/** The one region `to` differs from `from` in; null when they are equal. */
export function changedRegion(from: string, to: string): ChangedRegion | null {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endFrom = from.length
  let endTo = to.length
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--
    endTo--
  }
  return { start, end: endFrom, length: endTo - start }
}

/**
 * An offset of `from` in `to`, or null when it falls inside the changed
 * region (what stood there is gone). A region boundary is kept: a point right
 * before the change stays, one right after it moves.
 */
export function rebaseOffset(offset: number, region: ChangedRegion | null): number | null {
  if (!region) return offset
  if (offset <= region.start) return offset
  if (offset >= region.end) return offset + region.length - (region.end - region.start)
  return null
}

function touches(edit: SurgicalEdit, region: ChangedRegion): boolean {
  // Overlap, or an insertion at the same point as the edit's text: the order
  // the two would land in is unknowable.
  if (edit.start < region.end && edit.end > region.start) return true
  if (edit.start === edit.end && edit.start > region.start && edit.start < region.end) return true
  if (region.start === region.end && region.start > edit.start && region.start < edit.end) return true
  if (edit.start === edit.end && region.start === region.end && edit.start === region.start) return true
  return false
}

/**
 * `edits`, computed against `from`, as edits against `to`. Null when the
 * change between the two touches any of them: the fix was for text that is
 * no longer there, and the caller should drop it (the next analysis offers
 * the right one).
 */
export function rebaseEdits(edits: readonly SurgicalEdit[], from: string, to: string): SurgicalEdit[] | null {
  return rebaseEditsThrough(edits, changedRegion(from, to))
}

/** `rebaseEdits` with the changed region already worked out — for many edit sets over the same two texts. */
export function rebaseEditsThrough(edits: readonly SurgicalEdit[], region: ChangedRegion | null): SurgicalEdit[] | null {
  if (!region) return [...edits]
  const out: SurgicalEdit[] = []
  for (const edit of edits) {
    if (touches(edit, region)) return null
    const start = rebaseOffset(edit.start, region)
    const end = rebaseOffset(edit.end, region)
    if (start === null || end === null) return null
    out.push({ ...edit, start, end })
  }
  return out
}
