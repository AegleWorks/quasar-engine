/**
 * Quasar Analysis Framework — Gradient Analyzer (v2)
 *
 * Detects sequences of [color=#HEX] tags that form a gradient pattern
 * and reports them as SemanticContributions with a confidence score.
 *
 * ## Refinements over v1
 *
 * 1. **OKLab color space** — Uses OKLab (Bottosson 2020) for perceptual
 *    colour distance instead of RGB.  Two colours with small OKLab distance
 *    look nearly identical to the human eye, making gradient detection
 *    much more accurate.
 *
 * 2. **Change-point detection** — Identifies gradient *stops* even when
 *    plateaus (runs of identical colour) exist, so a sequence like
 *    RRRR→G→BBBB is correctly parsed as a 3-stop gradient rather than
 *    a failed linear interpolation.
 *
 * 3. **Sharper sigmoid (k=6)** — Better separation between "likely
 *    gradient" and "maybe gradient" at the decision thresholds.
 *
 * ## Confidence features (weights sum to 1.0)
 *
 *   - uniformPerceptualSpacing  (+0.30)
 *   - contiguousWrappers        (+0.25)
 *   - noFormattingBreaks        (+0.15)
 *   - monotonicProgression      (+0.20)
 *   - lowPerceptualError        (+0.10)
 *
 * @see SemanticContribution
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { hexToOklab, mixHexOklab, perceptualDistance, hexToRgb } from '../../../Utils/ColorMath'
import { extractHex, sigmoid, extractSequences, checkFormattingBreaks } from '../../Utils/color-utils'

// ── Constants ─────────────────────────────────────────────────────

const MIN_SEQUENCE_LENGTH = 3
const SIGMOID_STEEPNESS = 6

const WEIGHTS = {
  uniformPerceptualSpacing: 0.30,
  contiguousWrappers: 0.25,
  noFormattingBreaks: 0.15,
  monotonicProgression: 0.20,
  lowPerceptualError: 0.10,
} as const

// ── Types ─────────────────────────────────────────────────────────

export interface GradientModel {
  readonly colors: string[]
  readonly easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  readonly stops: GradientStop[]
  readonly rangeStart: number
  readonly rangeEnd: number
  readonly charCount: number
  readonly diagnostics: GradientDiagnostics
}

export interface GradientStop {
  /** Hex colour at this stop */
  readonly color: string
  /** Normalised position 0-1 */
  readonly position: number
}

export interface GradientDiagnostics {
  readonly uniformSpacing: boolean
  readonly monotonic: boolean
  readonly plateauCount: number
  readonly maxPerceptualError: number
  readonly stopCount: number
  readonly featureScores: Readonly<Record<string, number>>
}

// ── Main Analyzer ─────────────────────────────────────────────────

