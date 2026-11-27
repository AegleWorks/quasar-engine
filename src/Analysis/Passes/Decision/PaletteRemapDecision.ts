/**
 * Quasar Analysis Framework — Palette Remap Decision
 *
 * Turns an AnalysisReport into a plan for restyling a document with a
 * different palette: recolour its colour tags, swap its decorative glyphs,
 * replace its divider lines.
 *
 * ## The plan is applied by range, not by rebuilding the tree
 *
 * Every other DecisionPass in this framework feeds a TransformPass that
 * returns a new Green Tree, which is then serialized. That is the wrong shape
 * for restyling a document someone already wrote: `BBCodeExporter` rebuilds
 * BBCode from node kinds and metadata rather than replaying source bytes, so
 * re-exporting a whole document also rewrites the parts nobody asked to
 * change — `[B]` becomes `[b]`, `[color = #F00]` loses its spacing, CRLF
 * becomes LF.
 *
 * So the actions here carry a `range` and a literal `replacement` string, and
 * are meant to be applied directly to the source text. Everything outside
 * those ranges is never re-serialized and therefore cannot drift. The Decision
 * stage is still the right home — it consumes a report and describes intended
 * mutations without touching the tree — but no TransformPass consumes it.
 *
 * Apply the actions **last range first**. They are emitted in source order,
 * and rewriting front to back invalidates every offset that follows.
 *
 * ## What each kind of thing becomes
 *
 * **Colours inside a gradient** keep the gradient's shape. Each member tag is
 * recoloured by sampling the new palette at the member's own position along
 * the ramp, passed through the easing the original gradient was detected with.
 * The result reads as the same gradient wearing a different palette, rather
 * than as a new gradient.
 *
 * **Native `[gradient]` tags** are resampled the same way, by each stop's
 * own position along the ramp. Only the colour tokens change: the stop count,
 * any `40%` positions, the easing and every other parameter keep their exact
 * bytes, so a configured gradient stays configured.
 *
 * **Standalone colours** map to their nearest palette entry by perceptual
 * distance in OKLab, so a pink stays the palette's pink rather than becoming
 * whichever colour happens to be first.
 *
 * **Symbols** are substituted glyph for glyph, and **separators** wholesale.
 * Both substitutions are stable across the document: a given source glyph
 * always maps to the same palette glyph, so a document that used `✧` as its
 * motif comes out using one motif rather than a scatter.
 *
 * @see ColorUsageAnalyzer — supplies the per-tag offsets this pass edits
 * @see GradientAnalyzer — supplies the ramp shape those tags belong to
 * @see GradientTagAnalyzer — supplies native `[gradient]` stops
 * @see SymbolAnalyzer — supplies the glyph runs
 */

