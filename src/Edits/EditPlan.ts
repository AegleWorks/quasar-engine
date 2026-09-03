/**
 * Quasar — Surgical Edit Plan & Conflict Resolution
 *
 * The optimizer has exactly one output: a set of `SurgicalEdit`s over the
 * ORIGINAL source. Two appliers consume it — Monaco in-place, and a pure
 * string rewrite for export — so neither ever re-serializes the document and
 * neither can drift from the other.
 *
 * That design has one hard prerequisite, which is what this file is:
 * **the edits handed to an applier must be pairwise conflict-free.**
 * Monaco is explicit that it will not arbitrate:
 *
 *   > Overlapping ranges are the caller's responsibility — Monaco has no
 *   > answer for two edits claiming the same character.
 *   — `packages/core/Editor/Core_Editor.tsx`
 *
 * Rules are authored independently and WILL collide: merging a run of
 * identical `[color=#FF0000]` tags and shortening that same `#FF0000` to
 * `#F00` claim overlapping bytes. The resolution must never be "last writer
 * wins", because that makes the output depend on the order rules happen to be
 * registered in. Everything here exists to make the outcome a pure function of
 * the edit set itself.
 *
 * @see resolveEditConflicts
 */

import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

// ── Planned edits ─────────────────────────────────────────────────

/**
 * A `SurgicalEdit` plus the provenance the resolver needs to arbitrate and
 * the UI needs to explain itself.
 *
 * `priority` is declared by the rule, not derived from the edit. A rule that
 * rewrites a whole region outranks one that tweaks a token inside it, and
 * that relationship is a property of the rules — not something you can read
 * off two ranges.
 */
export interface PlannedEdit extends SurgicalEdit {
  /** Identifies the rule that produced this edit. Also the final tie-break. */
  readonly ruleId: string
  /** Higher wins. See {@link compareEditPriority} for the full order. */
  readonly priority: number
  /** Human-readable intent, for the "what did the minifier do" panel. */
  readonly label?: string
}

/**
 * Why an edit did not make it into the applied set.
 *
 * - `invalid-range` — the rule emitted a range that is not a valid slice of
 *   the source. A rule bug; dropped rather than thrown so one broken rule
 *   cannot destroy an otherwise good batch.
 * - `subsumed` — a winning edit's range fully contains this one (equal ranges
 *   included). The winner rewrites these bytes wholesale, so this edit's
 *   intent is either already covered or no longer meaningful.
 * - `straddle` — partial overlap where NEITHER range contains the other.
 *   Reported separately from `subsumed` on purpose: see the note on
 *   {@link classifyOverlap}.
 */
export type EditRejectionReason = 'invalid-range' | 'subsumed' | 'straddle'

export interface RejectedEdit {
  readonly edit: PlannedEdit
  readonly reason: EditRejectionReason
  /** The accepted edit that displaced it. Absent for `invalid-range`. */
  readonly winner?: PlannedEdit
}

export interface ResolvedEditPlan {
  /**
   * Pairwise conflict-free, sorted by ascending `start`. Safe to hand
   * verbatim to `applySurgicalEdits` (Monaco resolves original offsets
   * itself) or to a back-to-front string rewrite.
   */
  readonly accepted: readonly PlannedEdit[]
  /** Everything dropped, with the reason and the edit that displaced it. */
  readonly rejected: readonly RejectedEdit[]
}

// ── Overlap geometry ──────────────────────────────────────────────

/** How two claimed ranges relate. */
export type OverlapRelation = 'disjoint' | 'subsumption' | 'straddle'

/**
 * Classify two edits by the bytes they claim.
 *
 * Ranges are half-open `[start, end)` over the original source, so edits that
 * merely touch (`a.end === b.start`) are disjoint — adjacent replacements are
 * perfectly legal and common.
 *
 * Zero-width edits (insertions, `start === end`) need two special cases that
 * pure interval intersection gets wrong:
 *
 * 1. Two insertions at the SAME offset have an empty intersection, yet both
 *    write at one point with no defined order between them. That is a
 *    conflict, classified as `subsumption` so priority decides it.
 * 2. An insertion strictly inside a replacement also has an empty
 *    intersection, but the replacement destroys the bytes the insertion point
 *    refers to, so the insertion is meaningless. Also `subsumption`.
 *
 * An insertion exactly at a replacement's boundary stays disjoint — it is
 * unambiguously before or after, and both appliers agree on that.
 *
 * `straddle` is deliberately its own relation rather than folded into
 * `subsumption`. It is resolved the same way (drop the loser), but two
 * *maximal* rules should never straddle each other: a straddle almost always
 * means a rule computed a partial range instead of the whole normal form.
 * Keeping it distinct is what makes that bug visible instead of silent.
 */
export function classifyOverlap(a: SurgicalEdit, b: SurgicalEdit): OverlapRelation {
  const aEmpty = a.start === a.end
  const bEmpty = b.start === b.end

  // Case 1: two insertions. They conflict only at the very same offset.
  if (aEmpty && bEmpty) {
    return a.start === b.start ? 'subsumption' : 'disjoint'
  }

  const lo = Math.max(a.start, b.start)
  const hi = Math.min(a.end, b.end)

  if (lo >= hi) {
    // Case 2: an insertion strictly interior to the other's range.
    if (aEmpty && b.start < a.start && a.start < b.end) return 'subsumption'
    if (bEmpty && a.start < b.start && b.start < a.end) return 'subsumption'
    return 'disjoint'
  }

  const aContainsB = a.start <= b.start && b.end <= a.end
  const bContainsA = b.start <= a.start && a.end <= b.end

  // Equal ranges satisfy both, and land here as subsumption — correct: one of
  // the two must go, and priority is what decides which.
  return aContainsB || bContainsA ? 'subsumption' : 'straddle'
}

