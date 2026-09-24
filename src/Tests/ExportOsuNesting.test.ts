import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

/**
 * Export-time same-name-nesting fixes (`Edits/Rules/flattenOsuNesting.ts`)
 * and the editor-side diagnostic that covers what it cannot fix
 * (`SemanticAnalyzer`'s `osu-unsupported-nesting`).
 *
 * Ground truth for the drop/split shapes is the product rule + the real
 * osu-web pipeline measurement already on file in `quasar-nested-color-is-
 * supported` memory: same-name nesting is impossible in osu! for every tag
 * except `box`/`spoilerbox`/`quote` (first opener takes the first closer),
 * and HTML `font-size` percentages compound when nested. The structural
 * assertions below (no same-name pair left in `osu(export(src))`) are the
 * property that measurement backs; a couple of the trickier shapes (colour
 * split around an intervening tag, the size compound) are additionally spot-
 * checked against the docker `php:8.4-cli` osu-web harness — see the session
 * note for the exact runs.
 */

function exportOsu(source: string, dialect: BBCodeDialect = 'miliastry'): string {
  const model = new BBCodeDocumentModel({
    source, dialect, pairing: 'quasar', incremental: false, autoAnalyze: false,
  } as any)
  return new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)
}

function exportMiliastry(source: string): string {
  const model = new BBCodeDocumentModel({
    source, dialect: 'miliastry', pairing: 'quasar', incremental: false, autoAnalyze: false,
  } as any)
  return new BBCodeExporter(model.tagRegistry, 'miliastry').export(model.redRoot!)
}

