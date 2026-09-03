/**
 * Quasar — applying a resolved edit set to source text
 *
 * The string-rewriting half of the two appliers. Monaco is the other: it takes
 * the very same `SurgicalEdit[]` and resolves the offsets against its model
 * itself, which is why neither side ever re-serializes the document and the
 * two cannot drift.
 */

import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

/**
 * Apply edits carrying ORIGINAL offsets, in one pass.
 *
 * The obvious implementation splices the string once per edit:
 *
 *     for (const edit of backToFront) out = out.slice(0, s) + text + out.slice(e)
 *
 * which is correct and quadratic — every splice copies the whole document, so
 * a 250.000-character page with ~3.800 edits copies roughly a billion
 * characters and takes about half a second. Measured, not guessed. Collecting
 * the untouched spans and joining them once is linear and turns that into a
 * few milliseconds, which is the difference between a minify command that
 * feels instant and one that visibly stalls the editor.
 *
 * Going forwards rather than backwards is what makes the single pass possible,
 * and it costs nothing: each edit is measured against the original string
 * either way.
 *
 * ## Contract
 *
 * The edits must be pairwise conflict-free — run them through
 * `resolveEditConflicts` first. An edit that reaches back into a span already
 * written is a contract violation with no meaningful answer, so it is skipped
 * rather than allowed to interleave into nonsense; the result stays a valid
 * document that is merely missing one change.
 */
export function applyEditsToSource(source: string, edits: readonly SurgicalEdit[]): string {
  if (edits.length === 0) return source

  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const segments: string[] = []
  let cursor = 0

  for (const edit of ordered) {
    if (edit.start < cursor) continue
    if (edit.start > cursor) segments.push(source.slice(cursor, edit.start))
    if (edit.text) segments.push(edit.text)
    cursor = edit.end
  }

  if (cursor < source.length) segments.push(source.slice(cursor))
  return segments.join('')
}
