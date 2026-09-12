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
import { hexToOklab, mixOklabToHex, perceptualDistanceOklab, hexToRgb } from '../../../Utils/ColorMath'
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
  readonly maxStepDelta?: number
  readonly avgStepDelta?: number
  readonly featureScores: Readonly<Record<string, number>>
}

// ── Main Analyzer ─────────────────────────────────────────────────

export interface CollapsibleGradient {
  readonly range: { start: number; end: number }
  readonly colors: string[]
  readonly stops: GradientStop[]
  readonly easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  readonly combinedText: string
  readonly replacementText: string
  readonly confidence: number
  readonly colorCount: number
}

export function formatGradientTag(
  stops: GradientStop[],
  colors: string[],
  easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut',
  text: string,
): string {
  const effectiveStops = stops.length >= 2
    ? stops
    : [{ color: colors[0], position: 0 }, { color: colors[colors.length - 1], position: 1 }]

  // Deduplicate consecutive identical colors
  const filteredStops: GradientStop[] = []
  for (const s of effectiveStops) {
    if (
      filteredStops.length === 0 ||
      filteredStops[filteredStops.length - 1].color.toLowerCase() !== s.color.toLowerCase()
    ) {
      filteredStops.push(s)
    }
  }

  const finalStops = filteredStops.length >= 2
    ? filteredStops
    : [{ color: colors[0], position: 0 }, { color: colors[colors.length - 1], position: 1 }]

  const n = finalStops.length
  const isEvenlySpaced = finalStops.every((s, i) => {
    const expected = n <= 1 ? 0 : i / (n - 1)
    return Math.abs(s.position - expected) < 0.04
  })

  let stopsStr: string
  if (isEvenlySpaced) {
    stopsStr = finalStops.map(s => s.color).join(',')
  } else {
    stopsStr = finalStops
      .map(s => `${s.color} ${Math.round(s.position * 100)}%`)
      .join(',')
  }

  const easingStr = easing !== 'linear' ? `;easing=${easing}` : ''
  return `[gradient=${stopsStr}${easingStr}]${text}[/gradient]`
}

