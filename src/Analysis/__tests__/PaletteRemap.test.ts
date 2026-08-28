/**
 * Quasar Analysis Framework — Palette Remap
 *
 * Covers `ColorUsageAnalyzer` and `PaletteRemapDecision` together, because
 * neither is useful alone: the analyzer supplies per-tag offsets, the gradient
 * analyzer supplies the ramp those tags belong to, and the decision joins them.
 *
 * Most assertions run the plan through `applyPlan` and check the resulting
 * *document*. Asserting on action payloads alone would let an off-by-one in a
 * range pass unnoticed; rewriting the source with them cannot.
 *
 * @see RoundTrip.test.ts — establishes that editing by range is the safe move
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../../BBCode/BBCodeDocumentModel'
import { PipelineBuilder } from '../Pipeline/PipelineBuilder'
import { GradientAnalyzer } from '../Passes/Analysis/GradientAnalyzer'
import { ColorUsageAnalyzer } from '../Passes/Analysis/ColorUsageAnalyzer'
import { SymbolAnalyzer } from '../Passes/Analysis/SymbolAnalyzer'
import { PaletteRemapDecision } from '../Passes/Decision/PaletteRemapDecision'
import type { Palette, RemapAction } from '../Passes/Decision/PaletteRemapDecision'
import { PipelineMode, ExportTarget } from '../Contracts/PipelineContext'
import type { PipelineContext } from '../Contracts/PipelineContext'
import { ContributionKind } from '../Contracts/Contribution'
import type { SemanticContribution } from '../Contracts/Contribution'
import type { ColorUsageModel } from '../Passes/Analysis/ColorUsageAnalyzer'

// ── Fixtures ──────────────────────────────────────────────────────

const context: PipelineContext = {
  mode: PipelineMode.Interactive,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

/** `sakura` from the application's Aura theme catalogue. */
const SAKURA: Palette = {
  colors: ['#FFB7C5', '#FF69B4', '#FFC0CB', '#FF1493', '#FFE4E1'],
  symbols: ['✿', '❀', '❁', '✾', '♡'],
  separators: ['✿━━━━━✿', '❀═══════❀', '❁────────❁'],
}

function planFor(source: string, palette: Palette = SAKURA, minConfidence?: number): RemapAction[] {
  const model = new BBCodeDocumentModel({ autoAnalyze: false })
  model.rebuild(source)

  const result = new PipelineBuilder()
    .analysis(new GradientAnalyzer(), new ColorUsageAnalyzer(), new SymbolAnalyzer())
    .decision(new PaletteRemapDecision(palette, minConfidence === undefined ? {} : { minConfidence }))
    .build()
    .run(model.greenRoot!, context)

  return result.plan.actions as RemapAction[]
}

/**
 * Rewrite the source with a plan — last range first.
 *
 * Front to back, the first replacement would shift every offset after it and
 * each subsequent edit would land in the wrong place. This ordering is part of
 * the plan's contract, so the tests apply it the way a consumer must.
 */
function applyPlan(source: string, actions: readonly RemapAction[]): string {
  let out = source
  for (const action of [...actions].reverse()) {
    const { range, replacement } = action.payload
    out = out.slice(0, range.start) + replacement + out.slice(range.end)
  }
  return out
}

function remap(source: string, palette: Palette = SAKURA): string {
  return applyPlan(source, planFor(source, palette))
}

// ── ColorUsageAnalyzer ────────────────────────────────────────────

