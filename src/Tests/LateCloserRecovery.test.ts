import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { RedNode } from '../Syntax/RedNode'

/**
 * How a closing tag finds its opener when the source nests badly.
 *
 * osu!'s parser closes an inner tag when an outer one closes over it — that is
 * what makes `[b][i]x[/b]` work. The part Quasar was missing is what happens to
 * the *next* closer: once `[i]` has been auto-closed, a later `[/i]` has nothing
 * left to close, and osu! throws it away rather than hunting up the stack for
 * another `[i]`.
 *
 * Skipping that made a document lose its shape. In a userpage built as
 *
 *     [box=outer]
 *     [notice][box=inner-1] … [/notice][/box]
 *     [notice][box=inner-2] … [/notice][/box]
 *     [/notice][/box]
 *
 * the `[/box]` after the first `[/notice]` walked past the closed `inner-1` and
 * closed `outer` instead, so every later section fell out of the box it was
 * written inside. On `docs/ai/NyuPenyu` that flattened 43 nested boxes down to
 * 9 and made the rendered page 78% taller than what osu! shows.
 */

/** The container tree, as indented lines — the shape, without the prose. */
function shape(source: string): string[] {
  const CONTAINERS = ['box', 'spoilerbox', 'boxw', 'notice', 'center', 'quote']
  const out: string[] = []
  const walk = (node: RedNode, depth: number) => {
    const isContainer = CONTAINERS.includes(node.kind)
    if (isContainer) {
      const title = String(node.metadata?.rawTitle ?? node.metadata?.title ?? '')
      out.push('  '.repeat(depth) + node.kind + (title ? '=' + title : ''))
    }
    for (const child of node.children) walk(child, depth + (isContainer ? 1 : 0))
  }
  walk(new BBCodeDocumentModel({ source }).redRoot!, 0)
  return out
}

/** Inline marks, which the container shape does not show. */
function inlineShape(source: string): string {
  const walk = (node: RedNode): string => {
    if (node.kind === 'text') return node.text
    const inner = node.children.map(walk).join('')
    return ['bold', 'italic', 'underline', 'strikethrough'].includes(node.kind)
      ? `${node.kind}(${inner})`
      : inner
  }
  return walk(new BBCodeDocumentModel({ source }).redRoot!)
}

describe('a closer whose tag was already auto-closed is discarded', () => {
  it('keeps later siblings inside the box they were written in', () => {
    const source = [
      '[box=EXTERIOR]',
      '[notice][box=in1]',
      '[/notice][/box]',
      '[notice][box=in2]',
      '[/notice][/box]',
      '[/notice][/box]',
    ].join('\n')

    expect(shape(source)).toEqual([
      'box=EXTERIOR',
      '  notice',
      '    box=in1',
      '  notice',
      '    box=in2',
    ])
  })

  it('does not let the stray closer reach past two auto-closed levels', () => {
    const source = [
      '[box=A]',
      '[notice][centre][box=B]',
      '[/notice][/centre][/box]',
      '[notice][centre][box=C]',
      '[/notice][/centre][/box]',
      '[/notice][/box]',
    ].join('\n')

    expect(shape(source)).toEqual([
      'box=A',
      '  notice',
      '    center',
      '      box=B',
      '  notice',
      '    center',
      '      box=C',
    ])
  })

  it('still auto-closes the inner tag, which is what makes [b][i]x[/b] work', () => {
    expect(inlineShape('[b][i]x[/b]')).toBe('bold(italic(x))')
  })

  it('parks the late closer in a node that owns its range but is never shown', () => {
    // `[/i]` has nothing to close: `[i]` went out with the `[/b]`. It becomes a
    // `discarded_tag` — the range still belongs to a node, so the incremental
    // parser can map every character, but neither the renderer nor the exporter
    // emits it. Written back as text it returned from the exporter as a live
    // tag, and the document stopped converging.
    expect(inlineShape('[b][i]x[/b]y[/i]')).toBe('bold(italic(x))y')

    const kinds: string[] = []
    new BBCodeDocumentModel({ source: '[b][i]x[/b]y[/i]' }).redRoot!.walk(n => { kinds.push(n.kind) })
    expect(kinds).toContain('discarded_tag')
  })

  it('reopening the tag clears the mark, so its own closer still counts', () => {
    const source = [
      '[box=A]',
      '[notice][box=B]',
      '[/notice]',
      '[box=C]',
      '[/box]',
      '[/box]',
    ].join('\n')

    expect(shape(source)).toEqual([
      'box=A',
      '  notice',
      '    box=B',
      '  box=C',
    ])
  })

  it('leaves well-nested source exactly as written', () => {
    const source = ['[box=A]', '[notice]', '[box=B]', '[/box]', '[/notice]', '[/box]'].join('\n')
    expect(shape(source)).toEqual(['box=A', '  notice', '    box=B'])
  })

  it('ignores a closer that never had an opener at all', () => {
    expect(shape('[/box]\n[box=A]x[/box]')).toEqual(['box=A'])
  })

  it('swallows a repeated closer rather than closing an ancestor', () => {
    const source = ['[box=A]', '[notice]', '[box=B]', '[/notice]', '[/box]', '[/box]', '[/box]'].join('\n')
    expect(shape(source)).toEqual(['box=A', '  notice', '    box=B'])
  })

  it('does not confuse a tag written inside an attribute', () => {
    // `[box=[b]title[/b]]` puts markup in the title; the `[/b]` there is part of
    // the attribute and must not be mistaken for a late closer.
    const source = '[box=[b]locus 2025 [31/01/2025][/b]]\ncontenido\n[/box]'
    expect(shape(source)).toEqual(['box=[b]locus 2025 [31/01/2025][/b]'])
  })
})
