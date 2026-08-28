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
 * @see SymbolAnalyzer — supplies the glyph runs
 */

import type { DecisionPass, TransformationPlan, TransformAction } from '../../Contracts/Pass'
import type { AnalysisReport } from '../../Contracts/AnalysisReport'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { SemanticContribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import { ease, mixHexOklab, perceptualDistance } from '../../../Utils/ColorMath'
import type { ColorUsageModel } from '../Analysis/ColorUsageAnalyzer'
import type { GradientModel } from '../Analysis/GradientAnalyzer'
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
  readonly kind: 'recolor' | 'resymbol' | 'reseparator'
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
    /** Only on `recolor`: whether the tag belonged to a detected gradient. */
    readonly gradient?: boolean
  }
}

// ── Decision ──────────────────────────────────────────────────────

export class PaletteRemapDecision implements DecisionPass {
  readonly id = 'palette-remap'

  private readonly palette: Palette
  private readonly minConfidence: number

  /**
   * Substitution tables, rebuilt per `run` so the pass stays reusable and
   * every run over the same report produces the same plan.
   */
  private symbolMap = new Map<string, string>()
  private separatorMap = new Map<string, string>()

  constructor(palette: Palette, options: PaletteRemapOptions = {}) {
    this.palette = palette
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  }

  run(report: AnalysisReport, _context: PipelineContext): TransformationPlan {
    this.symbolMap = new Map()
    this.separatorMap = new Map()

    const semantic = report.contributions.filter(
      (c): c is SemanticContribution => c.kind === ContributionKind.Semantic,
    )

    const byLabel = (label: string) =>
      semantic
        .filter(c => c.label === label)
        .sort((a, b) => a.range.start - b.range.start)

    const actions: RemapAction[] = [
      ...this.planColors(byLabel('Color'), byLabel('Gradient')),
      ...this.planSymbols(byLabel('Symbol')),
      ...this.planSeparators(byLabel('Separator')),
    ]

    // Source order, so a caller can apply them back to front by reversing.
    actions.sort((a, b) => a.payload.range.start - b.payload.range.start)

    return { actions: Object.freeze(actions) }
  }

  // ── Colours ─────────────────────────────────────────────────────

