import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { QueryEngine } from '../Queries/QueryEngine'
import { query } from '../Types/queries'
import type { RedNode } from '../Syntax/RedNode'

const engine = new QueryEngine()

function parse(source: string): RedNode {
  return new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot!
}

function run(source: string, selector: string): RedNode[] {
  return engine.execute(query(selector), parse(source)).matches.map(m => m.node)
}

describe('QueryEngine — documented selectors', () => {
  it('finds every node of a kind from the whole document', () => {
    expect(run('[b]one[/b] [i]two[/i] [b]three[/b]', 'bold')).toHaveLength(2)
    expect(run('[b]one[/b]', 'italic')).toHaveLength(0)
  })

  it('matches descendants with whitespace and direct children with >', () => {
    const source = '[quote][b]inside[/b][/quote]\n\n[b]outside[/b]'
    const descendant = run(source, 'quote bold')
    const child = run(source, 'quote > bold')
    expect(descendant).toHaveLength(1)
    expect(descendant[0].children[0]?.text).toBe('inside')
    expect(child).toHaveLength(1)
    expect(child[0].range).toEqual(descendant[0].range)
    // The sibling bold lives inside a paragraph, so it is not a child of the
    // document and not a descendant of the quote.
    expect(run(source, 'document > bold')).toHaveLength(0)
    expect(run(source, 'quote ~ bold')).toHaveLength(0)
  })

  it('finds the first paragraph under the document', () => {
    const source = 'first\n\nsecond'
    const paragraphs = run(source, 'document > paragraph')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs.map(p => p.range.start)).toEqual([0, 7])
  })

  it('resolves adjacent and following siblings', () => {
    const source = '[b]a[/b][i]b[/i] [s]c[/s][i]d[/i]'
    expect(run(source, 'bold + italic')).toHaveLength(1)
    expect(run(source, 'bold ~ italic')).toHaveLength(2)
    expect(run(source, 'italic + bold')).toHaveLength(0)
  })

  it('supports the universal selector', () => {
    const root = parse('[b]x[/b] [i]y[/i]')
    let count = 0
    root.walk(() => { count++ })
    const all = engine.execute(query('*'), root).matches.map(m => m.node)
    expect(all).toHaveLength(count)
    expect(all[0]).toBe(root)
  })

  it('reads a bracketed name as a BBCode tag and its =value as the attribute', () => {
    const source = '[color=red]r[/color] [color=blue]b[/color] [b]x[/b]'
    expect(run(source, '[color]')).toHaveLength(2)
    expect(run(source, '[color=red]')).toHaveLength(1)
    expect(run(source, '[color=red]')[0].metadata.color).toBe('red')
    expect(run(source, '[b]')).toHaveLength(1)
  })

  it('keeps spaces inside a bracketed attribute', () => {
    const source = '[box=My Long Title]body[/box]'
    const boxes = run(source, '[box=My Long Title]')
    expect(boxes).toHaveLength(1)
    expect(boxes[0].metadata.rawTitle).toBe('My Long Title')
  })

  it('supports CSS attribute selectors on a tag', () => {
    const source = '[url=https://osu.ppy.sh]ok[/url] [url=http://x.y]plain[/url]'
    expect(run(source, 'url[href=https://osu.ppy.sh]')).toHaveLength(1)
    expect(run(source, 'url[href]')).toHaveLength(2)
  })

  it('supports positional pseudo-classes', () => {
    const source = '[list][*]first[*]second[*]third[/list]'
    expect(run(source, 'list_item:first-child')).toHaveLength(1)
    expect(run(source, 'list_item:last-child')).toHaveLength(1)
    expect(run(source, 'list_item:nth-child(2)')).toHaveLength(1)
  })

  it('supports programmatic positional and depth selectors', () => {
    const root = parse('a\n\nb\n\nc')
    const firstTwo = engine.execute({
      steps: [{ combinator: 'root', selector: [{ type: 'position', max: 1 }] }],
    }, root)
    expect(firstTwo.matches.length).toBeGreaterThan(0)
    expect(firstTwo.matches.every(m => m.node.index <= 1)).toBe(true)

    const shallow = engine.execute({
      steps: [{ combinator: 'root', selector: [{ type: 'depth', max: 1 }] }],
    }, root)
    expect(shallow.matches.every(m => m.node.depth <= 1)).toBe(true)
    expect(shallow.matches.some(m => m.node === root)).toBe(true)
  })
})

describe('QueryEngine — result contract', () => {
  it('returns document order with no duplicates', () => {
    const matches = run('[quote][quote][b]x[/b][/quote][/quote]', '[quote] b')
    const ranges = matches.map(n => n.range.start)
    expect([...ranges].sort((a, b) => a - b)).toEqual(ranges)
    expect(new Set(matches).size).toBe(matches.length)
  })

  it('returns nothing for an empty or unparseable selector', () => {
    const root = parse('[b]x[/b]')
    expect(engine.execute(query(''), root).matches).toEqual([])
    expect(engine.execute(query('   '), root).matches).toEqual([])
    expect(engine.execute({ steps: [] }, root).matches).toEqual([])
  })

  it('recovers from unbalanced brackets instead of throwing', () => {
    const root = parse('[b]x[/b]')
    expect(() => engine.execute(query('[b'), root)).not.toThrow()
    expect(() => engine.execute(query('(*'), root)).not.toThrow()
  })

  it('does not mint node ids while querying', () => {
    const root = parse('[b]x[/b] [i]y[/i]')
    // `QUASAR_VALIDATE_TREES=1` makes the model's own validator read ids, so
    // the precondition is "no id changed", not "none was ever minted".
    const before = rawIds(root)
    engine.execute(query('*'), root)
    expect(rawIds(root)).toEqual(before)
  })

  it('reports one selector description per compound part', () => {
    const result = engine.execute(query('[color=red]:first-child'), parse('[color=red]x[/color]'))
    expect(result.matches[0]?.matchedSelectors).toEqual(['tag:color', 'value:red', 'first-child'])
  })

  it('returns a time measurement', () => {
    const result = engine.execute(query('*'), parse('text'))
    expect(typeof result.time).toBe('number')
    expect(result.time).toBeGreaterThanOrEqual(0)
  })
})

/** The private id slot, without invoking the lazy getter. */
function rawIds(root: RedNode): Array<string | undefined> {
  const out: Array<string | undefined> = []
  root.walk(node => { out.push((node as unknown as { _id?: string })._id) })
  return out
}