export class GradientAnalyzer implements AnalyzerPass {
  readonly id = 'gradient-analyzer'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.findGradients(tree, contributions)
    return contributions
  }

  // ── Sequence Detection ──────────────────────────────────────────

  private findGradients(node: GreenNode, sink: Contribution[], nodeStart: number = 0): void {
    // Green nodes carry widths, not positions, so a walk that reports source
    // ranges accumulates them on the way down.
    const offsets = childOffsets(node, nodeStart)
    if (node.children.length > 0) {
      const children = node.children as GreenNode[]
      const sequences = extractSequences(children, 'color', extractHex)

      for (const seq of sequences) {
        const colors = seq.values as string[]
        if (colors.length < MIN_SEQUENCE_LENGTH) continue

        // Sum text length in the sequence
        let textLen = 0
        for (let i = seq.startIdx; i < seq.endIdx; i++) {
          for (const child of children[i].children as GreenNode[]) {
            if (child.kind === 'text') textLen += child.text.length
          }
        }

        const hasBreaks = checkFormattingBreaks(children, seq, 'color')
        const { stops, easing } = this.detectStops(colors)
        const diag = this.buildDiagnostics(colors, stops)
        const { score: rawScore, featureScores } = this.calculateRawScore(diag, hasBreaks)
        const confidence = sigmoid(rawScore, SIGMOID_STEEPNESS)

        sink.push({
          kind: ContributionKind.Semantic,
          label: 'Gradient',
          confidence,
          range: {
            start: offsets[seq.startIdx],
            end: offsets[seq.endIdx],
          },
          metadata: {
            model: { colors, easing, stops, charCount: textLen },
            diagnostics: { ...diag, featureScores },
          },
        })
      }
    }

    const kids = node.children as GreenNode[]
    for (let i = 0; i < kids.length; i++) {
      this.findGradients(kids[i], sink, offsets[i])
    }
  }

  // ── Change-point Detection ──────────────────────────────────────

  /**
   * Detect gradient stops from a sequence of hex colours, handling plateaus.
   *
   * Algorithm: Scan for "significant changes" in perceptual distance.
   * Wherever the cumulative perceptual distance from the last stop exceeds a
   * threshold, a new stop is recorded.  This naturally skips over plateaus.
   */
  private detectStops(colors: string[]): { stops: GradientStop[]; easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' } {
    const n = colors.length
    const stops: GradientStop[] = [{ color: colors[0], position: 0 }]

    const totalDist = perceptualDistance(colors[0], colors[n - 1])
    const minStep = totalDist * 0.08  // At least 8% of total range
    let accumulated = 0

    for (let i = 1; i < n; i++) {
      const dist = perceptualDistance(colors[i - 1], colors[i])
      accumulated += dist
      if (accumulated >= minStep && i < n - 1) {
        stops.push({ color: colors[i], position: i / (n - 1) })
        accumulated = 0
      }
    }

    // Always include the last colour
    if (stops[stops.length - 1].position < 1) {
      stops.push({ color: colors[n - 1], position: 1 })
    }

    // Infer easing from change in perceptual distance across segments
    let easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' = 'linear'
    if (stops.length >= 3) {
      const segDists: number[] = []
      for (let i = 1; i < stops.length; i++) {
        const segLen = stops[i].position - stops[i - 1].position
        const segDist = perceptualDistance(stops[i - 1].color, stops[i].color)
        segDists.push(segLen > 0 ? segDist / segLen : 0)
      }

      const earlyAvg = segDists.slice(0, Math.ceil(segDists.length / 3)).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(segDists.length / 3))
      const lateAvg = segDists.slice(-Math.ceil(segDists.length / 3)).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(segDists.length / 3))

      if (earlyAvg > lateAvg * 1.5) easing = 'easeIn'
      else if (lateAvg > earlyAvg * 1.5) easing = 'easeOut'
      else if (segDists.length >= 3) {
        const midStart = Math.floor(segDists.length / 3)
        const midEnd = Math.floor(2 * segDists.length / 3)
        const midAvg = segDists.slice(midStart, midEnd).reduce((a, b) => a + b, 0) / (midEnd - midStart)
        const edgeAvg = [...segDists.slice(0, midStart), ...segDists.slice(midEnd)].reduce((a, b) => a + b, 0) / Math.max(1, segDists.length - (midEnd - midStart))
        if (midAvg > edgeAvg * 1.3) easing = 'easeInOut'
      }
    }

    return { stops, easing }
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  private buildDiagnostics(
    colors: string[],
    stops: GradientStop[],
  ): Omit<GradientDiagnostics, 'featureScores'> {
    const n = colors.length
    const oklabArray = colors.map(c => hexToOklab(c))

    // 1. Uniform perceptual spacing
    const pDiffs: number[] = []
    for (let i = 1; i < n; i++) {
      pDiffs.push(perceptualDistance(colors[i - 1], colors[i]))
    }
    const avgDiff = pDiffs.reduce((a, b) => a + b, 0) / pDiffs.length
    const diffVariance = pDiffs.reduce((sum, d) => sum + (d - avgDiff) ** 2, 0) / pDiffs.length
    const uniformSpacing = diffVariance < 0.001  // Tiny variance in perceptual space

    // 2. Check monotonic: does each OKLab dimension change in one direction?
    const first = oklabArray[0]
    const last = oklabArray[n - 1]
    const lDir = Math.sign(last[0] - first[0])
    const aDir = Math.sign(last[1] - first[1])
    const bDir = Math.sign(last[2] - first[2])

    let violations = 0
    for (let i = 1; i < n; i++) {
      const curr = oklabArray[i]
      const prev = oklabArray[i - 1]
      if (lDir !== 0 && Math.sign(curr[0] - prev[0]) !== lDir && Math.abs(curr[0] - prev[0]) > 0.005) violations++
      if (aDir !== 0 && Math.sign(curr[1] - prev[1]) !== aDir && Math.abs(curr[1] - prev[1]) > 0.005) violations++
      if (bDir !== 0 && Math.sign(curr[2] - prev[2]) !== bDir && Math.abs(curr[2] - prev[2]) > 0.005) violations++
    }
    const monotonic = violations < n * 0.2

    // 3. Count plateaus (consecutive perceptually identical colours)
    let plateauCount = 0
    for (let i = 1; i < n; i++) {
      if (perceptualDistance(colors[i - 1], colors[i]) < 0.01) plateauCount++
    }

    // 4. Perceptual error vs ideal OKLab interpolation
    let maxPerceptualError = 0
    if (n >= 3 && stops.length >= 2) {
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0
        const ideal = mixHexOklab(stops[0].color, stops[stops.length - 1].color, t)
        const error = perceptualDistance(ideal, colors[i])
        maxPerceptualError = Math.max(maxPerceptualError, error)
      }
    }

    return { uniformSpacing, monotonic, plateauCount, maxPerceptualError, stopCount: stops.length }
  }

  // ── Confidence Scoring ──────────────────────────────────────────

  private calculateRawScore(
    diag: Omit<GradientDiagnostics, 'featureScores'>,
    hasBreaks: boolean,
  ): { score: number; featureScores: Record<string, number> } {
    let score = 0

    if (diag.uniformSpacing) score += WEIGHTS.uniformPerceptualSpacing
    else score -= WEIGHTS.uniformPerceptualSpacing * 0.5

    score += WEIGHTS.contiguousWrappers

    if (!hasBreaks) score += WEIGHTS.noFormattingBreaks

    if (diag.monotonic) score += WEIGHTS.monotonicProgression
    else score -= WEIGHTS.monotonicProgression * 0.3

    if (diag.maxPerceptualError < 0.02) score += WEIGHTS.lowPerceptualError
    else if (diag.maxPerceptualError < 0.05) score += WEIGHTS.lowPerceptualError * 0.5
    else {
      const penalty = WEIGHTS.lowPerceptualError * Math.min(diag.maxPerceptualError * 20, 5)
      score -= penalty
    }

    const featureScores = {
      uniformPerceptualSpacing: diag.uniformSpacing ? WEIGHTS.uniformPerceptualSpacing : -WEIGHTS.uniformPerceptualSpacing * 0.5,
      contiguousWrappers: WEIGHTS.contiguousWrappers,
      noFormattingBreaks: hasBreaks ? -WEIGHTS.noFormattingBreaks : WEIGHTS.noFormattingBreaks,
      monotonicProgression: diag.monotonic ? WEIGHTS.monotonicProgression : -WEIGHTS.monotonicProgression * 0.3,
      lowPerceptualError: diag.maxPerceptualError < 0.05 ? WEIGHTS.lowPerceptualError : -WEIGHTS.lowPerceptualError * 0.5,
    }

    return { score, featureScores }
  }
}
