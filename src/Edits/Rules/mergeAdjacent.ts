/**
 * Quasar — `merge-adjacent`
 *
 * Fuses runs of identically-attributed sibling tags into one:
 *
 *   [color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]y[/color]
 *   → [color=#FF0000]Hey[/color]
 *
 * This is where the bytes are. A per-character gradient spends ~23 bytes of
 * delimiter on every 1 byte of text; collapsing a run of identical colours is
 * the single largest saving available on a real userpage.
 *
 * ## It only ever deletes
 *
 * The merged tag is not generated. The first member's opening delimiter and
 * the last member's closing delimiter are left exactly as the author typed
 * them, and only the seams between members are removed:
 *
 *   [Color = "#F00"]a[/color][color=#ff0000]b[/color]
 *   [Color = "#F00"]a‹  deleted  ›b[/color]
 *
 * So `[Color = "#F00"]` survives with its capital C, its spaces and its
 * quotes. A rule that rebuilt the tag would have normalised all three, which
 * is exactly the drift that makes whole-document re-export unusable in an
 * editor.
 *
 * ## Maximal in one pass
 *
 * `ASTOptimizer` merges pairwise and iterates to a fixpoint. Edits addressed
 * to the original source cannot do that — applying one invalidates every later
 * offset — so this rule recognises the **whole run at once**, and then
 * descends into the content the merge is about to create:
 *
 *   [b][color=X]a[/color][/b][b][color=X]bc[/color][/b]
 *
 * Merging the two `[b]` makes their colour children siblings, and those merge
 * too. The recursion walks that *virtual* child list, so both levels come out
 * of a single pass. Crucially the inner seams sit inside the members' content
 * and the outer seams sit between members, so the two sets never overlap.
 *
 * @see mergeIdentity — what "identically attributed" means
 * @see BRIDGES_WHITESPACE — when a gap between members may be absorbed
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
  coalesceDeletions,
} from './Rule'
import { mergeIdentity, BRIDGES_WHITESPACE, attributeValue } from './tagValue'
import { isInvisibleWhitespace } from './unwrapInvisibleColor'

/** Horizontal whitespace only — a newline is a paragraph break, never a gap. */
const HORIZONTAL_BLANK = /^[ \t]*$/

export const MERGE_ADJACENT_PRIORITY = 100

export interface MergeAdjacentOptions {
  /**
   * Restrict the rule to these node kinds. Omitted, every kind
   * {@link mergeIdentity} recognises is eligible.
   */
  readonly kinds?: ReadonlySet<string>
}

export class MergeAdjacentRule implements OptimizationRule {
  readonly id = 'merge-adjacent'
  readonly priority = MERGE_ADJACENT_PRIORITY
  readonly label = 'Merge adjacent identical tags'

  private readonly kinds?: ReadonlySet<string>

  constructor(options: MergeAdjacentOptions = {}) {
    this.kinds = options.kinds
  }

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan(positionedChildren({ node: context.root, start: 0 }), sink)
    // Emitted parent-first; the plan reads better in document order, and
    // `coalesceDeletions` requires it.
    sink.sort((a, b) => a.start - b.start || a.end - b.end)
    return coalesceDeletions(sink)
  }

  // ── Private ─────────────────────────────────────────────────────

  private identityOf(node: GreenNode): string | null {
    if (this.kinds && !this.kinds.has(node.kind)) return null

    // A colour wrapping nothing but whitespace is never a run *member*, only
    // ever a bridge — `unwrap-invisible-color` owns those delimiters.
    //
    // Adopting one as a member is a genuine corruption, and an instructive
    // one: a merged run keeps its first member's opening delimiter, so when
    // the whitespace node led the run, merge kept the delimiter that unwrap
    // was independently deleting. The two edits do not overlap, so the
    // conflict resolver — which can only arbitrate claims on the same bytes —
    // had nothing to arbitrate, and the document came out with an unbalanced
    // `[/color]`. Rules must not depend on each other's edits surviving.
    if (node.kind === 'color' && isInvisibleWhitespace(node)) return null

    return mergeIdentity(node)
  }

  /**
   * A node that may sit between two members and be absorbed by the merge.
   *
   * Blank text, or a colour tag wrapping nothing but blank text — the shape
   * `unwrap-invisible-color` exists to delete. Treating it as a gap rather
   * than as a wall lets `[color=A]x[/color][color=B] [/color][color=A]y[/color]`
   * still fuse its two `A` members; the `B` tag survives this rule untouched
   * and is removed by the other one, whose edits are disjoint from these.
   */
  private isBridge(item: Positioned): boolean {
    if (item.node.kind === 'text') return HORIZONTAL_BLANK.test(item.node.text ?? '')
    return item.node.kind === 'color' && isInvisibleWhitespace(item.node)
  }

  /**
   * Walk one sibling list, fusing every maximal run it contains.
   *
   * The list is not always a real node's children: after a merge is planned,
   * the members' children are spliced together and scanned as the sibling list
   * the merged tag will actually have.
   */
  private scan(items: readonly Positioned[], sink: PlannedEdit[]): void {
    let i = 0

    while (i < items.length) {
      const identity = this.identityOf(items[i].node)

      if (identity === null) {
        this.scan(positionedChildren(items[i]), sink)
        i++
        continue
      }

      const bridges = BRIDGES_WHITESPACE.has(items[i].node.kind)
      const members: number[] = [i]

      // Extend while the next sibling is either another member or — for kinds
      // where it is invisible — blank text between two of them.
      let j = i + 1
      while (j < items.length) {
        if (this.identityOf(items[j].node) === identity) {
          members.push(j)
          j++
          continue
        }
        if (bridges && this.isBridge(items[j])) {
          j++
          continue
        }
        break
      }

      const last = members[members.length - 1]
      const merging =
        members.length >= 2 && members.every(index => hasBothDelimiters(items[index]))

      if (merging) {
        this.emitSeams(items, members, sink)
        this.scan(this.virtualContent(items, members, last), sink)
      } else {
        // No merge: every element up to and including the last member still
        // has to be visited on its own.
        for (let t = i; t <= last; t++) this.scan(positionedChildren(items[t]), sink)
      }

      i = last + 1
    }
  }

  /**
   * Delete each member's closing delimiter and the next member's opening one.
   *
   * Two edits per seam rather than one span, because a bridge may sit between
   * them and must survive. When nothing separates them the two deletions touch
   * and `coalesceDeletions` folds them back into a single edit.
   */
  private emitSeams(
    items: readonly Positioned[],
    members: readonly number[],
    sink: PlannedEdit[],
  ): void {
    const head = items[members[0]].node
    const what = attributeValue(head) ? `${head.kind}=${attributeValue(head)}` : head.kind
    const label = `Merge ${members.length} × [${what}]`

    for (let m = 0; m < members.length - 1; m++) {
      const current = items[members[m]]
      const next = items[members[m + 1]]
      sink.push(deletion(closeRange(current), this.id, this.priority, label))
      sink.push(deletion(openRange(next), this.id, this.priority, label))
    }
  }

  /**
   * The sibling list the merged tag will hold: every member's children in
   * order, with any bridging text kept in place between them.
   */
  private virtualContent(
    items: readonly Positioned[],
    members: readonly number[],
    last: number,
  ): Positioned[] {
    const isMember = new Set(members)
    const out: Positioned[] = []
    for (let t = members[0]; t <= last; t++) {
      if (isMember.has(t)) out.push(...positionedChildren(items[t]))
      else out.push(items[t])
    }
    return out
  }
}
