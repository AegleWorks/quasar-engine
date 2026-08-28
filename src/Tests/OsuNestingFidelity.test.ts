import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { repairNesting } from '../Repair/NestingRepair'
import type { RedNode } from '../Syntax/RedNode'

/**
 * Quasar against osu!, on a document nobody would write on purpose.
 *
 * `docs/ai/NyuPenyu` is a real userpage whose tags cross and close out of order
 * all over. `docs/ai/NyuPenyuGoal` is the same page rewritten by hand until it
 * rendered the way osu! actually displays the broken one, so the pair is a
 * human-verified oracle for what osu! does with bad nesting.
 *
 * Read it as a fidelity budget, not as byte equality: the goal also carries its
 * author's own tidying — 17 `[centre]` blocks replaced by a single wrapper —
 * which is style, not parser behaviour. What has to match is the shape.
 */

const DOCS = join(__dirname, '../../../../docs/ai')

// The oracle pair is a real userpage: personal content, deliberately left out
// of version control (docs/ai/** is gitignored). These suites only run on a
// machine where someone has dropped the files into docs/ai/ — everywhere else
// (CI included) they skip instead of killing the whole file at collection time.
const FIXTURES = ['NyuPenyu', 'NyuPenyuGoal', 'hxovc.bbcode'] as const
const HAS_FIXTURES = FIXTURES.every(name => existsSync(join(DOCS, name)))
const readFixture = (name: string): string =>
  HAS_FIXTURES ? readFileSync(join(DOCS, name), 'utf8') : ''

const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), 'g')

const parse = (source: string) => new BBCodeDocumentModel({ source }).redRoot!

const render = (source: string): string =>
  new HTMLRenderer().render(parse(source)).replace(/ data-node-id="[^"]*"/g, '')

const visibleText = (source: string): string =>
  render(source).replace(/<[^>]+>/g, '\n').replace(ZERO_WIDTH, '')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n')

/** How many boxes sit at each nesting depth — the shape, in one number per level. */
function boxDepths(source: string): Record<number, number> {
  const BOXES = ['box', 'spoilerbox', 'boxw']
  const depths: Record<number, number> = {}
  const walk = (node: RedNode, depth: number) => {
    const isBox = BOXES.includes(node.kind)
    if (isBox) depths[depth] = (depths[depth] ?? 0) + 1
    for (const child of node.children) walk(child, depth + (isBox ? 1 : 0))
  }
  walk(parse(source), 0)
  return depths
}

const repair = (source: string) => repairNesting(source, parse(source))

describe.skipIf(!HAS_FIXTURES)('osu! fidelity on a badly nested userpage', () => {
  const broken = readFixture('NyuPenyu')
  const goal = readFixture('NyuPenyuGoal')

  it('keeps the sections inside the box they were written in', () => {
    // Before the late-closer rule this was {0: 46, 1: 9}: a stray `[/box]` closed
    // the outer box and every later section fell out of it, which made the page
    // render 78% taller than what osu! shows.
    //
    // One box short of the oracle's {0: 12, 1: 43}, and that gap is on purpose:
    // it is a single located discrepancy, not a reason to add another rule to
    // the parser until someone has found which box it is and why.
    expect(boxDepths(broken)).toEqual({ 0: 13, 1: 42 })
    expect(boxDepths(goal)).toEqual({ 0: 12, 1: 43 })
  })

  it('stops showing the late closers osu! never shows', () => {
    // What is left in view are closers that never had an opener at all — a
    // separate case, kept as text so the source stays fully covered, and
    // removed by `repairNesting` rather than by the parser.
    const leaked = visibleText(broken).match(/\[\/[a-zA-Z]+\]/g) ?? []
    expect(leaked.length).toBeLessThan(5)
    expect(visibleText(goal)).not.toMatch(/\[\/[a-zA-Z]+\]/)
  })

  it('balances the source without disturbing the render', () => {
    const repaired = repair(broken)
    expect(repaired.orphans.length).toBeGreaterThan(0)
    expect(repair(repaired.source).hasChanges).toBe(false)
    expect(visibleText(repaired.source)).toBe(visibleText(goal))
    expect(boxDepths(repaired.source)).toEqual(boxDepths(broken))
  })

  it('leaves a document that was already clean alone', () => {
    const clean = readFixture('hxovc.bbcode')
    expect(repair(clean).hasChanges).toBe(false)
  })
})

describe('nesting recovery matches correct nesting', () => {
  const TAGS = ['box=T', 'notice', 'centre', 'quote', 'b', 'i', 'color=#FF0000', 'size=150']
  const name = (tag: string) => tag.split('=')[0]

  /** The tree shape. `discarded_tag` is left out: it is a range holder, not structure. */
  const shape = (source: string): string => {
    const walk = (node: { kind: string; children: { kind: string }[] }): string => {
      if (node.kind === 'text') return 't'
      const kids = node.children
        .filter(c => c.kind !== 'discarded_tag')
        .map(c => walk(c as never))
        .join(',')
      return node.kind + (kids ? '(' + kids + ')' : '')
    }
    return parse(source).children
      .filter(c => c.kind !== 'discarded_tag')
      .map(c => walk(c as never))
      .join(' ')
  }

  it('gives a crossed pair the same tree as the correctly nested one', () => {
    for (const outer of TAGS) {
      for (const inner of TAGS) {
        const [a, b] = [name(outer), name(inner)]
        if (a === b) continue
        expect(shape(`[${outer}][${inner}]x[/${a}][/${b}]`), `${outer}/${inner}`)
          .toBe(shape(`[${outer}][${inner}]x[/${b}][/${a}]`))
      }
    }
  })

  it('reaches the same tree from every closing order of three tags', () => {
    const tags = ['centre', 'notice', 'b']
    const expected = shape('[centre][notice][b]x[/b][/notice][/centre]')
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const source = '[centre][notice][b]x' + order.map(i => `[/${tags[i]}]`).join('')
      expect(shape(source), source).toBe(expected)
    }
  })

  it('never drops content, whatever the nesting', () => {
    for (const outer of TAGS) {
      for (const inner of TAGS) {
        const [a, b] = [name(outer), name(inner)]
        if (a === b) continue
        for (const source of [
          `[${outer}][${inner}]MARCA[/${b}][/${a}]`,
          `[${outer}][${inner}]MARCA[/${a}][/${b}]`,
          `[${outer}][${inner}]MARCA[/${a}]`,
          `[${outer}][${inner}]MARCA`,
          `[${outer}][${inner}]MARCA[/${b}][/${a}][/${a}]`,
        ]) {
          expect(visibleText(source), source).toContain('MARCA')
        }
      }
    }
  })
})
