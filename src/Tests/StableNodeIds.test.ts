import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { morphHTML } from '../Visitors/DOMMorpher'
import type { RedNode } from '../Syntax/RedNode'

/**
 * Node ids must survive a reparse for every node that did not change.
 *
 * Ids are embedded in the rendered HTML as `data-node-id` (the preview→Monaco
 * click mapping reads them), so regenerating them on every parse made the HTML
 * of *unchanged* subtrees differ between keystrokes — which defeated the
 * DOMMorpher's isEqualNode fast path and rewrote DOM the user was looking at.
 *
 * The last test is the end-to-end payoff: after a one-character edit, the DOM
 * elements of untouched content must keep their object identity through a
 * morph, because their HTML is now byte-identical.
 */

/** Map every text node's content to its id (text content identifies the leaf). */
function textIds(root: RedNode): Map<string, string> {
  const out = new Map<string, string>()
  root.walk(n => {
    if (n.kind === 'text' && n.text.trim() !== '') out.set(n.text, String(n.id))
  })
  return out
}

function subtreeText(node: RedNode): string {
  let out = ''
  node.walk(n => { if (n.kind === 'text') out += n.text })
  return out
}

function allIds(root: RedNode): string[] {
  const out: string[] = []
  root.walk(n => { out.push(String(n.id)) })
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

describe('stable node ids across reparses', () => {
  it('an edit in the middle keeps the ids of untouched content (incremental path)', () => {
    const model = new BBCodeDocumentModel({
      source: 'uno\n\ndos\n\ntres\n\n[b]cuatro[/b]',
    })
    const before = textIds(model.redRoot!)

    model.applyTextUpdate('uno\n\ndos EDITADO\n\ntres\n\n[b]cuatro[/b]')
    const after = textIds(model.redRoot!)

    expect(after.get('uno')).toBe(before.get('uno'))
    expect(after.get('tres')).toBe(before.get('tres'))
    expect(after.get('cuatro')).toBe(before.get('cuatro'))
  })

  it('typing at the end keeps every previous id', () => {
    const model = new BBCodeDocumentModel({
      source: 'uno\n\n[i]dos[/i]\n\ntres',
    })
    const before = textIds(model.redRoot!)

    model.applyTextUpdate('uno\n\n[i]dos[/i]\n\ntres y algo mas')
    const after = textIds(model.redRoot!)

    expect(after.get('uno')).toBe(before.get('uno'))
    expect(after.get('dos')).toBe(before.get('dos'))
  })

  it('a full rebuild also preserves ids, via hash matching', () => {
    const model = new BBCodeDocumentModel({
      source: 'uno\n\ndos\n\n[b]tres[/b]',
    })
    const before = textIds(model.redRoot!)

    // rebuild() reparses everything: no green is shared by reference, so this
    // exercises the hash-verified tier.
    model.rebuild('uno\n\ndos!\n\n[b]tres[/b]')
    const after = textIds(model.redRoot!)

    expect(after.get('uno')).toBe(before.get('uno'))
    expect(after.get('tres')).toBe(before.get('tres'))
  })

  it('ids stay unique through seeded random edit sequences', () => {
    const rand = mulberry32(1234)
    const alphabet = ['a', ' ', '\n', '[', ']', 'b', '[b]', '[/b]', '[i]', '[/i]', '[list]', '[*]']

    for (let doc = 0; doc < 8; doc++) {
      let source = ''
      const parts = 40 + Math.floor(rand() * 120)
      for (let i = 0; i < parts; i++) {
        source += alphabet[Math.floor(rand() * alphabet.length)]
      }
      const model = new BBCodeDocumentModel({ source })

      for (let edit = 0; edit < 25; edit++) {
        const pos = Math.floor(rand() * (model.source.length + 1))
        const insert = alphabet[Math.floor(rand() * alphabet.length)]
        const next = rand() < 0.75
          ? model.source.slice(0, pos) + insert + model.source.slice(pos)
          : model.source.slice(0, pos) + model.source.slice(Math.min(pos + 1, model.source.length))
        model.applyTextUpdate(next)

        const ids = allIds(model.redRoot!)
        expect(new Set(ids).size).toBe(ids.length)
        expect(model.redRoot!.green).toBe(model.greenRoot)
      }
    }
  })

  it('inserting a block does not renumber the blocks that survive it', () => {
    // Regression. Identity is carried either by red-subtree REUSE (the nodes
    // are the previous objects) or by the id walk (every node is fresh) —
    // never both. When both ran, the walk paired positionally, so inserting a
    // block made each survivor pair with its NEIGHBOUR: it overwrote a live
    // node's id with a different node's, which both duplicated ids and
    // changed `data-node-id` on blocks that had not changed — defeating the
    // morpher's fast path exactly when it matters most.
    let src = ''
    for (let i = 0; i < 40; i++) src += `[notice]bloque ${i}[/notice]\n\n`
    const model = new BBCodeDocumentModel({ source: src })

    const idOf = (root: RedNode, text: string): string | null => {
      let found: string | null = null
      root.walk(n => {
        if (!found && n.kind === 'notice' && n.text === '' && subtreeText(n).includes(text)) {
          found = String(n.id)
        }
      })
      return found
    }
    const before10 = idOf(model.redRoot!, 'bloque 10')
    const before39 = idOf(model.redRoot!, 'bloque 39')
    expect(before10).toBeTruthy()

    // Insert a whole new block near the start: everything after it shifts.
    model.applyTextUpdate('[notice]NUEVO[/notice]\n\n' + src)

    expect(idOf(model.redRoot!, 'bloque 10')).toBe(before10)
    expect(idOf(model.redRoot!, 'bloque 39')).toBe(before39)

    const ids = allIds(model.redRoot!)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('end to end: untouched id-bearing blocks keep DOM identity through a morph', () => {
    // Only block containers carry data-node-id (see HTMLRenderer.ID_BEARING_KINDS),
    // so blocks are where id churn used to break the morpher's fast path.
    const model = new BBCodeDocumentModel({
      source: '[notice]uno[/notice]\n\n[quote]dos[/quote]\n\n[notice]tres[/notice]',
    })
    const renderer = new HTMLRenderer()
    const el = document.createElement('div')
    el.innerHTML = renderer.render(model.redRoot!)

    const findBlock = (text: string): Element | null => {
      for (const block of Array.from(el.querySelectorAll('[data-node-id]'))) {
        if (block.textContent?.includes(text)) return block
      }
      return null
    }

    const unoBefore = findBlock('uno')
    const tresBefore = findBlock('tres')
    expect(unoBefore).toBeTruthy()
    expect(tresBefore).toBeTruthy()
    const unoId = unoBefore!.getAttribute('data-node-id')
    const tresId = tresBefore!.getAttribute('data-node-id')

    model.applyTextUpdate('[notice]uno[/notice]\n\n[quote]dos EDITADO[/quote]\n\n[notice]tres[/notice]')
    morphHTML(el, renderer.render(model.redRoot!))

    // Same DOM objects, not equivalent ones: their HTML — ids included — did
    // not change, so the morpher's isEqualNode fast path skipped them.
    expect(findBlock('uno')).toBe(unoBefore)
    expect(findBlock('tres')).toBe(tresBefore)
    expect(unoBefore!.getAttribute('data-node-id')).toBe(unoId)
    expect(tresBefore!.getAttribute('data-node-id')).toBe(tresId)
    // And the edited block is actually updated.
    expect(findBlock('dos EDITADO')).toBeTruthy()
  })

  it('every data-node-id in fresh HTML resolves to a node in the current tree', () => {
    const model = new BBCodeDocumentModel({
      source: '[notice]uno[/notice]\n\n[list][*]dos[*]tres[/list]',
    })
    model.applyTextUpdate('[notice]uno![/notice]\n\n[list][*]dos[*]tres[/list]')

    const html = new HTMLRenderer().render(model.redRoot!)
    const el = document.createElement('div')
    el.innerHTML = html

    const withIds = Array.from(el.querySelectorAll('[data-node-id]'))
    expect(withIds.length).toBeGreaterThan(0)
    for (const node of withIds) {
      const id = node.getAttribute('data-node-id')!
      expect(model.findNode(id as never)).toBeTruthy()
    }
  })
})
