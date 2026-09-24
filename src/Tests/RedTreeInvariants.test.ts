import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { checkRedTree, assertRedTree } from '../Syntax/redTreeInvariants'
import { REFERENCE_DOCUMENT } from './referenceDocument'
import type { RedNode } from '../Syntax/RedNode'
import type { NodeId } from '../Types/core'

/**
 * `checkRedTree` is only worth running if it can fail. Every violation kind
 * is provoked here by corrupting a known-good tree the way a bug in one of the
 * maintenance paths would (a missed reparent, a lost lazy shift, an id adopted
 * twice), and the incremental parser is held to it after every random edit.
 */

const parse = (source: string, pairing: 'quasar' | 'osu' = 'quasar'): RedNode =>
  new BBCodeDocumentModel({ source, dialect: 'osu', pairing, incremental: false, autoAnalyze: false }).redRoot!

const kinds = (root: RedNode, source?: string) => checkRedTree(root, { source }).map(v => v.kind)

const SAMPLE = 'intro [b]negrita[/b]\n\n[box=[b]Rico[/b] titulo]dentro\n\n[notice]aviso[/notice][/box]\n\n[list]\n[*]uno\n[*]dos\n[/list]'

describe('checkRedTree', () => {
  it.each([
    ['the reference document', REFERENCE_DOCUMENT],
    ['rich titles, nesting and lists', SAMPLE],
  ])('passes on %s, with both pairings', (_name, source) => {
    expect(kinds(parse(source), source)).toEqual([])
    expect(kinds(parse(source, 'osu'), source)).toEqual([])
  })

  it.each([
    ['no `=` (the lexer accepts `[box[/b] …]`)', '[box[/b] titulo]dentro[/box]'],
    ['a quoted title', '[box="[b]Rico[/b] titulo"]dentro[/box]'],
    ['an uppercase tag', '[BOX=[b]Rico[/b]]dentro[/BOX]'],
    ['a colour suffix', '[box=[b]Rico[/b]:#ff66ab]dentro[/box]'],
  ])('positions rich box titles on their own characters: %s', (_name, source) => {
    const root = parse(source)
    const box = root.children.find(c => c.kind === 'box')
    expect(box?.metadata.titleNodes).toBeDefined()
    expect(kinds(root, source)).toEqual([])
  })

  it('catches a child whose parent pointer was not rewired', () => {
    const root = parse(SAMPLE)
    root.children[1].parent = root.children[0]
    expect(kinds(root)).toContain('parent')
  })

  it('catches a subtree left at the wrong offset (a lost or doubled shift)', () => {
    const root = parse(SAMPLE)
    root.children[2].setStart(root.children[2].range.start + 3)
    expect(kinds(root)).toContain('range')
  })

  it('catches an id adopted twice', () => {
    const root = parse(SAMPLE)
    ;(root.children[2] as { id: NodeId }).id = root.children[0].id
    expect(kinds(root)).toContain('duplicate-id')
  })

  it('catches a red child list that no longer mirrors its green', () => {
    const root = parse(SAMPLE)
    // Deliberate corruption, past the type system that normally forbids it.
    ;(root.children as RedNode[]).pop()
    expect(kinds(root)).toContain('shape')
  })

  it('catches a rich title that was not shifted with its box', () => {
    const root = parse(SAMPLE)
    const box = root.children.find(c => c.kind === 'box')!
    const titles = box.metadata.titleNodes as RedNode[]
    expect(titles.length).toBeGreaterThan(0)
    titles[0].setStart(box.range.end + 5)
    expect(kinds(root)).toContain('title')
  })

  it('catches a tree that describes a different text than the one given', () => {
    const root = parse(SAMPLE)
    expect(kinds(root, SAMPLE + 'x')).toContain('source')
    expect(kinds(root, SAMPLE.replace('intro', 'INTRO'))).toContain('source')
  })

  it('reports readably through assertRedTree', () => {
    const root = parse(SAMPLE)
    root.children[1].parent = null
    expect(() => assertRedTree(root)).toThrow(/parent at document\//)
  })
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = ['x', ' ', '\n', '\n\n', '[b]', '[/b]', '[box=T]', '[box=[b]R[/b]]', '[/box]', '[notice]', '[/notice]',
  '[list]', '[*]', '[/list]', '[centre]', '[/centre]', '[quote]', '[/quote]', '[color=red]', '[/color]']

describe('incremental parser — the red tree stays valid after every edit', () => {
  it('holds every invariant across random edits of a document above the incremental threshold', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = mulberry32(seed)
      let source = Array.from({ length: 40 }, (_, i) => `${SAMPLE} ${i}`).join('\n\n')
      const model = new BBCodeDocumentModel({ source, dialect: 'osu', autoAnalyze: false })
      for (let step = 0; step < 40; step++) {
        const at = Math.floor(rand() * (source.length + 1))
        source = rand() < 0.6
          ? source.slice(0, at) + TOKENS[Math.floor(rand() * TOKENS.length)] + source.slice(at)
          : source.slice(0, at) + source.slice(at + 1 + Math.floor(rand() * 10))
        model.applyTextUpdate(source)
        const violations = checkRedTree(model.redRoot!, { source, limit: 3 })
        expect(violations, `seed ${seed} step ${step}`).toEqual([])
      }
    }
  })
})
