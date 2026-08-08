/**
 * Quasar Analysis Framework — Rainbow Analyzer
 *
 * Detects sequences of [color=#HEX] tags where the HSL hue rotates
 * continuously while saturation and lightness remain approximately
 * constant — the classic "rainbow" pattern.
 *
 * ## Confidence features
 *
 *   - hueRotation (+0.35) — hue changes monotonically (increasing or decreasing)
 *   - stableSaturation (+0.20) — saturation stays within a narrow band
 *   - stableLightness (+0.20) — lightness stays within a narrow band
 *   - contiguousWrappers (+0.15) — no gaps in the colour sequence
 *   - noFormattingBreaks (+0.10) — no formatting tags between colours
 *
 * @see SemanticContribution
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { hexToHsl } from '../../../Utils/ColorMath'
import { extractHex, sigmoid, extractSequences, checkFormattingBreaks } from '../../Utils/color-utils'

// ── Constants ─────────────────────────────────────────────────────

const MIN_SEQUENCE_LENGTH = 4
const SIGMOID_STEEPNESS = 6

const WEIGHTS = {
  hueRotation: 0.50,
  stableSaturation: 0.25,
  stableLightness: 0.20,
  noFormattingBreaks: 0.05,
} as const

// ── Types ─────────────────────────────────────────────────────────

export interface RainbowModel {
  readonly colors: string[]
  readonly hueStart: number
  readonly hueEnd: number
  readonly avgSaturation: number
  readonly avgLightness: number
  readonly rangeStart: number
  readonly rangeEnd: number
  readonly charCount: number
  readonly diagnostics: RainbowDiagnostics
}

export interface RainbowDiagnostics {
  readonly hueDelta: number
  readonly saturationDeviation: number
  readonly lightnessDeviation: number
  readonly isContinuous: boolean
  readonly featureScores: Readonly<Record<string, number>>
}

// ── Main Analyzer ─────────────────────────────────────────────────

export class RainbowAnalyzer implements AnalyzerPass {
  readonly id = 'rainbow-analyzer'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.findRainbows(tree, contributions)
    return contributions
  }

  private findRainbows(node: GreenNode, sink: Contribution[], nodeStart: number = 0): void {
    // Green nodes carry widths, not positions, so a walk that reports source
    // ranges accumulates them on the way down.
    const offsets = childOffsets(node, nodeStart)
    if (node.children.length > 0) {
      const children = node.children as GreenNode[]
      const sequences = extractSequences(children, 'color', extractHex)

      for (const seq of sequences) {
        const colors = seq.values as string[]
        if (colors.length < MIN_SEQUENCE_LENGTH) continue

        let textLen = 0
        for (let i = seq.startIdx; i < seq.endIdx; i++) {
          for (const child of children[i].children as GreenNode[]) {
            if (child.kind === 'text') textLen += child.text.length
          }
        }

        const hasBreaks = checkFormattingBreaks(children, seq, 'color')
        const diag = this.analyzeRainbow(colors)
        const { score, featureScores } = this.calculateRawScore(diag, hasBreaks)
        const confidence = sigmoid(score, SIGMOID_STEEPNESS)

        sink.push({
          kind: ContributionKind.Semantic,
          label: 'Rainbow',
          confidence,
          range: {
            start: offsets[seq.startIdx],
            end: offsets[seq.endIdx],
          },
          metadata: {
            model: {
              colors,
              hueStart: diag.hueDelta >= 0 ? colors[0] : colors[colors.length - 1],
              hueEnd: diag.hueDelta >= 0 ? colors[colors.length - 1] : colors[0],
              avgSaturation: this.extractHSL(colors).avgS,
              avgLightness: this.extractHSL(colors).avgL,
              charCount: textLen,
            },
            diagnostics: { ...diag, featureScores },
          },
        })
      }
    }

    const kids = node.children as GreenNode[]
    for (let i = 0; i < kids.length; i++) {
      this.findRainbows(kids[i], sink, offsets[i])
    }
  }

  // ── HSL Analysis ────────────────────────────────────────────────

  private extractHSL(colors: string[]): { hues: number[]; sats: number[]; lights: number[]; avgS: number; avgL: number } {
    const hues: number[] = []
    const sats: number[] = []
    const lights: number[] = []

    for (const c of colors) {
      const [h, s, l] = hexToHsl(c)
      hues.push(h)
      sats.push(s)
      lights.push(l)
    }

    const avgS = sats.reduce((a, b) => a + b, 0) / sats.length
    const avgL = lights.reduce((a, b) => a + b, 0) / lights.length

    return { hues, sats, lights, avgS, avgL }
  }

  private analyzeRainbow(colors: string[]): Omit<RainbowDiagnostics, 'featureScores'> {
    const { hues, sats, lights, avgS, avgL } = this.extractHSL(colors)
    const n = colors.length

    // 1. Hue rotation: compute signed delta, unwrapping at 360→0
    let totalHueDelta = 0
    let unwrapped = hues[0]
    for (let i = 1; i < n; i++) {
      let delta = hues[i] - hues[i - 1]
      if (delta > 180) delta -= 360
      else if (delta < -180) delta += 360
      totalHueDelta += delta
      unwrapped += delta
    }

    // Reset to compute direction from unwrapped
    const hueDirection = Math.sign(totalHueDelta)

    // Check hue monotonicity (after unwrapping)
    let hueViolations = 0
    unwrapped = hues[0]
    for (let i = 1; i < n; i++) {
      let delta = hues[i] - hues[i - 1]
      if (delta > 180) delta -= 360
      else if (delta < -180) delta += 360
      unwrapped += delta

      const prevUnwrapped = unwrapped - delta
      if (Math.sign(delta) !== hueDirection && Math.abs(delta) > 15) {
        hueViolations++
      }
    }
    const isContinuous = hueViolations < n * 0.25

    // 2. Saturation stability (standard deviation)
    const satDev = Math.sqrt(sats.reduce((sum, s) => sum + (s - avgS) ** 2, 0) / n)

    // 3. Lightness stability (standard deviation)
    const litDev = Math.sqrt(lights.reduce((sum, l) => sum + (l - avgL) ** 2, 0) / n)

    return {
      hueDelta: totalHueDelta,
      saturationDeviation: satDev,
      lightnessDeviation: litDev,
      isContinuous,
    }
  }

  // ── Confidence Scoring ──────────────────────────────────────────

  private calculateRawScore(
    diag: Omit<RainbowDiagnostics, 'featureScores'>,
    hasBreaks: boolean,
  ): { score: number; featureScores: Record<string, number> } {
    let score = 0

    // Hue rotation: need significant hue change + continuity
    const absHueDelta = Math.abs(diag.hueDelta)
    if (diag.isContinuous && absHueDelta > 60) score += WEIGHTS.hueRotation
    else if (absHueDelta > 30) score += WEIGHTS.hueRotation * 0.5
    else score -= WEIGHTS.hueRotation * 0.5

    // Stable saturation (low deviation)
    if (diag.saturationDeviation < 15) score += WEIGHTS.stableSaturation
    else if (diag.saturationDeviation < 30) score += WEIGHTS.stableSaturation * 0.5
    else score -= WEIGHTS.stableSaturation * 0.5

    // Stable lightness (low deviation)
    if (diag.lightnessDeviation < 15) score += WEIGHTS.stableLightness
    else if (diag.lightnessDeviation < 30) score += WEIGHTS.stableLightness * 0.5
    else score -= WEIGHTS.stableLightness * 0.5

    // No formatting breaks
    if (!hasBreaks) score += WEIGHTS.noFormattingBreaks

    const featureScores = {
      hueRotation: (diag.isContinuous && absHueDelta > 60) ? WEIGHTS.hueRotation :
                    absHueDelta > 30 ? WEIGHTS.hueRotation * 0.5 : -WEIGHTS.hueRotation * 0.5,
      stableSaturation: diag.saturationDeviation < 15 ? WEIGHTS.stableSaturation :
                        diag.saturationDeviation < 30 ? WEIGHTS.stableSaturation * 0.5 : -WEIGHTS.stableSaturation * 0.5,
      stableLightness: diag.lightnessDeviation < 15 ? WEIGHTS.stableLightness :
                       diag.lightnessDeviation < 30 ? WEIGHTS.stableLightness * 0.5 : -WEIGHTS.stableLightness * 0.5,
      noFormattingBreaks: hasBreaks ? -WEIGHTS.noFormattingBreaks : WEIGHTS.noFormattingBreaks,
    }

    return { score, featureScores }
  }
}
