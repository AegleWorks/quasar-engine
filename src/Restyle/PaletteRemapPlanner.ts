/**
 * Quasar — Palette Remap Planner
 *
 * Restyling a document with a theme is two different jobs with two different
 * lifetimes:
 *
 *   1. **Understand the document.** Parse it and find every colour, gradient,
 *      native gradient tag, decorative glyph and divider. This depends only on
 *      the source text.
 *   2. **Decide what changes.** Map those facts onto a palette and emit actions.
 *      This depends on the source AND the palette.
 *
 * A theme picker changes the second on every click while the first stays the
 * same. Doing both each time — which is what a bare `PipelineBuilder` chain does
 * — parses and walks the whole page for every previewed theme. On the 500 KB
 * fixture that is ~100 ms of parsing and ~130 ms of analysis thrown away per
 * click.
 *
 * The planner keeps the understanding, bounded, and reuses it:
 *
 *   const planner = new PaletteRemapPlanner()
 *   planner.plan(source, paletteA)  // parse + analyse + decide
 *   planner.plan(source, paletteB)  // decide only
 *   planner.plan(source, paletteA)  // the previous plan, unchanged
 *
 * The cache is an LRU over source strings, small on purpose: a source string is
 * the size of the document and the report holds one object per colour, glyph
 * and divider. Two entries cover an editor plus the theme preview; more would
 * buy nothing and pin memory.
 *
 * ## What is cached, exactly
 *
 * The report holds no tree nodes — contributions carry ranges, metadata models
 * and strings — so a cached analysis does not pin a red/green tree alive.
 * Nothing here observes the `DocumentModel`; call `plan` with the current text
 * and the cache key is the text itself. An edit that changes one byte makes a
 * new entry and leaves the old one to age out.
 *
 * @see RestyleAnalyzer — the single walk that produces the report
 * @see PaletteRemapDecision — actions, by source range
 */

import { parseBBCode } from '../BBCode/Parser'
import type { AnalysisReport } from '../Analysis/Contracts/AnalysisReport'
import type { PipelineContext } from '../Analysis/Contracts/PipelineContext'
import type { TransformationPlan } from '../Analysis/Contracts/Pass'
import { RestyleAnalyzer } from '../Analysis/Passes/Analysis/RestyleAnalyzer'
import {
  PaletteRemapDecision,
  type Palette,
  type PaletteRemapOptions,
  type RemapAction,
} from '../Analysis/Passes/Decision/PaletteRemapDecision'

/**
 * The analysis context. A remap plan addresses source bytes, so the target
 * dialect is irrelevant to it; the document is parsed as `miliastry`, the union
 * of the tags the planner can recognise.
 */
const RESTYLE_CONTEXT: PipelineContext = {
  mode: 'interactive',
  target: 'miliastry',
  featureFlags: {},
  metadata: {},
}

export interface PaletteRemapPlannerOptions {
  /**
   * How many source texts to keep analysed. Default 2.
   *
   * One is enough for a single open document; two lets a preview compare the
   * current page with the previous one without re-analysing either.
   */
  readonly cacheSize?: number
  /** How many palette plans to keep per source. Default 8. */
  readonly planCacheSize?: number
}

export interface PaletteRemapPlannerStats {
  /** Reports computed from scratch. */
  readonly analyses: number
  /** `plan` calls whose source was already analysed. */
  readonly cacheHits: number
  /** `plan` calls that had to parse and walk the document. */
  readonly cacheMisses: number
  /** Plans answered from the per-source plan cache. */
  readonly planHits: number
  /** Source texts currently retained. */
  readonly cachedSources: number
}

interface CachedAnalysis {
  readonly report: AnalysisReport
  readonly plans: Map<string, TransformationPlan>
}

function emptyReport(): AnalysisReport {
  return { contributions: Object.freeze([]), passCount: 0, elapsedMs: 0 }
}

/**
 * Everything a decision can depend on, as a string. The palette is structural,
 * so two equal palettes from different theme objects share a plan.
 */
function planKey(palette: Palette, options: PaletteRemapOptions): string {
  return (
    palette.colors.join(',') +
    '\u0000' +
    palette.symbols.join('\u0000') +
    '\u0000' +
    palette.separators.join('\u0001') +
    '\u0000' +
    String(options.minConfidence ?? '')
  )
}

export class PaletteRemapPlanner {
  private readonly cacheSize: number
  private readonly planCacheSize: number
  private readonly analyses = new Map<string, CachedAnalysis>()
  private analysesRun = 0
  private hits = 0
  private misses = 0
  private planHits = 0

  constructor(options: PaletteRemapPlannerOptions = {}) {
    this.cacheSize = Math.max(1, options.cacheSize ?? 2)
    this.planCacheSize = Math.max(1, options.planCacheSize ?? 8)
  }

