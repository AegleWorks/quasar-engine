import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { DocumentEvent } from '../Events/EventBus'

/**
 * Every edit announces its `origin` and `change`, whichever path it took, and
 * every analysis the model runs on its own announces `diagnostics_updated`.
 * A model under `pairing: 'osu'`, without incremental parsing, or seeded from
 * empty (the collaboration join) used to lose the origin, and a rebuild never
 * announced its diagnostics.
 */

function record(model: BBCodeDocumentModel): DocumentEvent[] {
  const seen: DocumentEvent[] = []
  model.events.onAny(e => seen.push(e))
  return seen
}

describe('document events', () => {
  for (const [name, options] of [
    ['osu pairing', { pairing: 'osu' as const, dialect: 'osu' as const }],
    ['no incremental parsing', { incremental: false }],
  ] as const) {
    it(`${name}: a remote edit says it is remote`, () => {
      const model = new BBCodeDocumentModel({ source: '[b]x', ...options })
      const seen = record(model)
      model.applyTextUpdate('[b]xy', 'remote')
      const changed = seen.find(e => e.type === 'document_changed')!
      expect(changed.origin).toBe('remote')
      expect(changed.change).toEqual({ start: 4, end: 4, text: 'y' })
      expect(changed.kind).toBe('full_rebuild')
    })
  }

  it('the first edit into an empty model keeps its origin', () => {
    const model = new BBCodeDocumentModel({ source: '' })
    const seen = record(model)
    model.applyTextUpdate('[b]shared[/b]', 'remote')
    expect(seen.find(e => e.type === 'document_changed')!.origin).toBe('remote')
  })

  it('a rebuild announces its diagnostics after the change, once', () => {
    const model = new BBCodeDocumentModel({ source: 'a' })
    const seen = record(model)
    model.rebuild('[b]x')
    expect(seen.map(e => e.type)).toEqual(['document_changed', 'diagnostics_updated'])
  })

  it('undo, redo and transactions announce themselves', () => {
    const model = new BBCodeDocumentModel({ source: 'one [b]two[/b]' })
    const seen = record(model)
    const bold = model.redRoot!.findNodeAtOffset(8)!.parent!
    model.transact([{ kind: 'delete_node', nodeId: bold.id, node: bold, parentId: bold.parent!.id, index: bold.index, id: 'd', undoable: true, timestamp: 0 }])
    model.undo()
    model.redo()
    const types = seen.map(e => e.type).filter(t => t !== 'document_changed' && t !== 'diagnostics_updated')
    expect(types).toEqual(['transaction_applied', 'undo_performed', 'redo_performed'])
  })
})
