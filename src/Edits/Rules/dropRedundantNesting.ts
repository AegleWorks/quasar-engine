/**
 * Quasar — `drop-redundant-nesting`
 *
 * Removes a tag nested directly inside an identical one:
 *
 *   [color=#F00]a[color=#F00]b[/color][/color]  →  [color=#F00]ab[/color]
 *
 * The inner delimiters are the ones deleted, so the outer tag — and the
 * author's spelling of it — is what survives.
 *
 * Identity is the same normalised comparison the merge rule uses, so
 * `[color=#F00]` inside `[color=#FF0000]` counts as redundant: the colours are
 * equal even though the spellings are not.
 *
 * Siblings do not disqualify anything. In `[color=X]a[color=X]b[/color][/color]`
 * the inner tag is still setting a colour that is already in force, so
 * dropping its delimiters cannot change the render.
 *
 * ## Only tags that do nothing when nested in themselves
 *
 * "Redundant" has to be earned, not assumed. `[size=50]` renders as
 * `font-size:50%`, and a percentage is relative to its parent — so
 * `[size=50][size=50]x[/size][/size]` is 25%, not 50%, and the inner tag is
 * doing real work. `[sup]` stacks its vertical offset the same way. Removing
 * either would shrink or lift the text, which is not a smaller document, it is
 * a different one.
 *
 * @see IDEMPOTENT_WHEN_NESTED
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
  deletion,
} from './Rule'
import { mergeIdentity } from './tagValue'

export const DROP_REDUNDANT_NESTING_PRIORITY = 90

/**
 * Kinds whose effect is unchanged by being applied twice.
 *
 * A colour inside the same colour is still that colour; bold inside bold is
 * still bold. Excluded are the properties that **compound**: `font_size`
 * multiplies percentages, and `sup`/`sub` add their vertical offsets. Anything
 * not listed is left alone, unknown tags included.
 */
export const IDEMPOTENT_WHEN_NESTED: ReadonlySet<string> = new Set([
  'color',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'font',
  'mark',
])

export class DropRedundantNestingRule implements OptimizationRule {
  readonly id = 'drop-redundant-nesting'
  readonly priority = DROP_REDUNDANT_NESTING_PRIORITY
  readonly label = 'Remove tags nested inside an identical tag'

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan({ node: context.root, start: 0 }, new Map(), sink)
    sink.sort((a, b) => a.start - b.start || a.end - b.end)
    return sink
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * `inForce` maps a node kind to the identity its NEAREST ancestor of that
   * kind established.
   *
   * Keyed by kind rather than carrying a single inherited identity, because an
   * ancestor's colour survives an intervening tag of another kind:
   * `[color=X][b][color=X]…` is still redundant. Overwriting on the way down
   * is what makes it the *nearest* ancestor — in
   * `[color=X][color=Y][color=X]…` the innermost tag restores a colour that Y
   * had overridden, so it is doing real work and must stay.
   */
  private scan(
    item: Positioned,
    inForce: ReadonlyMap<string, string>,
    sink: PlannedEdit[],
  ): void {
    for (const child of positionedChildren(item)) {
      const identity = mergeIdentity(child.node)

      if (
        identity !== null &&
        IDEMPOTENT_WHEN_NESTED.has(child.node.kind) &&
        inForce.get(child.node.kind) === identity &&
        hasBothDelimiters(child)
      ) {
        const label = `Remove redundant nested [${child.node.kind}]`
        sink.push(deletion(openRange(child), this.id, this.priority, label))
        sink.push(deletion(closeRange(child), this.id, this.priority, label))
        // Deleting the delimiters leaves the ancestor's identity in force.
        this.scan(child, inForce, sink)
        continue
      }

      if (identity === null) {
        this.scan(child, inForce, sink)
      } else {
        const nested = new Map(inForce)
        nested.set(child.node.kind, identity)
        this.scan(child, nested, sink)
      }
    }
  }
}
