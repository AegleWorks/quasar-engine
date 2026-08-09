import { describe, it, expect } from 'vitest'
import { REFERENCE_DOCUMENT_WITH_GRADIENT } from './referenceDocument'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'

/**
 * Regression: the built-in validators must actually fire.
 *
 * Three of the four were unreachable, so `analyze()` returned zero diagnostics
 * on *any* document and `ErrorCheckerWindow` — a whole window whose job is
 * listing problems — was permanently empty. None of them set `range` either, so
 * even a firing diagnostic could not be clicked through to its position.
 *
 *   unknown-tag       required kind 'custom', but the parser turns unknown tags
 *                     into `text` nodes before the analyzer sees them
 *   deprecated-tag    looked up `deprecated[node.text]`, but `text` holds the
 *                     tag's attributes, not its name
 *   nested-structure  required non-text children of [code], but the parser
 *                     keeps code content as raw text, so there never are any
 *
 * `unknown-tag` is still unreachable by design — see the note at the bottom.
 */
function diagnose(source: string) {
  const model = new BBCodeDocumentModel({ source })
  const result = model.analyze()
  return result.diagnostics.items
}

function codes(source: string): string[] {
  return diagnose(source).map(d => d.code)
}

describe('SemanticAnalyzer — built-in validators', () => {
  it('flags a deprecated tag exactly once, with its range', () => {
    const source = '[strike]x[/strike]'
    const found = diagnose(source)

    expect(found.map(d => d.code)).toEqual(['deprecated-tag'])
    // Several nodes share offset 0 here (document, paragraph, the tag itself),
    // so an offset-only check reported this three times.
    expect(found[0].range).toEqual({ start: 0, end: source.length })
    expect(found[0].message).toContain('[s]')
  })

  it('does not flag the modern spelling', () => {
    expect(codes('[s]x[/s]')).toEqual([])
  })

  it('flags BBCode tags inside a code block', () => {
    expect(codes('[code][b]x[/b][/code]')).toEqual(['nested-tags-in-code', 'nested-tags-in-code'])
  })

  it('does not flag a code block without tags', () => {
    expect(codes('[code]const a = 1[/code]')).toEqual([])
  })

  it('flags an empty tag', () => {
    const found = diagnose('[b][/b]')
    expect(found.map(d => d.code)).toEqual(['empty-tag'])
    expect(found[0].range).not.toBeNull()
  })

  it('every diagnostic carries a usable range', () => {
    // ErrorCheckerWindow guards on `if (err.range)` to jump to the problem, so
    // a diagnostic without one is invisible in practice.
    for (const source of ['[strike]x[/strike]', '[code][b]x[/b][/code]', '[b][/b]']) {
      for (const d of diagnose(source)) {
        expect(d.range).not.toBeNull()
        expect(d.range!.start).toBeGreaterThanOrEqual(0)
        expect(d.range!.end).toBeGreaterThan(d.range!.start)
        expect(d.range!.end).toBeLessThanOrEqual(source.length)
      }
    }
  })

  describe('unclosed tags', () => {
    // The one BBCode mistake people actually make. The legacy parser closes
    // these silently by design, so without this nothing tells the author.
    it('flags a tag never closed', () => {
      expect(codes('[b]hola')).toEqual(['unclosed-tag'])
    })

    it('flags each unclosed tag separately', () => {
      expect(codes('[b][i]hola')).toEqual(['unclosed-tag', 'unclosed-tag'])
    })

    it('flags a tag auto-closed by a mismatched close', () => {
      // [i] is never closed; the legacy rules close it when [/b] arrives.
      expect(codes('[b][i]x[/b]')).toEqual(['unclosed-tag'])
    })

    it('says nothing about properly closed tags', () => {
      expect(codes('[b]hola[/b]')).toEqual([])
      expect(codes('[b][i]x[/i][/b]')).toEqual([])
      expect(codes('[color=red]x[/color]')).toEqual([])
      expect(codes('[url=https://osu.ppy.sh]x[/url]')).toEqual([])
    })

    it('is case-insensitive about the closing tag', () => {
      expect(codes('[B]x[/B]')).toEqual([])
    })

    it('does not flag [*], which has no closing form', () => {
      expect(codes('[list]\n[*]uno\n[*]dos\n[/list]')).toEqual([])
    })

    it('does not flag brackets in ordinary prose', () => {
      expect(codes('Combo de [90 misses] con teclado [Gateron]')).toEqual([])
      expect(codes('hola[/b]')).toEqual([])
    })
  })

  it('stays quiet on well-formed documents', () => {
    // False positives are worse than silence: a checker that cries wolf on
    // ordinary text gets ignored.
    expect(codes('[b]hola[/b] [i]mundo[/i]')).toEqual([])
    expect(codes('texto sin ninguna etiqueta')).toEqual([])
    expect(codes('[url=https://osu.ppy.sh]enlace[/url]')).toEqual([])
  })

  it('produces no noise on the real reference document', () => {
    const found = diagnose(REFERENCE_DOCUMENT_WITH_GRADIENT)
    // This is a real, valid document: anything reported here is a false
    // positive that would bury genuine problems in the checker window.
    expect(found.filter(d => d.severity === 'error')).toEqual([])
    expect(found.filter(d => d.severity === 'warning')).toEqual([])
  })

  // NOTE: `unknown-tag` is deliberately still dormant. The parser renders
  // unrecognised tags as literal text on purpose — `[Gateron]`, `[90 misses]`
  // are ordinary prose, not typos — so warning on them would be pure noise.
  // Reviving it is a product decision, tracked as roadmap point 15.
  it('does not warn about unknown tags (parser renders them as text)', () => {
    expect(codes('[unknowntag]hola[/unknowntag]')).toEqual([])
    expect(codes('Combo de [90 misses] con teclado [Gateron]')).toEqual([])
  })
})
