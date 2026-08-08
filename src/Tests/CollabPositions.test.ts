import { describe, it, expect } from 'vitest'
import { transformOffset, transformRange } from '../Collab/positions'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { TextChange } from '../Incremental/ChangeTracker'

/**
 * Position transforms are collaboration's ground floor: a caret or remote
 * cursor must keep pointing at the same CONTENT while text shifts under it.
 *
 * The central property, fuzz-checked below: for any position outside an
 * edit's replaced span, the character it pointed at before is the character
 * it points at after. Positions inside deleted text have no content left to
 * point at, so they collapse to the edit boundary — asserted separately.
 */

function apply(source: string, c: TextChange): string {
  return source.slice(0, c.start) + c.text + source.slice(c.end)
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('transformOffset', () => {
  const insert: TextChange = { start: 5, end: 5, text: 'XY' }
  const del: TextChange = { start: 3, end: 7, text: '' }
  const replace: TextChange = { start: 3, end: 7, text: 'Z' }

  it('before the edit: unchanged', () => {
    expect(transformOffset(2, insert)).toBe(2)
    expect(transformOffset(2, del)).toBe(2)
  })

  it('after the edit: shifted by the length delta', () => {
    expect(transformOffset(9, insert)).toBe(11)
    expect(transformOffset(9, del)).toBe(5)
    expect(transformOffset(9, replace)).toBe(6)
  })

  it('exactly at an insertion point: bias decides the side', () => {
    expect(transformOffset(5, insert, 'right')).toBe(7)
    expect(transformOffset(5, insert, 'left')).toBe(5)
  })

  it('inside deleted text: collapses to the edit boundary', () => {
    expect(transformOffset(5, del, 'left')).toBe(3)
    expect(transformOffset(5, del, 'right')).toBe(3)
    expect(transformOffset(5, replace, 'left')).toBe(3)
    expect(transformOffset(5, replace, 'right')).toBe(4)
  })

  it('composes over a sequence of changes', () => {
    const changes: TextChange[] = [
      { start: 0, end: 0, text: 'aa' }, // caret at 5 → 7
      { start: 9, end: 9, text: 'bb' }, // after 7: unchanged
      { start: 1, end: 3, text: '' },   // before: 7 → 5
    ]
    expect(transformOffset(5, changes)).toBe(5)
  })

  it('property: positions outside the edit keep pointing at the same character', () => {
    const rand = mulberry32(2026)
    const alphabet = 'abcdefghij[]/ \n'
    for (let round = 0; round < 2000; round++) {
      let src = ''
      const len = 10 + Math.floor(rand() * 60)
      for (let i = 0; i < len; i++) src += alphabet[Math.floor(rand() * alphabet.length)]

      const start = Math.floor(rand() * src.length)
      const end = start + Math.floor(rand() * (src.length - start + 1))
      let text = ''
      const insertLen = Math.floor(rand() * 5)
      for (let i = 0; i < insertLen; i++) text += alphabet[Math.floor(rand() * alphabet.length)]
      const change: TextChange = { start, end, text }
      const after = apply(src, change)

      for (let offset = 0; offset < src.length; offset++) {
        const isInsertionPoint = start === end && offset === start
        if (offset >= start && offset <= end && !(offset === end && !isInsertionPoint)) {
          // Inside the replaced span (or at the insertion point): only assert
          // the result lands within the replacement's bounds.
          const mapped = transformOffset(offset, change)
          expect(mapped).toBeGreaterThanOrEqual(start)
          expect(mapped).toBeLessThanOrEqual(start + text.length)
          continue
        }
        const mapped = transformOffset(offset, change)
        expect(after[mapped]).toBe(src[offset])
      }
    }
  })
})

describe('transformRange', () => {
  it('keeps covering exactly the content it covered', () => {
    // "hola mundo cruel" — range over "mundo" = [5, 10)
    const range = { start: 5, end: 10 }

    // Insertion exactly at the start lands OUTSIDE the range.
    expect(transformRange(range, { start: 5, end: 5, text: 'XX' })).toEqual({ start: 7, end: 12 })
    // Insertion exactly at the end lands OUTSIDE too.
    expect(transformRange(range, { start: 10, end: 10, text: 'XX' })).toEqual({ start: 5, end: 10 })
    // Insertion strictly inside grows it.
    expect(transformRange(range, { start: 7, end: 7, text: 'XX' })).toEqual({ start: 5, end: 12 })
    // Deletion strictly before shifts it whole.
    expect(transformRange(range, { start: 0, end: 2, text: '' })).toEqual({ start: 3, end: 8 })
  })

  it('never inverts: a range inside deleted text collapses to a point', () => {
    const out = transformRange({ start: 4, end: 8 }, { start: 2, end: 10, text: '' })
    expect(out.start).toBe(out.end)
  })
})

describe('origin on model events', () => {
  it('travels from applyTextUpdate to the document_changed event', () => {
    const model = new BBCodeDocumentModel({ source: 'hola mundo' })
    const origins: Array<string | undefined> = []
    model.events.on('document_changed', e => origins.push(e.origin as string | undefined))

    model.applyTextUpdate('hola mundo!')
    model.applyTextUpdate('hola mundo!!', 'remote')

    expect(origins).toEqual(['local', 'remote'])
  })

  it('a sync layer can ignore its own echo', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    let userEdits = 0
    model.events.on('document_changed', e => {
      if (e.origin === 'local') userEdits++
    })

    model.applyTextUpdate('hola!', 'sync')
    model.applyTextUpdate('hola! y algo', 'local')
    model.applyTextUpdate('hola! y algo mas')

    expect(userEdits).toBe(2)
  })
})
