/**
 * Quasar Lightbulb Engine — example refactoring: extract selection to template.
 *
 * Wraps a source range in a reusable `[template]` block. The core is the pure
 * `extractTemplateEdits(source, selection)` helper; the registered provider
 * applies it to the text node under the caret so the lightbulb needs only an
 * offset.
 */

import type { Range } from '../../Types/tokens'
import type { RedNode } from '../../Syntax/RedNode'
import type { SurgicalEdit } from '../../Reconciler/SurgicalReconciler'
import type { RefactoringProvider } from '../RefactoringRegistry'

/**
 * Edits wrapping `selection` in a template block. Empty or inverted
 * selections produce no edits — there is nothing to extract.
 */
export function extractTemplateEdits(
  _source: string,
  selection: Range,
): SurgicalEdit[] {
  if (selection.end <= selection.start) return []
  return [
    { start: selection.start, end: selection.start, text: '[template]' },
    { start: selection.end, end: selection.end, text: '[/template]' },
  ]
}

/** Deepest text leaf containing the offset with non-blank content. */
function textAt(node: RedNode | null, offset: number): RedNode | null {
  const root = node?.root ?? node
  const at = root?.findNodeAtOffset(offset) ?? node
  if (!at || at.kind !== 'text' || at.text.trim() === '') return null
  return at
}

export const extractTemplateProvider: RefactoringProvider = {
  id: 'extract-template',
  title: 'Extract selection to template',
  kinds: ['refactor.extract'],

  match(node, offset, _source): boolean {
    return textAt(node, offset) !== null
  },

  edits(node, offset, _source): SurgicalEdit[] {
    const text = textAt(node, offset)
    if (!text) return []
    return [
      { start: text.range.start, end: text.range.start, text: '[template]' },
      { start: text.range.end, end: text.range.end, text: '[/template]' },
    ]
  },
}