/** Whether two edits may not be applied together. */
export function editsConflict(a: SurgicalEdit, b: SurgicalEdit): boolean {
  return classifyOverlap(a, b) !== 'disjoint'
}

// ── Priority ──────────────────────────────────────────────────────

/**
 * The arbitration order, as a comparator: negative means `a` is considered
 * first and therefore wins any conflict against `b`.
 *
 * The chain is **total** — it never returns 0 for two distinguishable edits.
 * That is the whole point. A partial order would leave ties broken by
 * `Array.prototype.sort` stability, i.e. by the order rules were registered,
 * which is exactly the non-determinism this contract exists to prevent.
 *
 * 1. `priority` descending — the rule's own declaration, and the only lever a
 *    rule author has.
 * 2. Width descending — at equal priority the wider claim wins, because a
 *    broader rewrite subsumes the work of a narrower one more often than the
 *    reverse. (A zero-width insertion therefore loses to any replacement it
 *    ties with, which is what you want: the replacement carries text anyway.)
 * 3. `start` ascending — earlier in the document.
 * 4. `ruleId`, then `text`, lexicographically — no semantic meaning, purely
 *    the guarantee that the order is total.
 */
export function compareEditPriority(a: PlannedEdit, b: PlannedEdit): number {
  if (a.priority !== b.priority) return b.priority - a.priority

  const aWidth = a.end - a.start
  const bWidth = b.end - b.start
  if (aWidth !== bWidth) return bWidth - aWidth

  if (a.start !== b.start) return a.start - b.start
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
  if (a.text !== b.text) return a.text < b.text ? -1 : 1
  return 0
}

// ── Resolution ────────────────────────────────────────────────────

/**
 * Overlap geometry and rejection reasons are separate vocabularies on purpose:
 * one describes how two ranges sit, the other why an edit was dropped. This is
 * the only place they meet. It used to be a cast, which quietly turned
 * `'subsumption'` into an invalid reason string.
 */
const REJECTION_FOR: Record<Exclude<OverlapRelation, 'disjoint'>, EditRejectionReason> = {
  subsumption: 'subsumed',
  straddle: 'straddle',
}

function isValidRange(edit: SurgicalEdit, sourceLength: number): boolean {
  return (
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= sourceLength
  )
}

/** Index of the first accepted edit ordered at or after `edit`. */
function lowerBound(sorted: readonly PlannedEdit[], edit: PlannedEdit): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const probe = sorted[mid]
    if (probe.start < edit.start || (probe.start === edit.start && probe.end < edit.end)) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * Reduce a rule-authored edit set to a conflict-free one.
 *
 * Greedy by {@link compareEditPriority}: walk the edits in arbitration order
 * and accept each one that collides with nothing already accepted.
 *
 * This is deliberately **not** a maximum-weight independent set. Greedy can
 * drop two small edits to keep one large one that saves fewer bytes, and that
 * is an accepted trade: the optimizer's contract is that the same document
 * always minifies to the same output, not that it minifies to the smallest
 * possible output. Predictability is worth more than the last few bytes in a
 * tool that rewrites someone's document.
 *
 * The result is order-independent — shuffling `edits` cannot change
 * `accepted` — which is the property the tests pin down.
 *
 * @param edits        Rule output, in any order.
 * @param sourceLength Length of the ORIGINAL source every range indexes into.
 */
export function resolveEditConflicts(
  edits: readonly PlannedEdit[],
  sourceLength: number,
): ResolvedEditPlan {
  const rejected: RejectedEdit[] = []
  const candidates: PlannedEdit[] = []

  for (const edit of edits) {
    if (isValidRange(edit, sourceLength)) candidates.push(edit)
    else rejected.push({ edit, reason: 'invalid-range' })
  }

  candidates.sort(compareEditPriority)

  // Kept sorted by (start, end). Every member is disjoint from every other,
  // so a conflicting neighbour is always found next to the insertion point.
  const accepted: PlannedEdit[] = []

  for (const candidate of candidates) {
    const at = lowerBound(accepted, candidate)

    let winner: PlannedEdit | undefined
    let reason: EditRejectionReason | undefined

    // The predecessor can extend past the candidate's start...
    if (at > 0) {
      const previous = accepted[at - 1]
      const rel = classifyOverlap(candidate, previous)
      if (rel !== 'disjoint') {
        winner = previous
        reason = REJECTION_FOR[rel]
      }
    }

    // ...and any accepted edit beginning at or before the candidate's end may
    // reach back into it. Scanning stops at the first hit, and the accepted
    // set is disjoint, so this walks a couple of entries, never the list.
    for (let i = at; !winner && i < accepted.length && accepted[i].start <= candidate.end; i++) {
      const rel = classifyOverlap(candidate, accepted[i])
      if (rel !== 'disjoint') {
        winner = accepted[i]
        reason = REJECTION_FOR[rel]
      }
    }

    if (winner && reason) {
      rejected.push({ edit: candidate, reason, winner })
    } else {
      accepted.splice(at, 0, candidate)
    }
  }

  return { accepted, rejected }
}
