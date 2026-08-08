/**
 * Quasar Analysis Framework — Mergeable Color Analyzer
 *
 * Detects sequences of consecutive [color=#HEX] wrappers where ALL
 * adjacent colours are identical.  These are optimisation opportunities:
 * the user could merge them into a single `[color]` tag.
 *
 * Example:
 *   [color=#FF0000]H[/color][color=#FF0000]e[/color] → mergeable
 *   [color=#FF0000]H[/color][color=#EE1100]e[/color] → NOT mergeable
 *
 * @see OptimizationContribution
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { extractHex } from '../../Utils/color-utils'

export class MergeableColorAnalyzer implements AnalyzerPass {
  readonly id = 'mergeable-color'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []

    // Walk all children of each node to find sequences of colour wrappers
    this.findMergeableColorSequences(tree, contributions)

    return contributions
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Walk the tree and find consecutive color nodes with identical colours.
   */
  private findMergeableColorSequences(node: GreenNode, sink: Contribution[], nodeStart: number = 0): void {
    // Green nodes carry widths, not positions, so a walk that reports source
    // ranges accumulates them on the way down.
    const offsets = childOffsets(node, nodeStart)
    // Only look at container nodes that might have colour children
    if (node.children.length > 1) {
      const children = node.children as GreenNode[]
      let seqStart = -1
      let seqHex: string | null = null

      for (let i = 0; i < children.length; i++) {
        const hex = extractHex(children[i])

        if (hex !== null) {
          if (seqStart === -1) {
            // Start a new sequence
            seqStart = i
            seqHex = hex
          } else if (hex !== seqHex) {
            // Color changed — check if previous sequence was mergeable
            if (i - seqStart > 1) {
              this.emitMergeable(children, seqStart, i, seqHex!, sink, offsets)
            }
            seqStart = i
            seqHex = hex
          }
          // If hex === seqHex, sequence continues — do nothing
        } else {
          // Non-color node — end any active sequence
          if (seqStart !== -1 && seqStart < i - 1) {
            this.emitMergeable(children, seqStart, i, seqHex!, sink, offsets)
          }
          seqStart = -1
          seqHex = null
        }
      }

      // Check if the last sequence is mergeable
      if (seqStart !== -1 && seqStart < children.length - 1) {
        this.emitMergeable(children, seqStart, children.length, seqHex!, sink, offsets)
      }
    }

    // Recurse into children (colour nodes' children are text, so only recurse non-color nodes)
    const kids = node.children as GreenNode[]
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].kind !== 'color') {
        this.findMergeableColorSequences(kids[i], sink, offsets[i])
      }
    }
  }

  private emitMergeable(
    children: GreenNode[],
    start: number,
    end: number,
    hex: string,
    sink: Contribution[],
    offsets: number[],
  ): void {
    const count = end - start
    sink.push({
      kind: ContributionKind.Optimization,
      label: 'Merge Colors',
      description: `${count} consecutive [color=${hex}] tags can be merged into one`,
      estimatedImprovement: `-${(count - 1) * 100}% color tags`,
      range: {
        start: offsets[start],
        end: offsets[end],
      },
    })
  }
}