describe('colour usage detection', () => {
  function colours(source: string): Array<{ model: ColorUsageModel; openSlice: string }> {
    const model = new BBCodeDocumentModel({ autoAnalyze: false })
    model.rebuild(source)

    const result = new PipelineBuilder()
      .analysis(new ColorUsageAnalyzer())
      .build()
      .run(model.greenRoot!, context)

    return result.report.contributions
      .filter((c): c is SemanticContribution => c.kind === ContributionKind.Semantic)
      .map(c => {
        const m = c.metadata.model as ColorUsageModel
        return { model: m, openSlice: source.slice(m.openStart, m.openEnd) }
      })
  }

  it('reports the opening delimiter of every colour tag', () => {
    const found = colours('[color=#D194B3]a[/color] plain [color=#FF0000]b[/color]')

    expect(found.map(f => f.openSlice)).toEqual(['[color=#D194B3]', '[color=#FF0000]'])
    expect(found.map(f => f.model.hex)).toEqual(['#D194B3', '#FF0000'])
  })

  it('normalises the hex to uppercase', () => {
    expect(colours('[color=#d194b3]a[/color]')[0].model.hex).toBe('#D194B3')
  })

  it('finds colours nested inside other tags', () => {
    const found = colours('[centre][b][color=#FF0000]x[/color][/b][/centre]')

    expect(found).toHaveLength(1)
    expect(found[0].openSlice).toBe('[color=#FF0000]')
  })

  it('reports nothing for a document without colours', () => {
    expect(colours('[b]bold[/b] and [i]italic[/i]')).toEqual([])
  })

  /**
   * `extractHex` accepts only full six-digit hex, so shorthand and named
   * colours are parsed by the engine but invisible to this pass. Rewriting
   * them would mean picking a canonical spelling their author did not use.
   */
  it('ignores shorthand and named colours', () => {
    expect(colours('[color=#F00]a[/color][color=red]b[/color]')).toEqual([])
  })
})

// ── Standalone colours ────────────────────────────────────────────

describe('standalone colours map to their nearest palette entry', () => {
  it('rewrites only the opening delimiter, leaving content untouched', () => {
    expect(remap('[color=#D194B3]hello world[/color]')).toBe('[color=#FF69B4]hello world[/color]')
  })

  it('sends a pink to the palette pink rather than to the first entry', () => {
    // #FF1493 (deep pink) is nearer this input than #FFB7C5, the first colour.
    const [action] = planFor('[color=#E00080]x[/color]')

    expect(action.payload.to).toBe('#FF1493')
    expect(SAKURA.colors.indexOf(action.payload.to)).toBeGreaterThan(0)
  })

  it('emits nothing for a colour already on the palette', () => {
    expect(planFor('[color=#FF69B4]x[/color]')).toEqual([])
  })

  it('leaves everything outside the colour tags byte for byte', () => {
    const source = '[b]before[/b] [color=#D194B3]  spaced  [/color]\n\nafter'

    expect(remap(source)).toBe('[b]before[/b] [color=#FF69B4]  spaced  [/color]\n\nafter')
  })
})

// ── Gradients ─────────────────────────────────────────────────────

