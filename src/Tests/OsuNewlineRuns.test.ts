import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { OsuSemanticModel } from '../Semantic/osu/OsuSemanticModel'
import {
  CROSSABLE_DIV_KINDS, WIDTHLESS_CLOSE, WIDTHLESS_OPEN, firstNonWidthlessOpenChild, newlineRule,
} from '../Semantic/osu/newlineRules'
import type { RedNode } from '../Syntax/RedNode'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

/**
 * `OsuSemanticModel` answers "is this newline swallowed?" by memoized walks,
 * so a run of k newlines costs k instead of k². The oracle below is the
 * walk it replaced, one scan per question; on fuzzed trees, both pairings and
 * every dialect, they must agree on every newline.
 */

const isNewline = (n: RedNode): boolean => n.kind === 'spacing' || n.kind === 'empty_line'
const isBlank = (n: RedNode): boolean => n.kind === 'text' && n.children.length === 0 && n.text.trim() === ''

function oracle(model: OsuSemanticModel, node: RedNode): boolean {
  const byOpening = (): boolean => {
    let cur = node, nl = 0, blank = false
    for (;;) {
      const prev = cur.previousSibling
      if (prev) {
        if (isNewline(prev)) { nl++; cur = prev; continue }
        if (isBlank(prev)) { blank = true; cur = prev; continue }
        return false
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_OPEN.has(parent.kind)) { cur = parent; continue }
      const rule = newlineRule(parent.kind)
      if (!rule) return false
      switch (rule.afterOpen) {
        case 'whitespace': return true
        case 'all': return !blank
        case 'one': return !blank && nl === 0
        default: return false
      }
    }
  }
  const byClosing = (): boolean => {
    let cur = node, blank = false
    for (;;) {
      const next = cur.nextSibling
      if (next) {
        if (isNewline(next)) { cur = next; continue }
        if (isBlank(next)) { blank = true; cur = next; continue }
        const boundary = firstNonWidthlessOpenChild(next)
        if (model.isGhost(boundary)) {
          const rule = model.closingBudget(boundary)
          return rule?.beforeClose === 'all' ? !blank : rule?.beforeClose === 'whitespace'
        }
        return false
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_CLOSE.has(parent.kind)) { cur = parent; continue }
      if (CROSSABLE_DIV_KINDS.has(parent.kind) && parent.green.trailingWidth === 0) { cur = parent; continue }
      const rule = newlineRule(parent.kind)
      if (!rule) return false
      return rule.beforeClose === 'whitespace' || (rule.beforeClose === 'all' && !blank)
    }
  }
  const afterClosing = (): boolean => {
    let cur = node, nl = 0
    for (;;) {
      const prev = cur.previousSibling
      if (!prev) {
        const parent = cur.parent
        if (parent && WIDTHLESS_OPEN.has(parent.kind)) { cur = parent; continue }
        return false
      }
      if (isNewline(prev)) { nl++; cur = prev; continue }
      let closer: RedNode = prev
      while (WIDTHLESS_CLOSE.has(closer.kind) && closer.children.length > 0) closer = closer.children[closer.children.length - 1]
      const rule = model.closingBudget(closer)
      return rule !== null && nl < rule.afterClose
    }
  }
  const beforeOpening = (): boolean => {
    let cur = node
    for (;;) {
      const next = cur.nextSibling
      if (next) {
        if (isNewline(next) || isBlank(next)) { cur = next; continue }
        return newlineRule(next.kind)?.beforeOpen === 'whitespace'
      }
      const parent = cur.parent
      if (!parent) return false
      if (WIDTHLESS_CLOSE.has(parent.kind)) { cur = parent; continue }
      return false
    }
  }
  return byOpening() || byClosing() || afterClosing() || beforeOpening()
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

const PIECES = ['x', ' ', '  ', '\n', '\n\n', '\n\n\n', '[box=T]', '[/box]', '[centre]', '[/centre]', '[notice]', '[/notice]',
  '[quote]', '[/quote]', '[list]', '[*]', '[/list]', '[heading]', '[/heading]', '[b]', '[/b]', '[spoilerbox]',
  '[/spoilerbox]', '[code]', '[/code]', '[left]', '[/left]', '[/i]', '[i]',
  // Longer than SHORT_WALK, so the memoized walk is checked too.
  '\n'.repeat(20), ' \n'.repeat(12), '\n \n'.repeat(10)]

describe('newline runs: memoized walks agree with one walk per question', () => {
  for (const dialect of ['osu', 'miliastry', 'lyne'] as BBCodeDialect[]) {
    for (const pairing of ['quasar', 'osu'] as const) {
      it(`${dialect}, ${pairing} pairing`, () => {
        const rand = mulberry32(dialect.length * 31 + pairing.length)
        let checked = 0
        for (let doc = 0; doc < 150; doc++) {
          let src = ''
          const n = 10 + Math.floor(rand() * 60)
          for (let i = 0; i < n; i++) src += PIECES[Math.floor(rand() * PIECES.length)]
          const tree = new BBCodeDocumentModel({ source: src, dialect, pairing, autoAnalyze: false }).redRoot!
          const model = new OsuSemanticModel(dialect)
          const reference = new OsuSemanticModel(dialect)
          const stack: RedNode[] = [tree]
          while (stack.length > 0) {
            const node = stack.pop()!
            for (const c of node.children) stack.push(c)
            if (!isNewline(node)) continue
            expect(model.isNewlineSwallowed(node), `${JSON.stringify(src)} @${node.range.start}`).toBe(oracle(reference, node))
            checked++
          }
        }
        expect(checked).toBeGreaterThan(500)
      })
    }
  }

  it('a long run of newlines costs one walk, not one per newline', () => {
    const tree = new BBCodeDocumentModel({ source: 'a' + '\n'.repeat(20000) + '[box=t]x[/box]', autoAnalyze: false }).redRoot!
    const model = new OsuSemanticModel('osu')
    const nodes: RedNode[] = []
    const stack: RedNode[] = [tree]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const c of node.children) stack.push(c)
      if (isNewline(node)) nodes.push(node)
    }
    // Counting sibling reads would be the exact measure; the timing bound is
    // three orders of magnitude off the quadratic walk (seconds) and two
    // above the linear one.
    const t0 = performance.now()
    for (const node of nodes) model.isNewlineSwallowed(node)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
