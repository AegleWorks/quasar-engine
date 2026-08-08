/**
 * Quasar Analysis Framework — Merge Colors Transform
 *
 * Applies `merge-colors` actions from a TransformationPlan.
 * Each action targets a sequence of identical consecutive [color=#HEX]
 * nodes and merges them into a single `[color]` wrapper with combined text.
 *
 * The transform operates on the Green Tree and returns a new tree —
 * it NEVER mutates the original.
 *
 * @example
 * Before:
 *   [color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]l[/color]
 * After:
 *   [color=#FF0000]Hel[/color]
 *
 * @see TransformPass
 */

import type { TransformPass, TransformationPlan } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { greenNode, greenLeaf, childOffsets } from '../../../Syntax/GreenNode'

export class MergeColorsTransform implements TransformPass {
  readonly id = 'merge-colors'

  run(tree: GreenNode, plan: TransformationPlan, _context: PipelineContext): GreenNode {
    const mergeActions = plan.actions.filter(a => a.kind === 'merge-colors')

    if (mergeActions.length === 0) {
      return tree
    }

    const ranges = mergeActions
      .map(a => ({
        start: (a.payload.range as { start: number; end: number }).start,
        end: (a.payload.range as { start: number; end: number }).end,
      }))
      .sort((a, b) => a.start - b.start)

    return this.transformNode(tree, ranges)
  }

  // ── Private ─────────────────────────────────────────────────────

  private transformNode(
    node: GreenNode,
    ranges: Array<{ start: number; end: number }>,
    treeStart: number = 0,
  ): GreenNode {
    if (node.children.length === 0) return node

    const children = node.children as GreenNode[]
    // Green nodes carry widths, not positions. The ranges being matched here
    // come from the analyzers and are absolute, so the walk accumulates the
    // offsets it needs as it descends.
    const offsets = childOffsets(node, treeStart)
    const nodeStart = offsets[0]
    const nodeEnd = offsets[children.length]

    const activeRanges = ranges.filter(
      r => r.start >= nodeStart && r.end <= nodeEnd,
    )

    if (activeRanges.length === 0) {
      const newChildren = children.map((c, ci) => this.transformNode(c, ranges, offsets[ci]))
      return this.rebuildNode(node, newChildren)
    }

    const newChildren: GreenNode[] = []
    let i = 0

    while (i < children.length) {
      const child = children[i]
      const matchingRange = activeRanges.find(
        r => offsets[i] >= r.start && offsets[i + 1] <= r.end,
      )

      if (matchingRange && child.kind === 'color') {
        // Collect all consecutive colour nodes with the SAME hex
        const hex = this.extractHex(child)
        const mergedTexts: string[] = []

        while (
          i < children.length &&
          children[i].kind === 'color' &&
          this.extractHex(children[i]) === hex &&
          offsets[i + 1] <= matchingRange.end
        ) {
          // Get text from inside the colour node's children
          for (const textChild of children[i].children as GreenNode[]) {
            if (textChild.kind === 'text') {
              mergedTexts.push(textChild.text)
            }
          }
          i++
        }

        // Create a single merged colour node
        const combinedText = mergedTexts.join('')
        const textLeaf = greenLeaf('text', combinedText)
        const merged = greenNode('color', child.text, [textLeaf], child.leadingWidth, child.trailingWidth)
        newChildren.push(merged)
      } else {
        newChildren.push(this.transformNode(child, ranges, offsets[i]))
        i++
      }
    }

    return this.rebuildNode(node, newChildren)
  }

  private rebuildNode(node: GreenNode, newChildren: GreenNode[]): GreenNode {
    return greenNode(node.kind, node.text, newChildren,
    )
  }

  private extractHex(node: GreenNode): string | null {
    if (node.kind !== 'color') return null
    const text = node.text || ''
    const eqIdx = text.indexOf('=')
    const hex = eqIdx >= 0 ? text.slice(eqIdx + 1).trim() : text.trim()
    return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null
  }
}
