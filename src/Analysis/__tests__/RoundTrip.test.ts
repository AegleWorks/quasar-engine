/**
 * Quasar Analysis Framework — Source Round-Trip Fidelity
 *
 * Every other test in this folder builds Green Trees by hand with
 * `greenNode()` / `greenLeaf()`. That proves the passes work, but it never
 * proves the framework survives contact with a *parsed* document — and any
 * feature that re-themes an existing user document depends on exactly that.
 *
 * This suite closes the gap by exercising the full chain end to end:
 *
 *   source → BBCodeDocumentModel.rebuild → greenRoot
 *          → Pipeline.run → greenToRedNode → BBCodeExporter.export → source'
 *
 * It answers two questions a document-rewriting feature has to answer before
 * it writes a single byte:
 *
 *   1. Is `source' === source` when nothing was transformed?
 *      (If not, re-exporting a whole document silently rewrites regions the
 *      user never asked to touch.)
 *
 *   2. Do the `range` offsets on Contributions land on the original source
 *      with character precision?
 *      (If they do, edits can be applied surgically to those spans and the
 *      untouched remainder of the document is never re-serialized.)
 *
 * The answers are: yes for canonical BBCode, and yes for offsets — but the
 * exporter normalizes several non-canonical spellings, and corrupts three
 * bare tags outright. Those are pinned below.
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../../Visitors/BBCodeExporter'
import { TagRegistry } from '../../Model/TagRegistry'
import { greenToRedNode } from '../../BBCode/BBCodeToGreenNode'
import { PipelineBuilder } from '../Pipeline/PipelineBuilder'
import { GradientAnalyzer } from '../Passes/Analysis/GradientAnalyzer'
import { MergeableColorAnalyzer } from '../Passes/Analysis/MergeableColorAnalyzer'
import { PipelineMode, ExportTarget } from '../Contracts/PipelineContext'
import type { PipelineContext } from '../Contracts/PipelineContext'
import type { Contribution, SemanticContribution } from '../Contracts/Contribution'
import { ContributionKind } from '../Contracts/Contribution'

// ── Helpers ───────────────────────────────────────────────────────

const registry = new TagRegistry()

const interactiveContext: PipelineContext = {
  mode: PipelineMode.Interactive,
  target: ExportTarget.Miliastry,
  featureFlags: {},
  metadata: {},
}

/**
 * Analysis-only pipeline: observes the tree and returns it untouched.
 *
 * Any difference between input and output is therefore attributable to the
 * parse/export boundary alone, never to a transform.
 */
const identityPipeline = () =>
  new PipelineBuilder()
    .analysis(new GradientAnalyzer(), new MergeableColorAnalyzer())
    .build()

interface RoundTrip {
  readonly source: string
  readonly exported: string
  readonly contributions: readonly Contribution[]
}

/**
 * `target` defaults to 'miliastry' because that is the only target that
 * preserves Miliastry-native tags. Under 'osu' a `[gradient]` is deliberately
 * expanded into per-character `[color]` spans, which is a lossy export, not a
 * round trip. `BBCodeDocumentModel.exportSource` makes the same choice.
 */
function roundTrip(source: string, target: 'miliastry' | 'osu' = 'miliastry'): RoundTrip {
  const model = new BBCodeDocumentModel({ autoAnalyze: false })
  model.rebuild(source)

  const result = identityPipeline().run(model.greenRoot!, interactiveContext)
  const red = greenToRedNode(result.tree)

  return {
    source,
    exported: new BBCodeExporter(registry, target).export(red),
    contributions: result.report.contributions,
  }
}

const semantic = (cs: readonly Contribution[], label: string): SemanticContribution[] =>
  cs.filter(
    (c): c is SemanticContribution =>
      c.kind === ContributionKind.Semantic && c.label === label,
  )

// ── The guarantee ─────────────────────────────────────────────────

