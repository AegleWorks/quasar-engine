import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { RedNode } from '../Syntax/RedNode'

/**
 * Red-subtree reuse: on the incremental path, subtrees whose green is shared
 * by reference must be ADOPTED (same RedNode objects) instead of rebuilt —
 * building red was the largest phase of a keystroke.
 *
 * The property demanded is the engine's usual one: the resulting tree must be
 * IDENTICAL — kind, text, range, structure, metadata — to what a full rebuild
 * of the same final text produces. Ids are exempt (reuse is what makes them
 * stable; a fresh rebuild has no history), and object identity is the point.
 */

function bigDoc(): string {
  // Comfortably above MIN_SOURCE_LENGTH (2500) so the incremental path engages.
  let src = ''
  for (let i = 0; i < 40; i++) {
    src += `parrafo numero ${i} con [b]negrita[/b] y [color=#ff66ab]color[/color]\n\n`
  }
  src += '[notice]interior del notice con [i]cursiva[/i] y texto largo para editar[/notice]\n\n'
  for (let i = 0; i < 20; i++) {
    src += `cola numero ${i} despues del notice\n\n`
  }
  return src
}

/** Walk both trees asserting deep equality of everything but ids. */
function expectSameTree(a: RedNode, b: RedNode, path = 'root'): void {
  expect(a.kind, `${path}: kind`).toBe(b.kind)
  expect(a.text, `${path}: text`).toBe(b.text)
  expect(a.range.start, `${path}: range.start`).toBe(b.range.start)
  expect(a.range.end, `${path}: range.end`).toBe(b.range.end)
  expect(JSON.stringify(a.metadata), `${path}: metadata`).toBe(JSON.stringify(b.metadata))
  expect(a.children.length, `${path}: childCount`).toBe(b.children.length)
  for (let i = 0; i < a.children.length; i++) {
    expectSameTree(a.children[i], b.children[i], `${path}.${a.children[i].kind}[${i}]`)
  }
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

describe('red-subtree reuse', () => {
  it('adopts untouched subtrees as the same objects, with correct shifted ranges', () => {
    const model = new BBCodeDocumentModel({ source: bigDoc() })
    const root = model.redRoot!
    const noticeIdx = root.children.findIndex(c => c.kind === 'notice')
    expect(noticeIdx).toBeGreaterThan(0)

    const beforeBlock = root.children[noticeIdx - 2] // a paragraph before the notice
    const afterBlock = root.children[root.children.length - 2]
    const afterStart = afterBlock.range.start

    // Type one char inside the notice.
    const src = model.source
    const at = src.indexOf('texto largo') + 5
    model.applyTextUpdate(src.slice(0, at) + 'X' + src.slice(at))

    const newRoot = model.redRoot!
    expect(newRoot).not.toBe(root)

    // Prefix subtree: same object, same position.
    expect(newRoot.children[noticeIdx - 2]).toBe(beforeBlock)
    // Suffix subtree: same object, range shifted by the inserted char.
    const afterNow = newRoot.children[newRoot.children.length - 2]
    expect(afterNow).toBe(afterBlock)
    expect(afterNow.range.start).toBe(afterStart + 1)
    // Adopted nodes are correctly parented into the new tree.
    expect(afterNow.parent).toBe(newRoot)
    expect(afterNow.index).toBe(newRoot.children.length - 2)
  })

  it('reuseRed: false keeps the old behavior (no shared objects)', () => {
    const model = new BBCodeDocumentModel({ source: bigDoc(), reuseRed: false })
    const root = model.redRoot!
    const firstBlock = root.children[0]

    const src = model.source
    const at = src.indexOf('texto largo') + 5
    model.applyTextUpdate(src.slice(0, at) + 'X' + src.slice(at))

    expect(model.redRoot!.children[0]).not.toBe(firstBlock)
  })

  it('differential: reuse tree is identical to a full rebuild, over seeded edits', () => {
    const renderer = new HTMLRenderer()
    const rand = mulberry32(777)
    const insertables = ['a', 'X', ' ', '\n', '[', ']', '[b]', '[/b]', '[i]', '[*]', '[notice]', '[/notice]']

    const reuse = new BBCodeDocumentModel({ source: bigDoc() })
    const control = new BBCodeDocumentModel({ source: bigDoc(), incremental: false })

    for (let edit = 0; edit < 120; edit++) {
      const src = reuse.source
      const pos = Math.floor(rand() * (src.length + 1))
      const next = rand() < 0.7
        ? src.slice(0, pos) + insertables[Math.floor(rand() * insertables.length)] + src.slice(pos)
        : src.slice(0, pos) + src.slice(Math.min(pos + 1 + Math.floor(rand() * 3), src.length))

      reuse.applyTextUpdate(next)
      control.applyTextUpdate(next)

      expectSameTree(reuse.redRoot!, control.redRoot!)
      expect(renderer.render(reuse.redRoot!).replace(/ data-node-id="[^"]*"/g, ''))
        .toBe(renderer.render(control.redRoot!).replace(/ data-node-id="[^"]*"/g, ''))
      expect(reuse.redRoot!.green).toBe(reuse.greenRoot)
    }
  })

  it('ids stay unique after adoption plus fresh nodes', () => {
    const model = new BBCodeDocumentModel({ source: bigDoc() })
    const rand = mulberry32(4242)

    for (let edit = 0; edit < 40; edit++) {
      const src = model.source
      const pos = Math.floor(rand() * (src.length + 1))
      model.applyTextUpdate(src.slice(0, pos) + 'y' + src.slice(pos))

      const ids: string[] = []
      model.redRoot!.walk(n => { ids.push(String(n.id)) })
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