describe('BBCodeExporter — flatten osu!-unsupported same-name nesting (target osu)', () => {
  it.each([
    ['bold', '[b]A[b]B[/b]C[/b]D', '[b]ABC[/b]D'],
    ['italic', '[i]A[i]B[/i]C[/i]D', '[i]ABC[/i]D'],
    ['underline', '[u]A[u]B[/u]C[/u]D', '[u]ABC[/u]D'],
    ['strikethrough (s)', '[s]A[s]B[/s]C[/s]D', '[s]ABC[/s]D'],
    // BBCodeExporter always canonicalises the deprecated `strike` spelling to
    // `s` on export, independent of this rule — see TagRegistry's
    // `deprecatedReplacement`.
    ['strikethrough (strike)', '[strike]A[strike]B[/strike]C[/strike]D', '[s]ABC[/s]D'],
    ['spoiler', '[spoiler]A[spoiler]B[/spoiler]C[/spoiler]D', '[spoiler]ABC[/spoiler]D'],
  ])('%s (inline): idempotent inner is dropped, no newline budget to reconcile', (_label, src, expected) => {
    expect(exportOsu(src)).toBe(expected)
  })

  // `centre`/`left`/`right`/`heading` render as osu! `<div>`s (block, per
  // `HTMLRenderer.NEWLINE_RULES`), so dropping the inner one must ALSO
  // reconcile the newlines its own opening/closing bracket used to eat —
  // see `Edits/Rules/flattenOsuNesting.ts`'s `fixupBlockNewlines` doc
  // comment. Matrix: with/without a newline around the inner opener/closer,
  // and with the inner tag at the start/middle/end of the outer's content.
  describe.each([
    // `afterOpen`: 'one' for centre/left/right, 'none' for heading — see
    // `HTMLRenderer.NEWLINE_RULES`. `heading` never eats a leading newline,
    // so it is the one tag below where an ALREADY-swallowed leading newline
    // never happens; its own two cases are separate, further down.
    ['centre', 'centre'],
    ['left', 'left'],
    ['right', 'right'],
  ] as const)('%s (block): idempotent inner is dropped, newlines reconciled', (_label, tag) => {
    it('no newlines anywhere, inner in the middle — a line break is INSERTED on both sides (the div boundary was doing the separating)', () => {
      const src = `[${tag}]A[${tag}]B[/${tag}]C[/${tag}]D`
      expect(exportOsu(src)).toBe(`[${tag}]A\nB\nC[/${tag}]D`)
    })

    it('no newlines, inner at the START of the outer — no leading insert (nothing above B to separate from)', () => {
      const src = `[${tag}][${tag}]B[/${tag}]C[/${tag}]D`
      expect(exportOsu(src)).toBe(`[${tag}]B\nC[/${tag}]D`)
    })

    it('no newlines, inner at the END of the outer — no trailing insert (nothing after B to separate from)', () => {
      const src = `[${tag}]A[${tag}]B[/${tag}][/${tag}]D`
      expect(exportOsu(src)).toBe(`[${tag}]A\nB[/${tag}]D`)
    })

    it('inner is the OUTER\'s only content — no insert on either side, brackets just collapse', () => {
      const src = `[${tag}][${tag}]B[/${tag}][/${tag}]`
      expect(exportOsu(src)).toBe(`[${tag}]B[/${tag}]`)
    })

    it('a newline already sits on both sides of the inner tag — the ones the inner ATE are dropped, the already-visible ones survive untouched, and nothing is inserted', () => {
      const src = `[${tag}]A\n[${tag}]\nB\n[/${tag}]\nC[/${tag}]`
      expect(exportOsu(src)).toBe(`[${tag}]A\nB\nC[/${tag}]`)
    })

    it('newlines pad every edge, including the outer\'s own — only the inner tag\'s own budget is touched', () => {
      const src = `[${tag}]\nA\n[${tag}]\nB\n[/${tag}]\nC\n[/${tag}]`
      expect(exportOsu(src)).toBe(`[${tag}]\nA\nB\nC\n[/${tag}]`)
    })

    it('three levels of self-nesting collapse to one tag, one newline per seam', () => {
      const src = `[${tag}]A[${tag}]B[${tag}]C[/${tag}]D[/${tag}]E[/${tag}]`
      expect(exportOsu(src)).toBe(`[${tag}]A\nB\nC\nD\nE[/${tag}]`)
    })
  })

  // `heading` shares centre/left/right's `beforeClose`/`afterClose` budget
  // but NOT `afterOpen` (`'none'`, not `'one'` — `HTMLRenderer.NEWLINE_RULES`):
  // a heading never eats the newline right after its own opening tag, so an
  // inner heading's leading newline stays VISIBLE instead of being dropped —
  // the no-newline/sole-child/triple-nesting shapes are identical (nothing
  // there depends on afterOpen), but the two "already has newlines" cases
  // differ, which is why heading gets its own block instead of joining the
  // `describe.each` above.
  describe('heading (block): idempotent inner is dropped, newlines reconciled', () => {
    it('no newlines anywhere, inner in the middle — a line break is INSERTED on both sides', () => {
      expect(exportOsu('[heading]A[heading]B[/heading]C[/heading]D')).toBe('[heading]A\nB\nC[/heading]D')
    })

    it('no newlines, inner at the START of the outer — no leading insert', () => {
      expect(exportOsu('[heading][heading]B[/heading]C[/heading]D')).toBe('[heading]B\nC[/heading]D')
    })

    it('no newlines, inner at the END of the outer — no trailing insert', () => {
      expect(exportOsu('[heading]A[heading]B[/heading][/heading]D')).toBe('[heading]A\nB[/heading]D')
    })

    it('inner is the OUTER\'s only content — no insert on either side', () => {
      expect(exportOsu('[heading][heading]B[/heading][/heading]')).toBe('[heading]B[/heading]')
    })

    it('a newline already sits on both sides — beforeClose/afterClose eaten ones drop, but afterOpen eats NOTHING for heading, so the leading newline survives instead of being deleted', () => {
      expect(exportOsu('[heading]A\n[heading]\nB\n[/heading]\nC[/heading]')).toBe('[heading]A\n\nB\nC[/heading]')
    })

    it('newlines pad every edge — same, one extra leading newline survives since afterOpen never ate it', () => {
      expect(exportOsu('[heading]\nA\n[heading]\nB\n[/heading]\nC\n[/heading]')).toBe('[heading]\nA\n\nB\nC\n[/heading]')
    })

    it('three levels of self-nesting collapse to one tag, one newline per seam', () => {
      expect(exportOsu('[heading]A[heading]B[heading]C[/heading]D[/heading]E[/heading]')).toBe('[heading]A\nB\nC\nD\nE[/heading]')
    })
  })

  it('color: identical nested value is dropped (inner spelling deleted, outer survives)', () => {
    expect(exportOsu('[color=red]A[color=red]B[/color]C[/color]D')).toBe('[color=red]ABC[/color]D')
  })

  it('color: identical value under a different spelling is still dropped', () => {
    // #F00 and #FF0000 normalise equal — see tagValue.normalizeColorValue.
    // BBCodeExporter itself expands short hex to 6-digit for target 'osu'
    // (`normalizeColorToHex`), independent of this rule, so BOTH tags read
    // #FF0000 by the time this rule sees them — the outer's SPELLING still
    // survives, only the inner's delimiters are gone.
    expect(exportOsu('[color=#F00]A[color=#FF0000]B[/color]C[/color]D')).toBe('[color=#FF0000]ABC[/color]D')
  })

  it('color: different value splits the outer around the inner', () => {
    expect(exportOsu('[color=red]A[color=blue]B[/color]C[/color]D')).toBe(
      '[color=red]A[/color][color=blue]B[/color][color=red]C[/color]D',
    )
  })

  it('color: an intervening tag between outer and inner stays intact and balanced', () => {
    // Spot-checked against the osu-web harness: rendering this flattened form
    // produces the identical DOM (outline + <br> sequence) as the nested
    // source rendered by the default (miliastry) preview.
    expect(exportOsu('[color=a]x [b][color=b]y[/color][/b] z[/color]')).toBe(
      '[color=a]x [/color][b][color=b]y[/color][/b][color=a] z[/color]',
    )
  })

  it('color: two conflicting siblings under one ancestor split independently', () => {
    expect(exportOsu('[color=a]x[color=b]1[/color]y[color=c]2[/color]z[/color]')).toBe(
      '[color=a]x[/color][color=b]1[/color][color=a]y[/color][color=c]2[/color][color=a]z[/color]',
    )
  })

  it('color: two conflicts sharing one intervening ancestor split only once, at its boundary — and since that boundary is the whole of [color=a]\'s content, [color=a] itself (fully overridden, nothing else inside it) disappears rather than leaving an empty pair', () => {
    expect(exportOsu('[color=a][b][color=b]1[/color][color=c]2[/color][/b][/color]')).toBe(
      '[b][color=b]1[/color][color=c]2[/color][/b]',
    )
  })

  it('size: inner=100 is a no-op wrapper and is dropped', () => {
    expect(exportOsu('[size=150]A[size=100]B[/size]C[/size]D')).toBe('[size=150]ABC[/size]D')
  })

  it('size: a splittable compound rewrites the inner to the compounded percentage', () => {
    // 150% of 50% = 75% — spot-checked against the osu-web harness.
    expect(exportOsu('[size=150]A[size=50]B[/size]C[/size]D')).toBe(
      '[size=150]A[/size][size=75]B[/size][size=150]C[/size]D',
    )
  })

  it('size: a non-integer compound is left nested (unfixable — diagnostic covers it)', () => {
    // 150% of 33% = 49.5%, not expressible as a single [size=N].
    const src = '[size=150]A[size=33]B[/size]C[/size]D'
    expect(exportOsu(src)).toBe(src)
  })

  it('size: a compound past osu!\'s ceiling is left nested', () => {
    // 200% of 150% = 300%, past FontSizeLimits' osu! ceiling (200).
    const src = '[size=200]A[size=150]B[/size]C[/size]D'
    expect(exportOsu(src)).toBe(src)
  })

  it.each([
    ['notice', '[notice]A[notice]B[/notice]C[/notice]D'],
    ['list', '[list][*]A[list][*]B[/list]C[/list]D'],
    ['url', '[url=https://a.com]A[url=https://b.com]B[/url]C[/url]D'],
    ['code', '[code]A[code]B[/code]C[/code]D'],
    ['c', '[c]A[c]B[/c]C[/c]D'],
  ])('%s: unfixable nesting is left untouched by export', (_label, src) => {
    expect(exportOsu(src)).toBe(src)
  })

  it.each([
    ['box', '[box=Outer]A[box=Inner]B[/box]C[/box]D'],
    ['spoilerbox', '[spoilerbox]A[spoilerbox]B[/spoilerbox]C[/spoilerbox]D'],
    ['quote', '[quote]A[quote]B[/quote]C[/quote]D'],
  ])('%s: nestable-in-osu kinds are never touched by the flatten rule', (_label, src) => {
    expect(exportOsu(src)).toBe(src)
  })

  it('does nothing for target miliastry — the default preview export is untouched', () => {
    const src = '[color=red]A[color=blue]B[/color]C[/color]D'
    expect(exportMiliastry(src)).toBe(src)
  })

  it('runs under either source dialect (osu / miliastry)', () => {
    const src = '[b]A[b]B[/b]C[/b]D'
    expect(exportOsu(src, 'osu')).toBe('[b]ABC[/b]D')
    expect(exportOsu(src, 'miliastry')).toBe('[b]ABC[/b]D')
  })
})

