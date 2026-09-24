/**
 * Quasar — BBCode Optimizer
 *
 * Parses a document, runs every optimization rule over the tree, arbitrates
 * the edits they produce, and hands back one conflict-free `SurgicalEdit[]`
 * addressed to the ORIGINAL source.
 *
 * That edit set is the optimizer's only output. There is deliberately no
 * "optimized tree" — two appliers consume the edits instead:
 *
 *   in-place →  applySurgicalEdits(result.edits)     (Monaco, one undo stop)
 *   export   →  result.output                        (applyEditsToSource)
 *
 * Keeping a tree optimizer *and* a range optimizer in step forever was the
 * alternative, and it was rejected before the first rule was written. A tree
 * optimizer's output can only reach the document through a whole-document
 * re-export, which silently rewrites spellings the author chose (`[B]`→`[b]`,
 * `\r\n`→`\n`, unclosed tags closed). That is fine for an export and
 * unacceptable for someone's open buffer.
 */

import { parseBBCode } from '../BBCode/Parser'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import type { GreenNode } from '../Syntax/GreenNode'
import { resolveEditConflicts, type PlannedEdit, type ResolvedEditPlan } from './EditPlan'
import { applyEditsToSource } from './applyEdits'
import { composeEditPasses } from './composeEdits'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import type { OptimizationRule } from './Rules/Rule'
import { MergeAdjacentRule } from './Rules/mergeAdjacent'
import { DropEmptyTagsRule } from './Rules/dropEmptyTags'
import { DropRedundantNestingRule } from './Rules/dropRedundantNesting'
import { ShortenHexRule } from './Rules/shortenHex'
import { UnwrapInvisibleColorRule } from './Rules/unwrapInvisibleColor'
import { ReorderWrappersRule } from './Rules/reorderWrappers'

// ── Presets ───────────────────────────────────────────────────────

/**
 * The rules a plain "minify" run applies.
 *
 * Ordered by descending priority, which is also the order in which their
 * regions subsume one another: a merge deletes the delimiters that a hex
 * shortening inside them would have edited.
 *
 * `ReorderWrappersRule` is **not** here. It is a real, tested rule, but it
 * saves exactly zero bytes — it canonicalises nesting order rather than
 * removing anything. A minifier that rewrites someone's document without
 * making it smaller is a diff with no upside, so it is opt-in.
 */
export function defaultRules(): OptimizationRule[] {
  return [
    new MergeAdjacentRule(),
    new DropRedundantNestingRule(),
    new UnwrapInvisibleColorRule(),
    new DropEmptyTagsRule(),
    new ShortenHexRule(),
  ]
}

/** Every rule that exists, including the ones outside the default preset. */
export function allRules(): OptimizationRule[] {
  return [...defaultRules(), new ReorderWrappersRule()]
}

// ── Result ────────────────────────────────────────────────────────

export interface RuleStat {
  readonly ruleId: string
  readonly label: string
  /** Edits this rule contributed to the applied set. */
  readonly edits: number
  /** Characters removed by those edits. Never negative for the shipped rules. */
  readonly savedChars: number
}

export interface OptimizationResult {
  /** The document as given. */
  readonly source: string
  /** Conflict-free, sorted by ascending start. Hand straight to either applier. */
  readonly edits: readonly PlannedEdit[]
  /** Full arbitration record, including what was dropped and why. */
  readonly plan: ResolvedEditPlan
  /** `source` with `edits` applied. */
  readonly output: string
  readonly savedChars: number
  /** Per-rule breakdown of the *applied* edits, in descending saving order. */
  readonly stats: readonly RuleStat[]
}

export interface OptimizeOptions {
  readonly rules?: readonly OptimizationRule[]
  /** Dialect to parse against. Defaults to `'lyne'`, the superset. */
  readonly dialect?: BBCodeDialect
}

// ── Entry points ──────────────────────────────────────────────────

/**
 * Optimize a parsed tree.
 *
 * Prefer this when the caller already holds a green tree — the editor reparses
 * on every keystroke and has no reason to pay for another parse.
 *
 * `root.width` must equal `source.length`; the rules address offsets into that
 * exact string. A mismatch means the tree describes a different document, and
 * every range would land in the wrong place, so it is refused outright.
 */
export function optimizeTree(
  source: string,
  root: GreenNode,
  options: OptimizeOptions = {},
): OptimizationResult {
  if (root.width !== source.length) {
    throw new Error(
      `optimizeTree: tree width ${root.width} does not match source length ${source.length}; ` +
        'the tree must be the parse of exactly this source.',
    )
  }

  const rules = options.rules ?? defaultRules()
  const context = { source, root }

  const proposed: PlannedEdit[] = []
  for (const rule of rules) proposed.push(...rule.run(context))

  const plan = resolveEditConflicts(proposed, source.length)
  const output = applyEditsToSource(source, plan.accepted)

  return {
    source,
    edits: plan.accepted,
    plan,
    output,
    savedChars: source.length - output.length,
    stats: buildStats(plan.accepted, rules),
  }
}

