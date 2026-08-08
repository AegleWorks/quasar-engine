/**
 * Quasar Analysis Framework — Wave Collapse Transform
 *
 * Applies `collapse-wave` actions from a TransformationPlan.
 * Replaces sequences of [size=N] nodes forming a sinusoidal pattern
 * with a single [grow] node containing all text children and the
 * detected size range in metadata.
 *
 * @example
 * Before: [size=90]A[/size][size=150]B[/size][size=90]C[/size]
 * After:  [grow]ABC[/grow]  (with metadata: min=90, max=150)
 */

import type { TransformPass, TransformationPlan } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { greenNode, greenLeaf, childOffsets } from '../../../Syntax/GreenNode'

export class WaveCollapseTransform implements TransformPass {
  readonly id = 'wave-collapse'

  run(tree: GreenNode, plan: TransformationPlan, _context: PipelineContext): GreenNode {
    const actions = plan.actions.filter(a => a.kind === 'collapse-wave')
    if (actions.length === 0) return tree

    const ranges = actions.map(a => ({
      start: (a.payload.range as { start: number; end: number }).start,
      end: (a.payload.range as { start: number; end: number }).end,
      min: (a.payload.model as Record<string, unknown>)?.minSize as number ?? 90,
      max: (a.payload.model as Record<string, unknown>)?.maxSize as number ?? 160,
    })).sort((a, b) => a.start - b.start)

    return this.transformNode(tree, ranges)
  }

  private transformNode(
    node: GreenNode,
    ranges: Array<{ start: number; end: number; min: number; max: number }>,
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
    const activeRanges = ranges.filter(r => r.start >= nodeStart && r.end <= nodeEnd)

    if (activeRanges.length === 0) {
      return greenNode(node.kind, node.text, children.map((c, ci) => this.transformNode(c, ranges, offsets[ci])))
    }

    const newChildren: GreenNode[] = []
    let i = 0

    while (i < children.length) {
      const child = children[i]
      const range = activeRanges.find(r => offsets[i] >= r.start && offsets[i + 1] <= r.end)

      if (range && ['font_size', 'size'].includes(child.kind)) {
        const texts: string[] = []
        while (i < children.length && offsets[i + 1] <= range.end) {
          if (['font_size', 'size'].includes(children[i].kind)) {
            for (const tc of children[i].children as GreenNode[]) {
              if (tc.kind === 'text') texts.push(tc.text)
            }
          } else if (children[i].kind === 'text') {
            texts.push(children[i].text)
          }
          i++
        }

        const combined = texts.join('')
        const textLeaf = greenLeaf('text', combined)
        const attr = `=${range.min},${range.max}`
        newChildren.push(greenNode('grow', attr, [textLeaf]))
      } else {
        newChildren.push(this.transformNode(child, ranges, offsets[i]))
        i++
      }
    }

    return greenNode(node.kind, node.text, newChildren)
  }
}