// ── Diagnostic: osu-unsupported-nesting ─────────────────────────────

function diagnosticsFor(source: string, dialect: BBCodeDialect = 'miliastry') {
  const model = new BBCodeDocumentModel({ source, dialect, incremental: false } as any)
  return (model.diagnostics?.items ?? []).filter((d) => d.code === 'osu-unsupported-nesting')
}

describe('SemanticAnalyzer — osu-unsupported-nesting', () => {
  it.each([
    ['notice', '[notice]A[notice]B[/notice]C[/notice]D'],
    ['list', '[list][*]A[list][*]B[/list]C[/list]D'],
    ['url', '[url=https://a.com]A[url=https://b.com]B[/url]C[/url]D'],
  ])('%s: fires with a real source range on the inner tag', (_label, src) => {
    const diags = diagnosticsFor(src)
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('warning')
    expect(diags[0].range).toBeTruthy()
    expect(diags[0].range!.start).toBeGreaterThan(0)
    expect(diags[0].range!.end).toBeGreaterThan(diags[0].range!.start)
  })

  it.each([
    ['code', '[code]A[code]B[/code]C[/code]D'],
    ['c', '[c]A[c]B[/c]C[/c]D'],
  ])('%s: never fires — the lexer\'s raw-block tokenising already makes a same-name inner bracket inert text, identically in every dialect', (_label, src) => {
    // `code`/`c` are `BBCODE_RAW_TAGS`: the lexer isolates their content
    // before any tag pairing runs, so a literal `[code]`/`[c]` typed inside
    // one never becomes a second `code`/`inline_code` NODE at all — there is
    // no nesting in the tree for this rule or the validator to see, and the
    // default preview and osu! already render the inner bracket as the same
    // literal text.
    expect(diagnosticsFor(src)).toHaveLength(0)
  })

  it('fires for a size compound that cannot be expressed', () => {
    const diags = diagnosticsFor('[size=150]A[size=33]B[/size]C[/size]D')
    expect(diags).toHaveLength(1)
  })

  it('does not fire for a size compound the export already fixes silently', () => {
    expect(diagnosticsFor('[size=150]A[size=50]B[/size]C[/size]D')).toHaveLength(0)
    expect(diagnosticsFor('[size=150]A[size=100]B[/size]C[/size]D')).toHaveLength(0)
  })

  it('does not fire for kinds the export already fixes (bold, color)', () => {
    expect(diagnosticsFor('[b]A[b]B[/b]C[/b]D')).toHaveLength(0)
    expect(diagnosticsFor('[color=red]A[color=blue]B[/color]C[/color]D')).toHaveLength(0)
  })

  it('does not fire for the nestable-in-osu kinds', () => {
    expect(diagnosticsFor('[quote]A[quote]B[/quote]C[/quote]D')).toHaveLength(0)
    expect(diagnosticsFor('[box=Outer]A[box=Inner]B[/box]C[/box]D')).toHaveLength(0)
  })

  it('runs under either source dialect', () => {
    expect(diagnosticsFor('[notice]A[notice]B[/notice]C[/notice]D', 'osu')).toHaveLength(1)
    expect(diagnosticsFor('[notice]A[notice]B[/notice]C[/notice]D', 'miliastry')).toHaveLength(1)
  })
})
