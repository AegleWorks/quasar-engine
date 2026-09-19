import type { DiagnosticFix, FixOperation } from '../Types/diagnostics'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

/**
 * The text edits a diagnostic fix stands for.
 *
 * Every operation is one range replaced by some text: an insertion is an
 * empty range, a deletion is empty text. `wrap_in_tag` is the one real
 * exception — two insertions, at both ends. Apply the result with
 * `applyEditsToSource`, or hand it to an editor as a single batch.
 *
 * Lives in Quasar, next to the edits it produces, so every consumer — the
 * editor's quick fixes, the error checker, the About page — shares it.
 */
export function fixToSurgicalEdits(fix: DiagnosticFix): SurgicalEdit[] {
  const edits: SurgicalEdit[] = []
  for (const op of fix.operations as readonly FixOperation[]) {
    switch (op.kind) {
      case 'replace_text':
        edits.push({ start: op.range.start, end: op.range.end, text: op.newText })
        break
      case 'insert_text':
        edits.push({ start: op.position, end: op.position, text: op.text })
        break
      case 'delete_range':
        edits.push({ start: op.range.start, end: op.range.end, text: '' })
        break
      case 'wrap_in_tag':
        edits.push({ start: op.range.start, end: op.range.start, text: `[${op.tagName}]` })
        edits.push({ start: op.range.end, end: op.range.end, text: `[/${op.tagName}]` })
        break
    }
  }
  return edits
}
