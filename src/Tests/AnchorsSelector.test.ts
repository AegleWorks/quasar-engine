import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { AnchorSet } from '../Anchors/AnchorSet'
import { anchorForNode } from '../Anchors/bind'
import { fromSelector, restoreAnchors, toSelector } from '../Anchors/selector'
import type { RedNode } from '../Syntax/RedNode'

const FIXTURE = readFileSync(resolve(__dirname, '../../500KCharsTest'), 'utf8')

function boxAnchors(text: string): AnchorSet {
  const set = new AnchorSet(text)
  const root = new BBCodeDocumentModel({ source: text, dialect: 'osu', incremental: false, autoAnalyze: false }).redRoot!
  const walk = (n: RedNode): void => {
    if ((n.kind === 'box' || n.kind === 'spoilerbox') && n.green.leadingWidth > 0) anchorForNode(set, n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return set
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

describe('selectors — save and restore', () => {
  it('restores every anchor exactly when the text did not change', () => {
    const set = boxAnchors(FIXTURE)
    expect(set.size).toBeGreaterThan(200)
    const saved = set.all().map((a) => toSelector(a, FIXTURE))
    for (const s of saved) expect(fromSelector(s, FIXTURE)).toEqual({ kind: 'exact', start: s.start, end: s.end })
    const restored = new AnchorSet(FIXTURE)
    expect(restoreAnchors(restored, saved)).toEqual([])
    for (const s of saved) expect(restored.get(s.id)).toMatchObject({ start: s.start, end: s.end })
  })

  it('tells two identical snippets apart by their context', () => {
    const text = 'Uno:\n[box=X]primero[/box]\nDos:\n[box=X]segundo[/box]\n'
    const set = boxAnchors(text)
    const second = set.all().sort((a, b) => b.start - a.start)[0]
    const saved = toSelector(second, text)
    // The first box moves far away and its twin takes the saved position.
    const edited = 'Dos:\n[box=X]segundo[/box]\n' + 'relleno '.repeat(20) + '\nUno:\n[box=X]primero[/box]\n'
    const found = fromSelector(saved, edited)
    expect(found.kind).toBe('moved')
    expect(edited.slice((found as { end: number }).end).startsWith('segundo')).toBe(true)
  })

  it('reports an orphan instead of guessing when the quote is gone', () => {
    const text = 'antes [box=Titulo]x[/box] despues'
    const saved = toSelector(boxAnchors(text).all()[0], text)
    expect(fromSelector(saved, 'antes [box=Otro]x[/box] despues')).toEqual({ kind: 'orphan' })
  })

  it('after random edits made while nobody tracked them: right place or orphan, measured', () => {
    // A 60 KB slice keeps the run short; it still holds the twelve identical
    // copies' worth of repeated openers that make this hard.
    const base = FIXTURE.slice(0, 60_000)
    const TOKENS = ['x', ' ', '\n', '\n\n', '[b]', '[/b]', '[/box]', '[box=Nuevo]', 'texto nuevo aquí\n']
    let right = 0
    let orphaned = 0
    let wrong = 0
    let silentlyWrong = 0
    let lost = 0 // the edits changed or deleted the anchored text itself
    for (let seed = 1; seed <= 80; seed++) {
      const rand = mulberry32(seed)
      // Ground truth: a set that DID see every edit (layer 1, proven by its
      // own properties). The selectors were saved before the edits.
      const truth = boxAnchors(base)
      const saved = truth.all().map((a) => toSelector(a, base))
      const edits = 1 + Math.floor(rand() * 25)
      for (let i = 0; i < edits; i++) {
        const len = truth.text.length
        const start = Math.floor(rand() * (len + 1))
        const end = Math.min(len, start + (rand() < 0.5 ? 0 : Math.floor(rand() * 200)))
        // One edit in ten pastes 5 000 characters copied from the document
        // itself: it moves everything after it far away AND plants twins of
        // the anchors it copies — the hardest case for re-anchoring.
        const from = Math.floor(rand() * (len - 5000))
        const text = rand() < 0.1 ? truth.text.slice(from, from + 5000) : TOKENS[Math.floor(rand() * TOKENS.length)]
        truth.applyChange({ start, end, text })
      }
      for (const s of saved) {
        const t = truth.get(s.id)!
        const found = fromSelector(s, truth.text)
        if (t.deleted || truth.textOf(t) !== s.exact) { lost++; continue }
        if (found.kind === 'orphan') orphaned++
        else if (found.start === t.start) right++
        else {
          wrong++
          if (found.kind === 'exact' || !found.ambiguous) silentlyWrong++
        }
      }
    }
    const placed = right + wrong
    // The promise: never the wrong place SILENTLY. Twins with identical
    // context cannot always be told apart without the edit history (a far
    // twin can look more like what was saved than the damaged original), so
    // a placement with a rival is flagged `ambiguous` — and every wrong one is.
    // Measured (80 seeds, 1 in 10 edits pasting 5 000 self-copied characters):
    // 1 670 right, 45 wrong — all 45 flagged — 0 orphans.
    expect(silentlyWrong).toBe(0)
    expect(wrong / placed).toBeLessThan(0.05)
    expect(placed + orphaned).toBeGreaterThan(1000)
    expect(lost).toBeLessThan((placed + orphaned) / 10)
  })
})
