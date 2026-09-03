import { describe, it, expect } from 'vitest'
import { optimizeBBCode, defaultRules, allRules } from '../Edits/Optimizer'
import { MergeAdjacentRule } from '../Edits/Rules/mergeAdjacent'
import { DropEmptyTagsRule } from '../Edits/Rules/dropEmptyTags'
import { DropRedundantNestingRule } from '../Edits/Rules/dropRedundantNesting'
import { ShortenHexRule } from '../Edits/Rules/shortenHex'
import { UnwrapInvisibleColorRule } from '../Edits/Rules/unwrapInvisibleColor'
import { ReorderWrappersRule } from '../Edits/Rules/reorderWrappers'
import type { OptimizationRule } from '../Edits/Rules/Rule'
import { classifyOverlap } from '../Edits/EditPlan'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { GreenNode } from '../Syntax/GreenNode'
import { attributeValue, normalizeColorValue } from '../Edits/Rules/tagValue'

/**
 * Per-rule behaviour. Every rule gets both halves: the documents it must
 * change, and the documents it must leave alone. The second half is the one
 * that matters — a minifier that is too eager silently rewrites what someone
 * wrote.
 */

// ── Helpers ───────────────────────────────────────────────────────

function optimizeWith(source: string, ...rules: OptimizationRule[]): string {
  return optimizeBBCode(source, { rules }).output
}

const STRUCTURAL = new Set(['document', 'paragraph', 'group', 'text', 'spacing', 'empty_line'])

const FLAG_KINDS = new Set(['bold', 'italic', 'underline', 'strikethrough', 'mark'])

interface StyledChar {
  readonly char: string
  /** The computed style in force at this character. */
  readonly styles: string
}

/**
 * The style actually in effect, computed from the tags enclosing a character.
 *
 * Not the tag stack — the *computed* result, because the two differ in exactly
 * the places that matter:
 *
 * - `color` and `font` cascade: the innermost one wins, so nesting the same
 *   colour twice is indistinguishable from nesting it once.
 * - `font_size` renders as a percentage, which is relative to its parent, so
 *   nesting **compounds**: `[size=50][size=50]` is 25%. `sup`/`sub` stack their
 *   offsets the same way.
 * - Everything else keeps its full nesting path, so any structural change to a
 *   block shows up as a difference.
 *
 * Modelling this properly is what makes the invariant able to catch a rule that
 * removes a nested `[size]` — which an earlier version of
 * `drop-redundant-nesting` did.
 */
function computeStyle(stack: readonly { kind: string; value: string }[]): string {
  let color = ''
  let font = ''
  let size = 1
  let sup = 0
  let sub = 0
  const flags = new Set<string>()
  const other: string[] = []

  for (const entry of stack) {
    if (entry.kind === 'color') color = entry.value
    else if (entry.kind === 'font') font = entry.value
    else if (entry.kind === 'font_size') size *= Number(entry.value) || 100
    else if (entry.kind === 'sup') sup++
    else if (entry.kind === 'sub') sub++
    else if (FLAG_KINDS.has(entry.kind)) flags.add(entry.kind)
    else other.push(`${entry.kind}=${entry.value}`)
  }

  return [
    `color:${color}`,
    `font:${font}`,
    `size:${size}`,
    `sup:${sup}`,
    `sub:${sub}`,
    `flags:${[...flags].sort().join('+')}`,
    `path:${other.join('>')}`,
  ].join('|')
}

/** Flatten a document to "which computed style applies to each character". */
function styleProfile(source: string): StyledChar[] {
  const model = new BBCodeDocumentModel({ source, dialect: 'lyne', autoAnalyze: false })
  const root = model.greenRoot
  const out: StyledChar[] = []
  if (!root) return out

  const stack: { kind: string; value: string }[] = []

  const walk = (node: GreenNode): void => {
    if (node.kind === 'text') {
      const styles = computeStyle(stack)
      for (const char of node.text ?? '') out.push({ char, styles })
      return
    }
    if (node.kind === 'spacing' || node.kind === 'empty_line') {
      out.push({ char: '\n', styles: '' })
      return
    }

    const tracked = !STRUCTURAL.has(node.kind)
    if (tracked) {
      const raw = attributeValue(node)
      // Colours are compared by value, not by spelling: `shorten-hex` turns
      // `#FF0000` into `#F00`, which is the same colour and must not read as a
      // change to what the reader sees.
      const value = node.kind === 'color' ? normalizeColorValue(raw) : raw.toLowerCase()
      stack.push({ kind: node.kind, value })
    }
    for (const child of node.children as readonly GreenNode[]) walk(child)
    if (tracked) stack.pop()
  }

  walk(root)
  return out
}

