import { describe, it, expect } from 'vitest'
import { TreeDiffer } from '../TreeDiffer'
import { RedNode } from '../../Syntax/RedNode'
import { GreenNode } from '../../Syntax/GreenNode'
import type { NodeId } from '../../Types/core'

/** Fixed, readable NodeIds. `NodeId` is branded, so literals need the cast. */
const nid = (s: string) => s as unknown as NodeId

describe('TreeDiffer', () => {
  it('should detect moves/updates by content when IDs differ', () => {
    // Create old tree
    const oldChild = new RedNode(new GreenNode('paragraph', 'hello', [], 0, 0, 5), { id: nid('old-id'), kind: 'paragraph' })
    const oldRoot = new RedNode(new GreenNode('document', '', [], 0, 0, 5), { id: nid('root'), kind: 'document' })
    oldRoot.children.push(oldChild)
    oldChild.parent = oldRoot

    // Create new tree with different ID but same content
    const newChild = new RedNode(new GreenNode('paragraph', 'hello', [], 0, 0, 5), { id: nid('new-id'), kind: 'paragraph' })
    const newRoot = new RedNode(new GreenNode('document', '', [], 0, 0, 5), { id: nid('root'), kind: 'document' })
    newRoot.children.push(newChild)
    newChild.parent = newRoot

    const differ = new TreeDiffer()
    const result = differ.diff(oldRoot, newRoot)

    // Should detect as 1 preserve/update since index is same, not a delete and insert
    // Because the position didn't change it's treated as update when IDs change but content is same.
    expect(result.stats.inserts).toBe(0)
    expect(result.stats.deletes).toBe(0)
    expect(result.stats.updates).toBe(1)
    
    expect(result.operations[0].kind).toBe('update')
    expect(result.operations[0].node.id).toBe(nid('new-id'))
    expect(result.operations[0].oldNode?.id).toBe(nid('old-id'))
  })

  it('should detect moves when content matches and index changes', () => {
    const oldChild1 = new RedNode(new GreenNode('paragraph', 'a', [], 0, 0, 1), { id: nid('id1'), kind: 'paragraph' })
    const oldChild2 = new RedNode(new GreenNode('paragraph', 'b', [], 0, 0, 1), { id: nid('id2'), kind: 'paragraph' })
    const oldRoot = new RedNode(new GreenNode('document', '', [], 0, 0, 2), { id: nid('root'), kind: 'document' })
    oldRoot.children.push(oldChild1, oldChild2)
    oldChild1.parent = oldRoot
    oldChild2.parent = oldRoot

    const newChild1 = new RedNode(new GreenNode('paragraph', 'a', [], 0, 0, 1), { id: nid('id1'), kind: 'paragraph' }) // same id
    const newChild2 = new RedNode(new GreenNode('paragraph', 'b', [], 0, 0, 1), { id: nid('id3'), kind: 'paragraph' }) // different id, same content
    const newRoot = new RedNode(new GreenNode('document', '', [], 0, 0, 2), { id: nid('root'), kind: 'document' })
    // Swap order to trigger move
    newRoot.children.push(newChild2, newChild1)
    newChild1.parent = newRoot
    newChild2.parent = newRoot

    const differ = new TreeDiffer()
    const result = differ.diff(oldRoot, newRoot)

    // id2 moved to index 0 (and changed id to id3), id1 moved to index 1
    expect(result.stats.inserts).toBe(0)
    expect(result.stats.deletes).toBe(0)
    
    // We should have ops for moves/updates
    const hasMoveOrUpdateId3 = result.operations.some(op => op.node.id === nid('id3') && (op.kind === 'move' || op.kind === 'update'))
    expect(hasMoveOrUpdateId3).toBe(true)
  })
})
