/**
 * Quasar Analysis Framework — Pipeline Builder
 *
 * Provides a fluent API for assembling a Pipeline from individually
 * registered passes.  Each stage (analysis / decision / transform)
 * has its own registration method so TypeScript catches misuse at
 * compile time.
 *
 * @example
 * ```ts
 * const pipeline = Pipeline
 *   .builder()
 *   .analysis(new CharacterCountAnalyzer())
 *   .decision(new DefaultDecision())
 *   .transform(new CollapseGradientTransform())
 *   .build()
 * ```
 */

import type { AnalyzerPass, DecisionPass, TransformPass } from '../Contracts/Pass'
import type { PipelineStage } from './PipelineStage'
import { Pipeline } from './Pipeline'

export class PipelineBuilder {
  private readonly passes: { stage: PipelineStage; pass: AnalyzerPass | DecisionPass | TransformPass }[] = []

  /** Register one or more AnalyzerPasses (observation stage). */
  analysis(...passes: AnalyzerPass[]): this {
    for (const p of passes) {
      this.passes.push({ stage: 'analysis', pass: p })
    }
    return this
  }

  /** Register one or more DecisionPasses (planning stage). */
  decision(...passes: DecisionPass[]): this {
    for (const p of passes) {
      this.passes.push({ stage: 'decision', pass: p })
    }
    return this
  }

  /** Register one or more TransformPasses (mutation stage). */
  transform(...passes: TransformPass[]): this {
    for (const p of passes) {
      this.passes.push({ stage: 'transform', pass: p })
    }
    return this
  }

  /** Build the Pipeline from the registered passes. */
  build(): Pipeline {
    return new Pipeline([...this.passes])
  }
}