const BLANK = /\s/

/**
 * The invariant every default-preset rule must satisfy: the reader sees the
 * same thing afterwards.
 *
 * Comparing rendered HTML directly does NOT work, and the attempt is
 * instructive — merging two colour spans into one is *supposed* to change the
 * markup. What must be preserved is the styling of the text, not the shape of
 * the tree carrying it.
 *
 * Checked in two parts, because whitespace bridging is a deliberate exception.
 * The text must be identical character for character; the computed style must
 * be identical for every character that draws ink. A space that gains a colour
 * when two colour tags fuse is invisible, which is exactly why the merge rule
 * may absorb it — and why it may not absorb one between two `[u]`.
 */
function expectSameRender(source: string, output: string): void {
  const before = styleProfile(source)
  const after = styleProfile(output)

  expect(after.map(c => c.char).join('')).toBe(before.map(c => c.char).join(''))

  const inked = (profile: StyledChar[]) =>
    profile.filter(c => !BLANK.test(c.char)).map(c => `${c.char}{${c.styles}}`)

  expect(inked(after)).toEqual(inked(before))
}

function expectUnchanged(source: string, ...rules: OptimizationRule[]): void {
  expect(optimizeWith(source, ...rules)).toBe(source)
}

// ── merge-adjacent ────────────────────────────────────────────────

describe('merge-adjacent — transformation', () => {
  const rule = () => new MergeAdjacentRule()

  it('fuses a run of identical colours', () => {
    const source = '[color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]y[/color]'
    expect(optimizeWith(source, rule())).toBe('[color=#FF0000]Hey[/color]')
  })

  it('recognises the whole run in one pass, not pairwise', () => {
    // Five members collapse to one tag. A pairwise rule would need four passes
    // over offsets that no longer exist after the first.
    const source = Array.from({ length: 5 }, (_, i) => `[color=#0F0]${i}[/color]`).join('')
    expect(optimizeWith(source, rule())).toBe('[color=#0F0]01234[/color]')
  })

  it('keeps the first member\'s spelling exactly as written', () => {
    const source = '[Color = "#FF0000"]a[/color][color=#ff0000]b[/color]'
    // Capital C, spaces and quotes all survive: the rule only deletes.
    expect(optimizeWith(source, rule())).toBe('[Color = "#FF0000"]ab[/color]')
  })

  it('treats #F00 and #FF0000 as the same colour', () => {
    const source = '[color=#F00]a[/color][color=#FF0000]b[/color]'
    expect(optimizeWith(source, rule())).toBe('[color=#F00]ab[/color]')
  })

  it('absorbs blank space between colour members', () => {
    const source = '[color=#F00]a[/color] [color=#F00]b[/color]'
    expect(optimizeWith(source, rule())).toBe('[color=#F00]a b[/color]')
  })

  it('fuses identical inline tags too', () => {
    expect(optimizeWith('[b]a[/b][b]b[/b]', rule())).toBe('[b]ab[/b]')
  })

  it('fuses nested levels created by its own merge, in one pass', () => {
    // Merging the two [b] makes the colours siblings; those merge as well.
    const source = '[b][color=#FF0000]a[/color][/b][b][color=#FF0000]bc[/color][/b]'
    expect(optimizeWith(source, rule())).toBe('[b][color=#FF0000]abc[/color][/b]')
  })

  it('handles a long per-character ramp', () => {
    const source = 'x'.repeat(0) + Array.from('gradient', c => `[color=#ABCDEF]${c}[/color]`).join('')
    expect(optimizeWith(source, rule())).toBe('[color=#ABCDEF]gradient[/color]')
  })
})

