import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { MAX_NESTING_DEPTH } from '../BBCode/Parser'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { checkRedTree } from '../Syntax/redTreeInvariants'
import { HTMLDocumentModel } from '../HTML/HTMLDocumentModel'
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel'
import { MilHibriDocumentModel } from '../MilHibri/MilHibriDocumentModel'
import type { GreenNode } from '../Syntax/GreenNode'

/**
 * Past `MAX_NESTING_DEPTH` the parser keeps openers, and the closers that
 * answer them, as literal text. Every walker in the engine recurses once per
 * level, so without the limit `'[b]'.repeat(2000)` threw a stack overflow out
 * of an engine that promises never to throw on input.
 */

function frames(node: GreenNode): number {
  let max = 0
  const stack: [GreenNode, number][] = [[node, 0]]
  while (stack.length > 0) {
    const [n, above] = stack.pop()!
    const d = above + (n.leadingWidth > 0 ? 1 : 0)
    if (d > max) max = d
    for (const c of n.children) stack.push([c as GreenNode, d])
  }
  return max
}

/** Every node, pre-order: kind, width and text — what "the same tree" means here. */
function shape(node: GreenNode): string {
  const out: string[] = []
  const stack: GreenNode[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    out.push(`${n.kind}:${n.width}:${n.text}`)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as GreenNode)
  }
  return out.join('|')
}

const SHAPES: Record<string, (n: number) => string> = {
  'open bold': n => '[b]'.repeat(n) + 'x',
  'closed bold': n => '[b]'.repeat(n) + 'x' + '[/b]'.repeat(n),
  'boxes': n => '[box=t]'.repeat(n) + 'x' + '[/box]'.repeat(n),
  'quotes': n => '[quote]'.repeat(n) + 'x' + '[/quote]'.repeat(n),
  'list items': n => '[list][*]'.repeat(n) + 'x',
  'unclosed per line': n => '[b]x\n'.repeat(n),
  'mixed': n => Array.from({ length: n }, (_, i) => ['[b]', '[i]', '[color=red]', '[size=150]', '[u]'][i % 5]).join('') + 'x',
}

describe('the nesting limit', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    it(`${name}: 20 000 deep parses, renders, exports and analyses without throwing`, () => {
      const source = make(20000)
      const model = new BBCodeDocumentModel({ source })
      expect(frames(model.greenRoot!)).toBeLessThanOrEqual(MAX_NESTING_DEPTH)
      expect(checkRedTree(model.redRoot!, { source })).toEqual([])
      expect(() => new HTMLRenderer().render(model.redRoot!)).not.toThrow()
      expect(() => new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)).not.toThrow()
      expect(() => BBCodeDocumentModel.renderForum(source)).not.toThrow()
      expect(() => new BBCodeDocumentModel({ source, pairing: 'osu', dialect: 'osu' })).not.toThrow()
      const at = source.length >> 1
      expect(() => model.applyTextUpdate(source.slice(0, at) + 'q' + source.slice(at))).not.toThrow()
    })
  }

  it('openers past the limit, and their closers, are literal text', () => {
    const n = MAX_NESTING_DEPTH + 3
    const source = '[b]'.repeat(n) + 'x' + '[/b]'.repeat(n)
    const model = new BBCodeDocumentModel({ source })
    expect(frames(model.greenRoot!)).toBe(MAX_NESTING_DEPTH)
    const html = new HTMLRenderer({ idMode: 'none' }).render(model.redRoot!)
    expect(html).toContain('[b][b][b]x[/b][/b][/b]')
  })

  it('says why, and does not call [b] an unknown tag', () => {
    const n = MAX_NESTING_DEPTH + 1
    const model = new BBCodeDocumentModel({ source: '[b]'.repeat(n) + 'x' + '[/b]'.repeat(n) })
    const codes = model.diagnostics!.items.map(d => d.code)
    expect(codes).toContain('nesting-too-deep')
    expect(codes).not.toContain('unknown-tag')
  })

  it('nothing changes below the limit', () => {
    const n = MAX_NESTING_DEPTH
    const model = new BBCodeDocumentModel({ source: '[b]'.repeat(n) + 'x' + '[/b]'.repeat(n) })
    expect(frames(model.greenRoot!)).toBe(n)
    expect(model.diagnostics!.items.map(d => d.code)).not.toContain('nesting-too-deep')
  })

  it('incremental edits around the limit match a full parse', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pieces = ['[b]', '[/b]', '[i]', '[/i]', 'x', ' ', '\n', '[box=t]', '[/box]', '[quote]', '[/quote]']
    for (let doc = 0; doc < 6; doc++) {
      const depth = MAX_NESTING_DEPTH - 6 + doc * 2
      let source = 'intro\n\n' + '[b]'.repeat(depth) + 'a [i]b[/i] c' + '[/b]'.repeat(depth) + '\n\noutro'
      const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
      for (let edit = 0; edit < 60; edit++) {
        const at = Math.floor(rand() * (source.length + 1))
        source = rand() < 0.6
          ? source.slice(0, at) + pieces[Math.floor(rand() * pieces.length)] + source.slice(at)
          : source.slice(0, at) + source.slice(at + 1 + Math.floor(rand() * 4))
        model.applyTextUpdate(source)
        const truth = new BBCodeDocumentModel({ source, autoAnalyze: false })
        expect(shape(model.greenRoot!), `doc ${doc}, edit ${edit}`).toBe(shape(truth.greenRoot!))
      }
    }
  })

  describe('importers stop nesting at the same depth', () => {
    const importers: Record<string, () => { redRoot: unknown; greenRoot: unknown }> = {
      'HTML <div>': () => new HTMLDocumentModel({ source: '<div>'.repeat(8000) + 'deep text' }) as never,
      'HTML <b>': () => new HTMLDocumentModel({ source: '<b>'.repeat(8000) + 'deep text' }) as never,
      'Markdown emphasis': () => MarkdownDocumentModel.fromMarkdown('*_'.repeat(8000) + 'deep text' + '_*'.repeat(8000)) as never,
      'MilHibri': () => MilHibriDocumentModel.fromSource('[b]'.repeat(8000) + '**deep text**') as never,
    }
    for (const [name, build] of Object.entries(importers)) {
      it(`${name}: keeps the text, renders and exports`, () => {
        const model = build() as unknown as BBCodeDocumentModel
        expect(frames(model.greenRoot!)).toBeLessThanOrEqual(MAX_NESTING_DEPTH + 2)
        const html = new HTMLRenderer().render(model.redRoot!)
        expect(html).toContain('deep text')
        expect(() => new BBCodeExporter(undefined, 'osu').export(model.redRoot!)).not.toThrow()
      })
    }
  })
})
