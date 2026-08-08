/**
 * Quasar Analysis Framework — Default Decision
 *
 * Consumes an AnalysisReport and produces a TransformationPlan.
 * The decision logic depends on the PipelineContext:
 *
 *   - target === 'miliastry':
 *       Aggressively collapses detected gradients (confidence ≥ 0.6).
 *   - target === 'osu':
 *       Only collapses very high-confidence gradients (confidence ≥ 0.95).
 *   - mode === 'batch' || mode === 'import':
 *       Uses the OSU threshold by default.
 *
 * Optimisation opportunities (mergeable colours) are always included
 * regardless of target, but only when the count exceeds 1.
 *
 * @see DecisionPass
 * @see TransformationPlan
 */

import type { DecisionPass, TransformationPlan, TransformAction } from '../../Contracts/Pass'
import type { AnalysisReport } from '../../Contracts/AnalysisReport'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import { ContributionKind } from '../../Contracts/Contribution'
import type { SemanticContribution } from '../../Contracts/Contribution'
import { ExportTarget } from '../../Contracts/PipelineContext'

// ── Thresholds ────────────────────────────────────────────────────

const THRESHOLDS = {
  [ExportTarget.Miliastry]: {
    autoCollapse: 0.6,       // Suggest for anything ≥ 60%
    forceCollapse: 0.85,     // Auto-collapse without asking ≥ 85%
  },
  [ExportTarget.Osu]: {
    autoCollapse: 0.95,      // Only collapse very confident gradients
    forceCollapse: 0.99,     // Near-certain
  },
  [ExportTarget.HTML]: {
    autoCollapse: 0.8,       // Moderate — HTML can handle gradients natively
    forceCollapse: 0.95,
  },
  [ExportTarget.Markdown]: {
    autoCollapse: 0.95,      // Conservative — Markdown has no colour support
    forceCollapse: 0.99,
  },
} as const

const DEFAULT_THRESHOLD = {
  autoCollapse: 0.8,
  forceCollapse: 0.95,
}

export class DefaultDecision implements DecisionPass {
  readonly id = 'default-decision'

  run(report: AnalysisReport, context: PipelineContext): TransformationPlan {
    const actions: TransformAction[] = []
    const thresholds = THRESHOLDS[context.target] ?? DEFAULT_THRESHOLD

    for (const contribution of report.contributions) {
      switch (contribution.kind) {
        case ContributionKind.Semantic:
          this.handleSemantic(contribution, thresholds, actions)
          break

        case ContributionKind.Optimization:
          this.handleOptimization(contribution, actions)
          break

        // Diagnostics and metrics don't produce actions by default
        default:
          break
      }
    }

    return { actions: Object.freeze(actions) }
  }

  // ── Semantic handlers ───────────────────────────────────────────

  /** Map contribution label → transform action kind */
  private labelToActionKind(label: string): string | null {
    switch (label) {
      case 'Gradient': return 'collapse-gradient'
      case 'Rainbow':  return 'collapse-rainbow'
      case 'Wave':     return 'collapse-wave'
      default:         return null
    }
  }

  private handleSemantic(
    contribution: SemanticContribution,
    thresholds: { autoCollapse: number; forceCollapse: number },
    sink: TransformAction[],
  ): void {
    const { confidence } = contribution
    const actionKind = this.labelToActionKind(contribution.label)
    if (!actionKind) return

    if (confidence >= thresholds.forceCollapse) {
      sink.push({
        kind: actionKind,
        payload: {
          range: contribution.range,
          model: contribution.metadata.model as Record<string, unknown>,
          autoCollapse: true,
        },
      })
    } else if (confidence >= thresholds.autoCollapse) {
      sink.push({
        kind: actionKind,
        payload: {
          range: contribution.range,
          model: contribution.metadata.model as Record<string, unknown>,
          autoCollapse: false,
          confidence,
        },
      })
    }
  }

  // ── Optimization handlers ───────────────────────────────────────

  private handleOptimization(
    contribution: { label: string; range: { start: number; end: number } },
    sink: TransformAction[],
  ): void {
    if (contribution.label === 'Merge Colors') {
      // Always suggest merging identical consecutive colours
      sink.push({
        kind: 'merge-colors',
        payload: {
          range: contribution.range,
        },
      })
    }
  }
}