describe('gradients keep their shape', () => {
  const GRADIENT =
    '[color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color][color=#CC3300]l[/color][color=#BB4400]o[/color]'

  it('recolours every member of the ramp', () => {
    const actions = planFor(GRADIENT)

    expect(actions).toHaveLength(5)
    for (const action of actions) expect(action.payload.gradient).toBe(true)
  })

  it('preserves the stop count rather than the palette length', () => {
    // Three members, five palette colours: the result still has three stops.
    const short =
      '[color=#FF0000]a[/color][color=#DD2200]b[/color][color=#BB4400]c[/color]'

    expect(planFor(short)).toHaveLength(3)
  })

  it('anchors the ramp on the palette endpoints', () => {
    const actions = planFor(GRADIENT)

    expect(actions[0].payload.to).toBe('#FFB7C5')                      // palette first
    expect(actions[actions.length - 1].payload.to).toBe('#FFE4E1')     // palette last
  })

  it('samples distinct colours through the middle of the ramp', () => {
    const produced = planFor(GRADIENT).map(a => a.payload.to)

    expect(new Set(produced).size).toBe(produced.length)
  })

  it('emits every hex in one canonical spelling', () => {
    // Interpolated stops arrive lowercase from `mixHexOklab`; palette
    // endpoints arrive as written. Mixed output would be a visible mess.
    for (const action of planFor(GRADIENT)) {
      expect(action.payload.to).toBe(action.payload.to.toUpperCase())
      expect(action.payload.to).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('marks standalone colours as not belonging to a gradient', () => {
    const [action] = planFor('[color=#D194B3]x[/color]')

    expect(action.payload.gradient).toBe(false)
  })

  it('treats colours outside the gradient span separately', () => {
    // Plain text between the two keeps the analyzer from reading them as one
    // run, so the lone colour is matched individually and the ramp is intact.
    const source = `[color=#111111]lone[/color] plain text ${GRADIENT}`
    const actions = planFor(source)

    expect(actions[0].payload.gradient).toBe(false)
    for (const action of actions.slice(1)) expect(action.payload.gradient).toBe(true)
  })

  /**
   * GradientAnalyzer scores unlikely runs down rather than discarding them: a
   * lone `#111111` butted against a real gradient produces a single six-colour
   * candidate at 0.13 confidence, because those colours do not form a ramp.
   *
   * Sampling a palette across that would invent a gradient the document never
   * had. Below the threshold the candidate is ignored and its colours are
   * matched individually — which for a near-black means the palette's darkest
   * entry, not the first step of a pink ramp.
   */
  it('ignores a low-confidence gradient candidate', () => {
    const source = `[color=#111111]lone[/color]${GRADIENT}`
    const actions = planFor(source)

    expect(actions).toHaveLength(6)
    for (const action of actions) expect(action.payload.gradient).toBe(false)
  })

  it('still recolours the members of a rejected candidate', () => {
    const source = `[color=#111111]lone[/color]${GRADIENT}`
    const [first] = planFor(source)

    expect(first.payload.from).toBe('#111111')
    expect(SAKURA.colors).toContain(first.payload.to)
  })
})

// ── Symbols and separators ────────────────────────────────────────

describe('glyph substitution', () => {
  it('swaps ornaments glyph for glyph', () => {
    expect(remap('[centre]✧ airi ✧[/centre]')).toBe('[centre]✿ airi ✿[/centre]')
  })

  it('replaces a divider wholesale', () => {
    expect(remap('━━━━━━━━━━━━')).toBe('✿━━━━━✿')
  })

  it('keeps one source glyph on one replacement across the document', () => {
    const actions = planFor('✧ one ✧ two ✧')

    expect(actions).toHaveLength(3)
    expect(new Set(actions.map(a => a.payload.to)).size).toBe(1)
  })

  it('gives different source glyphs different replacements', () => {
    const actions = planFor('✧ and ⚔')

    expect(actions.map(a => a.payload.to)).toEqual(['✿', '❀'])
  })

  /**
   * Without this, restyling a document into the theme it already wears would
   * shuffle it: an unthemed rule seen first would claim `separators[0]`, and
   * the document's own `separators[0]` would be displaced to the next entry.
   */
  it('leaves a glyph the palette already owns in place', () => {
    expect(remap('✿ and ❀')).toBe('✿ and ❀')
  })

  it('does not hand an owned glyph to a different source', () => {
    // The unowned `✧` comes first, so a naive first-seen assignment would give
    // it `✿` and push the real `✿` onto `❀`.
    const actions = planFor('✧ then ✿')

    expect(actions).toHaveLength(1)
    expect(actions[0].payload.from).toBe('✧')
    expect(actions[0].payload.to).not.toBe('✿')
  })

  it('is idempotent', () => {
    const source = '[color=#D194B3]━━━━━━ ✧ airi ✧[/color]'
    const once = remap(source)

    expect(remap(once)).toBe(once)
  })

  it('wraps around when the palette runs shorter than the document', () => {
    // Six distinct glyphs, five palette symbols.
    const actions = planFor('✧ ⚔ ☽ ◈ ⌬ ☄')

    expect(actions).toHaveLength(6)
    expect(actions[5].payload.to).toBe(actions[0].payload.to)
  })

  it('does not touch symbols inside a code block', () => {
    expect(remap('[code]✧ literal ✧[/code]')).toBe('[code]✧ literal ✧[/code]')
  })
})

// ── Confidence ────────────────────────────────────────────────────

describe('confidence is reported, never used to hide findings', () => {
  /**
   * A glyph that is probably arithmetic still reaches the caller — it simply
   * arrives marked. Dropping it would make it impossible to offer.
   */
  it('emits prose-plausible glyphs marked as not recommended', () => {
    const [action] = planFor('result ≈ 5')

    expect(action.payload.from).toBe('≈')
    expect(action.payload.recommended).toBe(false)
  })

  it('recommends confident decoration', () => {
    const [action] = planFor('done ✧')

    expect(action.payload.recommended).toBe(true)
  })

  it('honours a caller-supplied threshold', () => {
    const strict = planFor('done ✧', SAKURA, 0.99)

    expect(strict[0].payload.recommended).toBe(false)
  })

  it('treats a parsed colour tag as certain', () => {
    const [action] = planFor('[color=#D194B3]x[/color]')

    expect(action.payload.confidence).toBe(1)
    expect(action.payload.recommended).toBe(true)
  })
})

// ── Plan mechanics ────────────────────────────────────────────────

describe('the plan itself', () => {
  const MIXED = '[color=#D194B3]✧ airi ✧[/color] tail ━━━━━━'

  it('is emitted in source order', () => {
    const starts = planFor(MIXED).map(a => a.payload.range.start)

    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('reports ranges that slice back to what they claim to replace', () => {
    for (const action of planFor(MIXED)) {
      const { range, from } = action.payload
      const slice = MIXED.slice(range.start, range.end)
      // A recolor replaces the whole delimiter; a glyph action replaces itself.
      expect(action.kind === 'recolor' ? slice.includes(from) : slice).toBeTruthy()
      if (action.kind !== 'recolor') expect(slice).toBe(from)
    }
  })

  it('produces the same plan every run', () => {
    const first = planFor(MIXED)
    const second = planFor(MIXED)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('is a no-op for a document with nothing to restyle', () => {
    const source = '[b]just words[/b] and 123.'

    expect(planFor(source)).toEqual([])
    expect(remap(source)).toBe(source)
  })

  it('restyles a realistic userpage without disturbing its structure', () => {
    const source = [
      '[centre]',
      '[color=#D194B3]━━━━━━━━━━━━[/color]',
      '[size=150][b]✧ airi ✧[/b][/size]',
      '[/centre]',
      '',
      '[box=Stats]',
      '[list]',
      '[*][b]RANK:[/b] #1234',
      '[/list]',
      '[/box]',
    ].join('\n')

    const restyled = remap(source)

    // Structure survives: same tags, same line count, same text.
    expect(restyled.split('\n')).toHaveLength(source.split('\n').length)
    expect(restyled).toContain('[box=Stats]')
    expect(restyled).toContain('[*][b]RANK:[/b] #1234')
    // Style changed.
    expect(restyled).toContain('[color=#FF69B4]')
    expect(restyled).toContain('✿ airi ✿')
    expect(restyled).not.toContain('#D194B3')
  })
})

// ── Degenerate palettes ───────────────────────────────────────────

describe('degenerate palettes', () => {
  it('plans nothing for colours when the palette has none', () => {
    const bare: Palette = { colors: [], symbols: ['✿'], separators: [] }
    const actions = planFor('[color=#D194B3]✧[/color]', bare)

    expect(actions.every(a => a.kind !== 'recolor')).toBe(true)
  })

  it('collapses a gradient onto a single-colour palette', () => {
    const mono: Palette = { colors: ['#000000'], symbols: [], separators: [] }
    const actions = planFor(
      '[color=#FF0000]a[/color][color=#EE1100]b[/color][color=#DD2200]c[/color]',
      mono,
    )

    expect(actions).toHaveLength(3)
    expect(new Set(actions.map(a => a.payload.to))).toEqual(new Set(['#000000']))
  })

  it('leaves separators alone when the palette offers none', () => {
    const noSeparators: Palette = { colors: [], symbols: ['✿'], separators: [] }

    expect(remap('━━━━━━', noSeparators)).toBe('━━━━━━')
  })
})
