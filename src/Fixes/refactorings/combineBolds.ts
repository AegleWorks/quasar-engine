/**
 * Quasar Lightbulb Engine — example refactoring: combine adjacent bolds.
 *
 * `[b]a[/b][b]b[/b]` is one bold split in two. Merging rewrites exactly the
 * span the parser already rendered as bold, so the visible output is unchanged.
 */

import type { RedNode } from '../../Syntax/RedNode'
import type { SurgicalEdit } from '../../Reconciler/SurgicalReconciler'
import type { RefactoringProvider } from '../RefactoringRegistry'

/** Nearest ancestor (or self) of the given kind. */
function closest(node: RedNode | null, kind: string): RedNode | null {
  let current = node
  while (current) {
    if (current.kind === kind) return current
    current = current.parent
  }
  return null
}

/**
 * The adjacent bold pair around the offset, in document order.
 * Strictly adjacent only: any gap text between the tags (even whitespace)
 * belongs to the render and merging would drop it.
 */
function adjacentBoldPair(
  node: RedNode | null,
  offset: number,
  source: string,
): [first: RedNode, second: RedNode] | null {
  const root = node?.root ?? node
  const at = root?.findNodeAtOffset(offset) ?? node
  const bold = closest(at, 'bold')
  if (!bold) return null

  const candidates = [bold.previousSibling, bold.nextSibling].filter(
    (s): s is RedNode => s !== null && s.kind === 'bold',
  )
  for (const other of candidates) {
    const [first, second] = other.range.end === bold.range.start ? [other, bold] : [bold, other]
    if (first.range.end !== second.range.start) continue
    if (source.slice(first.range.end, second.range.start) !== '') continue
    return [first, second]
  }
  return null
}

export const combineBoldsProvider: RefactoringProvider = {
  id: 'combine-bolds',
  title: 'Combine adjacent bold sections',
  kinds: ['refactor.rewrite'],

  match(node, offset, source): boolean {
    return adjacentBoldPair(node, offset, source) !== null
  },

  edits(node, offset, source): SurgicalEdit[] {
    const pair = adjacentBoldPair(node, offset, source)
    if (!pair) return []
    const [first, second] = pair
    const inner =
      source.slice(first.innerStart, first.innerEnd) +
      source.slice(second.innerStart, second.innerEnd)
    return [{ start: first.range.start, end: second.range.end, text: `[b]${inner}[/b]` }]
  },
}
