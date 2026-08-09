import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { processStudioAST } from '@miliastry/quasar-studio'
import { REFERENCE_DOCUMENT, REFERENCE_GRADIENT_LAYER } from './referenceDocument'

/**
 * Round-tripping a document through the Studio must not invent or drop layout.
 *
 * The name of this suite always promised that, but the body only rendered the
 * document and `console.log`ged the result — `expect` was imported and never
 * called, so it could not fail. It also read an untracked `.milia` fixture,
 * which is what finally broke it. Both are fixed here: the invariant its name
 * describes is now actually asserted, against `referenceDocument.ts`.
 *
 * Braille blanks (`⠀`, U+2800) are load-bearing in these posts — authors use
 * them as padding because osu! collapses ordinary whitespace. Gaining or losing
 * one silently reflows somebody's profile.
 */
describe('Problematic Section Export', () => {
  const exportWithLayers = (source: string, layers: unknown[]) => {
    const registry = new TagRegistry()
    const { redRoot } = processStudioAST(source, layers as never, {})
    return new BBCodeExporter(registry).export(redRoot)
  }

  const brailleCount = (s: string) => (s.match(/⠀/g) || []).length

  it('preserves every braille blank through a plain round trip', () => {
    const exported = exportWithLayers(REFERENCE_DOCUMENT, [])
    expect(brailleCount(exported)).toBe(brailleCount(REFERENCE_DOCUMENT))
  })

  it('preserves every braille blank through a gradient layer', () => {
    // A gradient splits text into one node per character; the padding must come
    // out the far side with the same count it went in with.
    const exported = exportWithLayers(REFERENCE_DOCUMENT, [REFERENCE_GRADIENT_LAYER])
    expect(brailleCount(exported)).toBe(brailleCount(REFERENCE_DOCUMENT))
  })

  it('does not add a trailing blank line', () => {
    const exported = exportWithLayers(REFERENCE_DOCUMENT, [])
    const trailing = (s: string) => s.length - s.replace(/\n+$/, '').length
    expect(trailing(exported)).toBe(trailing(REFERENCE_DOCUMENT))
  })
})
