/**
 * Quasar Analysis Framework — Pass Contracts
 *
 * Each pass in the analysis/transform pipeline implements one of these
 * specialized interfaces.  The three kinds mirror LLVM's pass structure:
 *
 *   Analysis  — observe the tree, produce Contributions (never mutate)
 *   Decision  — consume an AnalysisReport, produce a TransformationPlan
 *   Transform — mutate the tree according to a plan
 *
 * @see ARCHITECTURE.md (Analysis Framework)
 */

import type { PipelineContext } from './PipelineContext'
import type { Contribution } from './Contribution'
import type { GreenNode } from '../../Syntax/GreenNode'
import type { AnalysisReport } from './AnalysisReport'

// ── Base ──────────────────────────────────────────────────────────

/** Every pass has an identity string and belongs to a stage. */
export interface Pass {
  readonly id: string
}

// ── Analysis — observe, never mutate ──────────────────────────────

/**
 * An AnalyzerPass observes the Green Tree and produces one or more
 * Contributions.  It MUST NOT mutate the tree or the context.
 */
export interface AnalyzerPass extends Pass {
  run(tree: GreenNode, context: PipelineContext): Contribution[]
}

// ── Decision — plan actions from evidence ─────────────────────────

/**
 * A DecisionPass consumes an AnalysisReport (which itself is the
 * aggregated output of all AnalyzerPasses) and produces a
 * TransformationPlan that describes *intended* tree mutations.
 */
export interface DecisionPass extends Pass {
  run(report: AnalysisReport, context: PipelineContext): TransformationPlan
}

// ── Transform — execute a plan on the tree ────────────────────────

/**
 * A TransformPass receives the current Green Tree together with a
 * TransformationPlan and returns a **new** Green Tree.  It MUST NOT
 * mutate the original tree — immutability guarantees deterministic
 * replay and debugging.
 */
export interface TransformPass extends Pass {
  run(tree: GreenNode, plan: TransformationPlan, context: PipelineContext): GreenNode
}

// ── Supporting types ──────────────────────────────────────────────

/**
 * A single action described by a TransformationPlan.
 * `kind` tells the TransformPass what to do; `payload` carries
 * per-kind parameters.
 */
export interface TransformAction {
  readonly kind: string
  readonly payload: Record<string, unknown>
}

/**
 * Ordered set of actions that a DecisionPass produces.
 */
export interface TransformationPlan {
  readonly actions: readonly TransformAction[]
}