  private planColors(
    colors: readonly SemanticContribution[],
    gradients: readonly SemanticContribution[],
  ): RemapAction[] {
    if (this.palette.colors.length === 0) return []

    // Which gradient, if any, each colour tag belongs to. Membership is by
    // containment: GradientAnalyzer reports the span its member tags cover.
    const memberOf = new Map<SemanticContribution, SemanticContribution>()
    const members = new Map<SemanticContribution, SemanticContribution[]>()

    for (const gradient of gradients) {
      // A doubtful gradient must not drive ramp sampling.
      //
      // GradientAnalyzer reports every colour run it *considers*, scoring the
      // ones that are not ramps down rather than discarding them — a lone
      // `#111111` sitting against a real gradient yields one six-colour
      // candidate at 0.13 confidence. Sampling a palette across that would
      // impose a ramp the document never had, so anything under the threshold
      // falls through and its colours are matched individually instead.
      if (gradient.confidence < this.minConfidence) continue

      const inside = colors.filter(
        c => c.range.start >= gradient.range.start && c.range.end <= gradient.range.end,
      )
      // A gradient needs at least two members before "position along it" means
      // anything; a degenerate one is treated as standalone colours.
      if (inside.length < 2) continue

      members.set(gradient, inside)
      for (const color of inside) memberOf.set(color, gradient)
    }

    const actions: RemapAction[] = []

    for (const color of colors) {
      const model = color.metadata.model as ColorUsageModel
      const gradient = memberOf.get(color)

      const to = gradient
        ? this.gradientColorFor(color, gradient, members.get(gradient)!)
        : this.nearestPaletteColor(model.hex)

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
          confidence: gradient ? gradient.confidence : color.confidence,
          recommended: (gradient ? gradient.confidence : color.confidence) >= this.minConfidence,
          gradient: gradient !== undefined,
        },
      })
    }

    return actions
  }

  /**
   * Where this tag sits along its gradient, resampled onto the new palette.
   *
   * Position comes from the tag's ordinal among the gradient's members rather
   * than from its offset, because the members are evenly spaced *as tags* — a
   * gradient over `Hello` has five of them regardless of how wide each tag's
   * text is.
   */
  private gradientColorFor(
    color: SemanticContribution,
    gradient: SemanticContribution,
    members: readonly SemanticContribution[],
  ): string {
    const model = gradient.metadata.model as GradientModel
    const index = members.indexOf(color)
    const t = members.length > 1 ? index / (members.length - 1) : 0

    return this.samplePalette(ease(t, model.easing))
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

    return canonicalHex(mixHexOklab(colors[index], colors[index + 1], scaled - index))
  }

  /**
   * The palette entry that looks most like the colour already there.
   *
   * Perceptual distance rather than index order: a document's pink should come
   * back as the palette's pink, not as whichever colour the palette happens to
   * list first.
   */
  private nearestPaletteColor(hex: string): string {
    let best = this.palette.colors[0]
    let bestDistance = Infinity

    for (const candidate of this.palette.colors) {
      const distance = perceptualDistance(hex, candidate)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }

    return canonicalHex(best)
  }

  // ── Glyphs ──────────────────────────────────────────────────────

  private planSymbols(symbols: readonly SemanticContribution[]): RemapAction[] {
    if (this.palette.symbols.length === 0) return []

    const actions: RemapAction[] = []

    this.reserveIdentities(
      this.symbolMap,
      symbols.flatMap(run => (run.metadata.model as SymbolRunModel).glyphs.map(g => g.char)),
      this.palette.symbols,
    )

    for (const run of symbols) {
      const model = run.metadata.model as SymbolRunModel
      const replacement = model.glyphs
        .map(glyph => this.substitute(this.symbolMap, glyph.char, this.palette.symbols))
        .join('')

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

    return actions
  }

  private planSeparators(separators: readonly SemanticContribution[]): RemapAction[] {
    if (this.palette.separators.length === 0) return []

    const actions: RemapAction[] = []

    this.reserveIdentities(
      this.separatorMap,
      separators.map(run => (run.metadata.model as SymbolRunModel).text),
      this.palette.separators,
    )

    for (const run of separators) {
      const model = run.metadata.model as SymbolRunModel
      const replacement = this.substitute(this.separatorMap, model.text, this.palette.separators)

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

    return actions
  }

  /**
   * Assign a replacement for `source`, remembering it.
   *
   * Distinct sources are handed palette entries in first-seen order.
   * Recording the choice is what keeps the document coherent: every later `✧`
   * gets the same replacement as the first one, so a motif stays a motif.
   *
   * Entries already spoken for are skipped — including the identities
   * `reserveIdentities` claimed before this ran — so distinct sources keep
   * distinct replacements for as long as the palette has them. Once it runs
   * out the assignment wraps, and glyphs begin to share.
   */
  private substitute(
    table: Map<string, string>,
    source: string,
    replacements: readonly string[],
  ): string {
    const existing = table.get(source)
    if (existing !== undefined) return existing

    const taken = new Set(table.values())
    const free = replacements.find(r => !taken.has(r))
    const chosen = free ?? replacements[table.size % replacements.length]

    table.set(source, chosen)
    return chosen
  }

  /**
   * Let everything the palette already contains keep its own place, before
   * anything else is handed out.
   *
   * This has to happen up front rather than as each source is reached.
   * Assignment follows document order, so in `✧ then ✿` the unowned `✧` would
   * otherwise claim `✿` first and the real `✿` would arrive to find its own
   * identity taken — displacing it onto a glyph the document never used.
   *
   * Holding identities fixed is what makes restyling idempotent: a second pass
   * with the same theme finds every glyph already in place and changes
   * nothing.
   */
  private reserveIdentities(
    table: Map<string, string>,
    sources: readonly string[],
    replacements: readonly string[],
  ): void {
    for (const source of sources) {
      if (!table.has(source) && replacements.includes(source)) {
        table.set(source, source)
      }
    }
  }
}

