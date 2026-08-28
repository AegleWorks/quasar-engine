/**
 * Quasar Analysis Framework — Symbol Analyzer
 *
 * Exercised against *parsed* documents rather than hand-built Green Trees,
 * because the analyzer's whole contract is that its offsets address real
 * source. Every assertion that involves a range slices it back out of the
 * input, so a drifting offset fails the test rather than passing silently.
 *
 * @see RoundTrip.test.ts — the same discipline applied to the export boundary
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../../BBCode/BBCodeDocumentModel'
import { PipelineBuilder } from '../Pipeline/PipelineBuilder'
import { SymbolAnalyzer } from '../Passes/Analysis/SymbolAnalyzer'
import { PipelineMode, ExportTarget } from '../Contracts/PipelineContext'
import type { PipelineContext } from '../Contracts/PipelineContext'
import type { SemanticContribution } from '../Contracts/Contribution'
import { ContributionKind } from '../Contracts/Contribution'
import type { SymbolRunModel } from '../Passes/Analysis/SymbolAnalyzer'

// ── Helpers ───────────────────────────────────────────────────────

const context: PipelineContext = {
  mode: PipelineMode.Interactive,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

interface Found {
  readonly label: string
  readonly confidence: number
  readonly range: { start: number; end: number }
  readonly model: SymbolRunModel
  /** The run sliced back out of the original source by its reported range. */
  readonly slice: string
}

function analyze(source: string): Found[] {
  const model = new BBCodeDocumentModel({ autoAnalyze: false })
  model.rebuild(source)

  const result = new PipelineBuilder()
    .analysis(new SymbolAnalyzer())
    .build()
    .run(model.greenRoot!, context)

  return result.report.contributions
    .filter((c): c is SemanticContribution => c.kind === ContributionKind.Semantic)
    .map(c => ({
      label: c.label,
      confidence: c.confidence,
      range: c.range,
      model: c.metadata.model as SymbolRunModel,
      slice: source.slice(c.range.start, c.range.end),
    }))
}

// ── Detection ─────────────────────────────────────────────────────

describe('symbol detection', () => {
  it('finds nothing in ordinary prose', () => {
    expect(analyze('just some words, punctuation; and numbers 123.')).toEqual([])
  })

  it('reports each ornament framing a word separately', () => {
    const found = analyze('[centre]✧ airi ✧[/centre]')

    expect(found).toHaveLength(2)
    expect(found.map(f => f.label)).toEqual(['Symbol', 'Symbol'])
    expect(found.map(f => f.slice)).toEqual(['✧', '✧'])
  })

  it('reports a divider as a single run', () => {
    const found = analyze('[color=#D194B3]✧⋆⋅⋆⋅⋆✧[/color]')

    expect(found).toHaveLength(1)
    expect(found[0].label).toBe('Separator')
    expect(found[0].slice).toBe('✧⋆⋅⋆⋅⋆✧')
    expect(found[0].model.length).toBe(7)
  })

  it('splits runs that are interrupted by text', () => {
    const found = analyze('✧✧ middle ✧✧')

    expect(found).toHaveLength(2)
    expect(found.map(f => f.slice)).toEqual(['✧✧', '✧✧'])
  })

  it('records the distinct blocks a mixed run draws from', () => {
    const found = analyze('♡━━━━━♡')

    expect(found).toHaveLength(1)
    expect(found[0].model.blocks).toEqual(['misc-symbols', 'box-drawing'])
  })
})

// ── Offsets ───────────────────────────────────────────────────────

describe('offsets address the original source', () => {
  it('every reported range slices back to its own run', () => {
    const source = [
      '[centre]',
      '[color=#D194B3]━━━━━━━━━━━━[/color]',
      '[size=150][b]✧ airi ✧[/b][/size]',
      '[/centre]',
      '[box=Stats]',
      '[*]✿ first',
      '[/box]',
    ].join('\n')

    const found = analyze(source)
    expect(found.length).toBeGreaterThan(0)

    for (const f of found) {
      expect(f.slice).toBe(f.model.text)
    }
  })

  it('gives each glyph in a run its own addressable offsets', () => {
    const source = 'a ✧⋆✦ b'
    const found = analyze(source)

    expect(found).toHaveLength(1)
    expect(found[0].model.glyphs.map(g => source.slice(g.start, g.end))).toEqual(['✧', '⋆', '✦'])
  })

  /**
   * Astral symbols occupy two UTF-16 units. Iterating by index rather than by
   * code point would cut them into unpaired surrogates that match no block —
   * so `🌸` would vanish and every offset after it would be wrong.
   */
  it('handles astral symbols without splitting surrogate pairs', () => {
    const source = '⛧ dark 🌸 sakura'
    const found = analyze(source)

    expect(found.map(f => f.slice)).toEqual(['⛧', '🌸'])

    const flower = found[1]
    expect(flower.range.end - flower.range.start).toBe(2)  // UTF-16 units
    expect(flower.model.length).toBe(1)                    // one glyph
  })

  it('keeps offsets correct for text following an astral symbol', () => {
    const source = '🌸 then ✧'
    const found = analyze(source)

    expect(found.map(f => f.slice)).toEqual(['🌸', '✧'])
  })
})