describe('round-trip fidelity for canonical BBCode', () => {
  const CANONICAL: Record<string, string> = {
    'plain text': 'hello world',
    'inline tags': '[b]bold[/b] and [i]italic[/i]',
    'per-character gradient':
      '[color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color][color=#CC3300]l[/color][color=#BB4400]o[/color]',
    'significant whitespace': '[centre]\n  [b]hi[/b]\n\n[/centre]\n',
    'tabs inside a block': '[centre]\ta\t[/centre]',
    'unknown tag': '[foo]bar[/foo]',
    'raw content tag': '[code][b]not bold[/b][/code]',
    'named colour': '[color=red]x[/color]',
    'short hex': '[color=#F00]x[/color]',
    'link': '[url=https://osu.ppy.sh]link[/url]',
    'image': '[img]https://a.png[/img]',
    'self-nested tag': '[b][b]x[/b][/b]',
    'empty tag': '[b][/b]',
    'stray closing tag': 'text [/b] more',
    'titled box': '[box=My Title]content[/box]',
    'non-BMP symbols': '⛧ dark ⛧ 🌸 sakura',
    'symbols inside colour': '[color=#D194B3]✧ ⋆ ✦[/color]',
    'miliastry-native gradient': '[gradient=#FF0000,#00FF00]hello[/gradient]',
  }

  for (const [name, source] of Object.entries(CANONICAL)) {
    it(`preserves ${name} byte for byte`, () => {
      expect(roundTrip(source).exported).toBe(source)
    })
  }

  it('preserves a realistic userpage', () => {
    const source = [
      '[centre]',
      '[color=#D194B3]━━━━━━━━━━━━[/color]',
      '[size=150][b]✧ airi ✧[/b][/size]',
      '[size=85][i]just vibing[/i][/size]',
      '[/centre]',
      '',
      '[box=Stats]',
      '[list]',
      '[*][b]RANK:[/b] #1234',
      '[*][b]PP:[/b] 5678',
      '[/list]',
      '[/box]',
      '',
      '[centre]',
      '[size=75][color=#E0A5C4]✧⋆⋅⋆⋅⋆✧[/color][/size]',
      '[/centre]',
    ].join('\n')

    expect(roundTrip(source).exported).toBe(source)
  })
})

// ── Offset fidelity ───────────────────────────────────────────────

describe('contribution offsets address the original source', () => {
  it('a gradient range slices back to exactly the gradient span', () => {
    const source =
      '[color=#FF0000]H[/color][color=#EE1100]e[/color][color=#DD2200]l[/color][color=#CC3300]l[/color][color=#BB4400]o[/color]'
    const { contributions } = roundTrip(source)

    const gradients = semantic(contributions, 'Gradient')
    expect(gradients).toHaveLength(1)

    const { start, end } = gradients[0].range
    expect(source.slice(start, end)).toBe(source)
  })

  it('locates a gradient embedded in surrounding text', () => {
    const prefix = '[centre]intro\n'
    const gradient =
      '[color=#FF0000]a[/color][color=#EE1100]b[/color][color=#DD2200]c[/color][color=#CC3300]d[/color]'
    const source = `${prefix}${gradient}\noutro[/centre]`

    const gradients = semantic(roundTrip(source).contributions, 'Gradient')
    expect(gradients.length).toBeGreaterThanOrEqual(1)

    const { start, end } = gradients[0].range
    expect(source.slice(start, end)).toBe(gradient)
  })

  /**
   * Offsets are UTF-16 code-unit based, matching `String.prototype.slice`.
   *
   * This is what makes `applySurgicalEdit(start, end, text)` safe to drive
   * from a Contribution range without any conversion. It also means a pass
   * that inspects individual glyphs must iterate code *points* (`for…of`),
   * because an astral symbol occupies two units — see the assertion below.
   */
  it('keeps offsets consistent with slice() across astral symbols', () => {
    const source = '⛧[color=#D194B3]🌸 x[/color]⛧'

    expect(source.length).toBe(29)        // UTF-16 code units
    expect([...source].length).toBe(28)   // code points — 🌸 is a surrogate pair

    const model = new BBCodeDocumentModel({ autoAnalyze: false })
    model.rebuild(source)
    const red = greenToRedNode(model.greenRoot!)

    const colorNodes: string[] = []
    red.walk((node) => {
      if (node.kind === 'color') {
        colorNodes.push(source.slice(node.range.start, node.range.end))
      }
    })

    expect(colorNodes).toEqual(['[color=#D194B3]🌸 x[/color]'])
  })
})

// ── Known drift ───────────────────────────────────────────────────

/**
 * The exporter rebuilds BBCode from `kind` + `TagRegistry` + metadata; it does
 * not replay the original bytes. Non-canonical spellings are therefore
 * normalized on the way out.
 *
 * None of this is a problem for a surgical edit — the untouched bytes are
 * never re-serialized. It is only a problem for a whole-document re-export,
 * which is precisely why the re-theming feature must not do one.
 */
