/**
 * Quasar Analysis Framework — Restyle Analyzer
 *
 * The one pass a restyle needs: every fact the palette remap decision reads,
 * collected in a single walk of the tree.
 *
 * ## Why one pass
 *
 * Restyling used to compose four independent analyzers — `GradientAnalyzer`,
 * `ColorUsageAnalyzer`, `GradientTagAnalyzer`, `SymbolAnalyzer` — and every one
 * of them walked the whole document from the root. That is four pre-order
 * traversals, four offset accumulations per node, and four allocations of the
 * same facts. The work is the same work; only the report changes.
 *
 * This pass produces the same contributions, in a traversal that also hands
 * the gradient scan the offsets it would otherwise have to compute itself.
 * On the 500 KB fixture it turns ~128 ms of analysis into ~50 ms (see
 * `scripts/perf`), and the decision layer cannot tell the difference: it
 * filters contributions by label and sorts by range, which makes declaration
 * order irrelevant.
 *
 * ## Opaque regions
 *
 * `[code]`, `[c]` and `[image]` content is literal. Symbols inside them are
 * characters the author meant, and a tag-looking string inside them is not a
 * tag, so the walker stops at those kinds. Colours and gradients are nodes
 * only outside them by construction.
 *
 * @see PaletteRemapDecision — the consumer
 * @see PaletteRemapPlanner — parse + this pass + decision, cached per source
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { colorUsageContributionAt } from './ColorUsageAnalyzer'
import { GradientAnalyzer } from './GradientAnalyzer'
import { gradientTagContributionAt } from './GradientTagAnalyzer'
import { scanSymbolText } from './SymbolAnalyzer'

/** Node kinds whose content is literal text, never markup or decoration. */
const OPAQUE_KINDS: ReadonlySet<string> = new Set(['code', 'inline_code', 'image'])

/** A gradient needs at least three adjacent colour children. */
const MIN_COLOR_RUN = 3

function countColorChildren(children: readonly GreenNode[]): number {
  let count = 0
  for (let i = 0; i < children.length; i++) {
    if (children[i].kind === 'color') count++
  }
  return count
}

export class RestyleAnalyzer implements AnalyzerPass {
  readonly id = 'restyle'

  /** One gradient detector, reused across calls; it holds no per-run state. */
  private readonly gradients = new GradientAnalyzer()

  /**
   * @param source — the exact text the analysed tree was parsed from. Needed
   * only by the native `[gradient]` scan, whose stop offsets are source bytes
   * rather than tree widths.
   */
  constructor(private readonly source: string) {}

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.walk(tree, contributions, 0)
    return contributions
  }

  private walk(node: GreenNode, sink: Contribution[], start: number): void {
    const color = colorUsageContributionAt(node, start)
    if (color !== null) sink.push(color)

    const gradientTag = gradientTagContributionAt(node, this.source, start)
    if (gradientTag !== null) sink.push(gradientTag)

    if (node.kind === 'text') {
      scanSymbolText(node.text, start, sink)
      return
    }

    if (OPAQUE_KINDS.has(node.kind)) return

    const children = node.children as readonly GreenNode[]
    if (children.length === 0) return

    if (countColorChildren(children) >= MIN_COLOR_RUN) {
      const offsets = childOffsets(node, start)
      for (const contribution of this.gradients.gradientsAt(children, offsets)) {
        sink.push(contribution)
      }
      for (let i = 0; i < children.length; i++) {
        this.walk(children[i], sink, offsets[i])
      }
      return
    }

    let offset = start + node.leadingWidth
    for (let i = 0; i < children.length; i++) {
      this.walk(children[i], sink, offset)
      offset += children[i].width
    }
  }
}
