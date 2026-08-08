/**
 * Quasar Analysis Framework — Pipeline Stage
 *
 * Passes are grouped into stages that execute in order:
 *
 *   1. Analysis  — observe the tree, produce Contributions
 *   2. Decision  — consume the AnalysisReport, produce a TransformationPlan
 *   3. Transform — apply the plan to produce a new Green Tree
 *
 * @see Pass
 */

export const PipelineStage = {
  Analysis: 'analysis',
  Decision: 'decision',
  Transform: 'transform',
} as const

export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage]