  /**
   * Work out how to restyle `source` with `palette`.
   *
   * Returns actions in source order. Nothing is applied and `source` is not
   * modified; a plan is a proposal. Applying it is `applyRemapPlan`, or any
   * caller that resolves the actions through `applyEditsToSource` — the actions
   * are `{ range, replacement }`, never a re-serialization of the tree.
   */
  plan(source: string, palette: Palette, options: PaletteRemapOptions = {}): TransformationPlan {
    const cached = this.analysisFor(source)
    const key = planKey(palette, options)

    const memo = cached.plans.get(key)
    if (memo !== undefined) {
      this.planHits++
      return memo
    }

    const decision = new PaletteRemapDecision(palette, options)
    const plan = decision.run(cached.report, RESTYLE_CONTEXT)

    cached.plans.set(key, plan)
    if (cached.plans.size > this.planCacheSize) {
      const oldest = cached.plans.keys().next().value
      if (oldest !== undefined) cached.plans.delete(oldest)
    }
    return plan
  }

  /** The analysis report for `source`, computed once and reused. */
  report(source: string): AnalysisReport {
    return this.analysisFor(source).report
  }

  /** Forget every analysed source and every plan. */
  clear(): void {
    this.analyses.clear()
    this.analysesRun = 0
    this.hits = 0
    this.misses = 0
    this.planHits = 0
  }

  get stats(): PaletteRemapPlannerStats {
    return {
      analyses: this.analysesRun,
      cacheHits: this.hits,
      cacheMisses: this.misses,
      planHits: this.planHits,
      cachedSources: this.analyses.size,
    }
  }

  // ── Internal ────────────────────────────────────────────────────

  private analysisFor(source: string): CachedAnalysis {
    const existing = this.analyses.get(source)
    if (existing !== undefined) {
      this.hits++
      // Refresh LRU position: delete + set is O(1) and leaves the other entries
      // in their previous order.
      this.analyses.delete(source)
      this.analyses.set(source, existing)
      return existing
    }

    this.misses++
    this.analysesRun++
    const entry: CachedAnalysis = {
      report: source === '' ? emptyReport() : this.analyse(source),
      plans: new Map(),
    }

    this.analyses.set(source, entry)
    if (this.analyses.size > this.cacheSize) {
      const oldest = this.analyses.keys().next().value
      if (oldest !== undefined) this.analyses.delete(oldest)
    }
    return entry
  }

  private analyse(source: string): AnalysisReport {
    // Green only on purpose. `RestyleAnalyzer` reads the immutable green tree;
    // it never asks for a parent, an absolute range or a node id. Building a
    // `BBCodeDocumentModel` here would pay for the entire red tree — 38 522
    // nodes on the 547 KB fixture, roughly half of a warm parse — and then
    // throw it away one statement later. `parseBBCode` runs the same lexer and
    // parser with the same defaults (miliastry, quasar pairing, paragraph
    // grouping) and stops at green.
    const green = parseBBCode(source)

    const started = performance.now()
    const contributions = new RestyleAnalyzer(source).run(green, RESTYLE_CONTEXT)
    return {
      contributions: Object.freeze(contributions),
      passCount: 1,
      elapsedMs: performance.now() - started,
    }
  }
}

/**
 * Apply a remap plan to source text in one pass.
 *
 * The obvious loop — splice once per action, last range first — is correct and
 * quadratic in the wrong direction: every splice copies the whole document.
 * A style-heavy page has thousands of colour actions, so a 250 KB page with
 * 4 000 actions copies roughly a billion characters (~half a second). Walking
 * forward once and joining the untouched spans is linear and turns that into a
 * few milliseconds. This is the same shape as `applyEditsToSource`, which is
 * the general form; this one avoids materialising a second array of edits.
 *
 * Overlapping actions are skipped rather than interleaved: a plan should not
 * contain them, and a caller passing an arbitrary subset gets the same
 * "first in reading order wins" contract as the segment preview.
 */
export function applyRemapActions(
  source: string,
  actions: readonly RemapAction[],
): string {
  if (actions.length === 0) return source

  let ordered: readonly RemapAction[] = actions
  for (let i = 1; i < actions.length; i++) {
    if (actions[i].payload.range.start < actions[i - 1].payload.range.start) {
      ordered = [...actions].sort(
        (a, b) => a.payload.range.start - b.payload.range.start ||
          a.payload.range.end - b.payload.range.end,
      )
      break
    }
  }

  const segments: string[] = []
  let cursor = 0

  for (const action of ordered) {
    const { start, end } = action.payload.range
    if (start < cursor) continue
    if (start > cursor) segments.push(source.slice(cursor, start))
    if (action.payload.replacement !== '') segments.push(action.payload.replacement)
    cursor = end
  }

  if (cursor < source.length) segments.push(source.slice(cursor))
  return segments.join('')
}
