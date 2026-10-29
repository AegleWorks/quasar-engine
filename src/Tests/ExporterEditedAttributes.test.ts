import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { RedNode } from '../Syntax/RedNode'
import { greenLeaf, greenNode } from '../Syntax/GreenNode'

/**
 * An attribute an editor changed through `metadata` (the canvas inspector)
 * is written from the metadata; one nobody touched keeps the author's
 * spelling byte for byte. Writing every list as `=1` or nothing, and every
 * gradient as its colours alone, dropped `[list=a]` and `axis=spot`.
 */

const exportOf = (source: string, edit?: (root: RedNode) => void, target: 'miliastry' | 'osu' = 'miliastry') => {
  const model = new BBCodeDocumentModel({ source })
  edit?.(model.redRoot!)
  return new BBCodeExporter(model.tagRegistry, target).export(model.redRoot!)
}
const first = (root: RedNode, kind: string): RedNode => {
  const stack = [root]
  while (stack.length) { const n = stack.pop()!; if (n.kind === kind) return n; stack.push(...n.children) }
  throw new Error(kind)
}
const meta = (n: RedNode) => n.metadata as Record<string, unknown>

describe('attributes an editor did not touch keep their spelling', () => {
  for (const source of [
    '[list=a][*]x[/list]', '[list=i][*]x[/list]', '[list=1][*]x[/list]', '[quote=]x[/quote]', '[quote="Ana"]x[/quote]',
    '[gradient=#ff0000,#0000ff;axis=spot;ox=0.3]ab[/gradient]', '[gradient=#FF0000 , #00f]ab[/gradient]',
  ]) {
    it(source, () => expect(exportOf(source)).toBe(source.replace('[quote="Ana"]', '[quote="Ana"]')))
  }
})

describe('attributes an editor changed are written from the metadata', () => {
  it('a list switched to ordered, and back', () => {
    expect(exportOf('[list][*]x[/list]', r => { meta(first(r, 'list')).ordered = true })).toBe('[list=1][*]x[/list]')
    expect(exportOf('[list=1][*]x[/list]', r => { meta(first(r, 'list')).ordered = false })).toBe('[list][*]x[/list]')
  })

  it('a quote author cleared', () => {
    expect(exportOf('[quote="Ana"]x[/quote]', r => { meta(first(r, 'quote')).source = '' })).toBe('[quote]x[/quote]')
  })

  it('new gradient colours keep every other parameter', () => {
    const out = exportOf('[gradient=#ff0000,#0000ff;axis=spot]ab[/gradient]', r => { meta(first(r, 'gradient')).colors = ['#00ff00', '#0000ff'] })
    expect(out).toContain('#00ff00,#0000ff')
    expect(out).toContain('axis=spot')
  })
})

describe('an effect exported to Miliastry comes back as the same picture', () => {
  it('per-letter gradient tags keep one ramp (at/of)', () => {
    const text = 'hola mundo'
    const colors = ['#ff0000', '#0000ff']
    // The shape the studio writes when it splits one range across nodes: one
    // `[gradient]` tag per character, each carrying its slice of the ramp.
    // Built here directly — the tree transformers that used to produce it are
    // gone, and the export path they exercised is not.
    const tree = new RedNode(greenNode('document', ''), { kind: 'document' })
    RedNode.allowMutation(() => {
      [...text].forEach((ch, i) => {
        const node = new RedNode(greenNode('gradient', ''), {
          kind: 'gradient',
          metadata: {
            colors, unit: 'character', easing: 'linear',
            globalOffset: i, documentLength: text.length,
          },
        })
        node.appendChild(new RedNode(greenLeaf('text', ch), { kind: 'text' }))
        tree.appendChild(node)
      })
    })
    const ramps = (root: RedNode): string[] => {
      const out: string[] = []
      const stack = [root]
      while (stack.length) {
        const n = stack.pop()!
        if (n.kind === 'gradient') {
          const m = n.metadata as Record<string, unknown>
          out.push(JSON.stringify([m.colors, m.globalOffset, m.documentLength]))
        }
        for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
      }
      return out
    }
    const model = new BBCodeDocumentModel({ source: text })
    const bbcode = new BBCodeExporter(model.tagRegistry, 'miliastry').export(tree)
    expect(bbcode).toContain(';at=0;of=')
    expect(ramps(new BBCodeDocumentModel({ source: bbcode }).redRoot!)).toEqual(ramps(tree))
  })
})
