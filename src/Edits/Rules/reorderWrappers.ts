/**
 * Quasar — `reorder-wrappers` (opt-in)
 *
 * Puts a chain of single-child wrappers into a canonical order:
 *
 *   [color=#F00][b]x[/b][/color]  →  [b][color=#F00]x[/color][/b]
 *
 * ## It saves no bytes, and that is why it is not in the default preset
 *
 * Reordering removes nothing. Its value is canonical form — two documents that
 * differ only in wrapper order become byte-identical, which is what lets other
 * rules recognise runs they would otherwise miss. On its own, in a *minifier*,
 * it produces a diff across someone's document in exchange for zero
 * characters, so `defaultRules()` leaves it out and callers opt in.
 *
 * ## Byte-swaps, never regeneration
 *
 * The delimiters are moved, not rebuilt: each slot receives the exact source
 * bytes of the delimiter that belongs there. `[Color = "#F00"]` comes out the
 * other side character for character, which a tag-rebuilding implementation
 * could not promise.
 *
 * ## Maximal
 *
 * The whole chain is sorted at once. Swapping one adjacent pair at a time
 * would need repeated passes over offsets that no longer exist, so
 * `[color][b][i]x[/i][/b][/color]` is permuted in a single step. The sort is
 * stable, so equal-rank wrappers keep the order the author wrote.
 */

import type { PlannedEdit } from '../EditPlan'
import {
  type OptimizationRule,
  type RuleContext,
  type Positioned,
  positionedChildren,
  openRange,
  closeRange,
  hasBothDelimiters,
} from './Rule'

export const REORDER_WRAPPERS_PRIORITY = 5

/**
 * Nesting rank — lower belongs further out.
 *
 * Links outermost (a link wrapping styled text is the common authoring
 * intent), then metrics, then weight/decoration, then colour innermost. Kinds
 * absent from the table are not reordered at all: an unranked tag may carry
 * layout or semantics that nesting order changes.
 */
const RANK: Readonly<Record<string, number>> = {
  url: 1,
  email: 1,
  profile: 1,
  font_size: 2,
  font: 2,
  bold: 3,
  italic: 3,
  underline: 3,
  strikethrough: 3,
  color: 4,
}

export class ReorderWrappersRule implements OptimizationRule {
  readonly id = 'reorder-wrappers'
  readonly priority = REORDER_WRAPPERS_PRIORITY
  readonly label = 'Canonicalise nested wrapper order'

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan({ node: context.root, start: 0 }, context.source, sink)
    sink.sort((a, b) => a.start - b.start || a.end - b.end)
    return sink
  }

  // ── Private ─────────────────────────────────────────────────────

  private scan(item: Positioned, source: string, sink: PlannedEdit[]): void {
    for (const child of positionedChildren(item)) {
      const chain = this.chainFrom(child)

      if (chain.length >= 2) {
        this.emitPermutation(chain, source, sink)
        // Continue below the chain. `scan` iterates its argument's children,
        // so the innermost wrapper is what gets handed down — passing its
        // children instead would skip a level.
        this.scan(chain[chain.length - 1], source, sink)
        continue
      }

      this.scan(child, source, sink)
    }
  }

  /** The maximal run of rankable single-child wrappers starting at `item`. */
  private chainFrom(item: Positioned): Positioned[] {
    const chain: Positioned[] = []
    let current: Positioned | undefined = item

    while (
      current &&
      RANK[current.node.kind] !== undefined &&
      hasBothDelimiters(current) &&
      current.node.children.length === 1
    ) {
      chain.push(current)
      const [only] = positionedChildren(current)
      current = only
    }
    return chain
  }

  private emitPermutation(
    chain: readonly Positioned[],
    source: string,
    sink: PlannedEdit[],
  ): void {
    const order = chain.map((_, index) => index)
    // Stable by construction: ties fall back to the original index.
    order.sort((a, b) => RANK[chain[a].node.kind] - RANK[chain[b].node.kind] || a - b)

    if (order.every((sourceIndex, slot) => sourceIndex === slot)) return

    const label = `Canonicalise ${chain.map(c => `[${c.node.kind}]`).join('')}`

    for (let slot = 0; slot < chain.length; slot++) {
      const from = chain[order[slot]]
      if (order[slot] === slot) continue

      const openSlot = openRange(chain[slot])
      const closeSlot = closeRange(chain[slot])
      const openFrom = openRange(from)
      const closeFrom = closeRange(from)

      sink.push({
        start: openSlot.start,
        end: openSlot.end,
        text: source.slice(openFrom.start, openFrom.end),
        ruleId: this.id,
        priority: this.priority,
        label,
      })
      sink.push({
        start: closeSlot.start,
        end: closeSlot.end,
        text: source.slice(closeFrom.start, closeFrom.end),
        ruleId: this.id,
        priority: this.priority,
        label,
      })
    }
  }
}
