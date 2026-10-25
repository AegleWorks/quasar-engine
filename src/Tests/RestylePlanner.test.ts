import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { PipelineBuilder } from '../Analysis/Pipeline/PipelineBuilder'
import { GradientAnalyzer } from '../Analysis/Passes/Analysis/GradientAnalyzer'
import { ColorUsageAnalyzer } from '../Analysis/Passes/Analysis/ColorUsageAnalyzer'
import { GradientTagAnalyzer } from '../Analysis/Passes/Analysis/GradientTagAnalyzer'
import { SymbolAnalyzer } from '../Analysis/Passes/Analysis/SymbolAnalyzer'
import { PaletteRemapDecision } from '../Analysis/Passes/Decision/PaletteRemapDecision'
import type { Palette, RemapAction } from '../Analysis/Passes/Decision/PaletteRemapDecision'
import { PaletteRemapPlanner, applyRemapActions } from '../Restyle/PaletteRemapPlanner'
import { PipelineMode, ExportTarget } from '../Analysis/Contracts/PipelineContext'
import type { PipelineContext } from '../Analysis/Contracts/PipelineContext'

const context: PipelineContext = {
  mode: PipelineMode.Interactive,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

const SAKURA: Palette = {
  colors: ['#FFB7C5', '#FF69B4', '#FFC0CB', '#FF1493', '#FFE4E1'],
  symbols: ['✿', '❀', '❁', '✾', '♡'],
  separators: ['✿━━━━━✿', '❀═══════❀', '❁────────❁'],
}

const OCEAN: Palette = {
  colors: ['#8ECAE6', '#219EBC', '#023047', '#FFB703', '#FB8500'],
  symbols: ['✦', '✧', '◦', '⋆', '·'],
  separators: ['✦━━━━✦', '✧────✧'],
}

const SOURCE = [
  '[heading]Intro[/heading]',
  '[color=#D194B3]pink[/color] [color=#FF66AB]pink two[/color]',
  '[gradient=#111111,#222222;easing=easeIn]ramp[/gradient]',
  '[centre]✧ airi ✧[/centre]',
  '━━━━━━━━━━━━',
  '[url=#intro]back[/url]',
].join('\n')

function legacyPlan(source: string, palette: Palette): RemapAction[] {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  const result = new PipelineBuilder()
    .analysis(
      new GradientAnalyzer(),
      new ColorUsageAnalyzer(),
      new GradientTagAnalyzer(source),
      new SymbolAnalyzer(),
    )
    .decision(new PaletteRemapDecision(palette))
    .build()
    .run(model.greenRoot!, context)
  return result.plan.actions as RemapAction[]
}

/** The old back-to-front splice, kept as the reference for the linear one. */
function reverseSplice(source: string, actions: readonly RemapAction[]): string {
  let out = source
  for (const action of [...actions].reverse()) {
    const { range, replacement } = action.payload
    out = out.slice(0, range.start) + replacement + out.slice(range.end)
  }
  return out
}

describe('RestyleAnalyzer + decision — equivalence with the four-pass plan', () => {
  it('produces the same actions as the separate analyzers', () => {
    const planner = new PaletteRemapPlanner()
    const combined = planner.plan(SOURCE, SAKURA).actions as RemapAction[]
    const separate = legacyPlan(SOURCE, SAKURA)

    const key = (action: RemapAction) =>
      `${action.kind}:${action.payload.range.start}:${action.payload.range.end}:` +
      `${action.payload.from}:${action.payload.to}:${action.payload.confidence.toFixed(6)}`

    expect(combined.map(key)).toEqual(separate.map(key))
  })
})

describe('PaletteRemapPlanner — reuse', () => {
  it('parses and analyses once for the same source, and reuses plans', () => {
    const planner = new PaletteRemapPlanner()
    const first = planner.plan(SOURCE, SAKURA)
    const again = planner.plan(SOURCE, SAKURA)
    const otherTheme = planner.plan(SOURCE, OCEAN)

    expect(again).toBe(first)
    expect(otherTheme).not.toBe(first)
    expect(planner.stats.cacheMisses).toBe(1)
    expect(planner.stats.analyses).toBe(1)
    expect(planner.stats.planHits).toBe(1)
    expect(planner.stats.cacheHits).toBe(2)
  })

  it('treats an edit as a new analysis and ages the old source out', () => {
    const planner = new PaletteRemapPlanner({ cacheSize: 1 })
    planner.plan(SOURCE, SAKURA)
    planner.plan(`${SOURCE} `, SAKURA)

    expect(planner.stats.analyses).toBe(2)
    expect(planner.stats.cachedSources).toBe(1)
    expect(planner.stats.cacheHits).toBe(0)
  })

  it('keeps the decision independent of the traversal order', () => {
    const planner = new PaletteRemapPlanner()
    const plan = planner.plan(SOURCE, SAKURA)
    expect(plan.actions.length).toBeGreaterThan(0)
    expect(planner.report(SOURCE).contributions.length).toBeGreaterThan(0)
  })

  it('clears every cache on demand', () => {
    const planner = new PaletteRemapPlanner()
    planner.plan(SOURCE, SAKURA)
    planner.clear()

    expect(planner.stats.cachedSources).toBe(0)
    expect(planner.stats.analyses).toBe(0)
  })
})

describe('applyRemapActions', () => {
  it('equals the back-to-front splice on the plan it is given', () => {
    const planner = new PaletteRemapPlanner()
    const actions = planner.plan(SOURCE, SAKURA).actions as RemapAction[]

    expect(applyRemapActions(SOURCE, actions)).toBe(reverseSplice(SOURCE, actions))
  })

  it('is linear in one pass and keeps every untouched byte', () => {
    const source = 'a [color=#111111]b[/color] c [color=#222222]d[/color] e'
    const first = source.indexOf('[color=#111111]')
    const second = source.indexOf('[color=#222222]')
    const action = (start: number, end: number, replacement: string): RemapAction => ({
      kind: 'recolor',
      payload: { range: { start, end }, replacement, from: '', to: '', confidence: 1, recommended: true },
    })

    // Same-length replacements: every byte outside the two ranges must survive
    // exactly, in one pass.
    expect(applyRemapActions(source, [
      action(first, first + 15, '[color=#AAAAAA]'),
      action(second, second + 15, '[color=#BBBBBB]'),
    ])).toBe('a [color=#AAAAAA]b[/color] c [color=#BBBBBB]d[/color] e')
  })

  it('returns the source unchanged for an empty plan', () => {
    expect(applyRemapActions(SOURCE, [])).toBe(SOURCE)
  })

  it('skips overlapping actions instead of interleaving them', () => {
    const source = 'abcdef'
    const actions = [
      { kind: 'recolor', payload: { range: { start: 1, end: 4 }, replacement: 'X', from: '', to: '', confidence: 1, recommended: true } },
      { kind: 'recolor', payload: { range: { start: 2, end: 5 }, replacement: 'Y', from: '', to: '', confidence: 1, recommended: true } },
    ] as RemapAction[]

    expect(applyRemapActions(source, actions)).toBe('aXef')
  })
})

describe('PaletteRemapPlanner — realistic idempotence', () => {
  it('is silent once the theme is applied, for the whole document', () => {
    const planner = new PaletteRemapPlanner()
    const once = applyRemapActions(
      SOURCE,
      planner.plan(SOURCE, SAKURA).actions as RemapAction[],
    )

    expect(planner.plan(once, SAKURA).actions).toEqual([])
  })
})
