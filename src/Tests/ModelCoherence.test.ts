import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { RedNode } from '../Syntax/RedNode'
import type { Operation } from '../Types/operations'
import type { NodeId } from '../Types/core'

/**
 * Three properties this file pins down:
 *
 * 1. `ensureAnalyzed` — diagnostics must describe the CURRENT text. The
 *    incremental edit path defers `analyze()` behind a debounce, so a caller
 *    reading `diagnostics` right after `applyTextUpdate` used to see the
 *    previous document's errors (the error panel ran one keystroke behind).
 *
 * 2. EventBus laziness — with no subscribers, an edit must not retain event
 *    history (each retained event pinned the source string and, via the lazy
 *    `nodeMatch` closure, the whole previous red/green tree). The capability
 *    stays: subscribers get events, `recordHistory` opts back in.
 *
 * 3. transact/undo/redo coherence — after any of them, `source`, `greenRoot`
 *    and `redRoot` describe the same document. The old implementation swapped
 *    the red root and left source/green stale, and its undo re-applied
 *    non-inverted operations.
 */

function findKind(root: RedNode, kind: string): RedNode | null {
  let found: RedNode | null = null
  root.walk(n => {
    if (!found && n.kind === kind) found = n
  })
  return found
}

function deleteOp(node: RedNode): Operation {
  return {
    kind: 'delete_node',
    nodeId: node.id,
    node,
    parentId: node.parent!.id,
    index: node.index,
    id: '',
    undoable: true,
    timestamp: 0,
  }
}

describe('ensureAnalyzed — diagnostics freshness', () => {
  it('diagnostics describe the current text right after an incremental edit', () => {
    const model = new BBCodeDocumentModel({ source: 'hola mundo' })
    expect(model.diagnostics?.items ?? []).toHaveLength(0)

    model.applyTextUpdate('hola [b]mundo')
    model.ensureAnalyzed()

    expect(model.diagnostics!.items.map(d => d.code)).toContain('unclosed-tag')
  })

  it('clears again when the error is fixed', () => {
    const model = new BBCodeDocumentModel({ source: 'hola [b]mundo' })
    model.applyTextUpdate('hola [b]mundo[/b]')
    model.ensureAnalyzed()

    expect(model.diagnostics!.items).toHaveLength(0)
  })

  it('flushes the pending work exactly once', async () => {
    const model = new BBCodeDocumentModel({ source: 'hola mundo' })
    let emitted = 0
    model.events.on('diagnostics_updated', () => { emitted++ })

    model.applyTextUpdate('hola mundo!')
    model.ensureAnalyzed()
    expect(emitted).toBe(1)

    // The debounce timer must not fire a second run afterwards.
    await new Promise(r => setTimeout(r, 30))
    expect(emitted).toBe(1)
  })
})

describe('EventBus — no cost without subscribers', () => {
  it('keeps no event history by default', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    model.applyTextUpdate('hola mundo')
    model.ensureAnalyzed()
    model.rebuild('adios')

    expect(model.events.getHistory()).toHaveLength(0)
  })

  it('records history when opted in', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    model.events.recordHistory = true
    model.rebuild('adios')

    expect(model.events.getHistory().length).toBeGreaterThan(0)
  })

  it('subscribers still receive events, with a working lazy nodeMatch', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    const seen: Array<Record<string, unknown>> = []
    model.events.on('document_changed', e => seen.push(e))

    model.rebuild('adios')

    expect(seen).toHaveLength(1)
    // Reading the accessor computes the match on demand.
    expect(seen[0].nodeMatch).toBeTruthy()
  })
})

describe('transact / undo / redo — model coherence', () => {
  it('transact updates source, green and red together', () => {
    const model = new BBCodeDocumentModel({ source: '[b]hola[/b] mundo' })
    const before = model.source
    const bold = findKind(model.redRoot!, 'bold')!

    const changed = model.transact([deleteOp(bold)], 'delete bold')

    expect(changed).toBe(true)
    expect(model.source).not.toContain('[b]')
    expect(model.source).toContain('mundo')
    // The red tree is a view over the green tree the model holds — not a
    // mutated orphan, which is what the old implementation left behind.
    expect(model.redRoot!.green).toBe(model.greenRoot)
    expect(model.source).not.toBe(before)
  })

  it('undo and redo replay snapshots and stay coherent', () => {
    const model = new BBCodeDocumentModel({ source: '[b]hola[/b] mundo' })
    const before = model.source
    const bold = findKind(model.redRoot!, 'bold')!
    model.transact([deleteOp(bold)], 'delete bold')
    const after = model.source

    expect(model.undo()).toBe(true)
    expect(model.source).toBe(before)
    expect(model.redRoot!.green).toBe(model.greenRoot)
    expect(findKind(model.redRoot!, 'bold')).toBeTruthy()

    expect(model.redo()).toBe(true)
    expect(model.source).toBe(after)
    expect(findKind(model.redRoot!, 'bold')).toBeNull()

    expect(model.undo()).toBe(true)
    expect(model.source).toBe(before)
  })

  it('text editing keeps working after a transact', () => {
    const model = new BBCodeDocumentModel({ source: '[b]hola[/b] mundo' })
    const bold = findKind(model.redRoot!, 'bold')!
    model.transact([deleteOp(bold)])

    // This used to diff against a stale `_source` and splice a stale green
    // tree; with the coherence contract it is just another edit.
    const edited = model.source + '!'
    model.applyTextUpdate(edited)
    expect(model.source).toBe(edited)
    expect(model.redRoot!.green).toBe(model.greenRoot)
  })

  it('a no-op transaction changes nothing and is not undoable', () => {
    const model = new BBCodeDocumentModel({ source: 'hola mundo' })
    const missing: Operation = {
      kind: 'delete_node',
      nodeId: 'no-such-node' as unknown as NodeId,
      node: model.redRoot!,
      parentId: 'no-such-parent' as unknown as NodeId,
      index: 0,
      id: '',
      undoable: true,
      timestamp: 0,
    }

    expect(model.transact([missing])).toBe(false)
    expect(model.source).toBe('hola mundo')
    expect(model.undoManager.undoCount).toBe(0)
    expect(model.undo()).toBe(false)
  })
})