export class GradientAnalyzer implements AnalyzerPass {
  readonly id = 'gradient-analyzer'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.findGradients(tree, contributions)
    return contributions
  }

  findCollapsibleGradients(tree: GreenNode, minConfidence = 0.6): CollapsibleGradient[] {
    const results: CollapsibleGradient[] = []
    this.collectCollapsibleGradients(tree, results, 0, minConfidence)
    return results
  }

  private collectCollapsibleGradients(
    node: GreenNode,
    sink: CollapsibleGradient[],
    nodeStart: number = 0,
    minConfidence: number = 0.6,
  ): void {
    const children = node.children as GreenNode[]
    if (children.length === 0) return
    this.collapsibleGradientsAt(node, nodeStart, sink, minConfidence)
    // Los desplazamientos se acumulan sobre la marcha, que es lo mismo que
    // hace `childOffsets` pero sin el array.
    let offset = nodeStart + node.leadingWidth
    for (let i = 0; i < children.length; i++) {
      this.collectCollapsibleGradients(children[i], sink, offset, minConfidence)
      offset += children[i].width
    }
  }

  /**
   * The collapsible runs among the DIRECT children of `node`, and nothing
   * below them.
   *
   * A run is a property of one children list: which siblings are `color`,
   * what sits between them, what each one wraps. That is what makes it the
   * unit the incremental analysis can work with — an edit rebuilds the child
   * lists on the path down to it and nothing else, so only those lists can
   * have gained or lost a run (see `SemanticAnalyzer.analyzeWindow`). The
   * full scan above is this, applied to every node in pre-order; running it
   * per list keeps the two paths producing the same items in the same order.
   *
   * Returns the number of runs appended to `sink`. `nodeStart` is the absolute
   * offset of `node`, so the ranges come out in document coordinates.
   */
  collapsibleGradientsAt(
    node: GreenNode,
    nodeStart: number,
    sink: CollapsibleGradient[],
    minConfidence: number = 0.6,
  ): number {
    // El corte por arriba: la inmensa mayoría de los nodos del documento son
    // hojas o no tienen suficientes hijos `color` seguidos como para formar
    // un degradado. `childOffsets` asigna un array por nodo y
    // `extractSequences` otro más; hacerlo para todos era pagar dos
    // asignaciones por nodo del árbol para descartarlos acto seguido.
    const children = node.children as GreenNode[]
    if (children.length === 0) return 0
    if (countColorChildren(children) < MIN_SEQUENCE_LENGTH) return 0

    const offsets = childOffsets(node, nodeStart)
    const sequences = extractSequences(children, 'color', extractHex)
    let found = 0

    for (const seq of sequences) {
      const colors = seq.values as string[]
      if (colors.length < MIN_SEQUENCE_LENGTH) continue

      let textLen = 0
      const textChunks: string[] = []
      for (let i = seq.startIdx; i < seq.endIdx; i++) {
        const child = children[i]
        if (child.kind === 'color') {
          for (const textChild of child.children as GreenNode[]) {
            if (textChild.kind === 'text') {
              textLen += textChild.text.length
              textChunks.push(textChild.text)
            } else if (textChild.kind === 'spacing' || textChild.kind === 'empty_line') {
              textChunks.push('\n')
            }
          }
        } else if (child.kind === 'text') {
          textChunks.push(child.text)
        }
      }

      const combinedText = textChunks.join('')
      const hasBreaks = checkFormattingBreaks(children, seq, 'color')
      const { stops, easing } = this.detectStops(colors)
      const diag = this.buildDiagnostics(colors, stops)
      const minCharsPerSegment = (colors.length - 1) / (stops.length - 1)
      const maxDelta = diag.maxStepDelta ?? 0
      const hasValidInterpolation = colors.length > 3
        ? minCharsPerSegment >= 1.5 && diag.maxPerceptualError < 0.12 && maxDelta <= 0.45
        : (stops.length === 2 && diag.monotonic && diag.maxPerceptualError < 0.10 && maxDelta <= 0.40)
      const { score: rawScore } = this.calculateRawScore(diag, hasBreaks)
      const confidence = sigmoid(rawScore, SIGMOID_STEEPNESS)

      if (confidence >= minConfidence && stops.length >= 2 && hasValidInterpolation) {
        const range = {
          start: offsets[seq.startIdx],
          end: offsets[seq.endIdx],
        }
        const replacementText = formatGradientTag(stops, colors, easing, combinedText)
        sink.push({
          range,
          colors,
          stops,
          easing,
          combinedText,
          replacementText,
          confidence,
          colorCount: colors.length,
        })
        found++
      }
    }
    return found
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
    if (n <= 2) {
      return {
        stops: colors.map((c, i) => ({ color: c, position: n === 1 ? 0 : i / (n - 1) })),
        easing: 'linear',
      }
    }

    const oklab = colors.map(c => hexToOklab(c))
    const rgb = colors.map(h => {
      const [r, g, b] = hexToRgb(h)
      return [r / 255, g / 255, b / 255]
    })

    // From `oklab`, not from the hex strings: `perceptualDistance` would
    // convert both endpoints again, and both are already in hand.
    const deltas: number[] = []
    for (let i = 1; i < n; i++) {
      deltas.push(perceptualDistanceOklab(oklab[i - 1], oklab[i]))
    }

    // 1. Text Studio change-point detection (derivative jump between neighbours)
    const detectedIndices = new Set<number>([0, n - 1])
    const STOP_THRESHOLD = 0.08
    for (let i = 1; i < n - 1; i++) {
      const curr = deltas[i]
      const prev = deltas[i - 1]
      if (curr > prev * 1.5 && curr > STOP_THRESHOLD) {
        detectedIndices.add(i)
      }
    }

    // 2. Dual-space (RGB + OKLab) chord deviation (Douglas-Peucker)
    // Avoids over-segmenting smooth linear ramps (which are straight lines in RGB or OKLab)
    // while accurately capturing true inflection points / color turns.
    function checkChord(startIdx: number, endIdx: number): void {
      if (endIdx - startIdx <= 1) return

      const aR = rgb[startIdx]
      const bR = rgb[endIdx]
      const abRLenSq = (bR[0] - aR[0]) ** 2 + (bR[1] - aR[1]) ** 2 + (bR[2] - aR[2]) ** 2

      const aO = oklab[startIdx]
      const bO = oklab[endIdx]
      const abOLenSq = (bO[0] - aO[0]) ** 2 + (bO[1] - aO[1]) ** 2 + (bO[2] - aO[2]) ** 2

      let maxDev = 0
      let maxIdx = -1

      for (let i = startIdx + 1; i < endIdx; i++) {
        let dR = 0
        if (abRLenSq > 1e-7) {
          const tR = Math.max(0, Math.min(1, ((rgb[i][0] - aR[0]) * (bR[0] - aR[0]) + (rgb[i][1] - aR[1]) * (bR[1] - aR[1]) + (rgb[i][2] - aR[2]) * (bR[2] - aR[2])) / abRLenSq))
          dR = Math.hypot(rgb[i][0] - (aR[0] + tR * (bR[0] - aR[0])), rgb[i][1] - (aR[1] + tR * (bR[1] - aR[1])), rgb[i][2] - (aR[2] + tR * (bR[2] - aR[2])))
        } else {
          dR = Math.hypot(rgb[i][0] - aR[0], rgb[i][1] - aR[1], rgb[i][2] - aR[2])
        }

        let dO = 0
        if (abOLenSq > 1e-7) {
          const tO = Math.max(0, Math.min(1, ((oklab[i][0] - aO[0]) * (bO[0] - aO[0]) + (oklab[i][1] - aO[1]) * (bO[1] - aO[1]) + (oklab[i][2] - aO[2]) * (bO[2] - aO[2])) / abOLenSq))
          dO = Math.hypot(oklab[i][0] - (aO[0] + tO * (bO[0] - aO[0])), oklab[i][1] - (aO[1] + tO * (bO[1] - aO[1])), oklab[i][2] - (aO[2] + tO * (bO[2] - aO[2])))
        } else {
          dO = Math.hypot(oklab[i][0] - aO[0], oklab[i][1] - aO[1], oklab[i][2] - aO[2])
        }

        // Must deviate from linear in both sRGB and OKLab models to count as a genuine stop
        const dev = Math.min(dR / 0.05, dO / 0.08)
        if (dev > maxDev) {
          maxDev = dev
          maxIdx = i
        }
      }

      if (maxDev > 1.0 && maxIdx !== -1) {
        detectedIndices.add(maxIdx)
        checkChord(startIdx, maxIdx)
        checkChord(maxIdx, endIdx)
      }
    }

    checkChord(0, n - 1)

    const sortedIndices = Array.from(detectedIndices).sort((a, b) => a - b)
    const stops: GradientStop[] = sortedIndices.map(idx => ({
      color: colors[idx],
      position: idx / (n - 1),
    }))
    // Where each stop sits in `colors`, so the easing pass below can index
    // into `oklab` instead of re-converting `stop.color`.
    const stopSourceIndex = sortedIndices

    // Infer easing from change in perceptual distance across segments
    let easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' = 'linear'
    if (stops.length >= 3) {
      const segDists: number[] = []
      for (let i = 1; i < stops.length; i++) {
        const segLen = stops[i].position - stops[i - 1].position
        const segDist = perceptualDistanceOklab(oklab[stopSourceIndex[i - 1]], oklab[stopSourceIndex[i]])
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

    // 1. Perceptual distances between adjacent colours
    const pDiffs: number[] = []
    for (let i = 1; i < n; i++) {
      pDiffs.push(perceptualDistanceOklab(oklabArray[i - 1], oklabArray[i]))
    }
    const avgDiff = pDiffs.length > 0 ? pDiffs.reduce((a, b) => a + b, 0) / pDiffs.length : 0
    const maxStepDelta = pDiffs.length > 0 ? Math.max(...pDiffs) : 0
    const diffVariance = pDiffs.length > 0
      ? pDiffs.reduce((sum, d) => sum + (d - avgDiff) ** 2, 0) / pDiffs.length
      : 0

    // 2. Check monotonic: does each OKLab dimension change in one direction?
    const first = oklabArray[0]
    const last = oklabArray[n - 1]
    const totalDist = perceptualDistanceOklab(first, last)

    const lSpan = last[0] - first[0]
    const aSpan = last[1] - first[1]
    const bSpan = last[2] - first[2]
    const lDir = Math.abs(lSpan) > 0.02 ? Math.sign(lSpan) : 0
    const aDir = Math.abs(aSpan) > 0.02 ? Math.sign(aSpan) : 0
    const bDir = Math.abs(bSpan) > 0.02 ? Math.sign(bSpan) : 0

    let violations = 0
    for (let i = 1; i < n; i++) {
      const curr = oklabArray[i]
      const prev = oklabArray[i - 1]
      if (lDir !== 0 && Math.sign(curr[0] - prev[0]) !== lDir && Math.abs(curr[0] - prev[0]) > 0.005) violations++
      if (aDir !== 0 && Math.sign(curr[1] - prev[1]) !== aDir && Math.abs(curr[1] - prev[1]) > 0.005) violations++
      if (bDir !== 0 && Math.sign(curr[2] - prev[2]) !== bDir && Math.abs(curr[2] - prev[2]) > 0.005) violations++
      if (lDir === 0 && Math.abs(curr[0] - first[0]) > 0.04) violations++
      if (aDir === 0 && Math.abs(curr[1] - first[1]) > 0.04) violations++
      if (bDir === 0 && Math.abs(curr[2] - first[2]) > 0.04) violations++
    }

    const isShort = n <= 4
    const isLoopOrBounce = totalDist < 0.04 && maxStepDelta > 0.04
    const monotonic = !isLoopOrBounce && (
      isShort
        ? violations === 0 && (lDir !== 0 || aDir !== 0 || bDir !== 0)
        : violations < n * 0.2
    )

    // Spacing is only "uniform" if step variance is tiny AND steps are small gradient steps, not massive leaps
    const uniformSpacing = diffVariance < 0.001 &&
      avgDiff <= (isShort ? 0.28 : 0.25) &&
      maxStepDelta <= (isShort ? 0.30 : 0.35) &&
      (!isShort || monotonic)

    // 3. Count plateaus (consecutive perceptually identical colours).
    let plateauCount = 0
    for (let i = 0; i < pDiffs.length; i++) {
      if (pDiffs[i] < 0.01) plateauCount++
    }

    // 4. Perceptual error vs ideal OKLab interpolation across stops
    let maxPerceptualError = 0
    if (n >= 3 && stops.length >= 2) {
      const stopOklabs = stops.map(s => hexToOklab(s.color))
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0
        let segIdx = 0
        while (segIdx < stops.length - 2 && stops[segIdx + 1].position < t) {
          segIdx++
        }
        const s0 = stops[segIdx]
        const s1 = stops[segIdx + 1]
        const segSpan = s1.position - s0.position
        const segT = segSpan > 0 ? Math.max(0, Math.min(1, (t - s0.position) / segSpan)) : 0
        const ideal = mixOklabToHex(stopOklabs[segIdx], stopOklabs[segIdx + 1], segT)
        const error = perceptualDistanceOklab(hexToOklab(ideal), oklabArray[i])
        maxPerceptualError = Math.max(maxPerceptualError, error)
      }
    }

    return {
      uniformSpacing,
      monotonic,
      plateauCount,
      maxPerceptualError,
      stopCount: stops.length,
      maxStepDelta,
      avgStepDelta: avgDiff,
    }
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
      const penalty = WEIGHTS.lowPerceptualError * Math.min(diag.maxPerceptualError * 25, 12)
      score -= penalty
    }

    const maxDelta = diag.maxStepDelta ?? 0
    if (maxDelta > 0.35) {
      score -= Math.min((maxDelta - 0.35) * 2.5, 0.60)
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

/** Cuántos hijos directos son nodos `color`. Sin asignar nada. */
function countColorChildren(children: readonly GreenNode[]): number {
  let count = 0
  for (let i = 0; i < children.length; i++) {
    if (children[i].kind === 'color') count++
  }
  return count
}

export function findCollapsibleGradients(
  tree: GreenNode,
  minConfidence = 0.6,
): CollapsibleGradient[] {
  return new GradientAnalyzer().findCollapsibleGradients(tree, minConfidence)
}

const sharedAnalyzer = new GradientAnalyzer()

/**
 * The collapsible runs among the direct children of `node`, whose absolute
 * start is `nodeStart`. See {@link GradientAnalyzer.collapsibleGradientsAt}.
 */
export function collapsibleGradientsAt(
  node: GreenNode,
  nodeStart: number,
  sink: CollapsibleGradient[],
  minConfidence = 0.6,
): number {
  return sharedAnalyzer.collapsibleGradientsAt(node, nodeStart, sink, minConfidence)
}

