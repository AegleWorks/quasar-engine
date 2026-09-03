/**
 * Quasar Analysis Framework — Public API
 *
 * A pipeline-based analysis and transformation engine for Green Trees.
 *
 * @module
 * @see Analysis/ARCHITECTURE.md (planned)
 */

// ── Contracts ─────────────────────────────────────────────────────
export type { Pass } from './Contracts/Pass'
export type { AnalyzerPass, DecisionPass, TransformPass } from './Contracts/Pass'
export type { TransformationPlan, TransformAction } from './Contracts/Pass'

export type { Contribution } from './Contracts/Contribution'
export type {
  SemanticContribution,
  DiagnosticContribution,
  OptimizationContribution,
  MetricsContribution,
} from './Contracts/Contribution'
export { ContributionKind } from './Contracts/Contribution'

export type { AnalysisReport } from './Contracts/AnalysisReport'

export type { PipelineContext } from './Contracts/PipelineContext'
export { PipelineMode, ExportTarget } from './Contracts/PipelineContext'

// ── Pipeline ──────────────────────────────────────────────────────
export { Pipeline } from './Pipeline/Pipeline'
export type { PipelineResult } from './Pipeline/Pipeline'
export { PipelineBuilder } from './Pipeline/PipelineBuilder'
export { PipelineStage } from './Pipeline/PipelineStage'

// ── Analysis Passes ───────────────────────────────────────────────
export { CharacterCountAnalyzer } from './Passes/Utility/CharacterCountAnalyzer'
export { MergeableColorAnalyzer } from './Passes/Analysis/MergeableColorAnalyzer'
export { GradientAnalyzer, findCollapsibleGradients, formatGradientTag } from './Passes/Analysis/GradientAnalyzer'
export type { GradientModel, GradientDiagnostics, GradientStop, CollapsibleGradient } from './Passes/Analysis/GradientAnalyzer'
export { RainbowAnalyzer } from './Passes/Analysis/RainbowAnalyzer'
export type { RainbowModel, RainbowDiagnostics } from './Passes/Analysis/RainbowAnalyzer'
export { WaveAnalyzer } from './Passes/Analysis/WaveAnalyzer'
export type { WaveModel, WaveDiagnostics } from './Passes/Analysis/WaveAnalyzer'
export { SymbolAnalyzer } from './Passes/Analysis/SymbolAnalyzer'
export type { SymbolGlyph, SymbolRunModel } from './Passes/Analysis/SymbolAnalyzer'
export { ColorUsageAnalyzer } from './Passes/Analysis/ColorUsageAnalyzer'
export type { ColorUsageModel } from './Passes/Analysis/ColorUsageAnalyzer'

// ── Decision Passes ───────────────────────────────────────────────
export { DefaultDecision } from './Passes/Decision/DefaultDecision'
export { PaletteRemapDecision } from './Passes/Decision/PaletteRemapDecision'
export type { Palette, PaletteRemapOptions, RemapAction } from './Passes/Decision/PaletteRemapDecision'

// ── Transform Passes ──────────────────────────────────────────────
export { CollapseGradientTransform } from './Passes/Transform/CollapseGradientTransform'
export { RainbowCollapseTransform } from './Passes/Transform/RainbowCollapseTransform'
export { WaveCollapseTransform } from './Passes/Transform/WaveCollapseTransform'
export { MergeColorsTransform } from './Passes/Transform/MergeColorsTransform'
