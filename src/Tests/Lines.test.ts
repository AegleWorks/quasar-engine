import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { lineOf, linesOf, resolveLineId, isLineId } from '../Semantic/lines'
import type { RedNode } from '../Syntax/RedNode'

/**
 * Lines inside containers (`Semantic/lines.ts`): derived from the tree, never
 * stored in it, and the same answer for the renderer and for the editor.
 */

const parse = (source: string) => new BBCodeDocumentModel({ source, autoAnalyze: false })

function find(node: RedNode, kind: string): RedNode | null {
  if (node.kind === kind) return node
  for (const c of node.children) {
    const f = find(c, kind)
    if (f) return f
  }
  return null
}

const SOURCE = '[box=T]uno\ndos [b]tres[/b] cuatro\n\n[notice]dentro[/notice]cinco[/box]'

describe('lines — derived, not stored', () => {
  it('a container is split at newlines, empty lines and block children', () => {
    const { redRoot } = parse(SOURCE)
    const box = find(redRoot!, 'box')!
    const text = (l: { start: number; end: number }) => SOURCE.slice(l.start, l.end)
    expect(linesOf(box).map(text)).toEqual(['uno', 'dos [b]tres[/b] cuatro', 'cinco'])
    // The notice inside is a block of the box, with lines of its own.
    expect(linesOf(find(box, 'notice')!).map(text)).toEqual(['dentro'])
    // The tree itself is untouched: no node was added.
    expect(box.children.map((c) => c.kind)).toEqual(['text', 'spacing', 'text', 'bold', 'text', 'spacing', 'empty_line', 'notice', 'text'])
  })

  it('lineOf climbs through inline ancestors; the root and blocks have none', () => {
    const { redRoot } = parse('fuera\n' + SOURCE)
    const bold = find(redRoot!, 'bold')!
    const inBold = bold.children[0]
    expect(lineOf(inBold)!.id).toBe(lineOf(bold)!.id)
    expect(lineOf(redRoot!.children[0].children[0])).toBeNull() // root paragraph text
    expect(lineOf(find(redRoot!, 'notice')!)).toBeNull()
  })

  it('a line id resolves back to the same line, and not once its first node begins no line', () => {
    const { redRoot } = parse(SOURCE)
    const box = find(redRoot!, 'box')!
    for (const line of linesOf(box)) {
      expect(isLineId(line.id)).toBe(true)
      expect(resolveLineId(redRoot!, line.id)).toMatchObject({ start: line.start, end: line.end })
    }
    const bold = find(box, 'bold')!
    expect(resolveLineId(redRoot!, `line:${bold.id}`)).toBeNull() // mid-line
    expect(resolveLineId(redRoot!, 'line:nope')).toBeNull()
  })

  it('typing inside a line keeps its id — the preview attribute does not churn', () => {
    const model = parse('intro\n\n' + SOURCE)
    const before = linesOf(find(model.redRoot!, 'box')!).map((l) => l.id)
    const at = model.source.indexOf('cuatro')
    model.applyTextUpdate(model.source.slice(0, at) + 'x' + model.source.slice(at))
    const after = linesOf(find(model.redRoot!, 'box')!).map((l) => l.id)
    expect(after).toEqual(before)
  })
})

describe('lines — rendered as the editor\'s handle', () => {
  it('each line of a container is wrapped, carrying its id; the root keeps paragraphs', () => {
    const { redRoot } = parse('raíz\n' + SOURCE)
    const html = new HTMLRenderer({ dialect: 'miliastry', lineHandles: true }).render(redRoot!)
    const box = find(redRoot!, 'box')!
    for (const line of linesOf(box)) expect(html).toContain(`<span class="bb-line" data-node-id="${line.id}">`)
    expect(html).toContain('class="bb-paragraph"')
    expect((html.match(/class="bb-line"/g) ?? []).length).toBe(4) // 3 in the box + 1 in the notice
  })

  it('only a render that asks for them (lineHandles) carries wrappers, and never without ids', () => {
    const { redRoot } = parse(SOURCE)
    for (const dialect of ['osu', 'miliastry', 'lyne'] as const) {
      expect(new HTMLRenderer({ dialect, idMode: 'none', lineHandles: true }).render(redRoot!)).not.toContain('bb-line')
      // …and neither does any render that did not ask for them.
      expect(new HTMLRenderer({ dialect }).render(redRoot!)).not.toContain('bb-line')
    }
  })

  it('a line of only spaces is left bare, so osu!\'s edge trimming still sees spaces and newline together', () => {
    const source = '[box=T]  \nhola\n  [/box]'
    const { redRoot } = parse(source)
    const html = new HTMLRenderer({ dialect: 'osu', lineHandles: true }).render(redRoot!)
    const bare = new HTMLRenderer({ dialect: 'osu', idMode: 'none' }).render(redRoot!)
    const unwrapped = html.replace(/<span class="bb-line" data-node-id="[^"]*">(hola)<\/span>/, '$1').replace(/ data-node-id="[^"]*"/g, '')
    expect(unwrapped).toBe(bare)
  })
})
