/**
 * Quasar Analysis Framework — Collapse Gradient Transform
 *
 * Applies `collapse-gradient` actions from a TransformationPlan.
 * Each action targets a sequence of adjacent [color] nodes and replaces
 * them with a single [gradient] node containing all text children.
 *
 * The transform operates on the Green Tree and returns a new tree —
 * it NEVER mutates the original.
 *
 * @example
 * Before:
 *   [color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color]
 * After:
 *   [gradient=#FF0000,#EE1100,#DD2200]Hello[/gradient]
 *
 * @see TransformPass
 */

import type { TransformPass, TransformationPlan } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { greenNode, greenLeaf, childOffsets } from '../../../Syntax/GreenNode'

// ── Supported action kinds ────────────────────────────────────────

const COLLAPSE_KINDS = new Set(['collapse-gradient', 'collapse-gradient-auto'])

export class CollapseGradientTransform implements TransformPass {
  readonly id = 'collapse-gradient'

  run(tree: GreenNode, plan: TransformationPlan, _context: PipelineContext): GreenNode {
    // Filter only collapse-gradient actions
    const actions = plan.actions.filter(a => COLLAPSE_KINDS.has(a.kind))

    if (actions.length === 0) {
      return tree // No changes
    }

    // Build a set of ranges to collapse (sorted by start position)
    const ranges = actions
      .map(a => ({
        start: (a.payload.range as { start: number; end: number }).start,
        end: (a.payload.range as { start: number; end: number }).end,
        colors: ((a.payload.model as Record<string, unknown>)?.colors ?? []) as string[],
        easing: ((a.payload.model as Record<string, unknown>)?.easing ?? 'linear') as string,
      }))
      .sort((a, b) => a.start - b.start)

    // Apply transforms recursively
    return this.transformNode(tree, ranges)
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Walk the tree and collapse any sequences that fall within our ranges.
   */
  private transformNode(
    node: GreenNode,
    ranges: Array<{ start: number; end: number; colors: string[]; easing: string }>,
    treeStart: number = 0,
  ): GreenNode {
    // Leaf node — no children to transform
    if (node.children.length === 0) {
      return node
    }

    const children = node.children as GreenNode[]

    // Green nodes carry widths, not positions. The ranges being matched here
    // come from the analyzers and are absolute, so the walk accumulates the
    // offsets it needs as it descends.
    const offsets = childOffsets(node, treeStart)

    // Check if any range overlaps with this node's children
    const nodeStart = offsets[0]
    const nodeEnd = offsets[children.length]
    const activeRanges = ranges.filter(
      r => r.start >= nodeStart && r.end <= nodeEnd,
    )

    if (activeRanges.length === 0) {
      // No ranges in this subtree — recurse into children
      const newChildren = children.map((c, ci) => this.transformNode(c, ranges, offsets[ci]))
      return this.rebuildNode(node, newChildren)
    }

    // Build new children, collapsing ranges into gradient nodes
    const newChildren: GreenNode[] = []
    let i = 0

    while (i < children.length) {
      const child = children[i]
      const matchingRange = activeRanges.find(
        r => offsets[i] >= r.start && offsets[i + 1] <= r.end,
      )

      if (matchingRange) {
        // Find all children within this range
        const rangeChildren: GreenNode[] = []
        while (i < children.length && offsets[i + 1] <= matchingRange.end) {
          rangeChildren.push(children[i])
          i++
        }

        // Collapse into a single gradient node
        const textNodes: string[] = []
        const colorNodes: GreenNode[] = []

        for (const rc of rangeChildren) {
          if (rc.kind === 'color') {
            colorNodes.push(rc)
            // Collect text from inside the colour node
            for (const textChild of rc.children as GreenNode[]) {
              if (textChild.kind === 'text') {
                textNodes.push(textChild.text)
              }
            }
          } else if (rc.kind === 'text') {
            textNodes.push(rc.text)
          } else {
            textNodes.push(rc.text || '')
          }
        }

        // Create a text leaf inside the gradient node
        const combinedText = textNodes.join('')
        const textLeaf = greenLeaf('text', combinedText)

        // Use the detected colours; fall back to extracted colours from nodes
        let colors = matchingRange.colors
        if (colors.length === 0) {
          colors = colorNodes
            .map(cn => this.extractHex(cn))
            .filter((h): h is string => h !== null)
        }

        const colorsAttr = colors.join(',')
        const gradientNode = greenNode('gradient', `=${colorsAttr}`, [textLeaf])
        newChildren.push(gradientNode)
      } else {
        // Not in a collapse range — recurse and preserve
        newChildren.push(this.transformNode(child, ranges, offsets[i]))
        i++
      }
    }

    return this.rebuildNode(node, newChildren)
  }

  /**
   * Rebuild a node with the same kind/text/range but new children.
   */
  private rebuildNode(node: GreenNode, newChildren: GreenNode[]): GreenNode {
    // If the node is a colour node and all children were collapsed,
    // just return the first child instead (no need for empty colour)
    if (node.kind === 'color' && newChildren.length === 0) {
      return greenLeaf('text', node.text)
    }

    return greenNode(node.kind, node.text, newChildren,
    )
  }

  /**
   * Extract hex colour from a color node's text.
   */
  private extractHex(node: GreenNode): string | null {
    if (node.kind !== 'color') return null
    const text = node.text || ''
    const eqIdx = text.indexOf('=')
    const hex = eqIdx >= 0 ? text.slice(eqIdx + 1).trim() : text.trim()
    return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null
  }
}