// ── Confidence ────────────────────────────────────────────────────

describe('confidence reflects how safely ornamental a run is', () => {
  it('rates a lone maths operator below a dingbat', () => {
    const [maths] = analyze('result ≈ 5')
    const [dingbat] = analyze('done ✧')

    expect(maths.confidence).toBeLessThan(dingbat.confidence)
  })

  /**
   * `≈` and `→` are ordinary in prose. They are still *reported* — silently
   * dropping them would hide them from a consumer that wants to offer them —
   * but they arrive doubtful enough for a UI to leave them unchecked.
   */
  it('keeps prose-plausible glyphs below the 0.7 mark', () => {
    const found = analyze('result ≈ 5 and x → y')

    expect(found.map(f => f.slice)).toEqual(['≈', '→'])
    for (const f of found) expect(f.confidence).toBeLessThan(0.7)
  })

  it('rates a long divider as near-certain decoration', () => {
    const [found] = analyze('━━━━━━━━━━━━')

    expect(found.confidence).toBeGreaterThan(0.9)
  })

  it('lifts a maths-heavy run once it is long enough to be a divider', () => {
    const [ornament] = analyze('a ⋆ b')
    const [divider] = analyze('⋆⋅⋆⋅⋆⋅⋆')

    expect(divider.confidence).toBeGreaterThan(ornament.confidence)
  })

  it('never reports certainty', () => {
    const [found] = analyze('✧✧✧✧✧✧✧✧✧✧')

    expect(found.confidence).toBeLessThanOrEqual(0.99)
  })

  it('takes the lowest confidence in a mixed run', () => {
    // Dingbat bookends around maths operators: the maths sets the floor.
    const [mixed] = analyze('✧⋆⋅⋆✧')
    const [pure] = analyze('✧✧✧✧✧')

    expect(mixed.confidence).toBeLessThan(pure.confidence)
  })
})

// ── Content that must not be touched ──────────────────────────────

describe('opaque content is left alone', () => {
  it('ignores symbols inside a code block', () => {
    expect(analyze('[code]✧ literal ✧[/code]')).toEqual([])
  })

  it('ignores symbols inside inline code', () => {
    expect(analyze('[c]✧[/c]')).toEqual([])
  })

  it('ignores an image URL', () => {
    expect(analyze('[img]https://example.com/✧.png[/img]')).toEqual([])
  })

  it('still finds symbols beside a code block', () => {
    const found = analyze('✧ before [code]✧ inside ✧[/code] after ✧')

    expect(found).toHaveLength(2)
    for (const f of found) expect(f.slice).toBe('✧')
  })

  /**
   * An element node's own `text` holds its attributes, so a hex colour is
   * never mistaken for content. This matters because `#` and digits sit
   * outside the symbol blocks — the guarantee is structural, not incidental.
   */
  it('does not scan tag attributes', () => {
    expect(analyze('[color=#D194B3]plain[/color]')).toEqual([])
  })
})

// ── Known gap ─────────────────────────────────────────────────────

/**
 * A box title is stored in the node's leading width, not as a child text
 * node — `[box=✧ Stats ✧]` keeps its title inside the opening delimiter. The
 * analyzer only scans `text` leaves, so titles are invisible to it.
 *
 * Pinned rather than fixed: reaching into `rawTitle` means reporting offsets
 * into a string that is not the document, and no consumer needs re-themed box
 * titles yet. This test exists so the day one does, the gap is already
 * described instead of discovered.
 */
describe('known gap: box titles', () => {
  it('does not see symbols in a box title', () => {
    expect(analyze('[box=✧ Stats ✧]body[/box]')).toEqual([])
  })

  it('still sees symbols in the box body', () => {
    const found = analyze('[box=✧ Stats ✧]✧ body[/box]')

    expect(found).toHaveLength(1)
    expect(found[0].slice).toBe('✧')
  })
})

// ── The themes this was built for ─────────────────────────────────

/**
 * The glyph and separator inventory of `lib/aura/themes.ts`. If a theme ships
 * a symbol this analyzer cannot see, re-theming would silently skip it.
 */
describe('every Aura theme glyph is recognised', () => {
  const THEME_SYMBOLS = '✧⋆✦♡☆⚔☠✟♰⛧◈◆▣⬡⌬☽☄✿❀❁✾≈⋄○⚜'
  const THEME_SEPARATORS = ['✧⋆⋅⋆⋅⋆✧', '♡━━━━━♡', '⛧━━━━━⛧', '☠═══════☠', '✟────────✟', '◈══════◈', '⬡────────⬡']

  for (const glyph of THEME_SYMBOLS) {
    it(`recognises ${glyph}`, () => {
      const found = analyze(`a ${glyph} b`)

      expect(found).toHaveLength(1)
      expect(found[0].slice).toBe(glyph)
    })
  }

  for (const separator of THEME_SEPARATORS) {
    it(`recognises the divider ${separator}`, () => {
      const found = analyze(separator)

      expect(found).toHaveLength(1)
      expect(found[0].label).toBe('Separator')
      expect(found[0].slice).toBe(separator)
    })
  }
})
