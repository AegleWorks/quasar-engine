import { describe, it, expect } from 'vitest'
import { OsuPreviewTree } from '../Osu/OsuPreviewTree'
import { patchBlocksInto } from '../Visitors/BlockPatcher'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { RedNode } from '../Syntax/RedNode'

/**
 * The patcher keeps one DOM node per run, and the HTML parser does not always
 * agree: it reshapes malformed markup. Both ways that used to leave a wrong
 * DOM behind, found by the random-edit test of `OsuPreviewTree` (osu! pairing
 * produces far more malformed nesting than Quasar's):
 *
 *   - a block whose own HTML parses to several nodes, patched in on its own:
 *     only the first node was inserted, the rest silently dropped;
 *   - a whole-document parse that reshapes ACROSS blocks without changing the
 *     node count, so the run list looked in sync with a DOM it did not mirror.
 *
 * Either way the answer is a full render, and staying on it while the
 * document is malformed.
 */

const stripIds = (html: string): string => html.replace(/ data-node-id="[^"]*"/g, '')

function renderWhole(renderer: HTMLRenderer, root: RedNode): string {
  const full = document.createElement('div')
  full.innerHTML = renderer.render(root)
  return stripIds(full.innerHTML)
}

describe('BlockPatcher — HTML the parser reshapes', () => {
  it.each([
    ['keyed reconcile', undefined],
    ['windowed reconcile', 0],
  ])('%s: a block that parses to several nodes is rendered whole, not truncated', (_path, minWindowedBlocks) => {
    // Typing `[*]` makes the notice's content a stray list item: its `<li>`
    // holds another `<li>`, which the HTML parser splits into two siblings.
    const renderer = new HTMLRenderer({ dialect: 'osu', theme: 'osu' })
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    const container = document.createElement('div')
    const before = 'intro\n\n[*]a[notice]\nb[/notice]\n\nfin'
    patchBlocksInto(container, tree.update(before), { renderer, minWindowedBlocks })

    const at = before.indexOf('\nb') + 1
    const after = before.slice(0, at) + '[*]' + before.slice(at)
    const stats = patchBlocksInto(container, tree.update(after), { renderer, minWindowedBlocks })

    expect(stats.mode).toBe('full')
    expect(stripIds(container.innerHTML)).toBe(renderWhole(renderer, tree.root!))
  })

  it('a reshape that keeps the node count still counts as out of sync', () => {
    // Stands in for an unbalanced block body: the parser moves text out of the
    // element, and it merges with the bare-text run after it. One element and
    // one text node, exactly as many nodes as runs — but the text is wrong.
    class TailRenderer extends HTMLRenderer {
      render(node: RedNode): string {
        if (node.parent === null) return node.children.map((c) => this.render(c)).join('')
        const html = super.render(node)
        return node.kind === 'notice' && html.includes('>x<') ? `${html}tail` : html
      }
    }
    const renderer = new TailRenderer({ dialect: 'miliastry' })
    // After a notice the line break renders as bare text, and
    // `OsuPreviewTree` keeps it as the same node across the edit, so its
    // cached run is what the patch has to trust.
    const tree = new OsuPreviewTree({ dialect: 'miliastry' })
    const container = document.createElement('div')
    patchBlocksInto(container, tree.update('[notice]x[/notice]\ny'), { renderer })

    // The notice stops emitting the stray text.
    patchBlocksInto(container, tree.update('[notice]z[/notice]\ny'), { renderer })

    expect(container.textContent).not.toContain('tail')
    expect(stripIds(container.innerHTML)).toBe(renderWhole(renderer, tree.root!))
  })
})
