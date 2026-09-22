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
 * `MAX_FIX_ALL_PASSES` passes (cycle warning). Only `document` scope exists;
 * `project`/`solution` throw `UnimplementedError`.
 *
 * The target interface keeps the engine headless: the `DocumentModel` entry
 * (transact wiring, re-analyze) lands with the model integration, which feeds
 * this file `getSource`/`getDiagnostics`/`transact`.
 */

import type { Diagnostic, FixOperation } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { getCodeFix } from './CodeFixRegistry'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { editsConflict } from '../Edits/EditPlan'

export type FixAllScope = 'document' | 'project' | 'solution'

/** Thrown for the `project`/`solution` Fix-All scopes, which are stubbed out. */
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
 * One pass over the current source: same-key diagnostics through their
 * providers, per-diagnostic atomicity (any internal overlap discards the
 * whole fix), DESC order with cross-fix overlap rejection.
 */
export function planFixAll(
  source: string,
  diagnostics: Diagnostic[],
  equivalenceKey: string,
  findNode: (diagnostic: Diagnostic) => RedNode | null = () => null,
): FixAllPlan {
  const accepted: SurgicalEdit[] = []
  let applied = 0
  let deferred = 0

  const candidates: { edits: SurgicalEdit[]; anchor: number }[] = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.equivalenceKey !== equivalenceKey) continue
    const provider = getCodeFix(diagnostic.code)
    if (!provider) continue
    const ops = provider(diagnostic, { source, node: findNode(diagnostic) })
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
    candidates.push({
      edits,
      anchor: Math.min(...edits.map((edit) => edit.start)),
    })
  }

  // Back-to-front: later offsets win overlaps, earlier ones defer.
  candidates.sort((a, b) => b.anchor - a.anchor)
  for (const { edits } of candidates) {
    if (edits.some((edit) => accepted.some((kept) => editsConflict(kept, edit)))) {
      deferred++
      continue
    }
    accepted.push(...edits)
    applied++
  }
  accepted.sort((a, b) => b.start - a.start || b.end - a.end)
  return { accepted, applied, deferred }
}

function checkScope(scope: FixAllScope): void {
  if (scope !== 'document') {
    throw new UnimplementedError(
      `Fix-All scope "${scope}" is not implemented — only "document" is supported`,
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
  checkScope(scope)
  const maxPasses = options.maxPasses ?? MAX_FIX_ALL_PASSES

  let applied = 0
  let deferred = 0
  let passes = 0
  let cycle: string | undefined
  const seen = new Set<string>([target.getSource()])

  for (;;) {
    if (passes >= maxPasses) {
      cycle = `Fix-All stopped after ${maxPasses} passes with fixes still pending`
      break
    }
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

  return cycle === undefined ? { applied, deferred, passes } : { applied, deferred, passes, cycle }
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
  checkScope(options.scope ?? 'document')
  let applied = 0
  let deferred = 0
  let passes = 0
  let cycle: string | undefined
  for (const target of targets) {
    const result = fixAll(target, equivalenceKey, options)
    applied += result.applied
    deferred += result.deferred
    passes = Math.max(passes, result.passes)
    cycle ??= result.cycle
  }
  return cycle === undefined ? { applied, deferred, passes } : { applied, deferred, passes, cycle }
}
