/**
 * The two pieces every Fix-All aggregator shares (`BatchFixer`, the
 * lightbulb's `source.fixAll`, the editor's "Fix all"): a set of accepted
 * edits that answers "does this conflict with anything taken?" without
 * comparing against all of them, and the rule that turns several closers
 * written at one offset into one insertion.
 */

import type { Diagnostic } from '../Types/diagnostics'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { editsConflict } from '../Edits/EditPlan'
import { getCodeFixMeta } from './CodeFixRegistry'

/**
 * Accepted edits, pairwise conflict-free, kept sorted by start.
 *
 * Conflict-free means no two overlap (touching is allowed), so sorted by start
 * they are sorted by end as well: the edits that can conflict with a new one
 * are a contiguous run, found by binary search. Checking each candidate
 * against every accepted edit made Fix-All quadratic in the findings.
 */
export class AcceptedEdits {
  private readonly edits: SurgicalEdit[] = []

  /** Whether `edit` conflicts with an accepted edit. */
  conflicts(edit: SurgicalEdit): boolean {
    const list = this.edits
    // First accepted edit whose end reaches `edit.start` — nothing before it
    // can touch `edit`.
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].end < edit.start) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < list.length && list[i].start <= edit.end; i++) {
      if (editsConflict(list[i], edit)) return true
    }
    return false
  }

  /** Whether any of `edits` conflicts with an accepted edit. */
  conflictsAny(edits: readonly SurgicalEdit[]): boolean {
    for (const edit of edits) if (this.conflicts(edit)) return true
    return false
  }

  /** Accept `edits`; the caller has checked they do not conflict. */
  add(edits: readonly SurgicalEdit[]): void {
    const list = this.edits
    for (const edit of edits) {
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].start < edit.start || (list[mid].start === edit.start && list[mid].end <= edit.end)) lo = mid + 1
        else hi = mid
      }
      list.splice(lo, 0, edit)
    }
  }

  /** Every accepted edit, back-to-front (start DESC, then end DESC). */
  backToFront(): SurgicalEdit[] {
    return [...this.edits].sort((a, b) => b.start - a.start || b.end - a.end)
  }
}

/** One diagnostic's fix, as Fix-All sees it. */
export interface FixCandidate {
  diagnostic: Diagnostic
  edits: SurgicalEdit[]
  /** How many findings this candidate fixes (more than one once merged). */
  count: number
}

/**
 * Join single insertions at the same offset into one, for codes that declare
 * `mergeInsertions` — the closers of tags nested inside each other, all
 * missing at one place. As separate fixes they conflict (two insertions at
 * one offset), so Fix-All wrote one closer per pass, outermost first, and
 * stopped at its pass limit with tags still open; written as one, innermost
 * first (`[/i][/b]`), they close every level in one pass.
 *
 * Candidates that do not qualify pass through untouched and in order.
 */
export function mergeInsertionRuns(candidates: readonly FixCandidate[]): FixCandidate[] {
  const out: FixCandidate[] = []
  const groups = new Map<string, FixCandidate[]>()
  for (const c of candidates) {
    const edit = c.edits.length === 1 ? c.edits[0] : null
    const mergeable = edit !== null && edit.start === edit.end &&
      getCodeFixMeta(c.diagnostic.code)?.mergeInsertions === 'innermost-first'
    if (!mergeable) {
      out.push(c)
      continue
    }
    const key = `${c.diagnostic.code}@${edit.start}`
    const group = groups.get(key)
    if (group) group.push(c)
    else {
      const fresh = [c]
      groups.set(key, fresh)
      // Holds the group's place in the output; filled in below.
      out.push({ diagnostic: c.diagnostic, edits: [], count: -1 })
    }
  }
  if (groups.size === 0) return out
  const merged = new Map<Diagnostic, FixCandidate>()
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.set(group[0].diagnostic, group[0])
      continue
    }
    // Innermost first: a tag nested inside another starts after it.
    const ordered = [...group].sort((a, b) => (b.diagnostic.range?.start ?? 0) - (a.diagnostic.range?.start ?? 0))
    const at = ordered[0].edits[0].start
    merged.set(group[0].diagnostic, {
      diagnostic: group[0].diagnostic,
      edits: [{ start: at, end: at, text: ordered.map(c => c.edits[0].text).join('') }],
      count: ordered.reduce((n, c) => n + c.count, 0),
    })
  }
  return out.map(c => (c.count === -1 ? merged.get(c.diagnostic)! : c))
}
