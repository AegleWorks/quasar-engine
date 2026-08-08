/**
 * Quasar Analysis Framework — Pipeline
 *
 * The Pipeline is itself a Pass — it can be composed inside larger
 * pipelines.  Execution is strictly ordered:
 *
 *   1. All analysis passes run, collecting contributions.
 *   2. The aggregated AnalysisReport is fed to each decision pass.
 *   3. Each transform pass receives the current tree + plan and
 *      returns a new tree (never mutating the original).
 *
 * @example
 * ```ts
 * const pipeline = new Pipeline([
 *   { stage: 'analysis', pass: new CharacterCountAnalyzer() },
 * ])
 * const report = pipeline.run(tree, context)
 * ```
 */

import type { AnalyzerPass, DecisionPass, TransformPass, TransformationPlan } from '../Contracts/Pass'
import type { AnalysisReport } from '../Contracts/AnalysisReport'
import type { PipelineContext } from '../Contracts/PipelineContext'
import type { PipelineStage } from './PipelineStage'
import type { GreenNode } from '../../Syntax/GreenNode'
import type { Contribution } from '../Contracts/Contribution'

interface StageEntry {
  readonly stage: PipelineStage
  readonly pass: AnalyzerPass | DecisionPass | TransformPass
}

export interface PipelineResult {
  /** The final (possibly transformed) Green Tree. */
  readonly tree: GreenNode
  /** The aggregated analysis report. */
  readonly report: AnalysisReport
}

export class Pipeline {
  constructor(private readonly stages: readonly StageEntry[]) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Execute the full pipeline against `tree` with the given `context`.
   *
   * @returns The final tree and analysis report.
   */
  run(tree: GreenNode, context: PipelineContext): PipelineResult {
    const start = performance.now()
    let currentTree = tree
    const allContributions: Contribution[] = []
    let latestPlan: TransformationPlan = { actions: [] }
    const analysisPassCount: number = this.stages.filter(s => s.stage === 'analysis').length

    for (const entry of this.stages) {
      switch (entry.stage) {
        case 'analysis':
          this.runAnalysis(entry.pass as AnalyzerPass, currentTree, context, allContributions)
          break

        case 'decision': {
          const report = this.buildReport(allContributions, analysisPassCount, start)
          latestPlan = this.runDecision(entry.pass as DecisionPass, report, context)
          break
        }

        case 'transform':
          currentTree = this.runTransform(entry.pass as TransformPass, currentTree, latestPlan, context)
          break
      }
    }

    const elapsed = performance.now() - start
    const report = this.buildReport(allContributions, analysisPassCount, elapsed)
    return { tree: currentTree, report }
  }

  /**
   * Use PipelineBuilder to construct a Pipeline:
   *
   * ```ts
   * import { PipelineBuilder } from './PipelineBuilder'
   * const pipeline = new PipelineBuilder()
   *   .analysis(new CharacterCountAnalyzer())
   *   .build()
   * ```
   */

  // ── Internal helpers ────────────────────────────────────────────

  private runAnalysis(
    pass: AnalyzerPass,
    tree: GreenNode,
    context: PipelineContext,
    sink: Contribution[],
  ): void {
    const contributions = pass.run(tree, context)
    for (const c of contributions) {
      sink.push(c)
    }
  }

  private runDecision(
    pass: DecisionPass,
    report: AnalysisReport,
    context: PipelineContext,
  ): TransformationPlan {
    return pass.run(report, context)
  }

  private runTransform(
    pass: TransformPass,
    tree: GreenNode,
    plan: TransformationPlan,
    context: PipelineContext,
  ): GreenNode {
    return pass.run(tree, plan, context)
  }

  private buildReport(
    contributions: Contribution[],
    passCount: number,
    elapsedMs: number,
  ): AnalysisReport {
    return {
      contributions: Object.freeze([...contributions]),
      passCount,
      elapsedMs,
    }
  }
}
