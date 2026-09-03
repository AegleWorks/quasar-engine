/**
 * Quasar — `unwrap-invisible-color`
 *
 * Removes a `[color]` whose entire content is whitespace.
 *
 *   [color=#6A4C93]BARCA[/color][color=#6F518D] [/color][color=#755687]·[/color]
 *                               ╰── 24 bytes to colour a space ──╯
 *
 * A space has no glyph, and `[color]` sets `color` and nothing else — no
 * background, no decoration — so painting one is a guaranteed no-op. Deleting
 * the two delimiters turns 24 bytes into 1 and cannot change a pixel.
 *
 * This is the dominant waste in expanded gradients, and it is easy to see why:
 * the tool that expands `[gradient]` into per-character `[color]` spans walks
 * characters without asking which of them draw ink, so every space in the ramp
 * gets its own fully-spelled tag.
 *
 * ## Only colour
 *
 * The same shape is *not* removable for other tags, and the difference is not
 * subtle:
 *
 * - `[u]` / `[s]` draw a line through the gap — visible on a space.
 * - `[mark]` paints a background — visible on a space.
 * - `[size]` and `[font]` change the advance width of the space itself.
 *
 * Only `color` is invisible on whitespace, so only `color` is unwrapped.
 */

import type { GreenNode } from '../../Syntax/GreenNode'
import type { PlannedEdit } from '../EditPlan'
import {
  type OptimizationRule,
  type RuleContext,
  type Positioned,
  positionedChildren,
  openRange,
  closeRange,
  hasBothDelimiters,
  deletion,
} from './Rule'

export const UNWRAP_INVISIBLE_COLOR_PRIORITY = 85

/**
 * Whether a node contributes nothing but whitespace.
 *
 * Recursive through nested colours, so `[color=A][color=B] [/color][/color]`
 * counts. `spacing` is whitespace too — a newline inside a colour tag is as
 * invisible as a space.
 */
export function isInvisibleWhitespace(node: GreenNode): boolean {
  if (node.kind === 'text') return /^\s*$/.test(node.text ?? '')
  if (node.kind === 'spacing' || node.kind === 'empty_line') return true
  if (node.kind !== 'color') return false

  const children = node.children as readonly GreenNode[]
  if (children.length === 0) return node.width - node.leadingWidth - node.trailingWidth === 0
  return children.every(isInvisibleWhitespace)
}

export class UnwrapInvisibleColorRule implements OptimizationRule {
  readonly id = 'unwrap-invisible-color'
  readonly priority = UNWRAP_INVISIBLE_COLOR_PRIORITY
  readonly label = 'Unwrap colour tags around whitespace'

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan({ node: context.root, start: 0 }, sink)
    sink.sort((a, b) => a.start - b.start || a.end - b.end)
    return sink
  }

  // ── Private ─────────────────────────────────────────────────────

  private scan(item: Positioned, sink: PlannedEdit[]): void {
    for (const child of positionedChildren(item)) {
      if (
        child.node.kind === 'color' &&
        hasBothDelimiters(child) &&
        isInvisibleWhitespace(child.node)
      ) {
        const label = 'Unwrap colour around whitespace'
        sink.push(deletion(openRange(child), this.id, this.priority, label))
        sink.push(deletion(closeRange(child), this.id, this.priority, label))
        // Nested colours inside are invisible too; keep unwrapping them.
        this.scan(child, sink)
        continue
      }
      this.scan(child, sink)
    }
  }
}