describe('merge-adjacent — non-transformation', () => {
  const rule = () => new MergeAdjacentRule()

  it('leaves different colours alone', () => {
    expectUnchanged('[color=#FF0000]a[/color][color=#00FF00]b[/color]', rule())
  })

  it('does not merge across visible text', () => {
    expectUnchanged('[color=#F00]a[/color]XX[color=#F00]b[/color]', rule())
  })

  it('does not extend an underline across the gap between two of them', () => {
    // A coloured space is invisible; an underlined one is not.
    expectUnchanged('[u]a[/u] [u]b[/u]', rule())
  })

  it('merges underlines that actually touch', () => {
    expect(optimizeWith('[u]a[/u][u]b[/u]', rule())).toBe('[u]ab[/u]')
  })

  it('does not bridge whitespace for size or font', () => {
    expectUnchanged('[size=50]a[/size] [size=50]b[/size]', rule())
    expectUnchanged('[font=Arial]a[/font] [font=Arial]b[/font]', rule())
  })

  it('leaves a single tag alone', () => {
    expectUnchanged('[color=#F00]only[/color]', rule())
  })

  it('does not merge block tags', () => {
    // Two boxes are two frames; one box is one frame.
    expectUnchanged('[box=A]x[/box][box=A]y[/box]', rule())
    expectUnchanged('[quote]a[/quote][quote]b[/quote]', rule())
  })

  it('does not merge across a paragraph break', () => {
    expectUnchanged('[color=#F00]a[/color]\n[color=#F00]b[/color]', rule())
  })

  it('leaves an unclosed tag alone', () => {
    // The parser synthesises the close, so there are no bytes there to delete.
    expectUnchanged('[color=#F00]a[/color][color=#F00]b', rule())
  })

  it('leaves plain text alone', () => {
    expectUnchanged('just some text with [b]one[/b] tag', rule())
  })
})

// ── drop-empty-tags ───────────────────────────────────────────────

describe('drop-empty-tags — transformation', () => {
  const rule = () => new DropEmptyTagsRule()

  it('removes an empty inline tag', () => {
    expect(optimizeWith('a[b][/b]c', rule())).toBe('ac')
  })

  it('removes an empty colour tag', () => {
    expect(optimizeWith('a[color=#FF0000][/color]c', rule())).toBe('ac')
  })

  it('removes a nested-empty chain as one edit, no second pass', () => {
    const result = optimizeBBCode('a[b][i][/i][/b]c', { rules: [rule()] })
    expect(result.output).toBe('ac')
    expect(result.edits).toHaveLength(1)
  })
})

describe('drop-empty-tags — non-transformation', () => {
  const rule = () => new DropEmptyTagsRule()

  it('keeps an empty box — it still draws a frame', () => {
    expectUnchanged('[box=Title][/box]', rule())
  })

  it('keeps an empty quote', () => {
    expectUnchanged('[quote][/quote]', rule())
  })

  it('keeps tags that hold content', () => {
    expectUnchanged('[b]x[/b]', rule())
  })

  it('keeps a tag holding only a line break', () => {
    // `spacing` is the document's newline, not nothing.
    expectUnchanged('[b]\n[/b]', rule())
  })

  it('keeps an unknown tag', () => {
    expectUnchanged('[wobble][/wobble]', rule())
  })
})

// ── drop-redundant-nesting ────────────────────────────────────────

describe('drop-redundant-nesting — transformation', () => {
  const rule = () => new DropRedundantNestingRule()

  it('removes a colour nested in the same colour', () => {
    expect(optimizeWith('[color=#F00]a[color=#F00]b[/color][/color]', rule()))
      .toBe('[color=#F00]ab[/color]')
  })

  it('matches across spellings', () => {
    expect(optimizeWith('[color=#FF0000][color=#f00]x[/color][/color]', rule()))
      .toBe('[color=#FF0000]x[/color]')
  })

  it('sees an identity inherited through an intervening tag', () => {
    expect(optimizeWith('[color=#F00][b][color=#F00]x[/color][/b][/color]', rule()))
      .toBe('[color=#F00][b]x[/b][/color]')
  })

  it('removes doubled inline tags', () => {
    expect(optimizeWith('[b][b]x[/b][/b]', rule())).toBe('[b]x[/b]')
  })

  it('removes a redundant nested font', () => {
    expect(optimizeWith('[font=Arial][font=Arial]x[/font][/font]', rule()))
      .toBe('[font=Arial]x[/font]')
  })
})

