/**
 * Quasar — `drop-empty-tags`
 *
 * Removes formatting tags that enclose nothing: `[b][/b]`, `[color=#F00][/color]`.
 *
 * ## Only tags whose absence is invisible
 *
 * The droppable set is an explicit allowlist of inline formatting, not "any
 * tag with no children". An empty `[box]` still draws a frame, an empty
 * `[quote]` still draws a quote block, and `[img]`/`[youtube]` carry their
 * payload in the attribute rather than in children — deleting any of those
 * changes what the reader sees. Anything not on the list stays, including
 * tags this engine does not recognise.
 *
 * ## Outermost-first, so no second pass is needed
 *
 * `[b][i][/i][/b]` is empty all the way down. Dropping the inner tag would
 * leave `[b][/b]`, which is empty again — the classic reason `ASTOptimizer`
 * needs a fixpoint. Instead this rule asks whether a node renders nothing
 * *transitively* and deletes the outermost one it finds, in a single edit,
 * without descending into it.
 */

import type { GreenNode } from '../../Syntax/GreenNode'
import type { PlannedEdit } from '../EditPlan'
import {
  type OptimizationRule,
  type RuleContext,
  type Positioned,
  positionedChildren,
  hasBothDelimiters,
  deletion,
} from './Rule'

export const DROP_EMPTY_PRIORITY = 80

/**
 * Inline formatting whose empty form is guaranteed to render nothing.
 *
 * Deliberately conservative. A kind is only here if an empty instance of it
 * produces no glyphs, no box, no line break and no side effect.
 */
export const DROPPABLE_WHEN_EMPTY: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'color',
  'font_size',
  'font',
  'sup',
  'sub',
  'mark',
])

export class DropEmptyTagsRule implements OptimizationRule {
  readonly id = 'drop-empty-tags'
  readonly priority = DROP_EMPTY_PRIORITY
  readonly label = 'Remove empty formatting tags'

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan({ node: context.root, start: 0 }, sink)
    return sink
  }

  // ── Private ─────────────────────────────────────────────────────

  private scan(item: Positioned, sink: PlannedEdit[]): void {
    for (const child of positionedChildren(item)) {
      if (this.isDroppable(child)) {
        sink.push(
          deletion(
            { start: child.start, end: child.start + child.node.width },
            this.id,
            this.priority,
            `Remove empty [${child.node.kind}]`,
          ),
        )
        // Deleted whole; nothing inside it can still be worth an edit.
        continue
      }
      this.scan(child, sink)
    }
  }

  private isDroppable(item: Positioned): boolean {
    return (
      DROPPABLE_WHEN_EMPTY.has(item.node.kind) &&
      hasBothDelimiters(item) &&
      rendersNothing(item.node)
    )
  }
}

/**
 * Whether a node contributes no visible output at all.
 *
 * `spacing` and `empty_line` are explicitly *not* nothing — they are the
 * document's line breaks.
 */
function rendersNothing(node: GreenNode): boolean {
  if (node.kind === 'text') return (node.text ?? '') === ''
  if (node.kind === 'spacing' || node.kind === 'empty_line') return false
  if (!DROPPABLE_WHEN_EMPTY.has(node.kind)) return false

  const children = node.children as readonly GreenNode[]
  if (children.length === 0) return node.width - node.leadingWidth - node.trailingWidth === 0
  return children.every(rendersNothing)
}
