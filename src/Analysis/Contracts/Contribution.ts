/**
 * Quasar Analysis Framework — Contribution Types
 *
 * Every AnalyzerPass produces an array of Contributions.  A Contribution
 * is a discriminated union so that downstream consumers (DecisionPass,
 * AnalysisReport consumers, debug UI) can switch on `kind` and get
 * perfect TypeScript narrowing.
 *
 * @see AnalysisReport
 */

// ── Kind enum ─────────────────────────────────────────────────────

export const ContributionKind = {
  Semantic: 'semantic',
  Diagnostic: 'diagnostic',
  Optimization: 'optimization',
  Metrics: 'metrics',
} as const

export type ContributionKind = (typeof ContributionKind)[keyof typeof ContributionKind]

// ── Individual contribution shapes ────────────────────────────────

/**
 * A semantic pattern recognised in the tree (gradient, wave, rainbow,…).
 * These describe *meaning* of the document, not just surface syntax.
 */
export interface SemanticContribution {
  readonly kind: typeof ContributionKind.Semantic
  readonly label: string
  readonly confidence: number       // 0-1
  readonly range: { start: number; end: number }
  readonly metadata: Record<string, unknown>
  /** Human-readable description (optional). */
  readonly description?: string
}

/**
 * A diagnostic (warning, error, info) attached to a range in the tree.
 */
export interface DiagnosticContribution {
  readonly kind: typeof ContributionKind.Diagnostic
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message: string
  readonly range?: { start: number; end: number }
  readonly code?: string
}

/**
 * An optimisation opportunity detected in the tree (mergeable colours,
 * redundant wrapping, empty tags, …).
 */
export interface OptimizationContribution {
  readonly kind: typeof ContributionKind.Optimization
  readonly label: string
  readonly description: string
  readonly estimatedImprovement?: string
  readonly range: { start: number; end: number }
}

/**
 * Aggregate metrics about the tree (character count, node depth, …).
 */
export interface MetricsContribution {
  readonly kind: typeof ContributionKind.Metrics
  readonly metrics: Record<string, number | string>
}

// ── Discriminated union ───────────────────────────────────────────

export type Contribution =
  | SemanticContribution
  | DiagnosticContribution
  | OptimizationContribution
  | MetricsContribution