describe('drop-redundant-nesting — non-transformation', () => {
  const rule = () => new DropRedundantNestingRule()

  it('keeps a different colour inside a colour', () => {
    expectUnchanged('[color=#F00]a[color=#0F0]b[/color][/color]', rule())
  })

  it('keeps a different tag inside a tag', () => {
    expectUnchanged('[b]a[i]b[/i][/b]', rule())
  })

  it('keeps nested boxes', () => {
    expectUnchanged('[box=A][box=A]x[/box][/box]', rule())
  })

  it('keeps a nested identical size — percentages compound', () => {
    // [size=50][size=50] renders at 25%, so the inner tag is doing real work.
    expectUnchanged('[size=50][size=50]x[/size][/size]', rule())
  })

  it('keeps a nested identical sup — offsets stack', () => {
    expectUnchanged('[sup][sup]x[/sup][/sup]', rule())
  })

  it('keeps a colour that restores one an inner tag overrode', () => {
    expectUnchanged('[color=#F00][color=#0F0][color=#F00]x[/color][/color][/color]', rule())
  })
})

// ── shorten-hex ───────────────────────────────────────────────────

describe('shorten-hex — transformation', () => {
  const rule = () => new ShortenHexRule()

  it('shortens a doubled-digit hex', () => {
    expect(optimizeWith('[color=#FFAA00]x[/color]', rule())).toBe('[color=#FA0]x[/color]')
  })

  it('keeps everything around the hex untouched', () => {
    expect(optimizeWith('[Color = "#FFAA00"]x[/color]', rule()))
      .toBe('[Color = "#FA0"]x[/color]')
  })

  it('preserves the author\'s digit casing', () => {
    expect(optimizeWith('[color=#ffaa00]x[/color]', rule())).toBe('[color=#fa0]x[/color]')
  })

  it('shortens every colour in a document', () => {
    expect(optimizeWith('[color=#FF0000]a[/color][color=#00FF00]b[/color]', rule()))
      .toBe('[color=#F00]a[/color][color=#0F0]b[/color]')
  })
})

describe('shorten-hex — non-transformation', () => {
  const rule = () => new ShortenHexRule()

  it('leaves a hex that is not reducible', () => {
    expectUnchanged('[color=#FA0B23]x[/color]', rule())
  })

  it('leaves an already-short hex', () => {
    expectUnchanged('[color=#FA0]x[/color]', rule())
  })

  it('leaves colour keywords', () => {
    expectUnchanged('[color=red]x[/color]', rule())
  })

  it('does not touch hex outside a colour attribute', () => {
    expectUnchanged('the code #FFAA00 in text', rule())
  })
})

// ── reorder-wrappers ──────────────────────────────────────────────

describe('reorder-wrappers — transformation', () => {
  const rule = () => new ReorderWrappersRule()

  it('puts colour inside bold', () => {
    expect(optimizeWith('[color=#F00][b]x[/b][/color]', rule()))
      .toBe('[b][color=#F00]x[/color][/b]')
  })

  it('sorts a whole chain in one pass', () => {
    expect(optimizeWith('[color=#F00][b][size=50]x[/size][/b][/color]', rule()))
      .toBe('[size=50][b][color=#F00]x[/color][/b][/size]')
  })

  it('moves the author\'s exact bytes, not a rebuilt tag', () => {
    expect(optimizeWith('[Color = "#F00"][b]x[/b][/color]', rule()))
      .toBe('[b][Color = "#F00"]x[/color][/b]')
  })

  it('is excluded from the default preset because it saves nothing', () => {
    const source = '[color=#F00][b]x[/b][/color]'
    expect(defaultRules().some(r => r.id === 'reorder-wrappers')).toBe(false)
    expect(allRules().some(r => r.id === 'reorder-wrappers')).toBe(true)
    expect(optimizeBBCode(source).output).toBe(source)
  })
})