describe('known normalization drift', () => {
  const DRIFT: Array<{ name: string; source: string; exported: string }> = [
    { name: 'uppercases tag names', source: '[B]bold[/B]', exported: '[b]bold[/b]' },
    { name: 'lowercases mixed-case tag names', source: '[Color=#FF0000]x[/color]', exported: '[color=#FF0000]x[/color]' },
    { name: 'strips quotes from attributes', source: '[color="#FF0000"]x[/color]', exported: '[color=#FF0000]x[/color]' },
    { name: 'trims the space around the attribute separator', source: '[color = #FF0000]x[/color]', exported: '[color=#FF0000]x[/color]' },
    { name: 'normalizes CRLF to LF', source: '[b]a[/b]\r\n[i]b[/i]', exported: '[b]a[/b]\n[i]b[/i]' },
    { name: 'closes an unclosed tag', source: '[b]never closed', exported: '[b]never closed[/b]' },
  ]

  for (const { name, source, exported } of DRIFT) {
    it(name, () => {
      expect(roundTrip(source).exported).toBe(exported)
    })
  }

  it('expands miliastry-native tags under the osu target', () => {
    const { exported } = roundTrip('[gradient=#FF0000,#00FF00]hello[/gradient]', 'osu')

    expect(exported).not.toContain('[gradient')
    expect(exported).toContain('[color=#FF0000]h[/color]')
  })
})

// ── Bare attribute-bearing tags ───────────────────────────────────

/**
 * A tag written without an attribute must come back without one.
 *
 * `BBCodeExporter.getTagAttributes` used to guard every attribute with
 * `!== undefined`, but the parser stores an empty string for a bare tag — so
 * the guard passed and a stray separator was emitted:
 *
 *   [box]   → [box=]        [color] → [color=]
 *   [quote] → [quote=""]    [size]  → [size=]
 *
 * That is corruption rather than normalization: all of these are ordinary
 * BBCode that real userpages contain, and the emitted form is not what the
 * author wrote. The guards now test for a *present and non-empty* value.
 *
 * @see BBCodeExporter.ts — `hasAttrValue`
 */
describe('bare attribute-bearing tags', () => {
  const BARE = ['box', 'boxw', 'spoilerbox', 'quote', 'color', 'size', 'font', 'email']

  for (const tag of BARE) {
    it(`round-trips a bare [${tag}]`, () => {
      const source = `[${tag}]x[/${tag}]`
      expect(roundTrip(source).exported).toBe(source)
    })
  }

  it('leaves a bare tag bare inside a realistic document', () => {
    const source = [
      '[box]',
      '[centre][color=#D194B3]hi[/color][/centre]',
      '[/box]',
      '[quote]someone said this[/quote]',
    ].join('\n')

    expect(roundTrip(source).exported).toBe(source)
  })
})

/**
 * The emptiness guards must not swallow attributes that are genuinely there.
 */
describe('populated attributes survive the emptiness guard', () => {
  const POPULATED: Record<string, string> = {
    'titled box': '[box=My Title]x[/box]',
    'titled spoilerbox': '[spoilerbox=Spoilers]x[/spoilerbox]',
    'attributed quote': '[quote="airi"]x[/quote]',
    'colour': '[color=#FF0000]x[/color]',
    'size': '[size=150]x[/size]',
    'font': '[font=Comic Sans MS]x[/font]',
    'email': '[email=a@b.com]x[/email]',
  }

  for (const [name, source] of Object.entries(POPULATED)) {
    it(`preserves a ${name}`, () => {
      expect(roundTrip(source).exported).toBe(source)
    })
  }

  /**
   * `[box=Title:#hex]` splits the colour into its own metadata field, so the
   * suffix is reassembled on export. A box carrying only the colour still
   * needs its separator even though the title is empty.
   */
  it('preserves the box colour suffix', () => {
    expect(roundTrip('[box=Stats:#FF0055]x[/box]').exported).toBe('[box=Stats:#FF0055]x[/box]')
  })

  it('preserves a colour suffix with no title', () => {
    expect(roundTrip('[box=:#FF0055]x[/box]').exported).toBe('[box=:#FF0055]x[/box]')
  })
})
