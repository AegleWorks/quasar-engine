/**
 * Quasar Lightbulb Engine — BatchFixer (document Fix-All).
 *
 * Applies every fix sharing one `equivalenceKey` as a single batch:
 * filter by key, resolve each diagnostic through its `CodeFixRegistry`
 * provider, sort back-to-front, reject overlaps (edge-touching is legal —
 * ranges are half-open), and hand the batch to `transact()` — the sole edit
 * path. No direct mutation, no per-fix application.
 *
 * Multipass: after each batch the document is re-read and re-analyzed, so a
 * fix that unlocks another is picked up on the next pass. The loop stops when
 * nothing applies, when a source repeats (cycle warning), or after
 * `MAX_FIX_ALL_PASSES` passes (cycle warning). `fixAll` is document-scoped by
 * construction; `fixAllDocuments` is the project/solution entry point and runs
 * the same loop over every target.
 *
 * The target interface keeps the engine headless: the `DocumentModel` entry
 * (transact wiring, re-analyze) lands with the model integration, which feeds
 * this file `getSource`/`getDiagnostics`/`transact`.
 */

import type { Diagnostic, FixOperation } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { getCodeFix } from './CodeFixRegistry'
import { ensureValidatorFixes } from './validatorFixes'
import { AcceptedEdits, mergeInsertionRuns, type FixCandidate } from './fixSet'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { editsConflict } from '../Edits/EditPlan'

export type FixAllScope = 'document' | 'project' | 'solution'

/**
 * Thrown by `fixAll` for a project/solution scope: one `FixAllTarget` is one
 * document, so a wider scope must go through `fixAllDocuments` or `Workspace`.
 */
export class UnimplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnimplementedError'
  }
}

/** Multipass bound: cyclically re-triggering fixes must still terminate. */
export const MAX_FIX_ALL_PASSES = 10

export interface BatchResult {
  /** Diagnostics whose fix was accepted into a batch */
  applied: number
  /** Fixes discarded (intra-fix or cross-fix overlap) */
  deferred: number
  /** Completed transact passes */
  passes: number
  /** Set when the loop stopped on a cycle or the pass bound */
  cycle?: string
  /** Set (with `cycle`) when it was the pass bound: fixes were still pending. */
  passLimit?: true
}

export interface FixAllOptions {
  scope?: FixAllScope
  maxPasses?: number
}

/**
 * What `fixAll` needs from a document. `transact` applies one accepted batch
 * atomically — it is the only way fixes reach the document.
 */
export interface FixAllTarget {
  getSource(): string
  getDiagnostics(): Diagnostic[]
  findNode?(diagnostic: Diagnostic): RedNode | null
  transact(edits: SurgicalEdit[]): void
}

export interface FixAllPlan {
  /** Conflict-free, sorted back-to-front (DESC by start) */
  accepted: SurgicalEdit[]
  applied: number
  deferred: number
}

function toEdits(ops: FixOperation[]): SurgicalEdit[] {
  return fixToSurgicalEdits({ description: '', isAutomatic: false, operations: ops })
}

function isValidEdit(edit: SurgicalEdit, sourceLength: number): boolean {
  return (
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= sourceLength
  )
}

/**
 * The fixes one pass would apply, as groups: each group is one finding's fix,
 * or several findings' insertions merged into one (see `mergeInsertionRuns`).
 * Same-key diagnostics go through their providers, with per-diagnostic
 * atomicity (any internal overlap discards the whole fix), back to front,
 * rejecting cross-fix overlaps.
 */
export function planFixAllGroups(
  source: string,
  diagnostics: readonly Diagnostic[],
  equivalenceKey: string,
  findNode: (diagnostic: Diagnostic) => RedNode | null = () => null,
): { groups: FixCandidate[]; deferred: number } {
  ensureValidatorFixes()
  let deferred = 0

  const candidates: FixCandidate[] = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.equivalenceKey !== equivalenceKey) continue
    const provider = getCodeFix(diagnostic.code)
    if (!provider) continue
    // `node` resolves only if the provider reads it. No built-in does, and
    // resolving it eagerly was a tree search per finding.
    let node: RedNode | null | undefined
    const context = {
      source,
      get node(): RedNode | null {
        if (node === undefined) node = findNode(diagnostic)
        return node
      },
    }
    const ops = provider(diagnostic, context)
    if (ops.length === 0) continue
    const edits = toEdits(ops)
    if (!edits.every((edit) => isValidEdit(edit, source.length))) {
      deferred++
      continue
    }
    // Per-diagnostic atomicity: one internal conflict rejects the whole fix.
    let internal = false
    for (let i = 0; i < edits.length && !internal; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        if (editsConflict(edits[i], edits[j])) {
          internal = true
          break
        }
      }
    }
    if (internal) {
      deferred++
      continue
    }
    candidates.push({ diagnostic, edits, count: 1 })
  }

  const merged = mergeInsertionRuns(candidates)
  // Back-to-front: later offsets win overlaps, earlier ones defer.
  const anchored = merged.map((c) => ({ c, anchor: Math.min(...c.edits.map((edit) => edit.start)) }))
  anchored.sort((a, b) => b.anchor - a.anchor)
  const accepted = new AcceptedEdits()
  const groups: FixCandidate[] = []
  for (const { c } of anchored) {
    if (accepted.conflictsAny(c.edits)) {
      deferred += c.count
      continue
    }
    accepted.add(c.edits)
    groups.push(c)
  }
  return { groups, deferred }
}