describe('reorder-wrappers — non-transformation', () => {
  const rule = () => new ReorderWrappersRule()

  it('leaves an already-canonical chain', () => {
    expectUnchanged('[b][color=#F00]x[/color][/b]', rule())
  })

  it('leaves equal-rank wrappers in the author\'s order', () => {
    expectUnchanged('[b][i]x[/i][/b]', rule())
    expectUnchanged('[i][b]x[/b][/i]', rule())
  })

  it('does not reorder around an unranked tag', () => {
    expectUnchanged('[color=#F00][box=A]x[/box][/color]', rule())
  })

  it('does not reorder a wrapper with more than one child', () => {
    expectUnchanged('[color=#F00][b]x[/b]y[/color]', rule())
  })
})

// ── unwrap-invisible-color ────────────────────────────────────────

describe('unwrap-invisible-color — transformation', () => {
  const rule = () => new UnwrapInvisibleColorRule()

  it('unwraps a colour around a single space', () => {
    expect(optimizeWith('[color=#6F518D] [/color]', rule())).toBe(' ')
  })

  it('unwraps every gap in an expanded gradient', () => {
    const source =
      '[color=#6A4C93]a[/color][color=#6F518D] [/color][color=#755687]b[/color]'
    expect(optimizeWith(source, rule()))
      .toBe('[color=#6A4C93]a[/color] [color=#755687]b[/color]')
  })

  it('unwraps nested colours that are all whitespace', () => {
    expect(optimizeWith('[color=#F00][color=#0F0]  [/color][/color]', rule())).toBe('  ')
  })
})

describe('unwrap-invisible-color — non-transformation', () => {
  const rule = () => new UnwrapInvisibleColorRule()

  it('keeps a colour with visible content', () => {
    expectUnchanged('[color=#F00]x[/color]', rule())
  })

  it('keeps an underline around whitespace — the line is visible', () => {
    expectUnchanged('[u] [/u]', rule())
  })

  it('keeps a mark around whitespace — the background is visible', () => {
    expectUnchanged('[mark] [/mark]', rule())
  })

  it('keeps a size around whitespace — it changes the advance width', () => {
    expectUnchanged('[size=200] [/size]', rule())
  })

  it('keeps a font around whitespace', () => {
    expectUnchanged('[font=Arial] [/font]', rule())
  })
})

// ── Regression: bridge vs member ──────────────────────────────────

