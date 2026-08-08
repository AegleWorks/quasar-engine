/**
 * Quasar Analysis Framework — Analysis Report
 *
 * Once all AnalyzerPasses have run, their Contributions are collected
 * into an immutable AnalysisReport.  This report is the sole input to
 * the DecisionPass(es).
 *
 * We deliberately keep the aggregator simple for now — just an array
 * of contributions.  As more pass types emerge we may introduce a
 * structured Aggregator that indexes/categorises contributions.
 *
 * @see DecisionPass
 */

import type { Contribution } from './Contribution'

export interface AnalysisReport {
  /** All contributions gathered from every AnalyzerPass. */
  readonly contributions: readonly Contribution[]

  /** Total number of analysis passes that ran. */
  readonly passCount: number

  /** Wall-clock time spent in analysis (ms). */
  readonly elapsedMs: number
}