/**
 * One pass over the current source: every fix `planFixAllGroups` accepts,
 * flattened back-to-front.
 */
export function planFixAll(
  source: string,
  diagnostics: Diagnostic[],
  equivalenceKey: string,
  findNode: (diagnostic: Diagnostic) => RedNode | null = () => null,
): FixAllPlan {
  const { groups, deferred } = planFixAllGroups(source, diagnostics, equivalenceKey, findNode)
  const accepted: SurgicalEdit[] = []
  let applied = 0
  for (const g of groups) {
    accepted.push(...g.edits)
    applied += g.count
  }
  accepted.sort((a, b) => b.start - a.start || b.end - a.end)
  return { accepted, applied, deferred }
}

function checkDocumentScope(scope: FixAllScope): void {
  if (scope !== 'document') {
    throw new UnimplementedError(
      `Fix-All scope "${scope}" needs more than one document — use fixAllDocuments or Workspace`,
    )
  }
}

/**
 * Document Fix-All: batch every same-key fix through `transact`, re-analyze,
 * repeat up to `maxPasses` (default {@link MAX_FIX_ALL_PASSES}).
 */
export function fixAll(
  target: FixAllTarget,
  equivalenceKey: string,
  options: FixAllOptions = {},
): BatchResult {
  const scope = options.scope ?? 'document'
  checkDocumentScope(scope)
  const maxPasses = options.maxPasses ?? MAX_FIX_ALL_PASSES

  let applied = 0
  let deferred = 0
  let passes = 0
  let cycle: string | undefined
  const seen = new Set<string>([target.getSource()])

  let passLimit = false
  for (;;) {
    const source = target.getSource()
    const plan = planFixAll(
      source,
      target.getDiagnostics(),
      equivalenceKey,
      (diagnostic) => target.findNode?.(diagnostic) ?? null,
    )
    if (plan.accepted.length === 0) {
      deferred += plan.deferred
      break
    }
    // Checked against a real plan, not before one: a run that finished in
    // exactly `maxPasses` passes has nothing pending and must not say so.
    if (passes >= maxPasses) {
      cycle = `Fix-All stopped after ${maxPasses} passes with fixes still pending`
      passLimit = true
      break
    }
    target.transact(plan.accepted)
    passes++
    applied += plan.applied
    deferred += plan.deferred
    const next = target.getSource()
    if (seen.has(next)) {
      cycle = 'Fix-All detected a cycle: a batch reproduced an earlier source'
      break
    }
    seen.add(next)
  }

  if (cycle === undefined) return { applied, deferred, passes }
  return passLimit ? { applied, deferred, passes, cycle, passLimit: true } : { applied, deferred, passes, cycle }
}

/**
 * Fix-All across documents, one document scope each. Aggregates applied and
 * deferred, keeps the deepest pass count, reports the first cycle.
 */
export function fixAllDocuments(
  targets: FixAllTarget[],
  equivalenceKey: string,
  options: FixAllOptions = {},
): BatchResult {
  // A project or solution is a set of documents here (Quasar has no project
  // file), so both scopes run the same aggregation. An empty target list is a
  // valid answer: nothing applied, not an error.
  let applied = 0
  let deferred = 0
  let passes = 0
  let cycle: string | undefined
  for (const target of targets) {
    // Each target is one document; the outer scope is what spans them.
    const result = fixAll(target, equivalenceKey, {
      maxPasses: options.maxPasses,
      scope: 'document',
    })
    applied += result.applied
    deferred += result.deferred
    passes = Math.max(passes, result.passes)
    cycle ??= result.cycle
  }
  return cycle === undefined ? { applied, deferred, passes } : { applied, deferred, passes, cycle }
}