describe('a whitespace colour is a bridge, never a run member', () => {
  /**
   * Found by the corpus invariant, not by a synthetic case.
   *
   * `merge-adjacent` used to adopt a whitespace-only colour as the FIRST
   * member of a run, which meant it kept that node's opening delimiter — while
   * `unwrap-invisible-color` was independently deleting the very same
   * delimiter. The two edits do not overlap, so the conflict resolver had
   * nothing to arbitrate, and the result was an unbalanced `[/color]`.
   *
   * The lesson is in the contract, not in the case: a rule may not emit an
   * edit whose validity depends on another rule's edit surviving.
   */
  it('does not corrupt a gradient whose gap colour differs by one digit', () => {
    const source =
      '[color=#E83030]X[/color]' +
      '[color=#E83130] [/color]' +
      '[color=#E83130]R[/color][color=#E83130]A[/color][color=#E83130]D[/color]'

    expect(optimizeBBCode(source).output)
      .toBe('[color=#E83030]X[/color] [color=#E83130]RAD[/color]')
  })

  it('still fuses two members separated by a whitespace colour', () => {
    const source =
      '[color=#F00]a[/color][color=#0F0] [/color][color=#F00]b[/color]'
    expect(optimizeBBCode(source).output).toBe('[color=#F00]a b[/color]')
  })

  it('leaves the output balanced', () => {
    const source =
      '[color=#E83030]X[/color][color=#E83130] [/color][color=#E83130]R[/color]'
    const output = optimizeBBCode(source).output
    expect((output.match(/\[color=/g) ?? []).length)
      .toBe((output.match(/\[\/color\]/g) ?? []).length)
  })
})

// ── Cross-rule properties ─────────────────────────────────────────

const SAMPLES = [
  '[color=#FF0000]H[/color][color=#FF0000]e[/color][color=#FF0000]y[/color]',
  '[color=#FFAA00]a[/color][color=#ffaa00]b[/color]',
  '[color=#F00][color=#F00]a[/color][color=#F00]b[/color][/color]',
  '[b][color=#FF0000]a[/color][/b][b][color=#FF0000]bc[/color][/b]',
  'text [b][/b] more [color=#FF0000][/color] end',
  '[box=Title][color=#F00]a[/color][color=#F00]b[/color][/box]',
  '[u]a[/u] [u]b[/u] [color=#F00]c[/color][color=#F00]d[/color]',
  'plain text with no tags at all',
  '[color=#F00]a[/color]\n[color=#F00]b[/color]',
  '[size=50][size=50]x[/size][/size]',
  '[sup][sup]x[/sup][/sup]',
  '[color=#F00][color=#0F0][color=#F00]x[/color][/color][/color]',
  '[font=Arial][font=Arial]deep[/font][/font]',
  '[color=#E83030]X[/color][color=#E83130] [/color][color=#E83130]R[/color][color=#E83130]A[/color]',
  '[color=#F00]a[/color][color=#0F0] [/color][color=#F00]b[/color]',
  '[centre][color=#6A4C93]BARCA[/color][color=#6F518D] [/color][color=#755687]el[/color][/centre]',
]

describe('every rule, over every sample', () => {
  for (const source of SAMPLES) {
    it(`preserves the render of ${JSON.stringify(source.slice(0, 46))}`, () => {
      expectSameRender(source, optimizeBBCode(source).output)
    })

    it(`never grows ${JSON.stringify(source.slice(0, 46))}`, () => {
      const result = optimizeBBCode(source)
      expect(result.output.length).toBeLessThanOrEqual(source.length)
      expect(result.savedChars).toBe(source.length - result.output.length)
    })

    it(`emits no straddling edits for ${JSON.stringify(source.slice(0, 46))}`, () => {
      // Two maximal rules straddling each other means one computed a partial
      // range instead of a whole normal form. It is legal, and it is a smell.
      const { plan } = optimizeBBCode(source)
      expect(plan.rejected.filter(r => r.reason === 'straddle')).toEqual([])
    })

    it(`is deterministic for ${JSON.stringify(source.slice(0, 46))}`, () => {
      const a = optimizeBBCode(source)
      const b = optimizeBBCode(source)
      expect(b.output).toBe(a.output)
      expect(b.edits).toEqual(a.edits)
    })

    it(`converges — a second run finds nothing for ${JSON.stringify(source.slice(0, 46))}`, () => {
      // The maximality claim, made checkable: rules produce their normal form
      // directly, so re-optimising the output must be a no-op.
      const once = optimizeBBCode(source).output
      expect(optimizeBBCode(once).output).toBe(once)
    })

    it(`introduces no unparseable tags for ${JSON.stringify(source.slice(0, 46))}`, () => {
      // The most direct signal that an edit set left the document unbalanced:
      // the parser starts discarding tags it cannot pair.
      const count = (text: string): number => {
        const model = new BBCodeDocumentModel({ source: text, dialect: 'lyne', autoAnalyze: false })
        let discarded = 0
        const walk = (node: GreenNode): void => {
          if (node.kind === 'discarded_tag') discarded++
          for (const child of node.children as readonly GreenNode[]) walk(child)
        }
        if (model.greenRoot) walk(model.greenRoot)
        return discarded
      }
      expect(count(optimizeBBCode(source).output)).toBeLessThanOrEqual(count(source))
    })

    it(`produces non-overlapping edits for ${JSON.stringify(source.slice(0, 46))}`, () => {
      const { edits } = optimizeBBCode(source)
      for (let i = 0; i < edits.length; i++) {
        for (let j = i + 1; j < edits.length; j++) {
          expect(classifyOverlap(edits[i], edits[j])).toBe('disjoint')
        }
      }
    })
  }
})
