/**
 * Quasar Analysis Framework — Rainbow Collapse Transform
 *
 * Applies `collapse-rainbow` actions from a TransformationPlan.
 * Replaces sequences of [color] nodes forming a hue-rotation pattern
 * with a single [rainbow] node containing all text children.
 *
 * @example
 * Before: [color=#FF0000]R[/color][color=#FFFF00]O[/color][color=#00FF00]Y[/color]
 * After:  [rainbow]ROY[/rainbow]
 */

import type { TransformPass, TransformationPlan } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { greenNode, greenLeaf, childOffsets } from '../../../Syntax/GreenNode'

export class RainbowCollapseTransform implements TransformPass {
  readonly id = 'rainbow-collapse'

  run(tree: GreenNode, plan: TransformationPlan, _context: PipelineContext): GreenNode {
    const actions = plan.actions.filter(a => a.kind === 'collapse-rainbow')
    if (actions.length === 0) return tree

    const ranges = actions.map(a => ({
      start: (a.payload.range as { start: number; end: number }).start,
      end: (a.payload.range as { start: number; end: number }).end,
    })).sort((a, b) => a.start - b.start)

    return this.transformNode(tree, ranges)
  }

  private transformNode(node: GreenNode, ranges: Array<{ start: number; end: number }>, treeStart: number = 0): GreenNode {
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

      if (range && child.kind === 'color') {
        const rangeChildren: GreenNode[] = []
        const texts: string[] = []

        while (i < children.length && offsets[i + 1] <= range.end) {
          rangeChildren.push(children[i])
          if (children[i].kind === 'color') {
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
        newChildren.push(greenNode('rainbow', '', [textLeaf]))
      } else {
        newChildren.push(this.transformNode(child, ranges, offsets[i]))
        i++
      }
    }

    return greenNode(node.kind, node.text, newChildren)
  }
}
