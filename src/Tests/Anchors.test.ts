import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnchorSet, diffText, mapOffset, type Stickiness, type TextEdit } from '../Anchors/AnchorSet'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('mapOffset', () => {
  const insert = (at: number, text: string): TextEdit => ({ start: at, end: at, text })
  it('leaves offsets before the edit alone and shifts the ones after it', () => {
    expect(mapOffset(2, insert(5, 'abc'), 1)).toBe(2)
    expect(mapOffset(9, insert(5, 'abc'), 1)).toBe(12)
    expect(mapOffset(9, { start: 3, end: 6, text: '' }, 1)).toBe(6)
  })
  it('puts an offset at an insertion point before or after it, as asked', () => {
    expect(mapOffset(5, insert(5, 'abc'), -1)).toBe(5)
    expect(mapOffset(5, insert(5, 'abc'), 1)).toBe(8)
  })
  it('keeps the edges of a replaced range unambiguous', () => {
    const edit = { start: 3, end: 6, text: 'XY' }
    expect(mapOffset(3, edit, 1)).toBe(3)
    expect(mapOffset(6, edit, -1)).toBe(5)
    expect(mapOffset(4, edit, -1)).toBe(3)
    expect(mapOffset(4, edit, 1)).toBe(5)
  })
})

describe('AnchorSet — stickiness at the edges', () => {
  // "hello [world] !" with the anchor on "world"; type "X" at each edge.
  const cases: [Stickiness, string, string][] = [
    ['never-grows', 'world', 'world'],
    ['always-grows', 'Xworld', 'worldX'],
    ['grows-before', 'Xworld', 'world'],
    ['grows-after', 'world', 'worldX'],
  ]
  it.each(cases)('%s', (stickiness, typedBefore, typedAfter) => {
    const before = new AnchorSet('hello world !')
    const a = before.add(6, 11, { stickiness })
    before.applyChange({ start: 6, end: 6, text: 'X' })
    expect(before.textOf(before.get(a.id)!)).toBe(typedBefore)

    const after = new AnchorSet('hello world !')
    const b = after.add(6, 11, { stickiness })
    after.applyChange({ start: 11, end: 11, text: 'X' })
    expect(after.textOf(after.get(b.id)!)).toBe(typedAfter)
  })
})

describe('AnchorSet — deletions', () => {
  it('collapses and flags an anchor whose whole text was deleted', () => {
    const set = new AnchorSet('one [box=T]x[/box] two')
    const a = set.add(4, 11)
    set.applyChange({ start: 2, end: 20, text: '' })
    const now = set.get(a.id)!
    expect(now.deleted).toBe(true)
    expect(now.start).toBe(2)
    expect(now.end).toBe(2)
  })

  it('only shrinks an anchor that lost part of its text', () => {
    const set = new AnchorSet('[box=Title]')
    const a = set.add(0, 11)
    set.applyChange({ start: 5, end: 10, text: '' })
    const now = set.get(a.id)!
    expect(now.deleted).toBe(false)
    expect(set.textOf(now)).toBe('[box=]')
  })

  it('keeps a moved anchor as a new object and an unmoved one as the same object', () => {
    const set = new AnchorSet('abc def')
    const a = set.add(0, 3)
    const b = set.add(4, 7)
    set.applyChange({ start: 3, end: 3, text: '!!' })
    expect(set.get(a.id)).toBe(a)
    expect(set.get(b.id)).not.toBe(b)
  })
})

describe('AnchorSet — the diff slides to where an edit really begins', () => {
  it('deleting a whole box before a twin-prefixed box deletes its anchor, not moves it', () => {
    const text = 'Intro\n[box=Uno]a[/box]\n[box=Dos]b[/box]\n'
    const set = new AnchorSet(text)
    const uno = set.add(6, 15) // [box=Uno]
    const dos = set.add(23, 32) // [box=Dos]
    // The greedy scan reports "Uno]a[/box]\n[box=": the same text, shifted.
    set.updateText(text.replace('[box=Uno]a[/box]\n', ''))
    expect(set.get(uno.id)!.deleted).toBe(true)
    expect(set.textOf(set.get(dos.id)!)).toBe('[box=Dos]')
  })

  it('inserting a copy of a box before it leaves the anchor on the original', () => {
    const text = 'x\n[box=A]1[/box]\n'
    const set = new AnchorSet(text)
    const a = set.add(2, 9)
    set.updateText(text.replace('x\n', 'x\n[box=A]1[/box]\n'))
    expect(set.get(a.id)!.start).toBe(2 + '[box=A]1[/box]\n'.length)
  })
})

