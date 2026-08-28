/**
 * Quasar Analysis Framework — Color Usage Analyzer
 *
 * Reports every `[color=#RRGGBB]` in the document, one contribution per tag.
 *
 * ## Why this exists alongside GradientAnalyzer
 *
 * `GradientAnalyzer` recognises that a run of colour tags forms a gradient and
 * describes its *shape* — the stops, the easing, the span. What it does not
 * describe is where each individual tag sits, because a gradient is modelled
 * as one continuous ramp rather than as the tags that spell it out.
 *
 * A consumer that wants to recolour a document needs both: the shape, to know
 * what the gradient is doing, and the tag positions, to know what to edit.
 * This pass supplies the second half. A DecisionPass sees both contributions
 * in the same report and can join them — which is exactly how the framework is
 * meant to compose, since analyzer passes cannot observe each other.
 *
 * ## What gets reported
 *
 * Every colour tag, gradient member or not. Deciding which ones are
 * interesting is a decision, and decisions belong in the decision stage.
 *
 * Only full six-digit hex is recognised, because that is what `extractHex`
 * accepts. `[color=red]` and `[color=#F00]` are parsed as colours by the
 * engine but are invisible here — a deliberate limit, since rewriting them
 * would mean choosing a canonical spelling the author did not use.
 *
 * @see SemanticContribution
 * @see GradientAnalyzer
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { extractHex } from '../../Utils/color-utils'

// ── Types ─────────────────────────────────────────────────────────

export interface ColorUsageModel {
  /** Normalised to uppercase `#RRGGBB` by `extractHex`. */
  readonly hex: string
  /**
   * Source offsets of the opening delimiter alone — `[color=#D194B3]`.
   *
   * Recolouring replaces this span rather than the attribute inside it. The
   * attribute's own position would have to be derived from the delimiter's
   * width and the hex's length, which breaks the moment the author writes
   * `[color = #D194B3]`; the delimiter's bounds are read straight off the
   * node. The cost is that a rewritten tag comes back in canonical spelling,
   * which is acceptable for a tag being edited anyway.
   */
  readonly openStart: number
  readonly openEnd: number
}

// ── Analyzer ──────────────────────────────────────────────────────

export class ColorUsageAnalyzer implements AnalyzerPass {
  readonly id = 'color-usage'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.walk(tree, contributions, 0)
    return contributions
  }

  // ── Private ─────────────────────────────────────────────────────

  private walk(node: GreenNode, sink: Contribution[], start: number): void {
    const hex = extractHex(node)

    if (hex !== null) {
      const model: ColorUsageModel = {
        hex,
        openStart: start,
        openEnd: start + node.leadingWidth,
      }

      sink.push({
        kind: ContributionKind.Semantic,
        label: 'Color',
        // A parsed colour tag is a fact, not an inference: unlike a gradient
        // or a decorative glyph, there is nothing here to be unsure about.
        confidence: 1,
        range: { start, end: start + node.width },
        metadata: { model },
        description: `Colour ${hex}`,
      })
    }

    const children = node.children as readonly GreenNode[]
    if (children.length === 0) return

    const offsets = childOffsets(node, start)
    for (let i = 0; i < children.length; i++) {
      this.walk(children[i], sink, offsets[i])
    }
  }
}
