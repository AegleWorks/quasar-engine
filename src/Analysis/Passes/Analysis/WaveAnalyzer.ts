/**
 * Quasar Analysis Framework — Wave (Size Oscillation) Analyzer
 *
 * Detects sequences of [size=N] tags where the sizes follow a sinusoidal
 * (or other periodic) oscillation pattern — the classic "wave/grow" effect.
 *
 * ## Confidence features
 *
 *   - periodicPattern (+0.35) — sizes follow a clear periodic pattern
 *   - boundedRange (+0.20) — sizes stay within a plausible min-max range
 *   - smoothTransitions (+0.20) — adjacent size differences are small
 *   - contiguousWrappers (+0.15) — no gaps in the size sequence
 *   - noFormattingBreaks (+0.10) — no formatting tags between size nodes
 *
 * @see SemanticContribution
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { extractSize, sigmoid, extractSequences, checkFormattingBreaks } from '../../Utils/color-utils'

// ── Constants ─────────────────────────────────────────────────────

const MIN_SEQUENCE_LENGTH = 5
const SIGMOID_STEEPNESS = 6

const WEIGHTS = {
  periodicPattern: 0.45,
  boundedRange: 0.25,
  smoothTransitions: 0.25,
  noFormattingBreaks: 0.05,
} as const

// ── Types ─────────────────────────────────────────────────────────

export interface WaveModel {
  readonly sizes: number[]
  readonly minSize: number
  readonly maxSize: number
  readonly estimatedFrequency: number
  readonly rangeStart: number
  readonly rangeEnd: number
  readonly charCount: number
  readonly diagnostics: WaveDiagnostics
}

export interface WaveDiagnostics {
  readonly periodicityScore: number      // 0-1, how well it matches a sinusoid
  readonly hasSymmetry: boolean
  readonly isBounded: boolean
  readonly transitionSmoothness: number  // 0-1
  readonly featureScores: Readonly<Record<string, number>>
}

// ── Main Analyzer ─────────────────────────────────────────────────

export class WaveAnalyzer implements AnalyzerPass {
  readonly id = 'wave-analyzer'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.findWaves(tree, contributions)
    return contributions
  }

  private findWaves(node: GreenNode, sink: Contribution[], nodeStart: number = 0): void {
    // Green nodes carry widths, not positions, so a walk that reports source
    // ranges accumulates them on the way down.
    const offsets = childOffsets(node, nodeStart)
    if (node.children.length > 0) {
      const children = node.children as GreenNode[]
      const sequences = extractSequences(children, 'font_size', extractSize)

      for (const seq of sequences) {
        const sizes = seq.values as number[]
        if (sizes.length < MIN_SEQUENCE_LENGTH) continue

        let textLen = 0
        for (let i = seq.startIdx; i < seq.endIdx; i++) {
          for (const child of children[i].children as GreenNode[]) {
            if (child.kind === 'text') textLen += child.text.length
          }
        }

        const hasBreaks = checkFormattingBreaks(children, seq, 'font_size')
        const diag = this.analyzeWave(sizes)
        const { score, featureScores } = this.calculateRawScore(diag, hasBreaks)
        const confidence = sigmoid(score, SIGMOID_STEEPNESS)

        sink.push({
          kind: ContributionKind.Semantic,
          label: 'Wave',
          confidence,
          range: {
            start: offsets[seq.startIdx],
            end: offsets[seq.endIdx],
          },
          metadata: {
            model: {
              sizes,
              minSize: Math.min(...sizes),
              maxSize: Math.max(...sizes),
              estimatedFrequency: diag.periodicityScore,
              charCount: textLen,
            },
            diagnostics: { ...diag, featureScores },
          },
        })
      }
    }

    const kids = node.children as GreenNode[]
    for (let i = 0; i < kids.length; i++) {
      this.findWaves(kids[i], sink, offsets[i])
    }
  }

  // ── Wave Analysis ───────────────────────────────────────────────

  private analyzeWave(sizes: number[]): Omit<WaveDiagnostics, 'featureScores'> {
    const n = sizes.length

    // 1. Detect periodicity: normalise to [0,1] and check correlation with sinusoid
    const min = Math.min(...sizes)
    const max = Math.max(...sizes)
    const range = max - min || 1
    const norm = sizes.map(s => (s - min) / range)

    // Try multiple frequencies, pick the best match
    let bestCorrelation = 0
    for (let freq = 0.5; freq <= 4; freq += 0.25) {
      let correlation = 0
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1 || 1)
        const sinVal = (Math.sin(t * Math.PI * 2 * freq) + 1) / 2
        correlation += 1 - Math.abs(norm[i] - sinVal)
      }
      correlation /= n
      bestCorrelation = Math.max(bestCorrelation, correlation)
    }

    const periodicityScore = Math.max(0, Math.min(1, bestCorrelation))

    // 2. Check symmetry: is the first half a mirror of the second half?
    let symmetry = 0
    for (let i = 0; i < Math.floor(n / 2); i++) {
      const j = n - 1 - i
      symmetry += 1 - Math.abs(norm[i] - norm[j]) / (range || 1)
    }
    const hasSymmetry = symmetry / Math.max(1, Math.floor(n / 2)) > 0.7

    // 3. Bounded range: are min and max within a sensible range?
    const isBounded = min >= 50 && max <= 250 && range >= 20

    // 4. Transition smoothness: are adjacent sizes close?
    let smoothness = 0
    for (let i = 1; i < n; i++) {
      const diff = Math.abs(sizes[i] - sizes[i - 1])
      smoothness += 1 - Math.min(1, diff / (range || 1))
    }
    const transitionSmoothness = smoothness / Math.max(1, n - 1)

    return {
      periodicityScore,
      hasSymmetry,
      isBounded,
      transitionSmoothness,
    }
  }

  // ── Confidence Scoring ──────────────────────────────────────────

  private calculateRawScore(
    diag: Omit<WaveDiagnostics, 'featureScores'>,
    hasBreaks: boolean,
  ): { score: number; featureScores: Record<string, number> } {
    let score = 0

    // Periodicity
    if (diag.periodicityScore > 0.7) score += WEIGHTS.periodicPattern
    else if (diag.periodicityScore > 0.4) score += WEIGHTS.periodicPattern * 0.5
    else score -= WEIGHTS.periodicPattern * 0.5

    // Bounded range
    if (diag.isBounded) score += WEIGHTS.boundedRange
    else score -= WEIGHTS.boundedRange * 0.5

    // Smooth transitions
    if (diag.transitionSmoothness > 0.6) score += WEIGHTS.smoothTransitions
    else if (diag.transitionSmoothness > 0.3) score += WEIGHTS.smoothTransitions * 0.5
    else score -= WEIGHTS.smoothTransitions * 0.5

    // No formatting breaks
    if (!hasBreaks) score += WEIGHTS.noFormattingBreaks

    const featureScores = {
      periodicPattern: diag.periodicityScore > 0.7 ? WEIGHTS.periodicPattern :
                        diag.periodicityScore > 0.4 ? WEIGHTS.periodicPattern * 0.5 : -WEIGHTS.periodicPattern * 0.5,
      boundedRange: diag.isBounded ? WEIGHTS.boundedRange : -WEIGHTS.boundedRange * 0.5,
      smoothTransitions: diag.transitionSmoothness > 0.6 ? WEIGHTS.smoothTransitions :
                         diag.transitionSmoothness > 0.3 ? WEIGHTS.smoothTransitions * 0.5 : -WEIGHTS.smoothTransitions * 0.5,
      noFormattingBreaks: hasBreaks ? -WEIGHTS.noFormattingBreaks : WEIGHTS.noFormattingBreaks,
    }

    return { score, featureScores }
  }
}