describe('AnchorSet — properties under random edits', () => {
  const ALPHABET = 'ab[]/= \n'
  const randomText = (rand: () => number, n: number) =>
    Array.from({ length: n }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('')

  it('an anchor no edit touches keeps covering exactly the same text', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed)
      const set = new AnchorSet(randomText(rand, 400))
      const expected = new Map<string, string>()
      for (let i = 0; i < 12; i++) {
        const start = Math.floor(rand() * 390)
        const a = set.add(start, start + 1 + Math.floor(rand() * 9), {
          stickiness: (['never-grows', 'always-grows', 'grows-before', 'grows-after'] as const)[i % 4],
        })
        expected.set(a.id, set.textOf(a))
      }
      for (let step = 0; step < 300; step++) {
        const len = set.text.length
        const start = Math.floor(rand() * (len + 1))
        const end = Math.min(len, start + Math.floor(rand() * 6))
        const edit = { start, end, text: rand() < 0.5 ? randomText(rand, Math.floor(rand() * 5)) : '' }
        // Which anchors this edit leaves untouched: strictly outside, or
        // touching an edge only by an insertion the anchor does not grow into.
        const untouched = set.all().filter((a) => !a.deleted && (
          edit.end < a.start || edit.start > a.end
          || (edit.start === edit.end && edit.start === a.start && a.stickiness !== 'always-grows' && a.stickiness !== 'grows-before' && edit.start !== a.end)
          || (edit.start === edit.end && edit.start === a.end && a.stickiness !== 'always-grows' && a.stickiness !== 'grows-after' && edit.start !== a.start)
        ))
        set.applyChange(edit)
        for (const a of untouched) expect(set.textOf(set.get(a.id)!), `seed ${seed} step ${step}`).toBe(expected.get(a.id))
        for (const a of set.all()) {
          // Bounds, always; and the text of a touched anchor becomes the new expectation.
          expect(0 <= a.start && a.start <= a.end && a.end <= set.text.length).toBe(true)
          expected.set(a.id, set.textOf(a))
        }
      }
    }
  })

  it('updateText finds an edit that reproduces the new text, and agrees with applyChange away from it', () => {
    let compared = 0
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed)
      const text = randomText(rand, 300)
      const exact = new AnchorSet(text)
      const diffed = new AnchorSet(text)
      for (let i = 0; i < 10; i++) {
        const start = Math.floor(rand() * 290)
        const a = exact.add(start, start + 5)
        diffed.add(start, start + 5, { id: a.id })
      }
      for (let step = 0; step < 200; step++) {
        const len = exact.text.length
        const start = Math.floor(rand() * (len + 1))
        const end = Math.min(len, start + Math.floor(rand() * 6))
        const edit = { start, end, text: randomText(rand, Math.floor(rand() * 4)) }
        const next = exact.text.slice(0, start) + edit.text + exact.text.slice(end)
        const found = diffText(exact.text, next)
        if (found) expect(exact.text.slice(0, found.start) + found.text + exact.text.slice(found.end)).toBe(next)
        exact.applyChange(edit)
        diffed.updateText(next)
        expect(diffed.text).toBe(exact.text)
        // The diff may place an ambiguous edit elsewhere in a run of equal
        // characters (the plan's known limit); anchors clear of both agree.
        const lo = Math.min(start, found?.start ?? start) - 1
        const hi = Math.max(start + edit.text.length, (found?.start ?? start) + (found?.text.length ?? 0)) + 1
        for (const a of exact.all()) {
          const b = diffed.get(a.id)!
          if (a.end < lo || a.start > hi) { expect([b.start, b.end]).toEqual([a.start, a.end]); compared++ }
          else { diffed.remove(a.id); exact.remove(a.id) }
        }
      }
    }
    // Not vacuous: anchors near an ambiguous edit leave the comparison, so
    // make sure plenty stayed in it (measured: 5 330).
    expect(compared).toBeGreaterThan(3000)
  })

  it('keeps pace with a 547 KB document', () => {
    const fixture = readFileSync(resolve(__dirname, '../../500KCharsTest'), 'utf8')
    const set = new AnchorSet(fixture)
    for (let i = 0; i < 200; i++) set.add(i * 2500, i * 2500 + 10)
    const mid = fixture.length >> 1
    const edited = fixture.slice(0, mid) + 'x' + fixture.slice(mid)
    const t = performance.now()
    set.updateText(edited)
    set.updateText(fixture)
    const ms = (performance.now() - t) / 2
    // The same scan DocumentModel runs per keystroke; generous for CI noise.
    expect(ms).toBeLessThan(20)
    expect(set.all().every((a) => set.textOf(a).length === 10)).toBe(true)
  })
})
