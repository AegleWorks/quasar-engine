import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { OsuSemanticModel } from '../Semantic/osu/OsuSemanticModel'
import type { RedNode } from '../Syntax/RedNode'

/**
 * The osu! semantic model answers from the tree alone, so a tree the
 * incremental parser patched must get the same answers as a fresh full parse
 * of the same text. Answers are compared by range (ids differ between two
 * parses), for every query, after every random edit.
 */

type Answers = Map<string, string>

function answers(root: RedNode, dialect: 'osu' | 'miliastry'): Answers {
  const model = new OsuSemanticModel(dialect)
  const out: Answers = new Map()
  const walk = (n: RedNode): void => {
    const at = `${n.kind}@${n.range.start}-${n.range.end}`
    const facts: string[] = []
    if (n.kind === 'spacing' || n.kind === 'empty_line') facts.push(`swallowed=${model.isNewlineSwallowed(n)}`)
    const budget = model.closingBudget(n)
    if (budget !== null) facts.push(`afterClose=${budget.afterClose}`, `beforeClose=${budget.beforeClose}`)
    if (model.isGhost(n)) facts.push('ghost')
    if (model.isClaimedByBoxTitle(n) || model.isClaimedElement(n)) facts.push(`claimed=${model.claimedTagOf(n)}`)
    if (facts.length > 0) out.set(at, facts.join(' '))
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
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

// Every construct the model has an opinion about: newline budgets around
// each block, ghosts, orphan box closers, rich titles and what they claim.
const SAMPLE = 'intro [b]negrita[/b]\n\n[box=[size=85]Rico] [/size]dentro\n\n[notice]aviso[/notice]\n[/box]\n\n'
  + '[list]\n[*]uno\n[*]dos\n[/list]\n\n[quote]cita[/quote]\n\n[centre]c[/centre]\nfin [/box]\n'
const TOKENS = ['x', ' ', '\n', '\n\n', '[b]', '[/b]', '[box=T]', '[box=[b]R[/b]]', '[box=[size=85]T]', '[/size]',
  '[/box]', '[notice]', '[/notice]', '[list]', '[*]', '[/list]', '[centre]', '[/centre]', '[quote]', '[/quote]',
  '[spoilerbox]', '[/spoilerbox]', '[imagemap]\nhttps://a.b/i.png\n0 0 10 10 https://x T\n[/imagemap]']

describe('OsuSemanticModel — the reused tree answers like a fresh parse', () => {
  it.each(['osu', 'miliastry'] as const)('after random incremental edits and their undo (%s)', (dialect) => {
    // Each step edits the BASE text and then restores it, both through the
    // incremental parser: cumulative random tokens degrade any document into
    // bracket soup, which the parser rightly reparses in full — and a full
    // reparse would prove nothing about reused trees.
    const base = Array.from({ length: 30 }, (_, i) => `${SAMPLE} ${i}`).join('\n\n')
    const model = new BBCodeDocumentModel({ source: base, dialect, autoAnalyze: false })
    const expected = answers(new BBCodeDocumentModel({ source: base, dialect, incremental: false, autoAnalyze: false }).redRoot!, dialect)
    const paths = new Map<string, number>()
    const rand = mulberry32(dialect === 'osu' ? 1 : 2)
    for (let step = 0; step < 150; step++) {
      const at = Math.floor(rand() * (base.length + 1))
      const edited = rand() < 0.6
        ? base.slice(0, at) + TOKENS[Math.floor(rand() * TOKENS.length)] + base.slice(at)
        : base.slice(0, at) + base.slice(at + 1 + Math.floor(rand() * 10))
      model.applyTextUpdate(edited)
      paths.set(model.lastReparsePath, (paths.get(model.lastReparsePath) ?? 0) + 1)
      const fresh = new BBCodeDocumentModel({ source: edited, dialect, incremental: false, autoAnalyze: false })
      expect(answers(model.redRoot!, dialect), `step ${step} (edit)`).toEqual(answers(fresh.redRoot!, dialect))
      model.applyTextUpdate(base)
      expect(answers(model.redRoot!, dialect), `step ${step} (undo)`).toEqual(expected)
    }
    // Enough edits must really take the incremental path, or this proves
    // nothing about reused trees. Measured: 69 (osu) and 66 (miliastry) of
    // 150; the rest are tokens the parser cannot isolate (an unclosed
    // `[box=T]`, a stray `[/list]`), which it reparses in full by design.
    const incremental = paths.get('incremental') ?? 0
    expect(incremental, JSON.stringify(Object.fromEntries(paths))).toBeGreaterThan(150 / 3)
  })

  it('has something to say on the sample (the comparison is not vacuous)', () => {
    const root = new BBCodeDocumentModel({ source: SAMPLE, dialect: 'osu', incremental: false, autoAnalyze: false }).redRoot!
    const facts = [...answers(root, 'osu').values()].join('\n')
    expect(facts).toContain('swallowed=true')
    expect(facts).toContain('swallowed=false')
    expect(facts).toContain('ghost')
    expect(facts).toContain('claimed=size')
  })
})
