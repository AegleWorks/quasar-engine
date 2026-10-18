import { describe, it, expect, vi } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Operation } from '../Types/operations'

/**
 * `transact` is all or nothing: an operation kind the tree side does not
 * carry out is refused before anything is touched, and one that fails
 * part-way leaves the document as it was. It used to drop such operations,
 * normalise the whole document and report success.
 */
describe('DocumentModel.transact', () => {
  it('refuses set_text instead of reporting a rewrite that never happened', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = '[B]Hola[/B]\r\nmundo'
    const model = new BBCodeDocumentModel({ source })
    const leaf = model.redRoot!.findNodeAtOffset(4)!
    const op = { kind: 'set_text', nodeId: leaf.id, oldText: 'Hola', newText: 'Adiós', id: 'op', undoable: true, timestamp: 0 } as Operation
    expect(model.transact([op])).toBe(false)
    expect(model.source).toBe(source)
    expect(model.undoManager.undoCount).toBe(0)
    warn.mockRestore()
  })

  it('a failure part-way leaves the document and its tree as they were', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = 'one [b]two[/b] three [i]four[/i]'
    const model = new BBCodeDocumentModel({ source })
    const bold = model.redRoot!.findNodeAtOffset(5)!.parent!
    const ops = [
      { kind: 'delete_node', nodeId: bold.id, node: bold, parentId: bold.parent!.id, index: bold.index, id: 'a', undoable: true, timestamp: 0 },
      { kind: 'delete_node', nodeId: 'n-missing', node: bold, parentId: 'n-missing-parent', index: 0, id: 'b', undoable: true, timestamp: 0 },
    ] as Operation[]
    expect(model.transact(ops)).toBe(false)
    expect(model.source).toBe(source)
    expect(model.redRoot!.children.length).toBe(new BBCodeDocumentModel({ source }).redRoot!.children.length)
    warn.mockRestore()
  })

  it('an inserted node keeps its children', () => {
    const model = new BBCodeDocumentModel({ source: 'a' })
    const donor = new BBCodeDocumentModel({ source: '[b]bold[/b]' })
    const bold = donor.redRoot!.children[0].children[0]
    const paragraph = model.redRoot!.children[0]
    const op = { kind: 'insert_node', parentId: paragraph.id, index: 1, node: bold, id: 'i', undoable: true, timestamp: 0 } as Operation
    expect(model.transact([op])).toBe(true)
    expect(model.source).toBe('a[b]bold[/b]')
    // The donor tree is not robbed.
    expect(donor.redRoot!.children[0].children[0]).toBe(bold)
  })
})
