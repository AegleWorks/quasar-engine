import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { REFERENCE_DOCUMENT } from './referenceDocument'
import type { RedNode } from '../Syntax/RedNode'

/**
 * The incremental parser's contract, fuzzed: after every edit, the patched tree
 * is the tree a full parse of the same text builds — every node's kind, range
 * and text. Run over real-shaped documents (the 547 KB fixture's sections, the
 * reference document, list-heavy nesting), with edits biased towards tag
 * syntax, where the parser's guards and its candidate-window ladder do their
 * work.
 *
 * Each bug this has caught stays caught: a pending name whose span ended
 * exactly at a window's start (`PendingSpans.covers`), crossings born and
 * retired inside one window (`shifted`'s `born` spans), and a root paragraph
 * split across a window's edge (`paragraphSeam`).
 */

const FIXTURE = readFileSync(resolve(__dirname, '../../500KCharsTest'), 'utf8')
const LISTY = Array.from({ length: 12 }, (_, i) =>
  `[centre][list]\n[*]uno [b]${i}[/b]\n[*]dos\n[list=1]\n[*]a\n[*]b [color=red]c[/color]\n[/list]\n[*]tres\n[/list][/centre]\n`
  + '[box=T][list]\n[*]x\n[*]y\n[/list][/box]\n\n').join('\n')

const DOCS = [
  ...Array.from({ length: 6 }, (_, i) => FIXTURE.slice(i * 60_000, i * 60_000 + 12_000)),
  REFERENCE_DOCUMENT.repeat(3),
  LISTY,
]

const TOKENS = ['x', ' ', '\n', '\n\n', '[*]', '[list]', '[/list]', '[list=1]', '[b]', '[/b]', '[i]', '[/i]',
  '[color=red]', '[/color]', '[centre]', '[/centre]', '[box=T]', '[/box]', '[notice]', '[/notice]', '[', ']', '[/',
  '[size=150]', '[/size]', '[code]', '[/code]', '[quote]', '[/quote]', '[url=x]', '[/url]']

function dump(root: RedNode): string {
  const out: string[] = []
  const walk = (n: RedNode): void => {
    out.push(`${n.kind}@${n.range.start}-${n.range.end}${n.children.length === 0 ? `:${n.text}` : ''}`)
    n.children.forEach(walk)
  }
  walk(root)
  return out.join('|')
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

describe('incremental parser — differential fuzz against full parses', () => {
  it.each(['miliastry', 'osu'] as const)('every patched tree is the full parse (%s)', (dialect) => {
    let incremental = 0
    let edits = 0
    for (let seed = 1; seed <= 150; seed++) {
      const rand = mulberry32(seed * 7919 + (dialect === 'osu' ? 1 : 0))
      let source = DOCS[Math.floor(rand() * DOCS.length)]
      const model = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false })
      for (let step = 0; step < 6; step++) {
        const at = Math.floor(rand() * (source.length + 1))
        const del = rand() < 0.3 ? Math.floor(rand() * 6) : 0
        const ins = rand() < 0.85 ? TOKENS[Math.floor(rand() * TOKENS.length)] : ''
        source = source.slice(0, at) + ins + source.slice(at + del)
        model.applyTextUpdate(source)
        edits++
        if (model.lastReparsePath === 'incremental') incremental++
        const fresh = new BBCodeDocumentModel({ source, dialect, incremental: false, autoAnalyze: false })
        expect(dump(model.redRoot!), `seed ${seed} step ${step}: ${JSON.stringify({ at, del, ins })}`).toBe(dump(fresh.redRoot!))
      }
    }
    // Not vacuous: most edits really are splices.
    expect(incremental / edits).toBeGreaterThan(0.35) // measured: 0.46 (miliastry)
  })
})
