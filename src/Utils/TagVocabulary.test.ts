import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { parseImgAttr } from '../Syntax/nodeAttr'
import {
  attributeVocabularyFor,
  allAttributeVocabularies,
  IMG_MODIFIERS,
} from './TagVocabulary'

/**
 * The vocabularies must not drift away from the renderer.
 *
 * `TagVocabulary` is a list of strings; the behaviour is a `switch` in
 * `HTMLRenderer`. Nothing in the type system ties them together, so this
 * test does: every declared value is rendered and compared against a value
 * that is deliberately not in the vocabulary.
 *
 *   · a value the renderer handles must render DIFFERENTLY from the unknown
 *   · a value declared as the fallback must render the SAME as the unknown,
 *     because that is what "fallback" means
 *
 * Both directions matter. Drop a `case` from the renderer and the first
 * assertion fires; declare a fallback that is not the real one and the
 * second does. That is the whole point of writing the fallback down: it is
 * the part of the contract most likely to be wrong and least likely to be
 * noticed, since an unrecognised value never raises anything.
 */

/** Not in any vocabulary, and not a prefix of one. */
const UNKNOWN = 'zzz-not-a-real-value'

let previousIdMode: typeof HTMLRenderer.idMode

beforeAll(() => {
  // Node ids come from a global counter, so two renders of the same markup
  // differ in `data-node-id` alone. Comparing HTML needs them gone.
  previousIdMode = HTMLRenderer.idMode
  HTMLRenderer.idMode = 'none'
})

afterAll(() => {
  HTMLRenderer.idMode = previousIdMode
})

/** Tags that carry no body, so wrapping them in one would leave litter. */
const SELF_CLOSING = new Set(['separator'])

function render(tag: string, value: string): string {
  const source = SELF_CLOSING.has(tag)
    ? `[${tag}=${value}]`
    : `[${tag}=${value}]sample[/${tag}]`
  return new BBCodeDocumentModel({ source, mode: 'lyne' }).toHTML()
}

describe('TagVocabulary ↔ HTMLRenderer', () => {
  // `img` is not a renderer switch: its attribute is read by `parseImgAttr`,
  // so it is pinned separately below.
  const rendered = allAttributeVocabularies().filter(v => v.tag !== 'img')

  for (const vocabulary of rendered) {
    describe(`[${vocabulary.tag}]`, () => {
      for (const value of vocabulary.values) {
        const isFallback = value === vocabulary.fallback

        it(`${value} ${isFallback ? 'is the documented fallback' : 'renders distinctly'}`, () => {
          // Rendered inside the test, not at collection time: `idMode` is
          // only silenced once `beforeAll` has run.
          const baseline = render(vocabulary.tag, UNKNOWN)
          const html = render(vocabulary.tag, value)
          if (isFallback) {
            expect(html).toBe(baseline)
          } else {
            expect(html).not.toBe(baseline)
          }
        })
      }

      if (vocabulary.fallback !== null) {
        it('declares a fallback that is one of its own values', () => {
          expect(vocabulary.values).toContain(vocabulary.fallback)
        })
      }
    })
  }

  describe('[img]', () => {
    for (const modifier of IMG_MODIFIERS) {
      it(`${modifier} is understood by parseImgAttr`, () => {
        expect(parseImgAttr(modifier)).toEqual({ [modifier]: true })
      })
    }

    it('ignores an unknown modifier, which is why it needs completion', () => {
      expect(parseImgAttr(UNKNOWN)).toEqual({})
    })

    it('is exclusive, not combinable: a flag list yields nothing', () => {
      expect(parseImgAttr('round,shadow')).toEqual({})
    })
  })
})

describe('attributeVocabularyFor', () => {
  it('finds a vocabulary regardless of case, as the renderer lowercases', () => {
    expect(attributeVocabularyFor('EFFECT')?.tag).toBe('effect')
  })

  it('returns null for tags whose attribute is free text', () => {
    expect(attributeVocabularyFor('box')).toBeNull()
    expect(attributeVocabularyFor('url')).toBeNull()
    expect(attributeVocabularyFor('size')).toBeNull()
  })

  it('has no duplicate values inside a vocabulary', () => {
    for (const vocabulary of allAttributeVocabularies()) {
      expect(new Set(vocabulary.values).size).toBe(vocabulary.values.length)
    }
  })
})