/**
 * Parse `source` and optimize it.
 *
 * Parses straight to the green tree the rules read, not through a
 * `BBCodeDocumentModel`: the model also builds the red tree and its node
 * store, which the rules never touch, and that doubled the cost of every pass
 * (49 ms against 23 ms on the 547 KB fixture). The parse options are the
 * model's defaults, so the tree is the same.
 */
export function optimizeBBCode(source: string, options: OptimizeOptions = {}): OptimizationResult {
  let root: GreenNode | null
  try {
    root = parseBBCode(source, { dialect: options.dialect ?? 'lyne' })
  } catch {
    // The model falls back to one text leaf here, where no rule finds anything.
    root = null
  }

  if (!root) {
    return {
      source,
      edits: [],
      plan: { accepted: [], rejected: [] },
      output: source,
      savedChars: 0,
      stats: [],
    }
  }

  return optimizeTree(source, root, options)
}

/** Result of {@link optimizeBBCodeFully}. */
export interface FixpointOptimizationResult {
  readonly source: string
  readonly output: string
  /**
   * Every applied pass composed into ONE batch addressed to `source` (see
   * `composeEditPasses`). Empty when no pass applied anything. Hand this
   * straight to `applySurgicalEdits` for a single-undo-stop in-place minify —
   * `applyEditsToSource(source, edits) === output`.
   */
  readonly edits: readonly SurgicalEdit[]
  readonly savedChars: number
  /** Per-rule totals summed over every pass, in descending saving order. */
  readonly stats: readonly RuleStat[]
  /** Passes that applied at least one edit. */
  readonly passes: number
}

/**
 * Optimize until a pass finds nothing left to do.
 *
 * One pass is not a fixpoint: edits that overlap are arbitrated and the losers
 * deferred, and removing one tag can expose another (an emptied `[b][/b]`,
 * two now-adjacent identical tags). A single `optimizeBBCode` therefore leaves
 * work that a second call would find.
 *
 * Each pass runs over the previous pass's OUTPUT, so there is no single edit
 * list against the original `source` for free — `edits` is every applied
 * pass folded back into one batch by `composeEditPasses`. That is what lets
 * an open buffer reach the very same fixpoint an export does: apply `edits`
 * as one surgical batch instead of re-exporting the document.
 */
export function optimizeBBCodeFully(
  source: string,
  options: OptimizeOptions = {},
  maxPasses = 8,
): FixpointOptimizationResult {
  const totals = new Map<string, RuleStat>()
  const passEdits: (readonly PlannedEdit[])[] = []
  let output = source
  let passes = 0

  for (let i = 0; i < maxPasses; i++) {
    const pass = optimizeBBCode(output, options)
    if (pass.edits.length === 0) break
    passes++
    output = pass.output
    passEdits.push(pass.edits)
    for (const stat of pass.stats) {
      const prev = totals.get(stat.ruleId)
      totals.set(stat.ruleId, prev
        ? { ...prev, edits: prev.edits + stat.edits, savedChars: prev.savedChars + stat.savedChars }
        : stat)
    }
    // No shortcut on `pass.plan.rejected.length === 0`: an applied edit can
    // cascade (a tag emptied by another edit) with nothing deferred, and the
    // fuzzer catches that case. Only an empty pass proves the fixpoint.
  }

  return {
    source,
    output,
    edits: composeEditPasses(source, passEdits),
    savedChars: source.length - output.length,
    stats: [...totals.values()].sort((a, b) => b.savedChars - a.savedChars || a.ruleId.localeCompare(b.ruleId)),
    passes,
  }
}

// ── Reporting ─────────────────────────────────────────────────────

function buildStats(
  accepted: readonly PlannedEdit[],
  rules: readonly OptimizationRule[],
): RuleStat[] {
  const labels = new Map(rules.map(rule => [rule.id, rule.label]))
  const totals = new Map<string, { edits: number; savedChars: number }>()

  for (const edit of accepted) {
    const entry = totals.get(edit.ruleId) ?? { edits: 0, savedChars: 0 }
    entry.edits++
    entry.savedChars += edit.end - edit.start - edit.text.length
    totals.set(edit.ruleId, entry)
  }

  return [...totals.entries()]
    .map(([ruleId, entry]) => ({
      ruleId,
      label: labels.get(ruleId) ?? ruleId,
      edits: entry.edits,
      savedChars: entry.savedChars,
    }))
    .sort((a, b) => b.savedChars - a.savedChars || a.ruleId.localeCompare(b.ruleId))
}
