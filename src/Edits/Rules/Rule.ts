/**
 * Quasar — Optimization Rule contract
 *
 * Every rule reads the Green Tree and returns `PlannedEdit[]` addressed to
 * offsets in the ORIGINAL source. Rules never mutate the tree, never build a
 * new one, and never see each other's output — the only thing that arbitrates
 * between them is `resolveEditConflicts`.
 *
 * Three obligations, all of them load-bearing:
 *
 * 1. **Maximal.** A rule emits the final form in one pass. It may not rely on
 *    being run again: applying an edit invalidates every later offset, so
 *    there is no second pass to be had. Where `ASTOptimizer` merged pairwise
 *    and iterated to a fixpoint, a rule here recognises the whole run.
 * 2. **Deterministic.** Same tree in, same edits out, in the same order.
 * 3. **Spelling-preserving.** Prefer deleting the author's bytes over
 *    generating replacements. `[Color = "#FF0000"]` must survive a merge
 *    intact; the exporter would have rewritten it to `[color=#FF0000]`.
 *
 * @see resolveEditConflicts
 */

import type { GreenNode } from '../../Syntax/GreenNode'
import { childOffsets } from '../../Syntax/GreenNode'
import type { PlannedEdit } from '../EditPlan'

// ── Contract ──────────────────────────────────────────────────────

export interface RuleContext {
  /** The document exactly as the author wrote it. */
  readonly source: string
  /** Green root, whose width equals `source.length`. */
  readonly root: GreenNode
}

export interface OptimizationRule {
  /** Stable identifier; also the final tie-break in the conflict order. */
  readonly id: string
  /**
   * Arbitration weight. A rule that rewrites a whole region must outrank the
   * rules that tweak tokens inside it, so the region's own normal form wins.
   */
  readonly priority: number
  /** Short human label, shown in the "what did the minifier do" list. */
  readonly label: string
  run(context: RuleContext): PlannedEdit[]
}

// ── Positioned tree walking ───────────────────────────────────────

/**
 * A node together with its absolute start offset in the source.
 *
 * Green nodes carry widths, not positions, so every rule that wants a range
 * has to accumulate offsets on the way down. This pairing is what the rules
 * pass around instead of bare nodes.
 */
export interface Positioned {
  readonly node: GreenNode
  readonly start: number
}

/** Absolute end offset (exclusive). */
export function endOf(p: Positioned): number {
  return p.start + p.node.width
}

/** The range of the opening delimiter — `[color=#F00]`. */
export function openRange(p: Positioned): { start: number; end: number } {
  return { start: p.start, end: p.start + p.node.leadingWidth }
}

/** The range of the closing delimiter — `[/color]`. */
export function closeRange(p: Positioned): { start: number; end: number } {
  const end = endOf(p)
  return { start: end - p.node.trailingWidth, end }
}

/** Children paired with their absolute offsets, in document order. */
export function positionedChildren(p: Positioned): Positioned[] {
  const children = p.node.children as readonly GreenNode[]
  if (children.length === 0) return []
  const offsets = childOffsets(p.node, p.start)
  const out: Positioned[] = new Array(children.length)
  for (let i = 0; i < children.length; i++) {
    out[i] = { node: children[i], start: offsets[i] }
  }
  return out
}

/**
 * A node that actually has both delimiters in the source.
 *
 * The parser synthesises a closing tag for `[b]never closed`, which comes back
 * as `trailingWidth === 0`. Deleting a delimiter that occupies no bytes is a
 * no-op at best; treating a synthetic close as if it were real is a
 * correctness bug. Rules that move or remove delimiters check this first.
 */
export function hasBothDelimiters(p: Positioned): boolean {
  return p.node.leadingWidth > 0 && p.node.trailingWidth > 0
}

// ── Edit construction ─────────────────────────────────────────────

/** A deletion of an exact source range. */
export function deletion(
  range: { start: number; end: number },
  ruleId: string,
  priority: number,
  label?: string,
): PlannedEdit {
  return { start: range.start, end: range.end, text: '', ruleId, priority, label }
}

/**
 * Merge deletions that touch into single edits.
 *
 * Two deletions `[a,b)` and `[b,c)` are legal side by side — the conflict
 * resolver calls them disjoint — but they describe one contiguous removal.
 * Emitting them separately inflates the edit count for no benefit and makes
 * the "N optimisations applied" number lie about how much happened.
 *
 * Input must be sorted by `start` and non-overlapping.
 */
export function coalesceDeletions(edits: readonly PlannedEdit[]): PlannedEdit[] {
  if (edits.length < 2) return [...edits]

  const out: PlannedEdit[] = []
  for (const edit of edits) {
    const previous = out[out.length - 1]
    const joinable =
      previous !== undefined &&
      previous.text === '' &&
      edit.text === '' &&
      previous.end === edit.start &&
      previous.ruleId === edit.ruleId &&
      previous.priority === edit.priority
    if (joinable) {
      out[out.length - 1] = { ...previous, end: edit.end }
    } else {
      out.push(edit)
    }
  }
  return out
}
