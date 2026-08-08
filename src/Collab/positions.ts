/**
 * DocumentEngine — Position transforms
 *
 * Where does a position end up after a text edit?
 *
 * This is the primitive collaboration stands on: keeping carets, selections
 * and remote cursors pointing at the same *content* while the text shifts
 * under them — whether the edit came from the local user, a remote peer, or
 * a programmatic `transact`. See `QuasarCollab.MD` for the architecture; the
 * short version is that Quasar syncs TEXT, so mapping positions through
 * `TextChange`s is all the transform machinery the engine needs. This module
 * transforms positions, not changes-against-changes: convergence of
 * concurrent edits is the CRDT's job, not ours.
 */

import type { TextChange } from '../Incremental/ChangeTracker'

/**
 * Which side a position sticks to when an edit happens exactly at it.
 *
 * A caret usually wants `'right'`: text inserted at the caret by someone else
 * should push it forward (you keep typing after their insertion). The start
 * of a persistent highlight usually wants `'left'`: text inserted exactly at
 * its start belongs before the highlight, not inside it.
 */
export type TransformBias = 'left' | 'right'

/**
 * Map `offset` through one change or an ordered sequence of changes.
 *
 * Rules, in order:
 * - strictly before the edit → unchanged;
 * - strictly after the replaced span → shifted by the length delta;
 * - inside the replaced span → collapsed to the edit's boundary (`'left'` →
 *   where the replacement starts, `'right'` → where it ends). A position
 *   inside deleted text has no content to point at anymore; the boundary is
 *   the only honest answer;
 * - exactly at a pure insertion point → `bias` decides which side of the
 *   inserted text it lands on.
 */
export function transformOffset(
  offset: number,
  changes: TextChange | readonly TextChange[],
  bias: TransformBias = 'right',
): number {
  const list = Array.isArray(changes) ? (changes as readonly TextChange[]) : [changes as TextChange]
  let pos = offset
  for (const change of list) {
    pos = transformOne(pos, change, bias)
  }
  return pos
}

function transformOne(offset: number, change: TextChange, bias: TransformBias): number {
  const { start, end, text } = change

  if (offset < start) return offset

  const inserted = text.length
  const isInsertion = end === start

  if (isInsertion && offset === start) {
    return bias === 'right' ? offset + inserted : offset
  }

  if (offset > end) {
    return offset + inserted - (end - start)
  }

  // Inside the replaced span (start <= offset <= end, with something replaced).
  return bias === 'right' ? start + inserted : start
}

/**
 * Map a `{start, end}` range through one change or a sequence.
 *
 * The start sticks RIGHT and the end sticks LEFT, which is what preserves the
 * selected content: text inserted exactly at a boundary lands OUTSIDE the
 * range, so the range keeps covering exactly the characters it covered — it
 * neither absorbs a neighbour's insertion nor leaks its own content. The
 * result is clamped so it can never come out inverted; a range entirely
 * inside deleted text collapses to a point at the edit boundary.
 */
export function transformRange(
  range: { start: number; end: number },
  changes: TextChange | readonly TextChange[],
): { start: number; end: number } {
  const start = transformOffset(range.start, changes, 'right')
  const end = transformOffset(range.end, changes, 'left')
  return end < start ? { start, end: start } : { start, end }
}