import type { DecisionPass, TransformationPlan, TransformAction } from '../../Contracts/Pass'
import type { AnalysisReport } from '../../Contracts/AnalysisReport'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { SemanticContribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import { ease, hexToOklabCached, mixOklabToHex, perceptualDistanceOklab } from '../../../Utils/ColorMath'
import type { ColorUsageModel } from '../Analysis/ColorUsageAnalyzer'
import type { GradientModel } from '../Analysis/GradientAnalyzer'
import type { GradientTagModel } from '../Analysis/GradientTagAnalyzer'
import type { SymbolRunModel } from '../Analysis/SymbolAnalyzer'

// ── Configuration ─────────────────────────────────────────────────

/**
 * The palette to restyle towards.
 *
 * Structural, not imported: Quasar has no dependency on the application's
 * theme catalogue, and any object with these three lists satisfies it.
 */
export interface Palette {
  /** Hex colours, ordered as a ramp from first to last. */
  readonly colors: readonly string[]
  /** Decorative glyphs, in preference order. */
  readonly symbols: readonly string[]
  /** Whole divider lines. */
  readonly separators: readonly string[]
}

export interface PaletteRemapOptions {
  /**
   * Below this confidence an action is still emitted, but marked
   * `recommended: false`.
   *
   * Nothing is dropped. A caller that hides low-confidence findings can never
   * offer them, and the glyphs that land down here — `≈` in a sum, `→` in a
   * sentence — are exactly the ones a person should get to look at before
   * they are rewritten. Filtering is the caller's decision; this pass only
   * says which side of the line each action falls on.
   */
  readonly minConfidence?: number
}

const DEFAULT_MIN_CONFIDENCE = 0.7

/** Shared empty list for labels no analyzer produced. */
const EMPTY: readonly SemanticContribution[] = Object.freeze([])

/**
 * Pre-bucketed, range-sorted semantic contributions per immutable AnalysisReport.
 *
 * `PaletteRemapPlanner` caches the report across theme switches; indexing it
 * once here means every subsequent theme click skips the full contribution
 * scan and all four label sorts.
 */
const REPORT_BUCKETS = new WeakMap<AnalysisReport, ReadonlyMap<string, readonly SemanticContribution[]>>()

function bucketsForReport(report: AnalysisReport): ReadonlyMap<string, readonly SemanticContribution[]> {
  const cached = REPORT_BUCKETS.get(report)
  if (cached !== undefined) return cached

  const byLabel = new Map<string, SemanticContribution[]>()
  const list = report.contributions
  for (let i = 0; i < list.length; i++) {
    const contribution = list[i]
    if (contribution.kind !== ContributionKind.Semantic) continue
    const bucket = byLabel.get(contribution.label)
    if (bucket === undefined) byLabel.set(contribution.label, [contribution])
    else bucket.push(contribution)
  }
  for (const bucket of byLabel.values()) {
    let sorted = true
    for (let i = 1; i < bucket.length; i++) {
      if (bucket[i].range.start < bucket[i - 1].range.start) {
        sorted = false
        break
      }
    }
    if (!sorted) bucket.sort((a, b) => a.range.start - b.range.start)
  }
  REPORT_BUCKETS.set(report, byLabel)
  return byLabel
}

/**
 * One spelling for every hex this pass emits.
 *
 * `mixHexOklab` builds its result lowercase while palette entries are written
 * however the caller wrote them, so a sampled ramp would otherwise alternate
 * cases — `#ffb7c5` next to `#FFE4E1` — depending on whether a stop landed on
 * a palette entry or between two. `extractHex` already uppercases what it
 * reads, so matching it also keeps the "already this colour" check honest.
 */
function canonicalHex(hex: string): string {
  return hex.toUpperCase()
}

// ── Action payloads ───────────────────────────────────────────────

/** Every action this pass emits shares one shape. */
export interface RemapAction extends TransformAction {
  readonly kind: 'recolor' | 'regradient' | 'resymbol' | 'reseparator'
  readonly payload: {
    /** Source span to overwrite. */
    readonly range: { readonly start: number; readonly end: number }
    /** Literal text to write in its place. */
    readonly replacement: string
    /** What is there now, for previewing the change. */
    readonly from: string
    /** What it becomes. */
    readonly to: string
    readonly confidence: number
    readonly recommended: boolean
    /** On `recolor`: whether the tag belonged to a detected gradient. Always true on `regradient`. */
    readonly gradient?: boolean
    /**
     * Only on `regradient`: the stops before and after, aligned by index, with
     * the position each sits at — enough to draw both ramps side by side.
     */
    readonly stops?: {
      readonly from: readonly string[]
      readonly to: readonly string[]
      readonly positions: readonly number[]
    }
  }
}

// ── Decision ──────────────────────────────────────────────────────

export class PaletteRemapDecision implements DecisionPass {
  readonly id = 'palette-remap'

  private readonly palette: Palette
  private readonly minConfidence: number

  /**
   * The palette in OKLab, computed once per instance.
   *
   * `nearestPaletteColor` used to call `perceptualDistance`, which parses BOTH
   * hex strings on every comparison. A restyle of the 500 KB fixture asks that
   * question ~12 000 times against a five-colour palette: 60 000 parses for a
   * palette that never changes. These are the same numbers, calculated once.
   */
  private readonly paletteOklab: readonly (readonly [number, number, number])[]

  /**
   * Nearest-entry memo, one per run.
   *
   * Real documents repeat colours: a page with 12 000 colour tags typically
   * has a few dozen distinct hex values. The distance scan is deterministic,
   * so each distinct colour needs to be matched once.
   */
  private nearestCache = new Map<string, string>()

  /**
   * Substitution tables, rebuilt per `run` so the pass stays reusable and
   * every run over the same report produces the same plan.
   */
  private symbolMap = new Map<string, string>()
  private symbolTaken = new Set<string>()
  private separatorMap = new Map<string, string>()
  private separatorTaken = new Set<string>()

  constructor(palette: Palette, options: PaletteRemapOptions = {}) {
    this.palette = palette
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    this.paletteOklab = palette.colors.map(hexToOklabCached)
  }

  run(report: AnalysisReport, _context: PipelineContext): TransformationPlan {
    this.symbolMap = new Map()
    this.symbolTaken = new Set()
    this.separatorMap = new Map()
    this.separatorTaken = new Set()
    this.nearestCache = new Map()

    const byLabel = bucketsForReport(report)
    const labelled = (label: string): readonly SemanticContribution[] => byLabel.get(label) ?? EMPTY

    const actions: RemapAction[] = []
    this.planColors(labelled('Color'), labelled('Gradient'), actions)
    this.planGradientTags(labelled('GradientTag'), actions)
    this.planSymbols(labelled('Symbol'), actions)
    this.planSeparators(labelled('Separator'), actions)

    // Source order, so a caller can apply them back to front by reversing.
    let sorted = true
    for (let i = 1; i < actions.length; i++) {
      if (actions[i].payload.range.start < actions[i - 1].payload.range.start) {
        sorted = false
        break
      }
    }
    if (!sorted) actions.sort((a, b) => a.payload.range.start - b.payload.range.start)

    return { actions: Object.freeze(actions) }
  }

  // ── Colours ─────────────────────────────────────────────────────

  private planColors(
    colors: readonly SemanticContribution[],
    gradients: readonly SemanticContribution[],
    actions: RemapAction[],
  ): void {
    if (this.palette.colors.length === 0 || colors.length === 0) return

    // Which gradient, if any, each colour tag belongs to, plus its exact
    // ordinal and run length so sampling is O(1) instead of `indexOf` O(M²).
    const memberInfo = new Map<
      SemanticContribution,
      { readonly gradient: SemanticContribution; readonly index: number; readonly count: number }
    >()
    const colorsByStart = colors

    for (let g = 0; g < gradients.length; g++) {
      const gradient = gradients[g]
      // A doubtful gradient must not drive ramp sampling.
      if (gradient.confidence < this.minConfidence) continue

      let lo = 0
      let hi = colorsByStart.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (colorsByStart[mid].range.start < gradient.range.start) lo = mid + 1
        else hi = mid
      }

      const inside: SemanticContribution[] = []
      for (let i = lo; i < colorsByStart.length; i++) {
        const color = colorsByStart[i]
        if (color.range.start > gradient.range.end) break
        if (color.range.end <= gradient.range.end) inside.push(color)
      }
      // A gradient needs at least two members before "position along it" means
      // anything; a degenerate one is treated as standalone colours.
      const count = inside.length
      if (count < 2) continue

      for (let i = 0; i < count; i++) {
        memberInfo.set(inside[i], { gradient, index: i, count })
      }
    }

    for (let i = 0; i < colors.length; i++) {
      const color = colors[i]
      const model = color.metadata.model as ColorUsageModel
      const membership = memberInfo.get(color)

      let to: string
      let confidence: number
      if (membership !== undefined) {
        const gModel = membership.gradient.metadata.model as GradientModel
        const t = membership.index / (membership.count - 1)
        to = this.samplePalette(ease(t, gModel.easing))
        confidence = membership.gradient.confidence
      } else {
        to = this.nearestPaletteColor(model.hex)
        confidence = color.confidence
      }

      // A tag already wearing its target colour is not a change. Both sides
      // are canonical here: `extractHex` uppercases, and so does `to`.
      if (to === model.hex) continue

      actions.push({
        kind: 'recolor',
        payload: {
          range: { start: model.openStart, end: model.openEnd },
          replacement: `[color=${to}]`,
          from: model.hex,
          to,
          confidence,
          recommended: confidence >= this.minConfidence,
          gradient: membership !== undefined,
        },
      })
    }
  }

  /**
   * Recolour native `[gradient]` tags, stop by stop.
   *
   * Each stop is sampled at its own position, which is what keeps the shape:
   * a stop pinned at 40% takes the palette's colour at 40%, and the easing the
   * tag declares still bends the ramp between them exactly as before. The
   * replacement is the attribute with only its colour tokens spliced, so the
   * action can never touch a parameter.
   */
  private planGradientTags(tags: readonly SemanticContribution[], actions: RemapAction[]): void {
    if (this.palette.colors.length === 0 || tags.length === 0) return

    for (const tag of tags) {
      const model = tag.metadata.model as GradientTagModel
      const from = model.stops.map(stop => stop.hex)
      const to = model.stops.map(stop => this.samplePalette(stop.position))

      // Already wearing this palette — `hex` and `to` are both canonical.
      if (to.every((hex, i) => hex === from[i])) continue

      let replacement = ''
      let cursor = 0
      model.stops.forEach((stop, i) => {
        const start = stop.start - model.attributeStart
        replacement += model.attribute.slice(cursor, start) + to[i]
        cursor = stop.end - model.attributeStart
      })
      replacement += model.attribute.slice(cursor)

      actions.push({
        kind: 'regradient',
        payload: {
          range: { start: model.attributeStart, end: model.attributeEnd },
          replacement,
          from: from.join(', '),
          to: to.join(', '),
          confidence: tag.confidence,
          recommended: tag.confidence >= this.minConfidence,
          gradient: true,
          stops: { from, to, positions: model.stops.map(stop => stop.position) },
        },
      })
    }
  }

  /**
   * Sample the palette as a continuous ramp, interpolating in OKLab.
   *
   * `ColorMath.mixMultiple` does the same walk in RGB, which darkens and
   * desaturates through the middle of a blend — the reason the gradient
   * analyzers work in OKLab in the first place. Sampling rather than mapping
   * palette entries one-to-one is what preserves the original stop count: a
   * three-stop gradient stays three stops when restyled with a five-colour
   * palette, instead of gaining two.
   */
  private samplePalette(t: number): string {
    const colors = this.palette.colors
    if (colors.length === 1) return canonicalHex(colors[0])

    const clamped = Math.max(0, Math.min(1, t))
    const scaled = clamped * (colors.length - 1)
    const index = Math.floor(scaled)

    if (index >= colors.length - 1) return canonicalHex(colors[colors.length - 1])

    // Both endpoints are already in OKLab: the palette is converted once per
    // instance, not once per sampled stop.
    return canonicalHex(
      mixOklabToHex(this.paletteOklab[index], this.paletteOklab[index + 1], scaled - index),
    )
  }

  /**
   * The palette entry that looks most like the colour already there.
   *
   * Perceptual distance rather than index order: a document's pink should come
   * back as the palette's pink, not as whichever colour the palette happens to
   * list first.
   */
  private nearestPaletteColor(hex: string): string {
    const cached = this.nearestCache.get(hex)
    if (cached !== undefined) return cached

    const target = hexToOklabCached(hex)
    let best = this.palette.colors[0]
    let bestDistance = Infinity

    for (let i = 0; i < this.palette.colors.length; i++) {
      const distance = perceptualDistanceOklab(target, this.paletteOklab[i])
      if (distance < bestDistance) {
        bestDistance = distance
        best = this.palette.colors[i]
      }
    }

    const result = canonicalHex(best)
    this.nearestCache.set(hex, result)
    return result
  }

  // ── Glyphs ──────────────────────────────────────────────────────

  /**
   * Line/box-drawing geometry (`─`, `━`, `═`, `╔`, `╝`, `│`, `▓`) must never be
   * substituted with ornamental symbols (`✿`, `✦`, `🌸`) when seen as 1–2 char
   * `Symbol` runs (e.g. a per-character `[color]─[/color]` gradient divider or
   * ASCII box corners). Whole divider lines still map to `palette.separators`
   * in `planSeparators`.
   */
  private static readonly STRUCTURAL_GLYPH_BLOCKS: ReadonlySet<string> = new Set([
    'box-drawing',
    'block-elements',
  ])

  private planSymbols(symbols: readonly SemanticContribution[], actions: RemapAction[]): void {
    const replacements = this.palette.symbols
    if (replacements.length === 0 || symbols.length === 0) return

    const repSet = new Set(replacements)
    for (let i = 0; i < symbols.length; i++) {
      const glyphs = (symbols[i].metadata.model as SymbolRunModel).glyphs
      for (let j = 0; j < glyphs.length; j++) {
        if (PaletteRemapDecision.STRUCTURAL_GLYPH_BLOCKS.has(glyphs[j].block)) continue
        const ch = glyphs[j].char
        if (!this.symbolMap.has(ch) && repSet.has(ch)) {
          this.symbolMap.set(ch, ch)
          this.symbolTaken.add(ch)
        }
      }
    }

    for (let i = 0; i < symbols.length; i++) {
      const run = symbols[i]
      const model = run.metadata.model as SymbolRunModel
      let replacement = ''
      const glyphs = model.glyphs
      for (let j = 0; j < glyphs.length; j++) {
        if (PaletteRemapDecision.STRUCTURAL_GLYPH_BLOCKS.has(glyphs[j].block)) {
          replacement += glyphs[j].char
          continue
        }
        replacement += this.substitute(this.symbolMap, this.symbolTaken, glyphs[j].char, replacements)
      }

      if (replacement === model.text) continue

      actions.push({
        kind: 'resymbol',
        payload: {
          range: run.range,
          replacement,
          from: model.text,
          to: replacement,
          confidence: run.confidence,
          recommended: run.confidence >= this.minConfidence,
        },
      })
    }
  }

  private planSeparators(separators: readonly SemanticContribution[], actions: RemapAction[]): void {
    const replacements = this.palette.separators
    if (replacements.length === 0 || separators.length === 0) return

    const repSet = new Set(replacements)
    for (let i = 0; i < separators.length; i++) {
      const text = (separators[i].metadata.model as SymbolRunModel).text
      if (!this.separatorMap.has(text) && repSet.has(text)) {
        this.separatorMap.set(text, text)
        this.separatorTaken.add(text)
      }
    }

    for (let i = 0; i < separators.length; i++) {
      const run = separators[i]
      const model = run.metadata.model as SymbolRunModel
      const replacement = this.substitute(this.separatorMap, this.separatorTaken, model.text, replacements)

      if (replacement === model.text) continue

      actions.push({
        kind: 'reseparator',
        payload: {
          range: run.range,
          replacement,
          from: model.text,
          to: replacement,
          confidence: run.confidence,
          recommended: run.confidence >= this.minConfidence,
        },
      })
    }
  }

  /**
   * Assign a replacement for `source`, remembering it.
   */
  private substitute(
    table: Map<string, string>,
    taken: Set<string>,
    source: string,
    replacements: readonly string[],
  ): string {
    const existing = table.get(source)
    if (existing !== undefined) return existing

    let chosen: string | undefined
    for (let i = 0; i < replacements.length; i++) {
      if (!taken.has(replacements[i])) {
        chosen = replacements[i]
        break
      }
    }
    if (chosen === undefined) chosen = replacements[table.size % replacements.length]

    table.set(source, chosen)
    taken.add(chosen)
    return chosen
  }
}

