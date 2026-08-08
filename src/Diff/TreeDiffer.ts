/**
 * DocumentEngine — TreeDiffer
 *
 * Computes structural differences between two Red Trees.
 * Produces a list of DiffOperations that can be used for:
 * - Updating the UI with minimal DOM changes
 * - Syncing with collaboration servers
 * - Animation interpolation
 * - Undo/redo granularity
 *
 * Inspired by React's reconciliation and ProseMirror's diff.
 */

import { RedNode } from '../Syntax/RedNode'

// ─── Diff Kinds ────────────────────────────────────────────────

export type DiffKind =
  | 'insert'
  | 'delete'
  | 'update'
  | 'move'
  | 'preserve'

export interface DiffOperation {
  kind: DiffKind
  node: RedNode
  oldNode?: RedNode
  /** Index in parent */
  oldIndex?: number
  newIndex?: number
  /** Parent node ID */
  parentId?: string
}

export interface DiffResult {
  operations: DiffOperation[]
  /** Count by kind */
  stats: {
    inserts: number
    deletes: number
    updates: number
    moves: number
    preserves: number
  }
  /** Time taken in ms */
  duration: number
}

// ─── TreeDiffer ────────────────────────────────────────────────

export class TreeDiffer {
  /**
   * Compute the diff between two Red Trees.
   */
  diff(oldRoot: RedNode, newRoot: RedNode): DiffResult {
    const startTime = performance.now()
    const operations: DiffOperation[] = []
    const stats = { inserts: 0, deletes: 0, updates: 0, moves: 0, preserves: 0 }

    this.diffChildren(
      oldRoot.children,
      newRoot.children,
      oldRoot,
      operations,
      stats,
    )

    return {
      operations,
      stats,
      duration: performance.now() - startTime,
    }
  }

  private diffChildren(
    oldChildren: RedNode[],
    newChildren: RedNode[],
    parent: RedNode,
    ops: DiffOperation[],
    stats: { inserts: number; deletes: number; updates: number; moves: number; preserves: number },
  ): void {
    // Build maps for quick lookup
    const oldMap = new Map<string, RedNode>()
    const oldIndexMap = new Map<string, number>()
    oldChildren.forEach((child, i) => {
      oldMap.set(child.id, child)
      oldIndexMap.set(child.id, i)
    })

    const newMap = new Map<string, RedNode>()
    newChildren.forEach((child, i) => {
      newMap.set(child.id, child)
    })

    // Find deleted nodes (in old but not in new)
    const deletedNodes = new Map<string, RedNode>()
    for (const [id, node] of oldMap) {
      if (!newMap.has(id)) {
        deletedNodes.set(id, node)
      }
    }

    const unmatchedNewNodes: { newChild: RedNode, newIdx: number }[] = []

    // Process nodes that kept their ID
    newChildren.forEach((newChild, newIdx) => {
      const oldChild = oldMap.get(newChild.id)

      if (!oldChild) {
        unmatchedNewNodes.push({ newChild, newIdx })
      } else {
        const oldIdx = oldIndexMap.get(newChild.id)!

        if (oldIdx !== newIdx) {
          // Node moved
          // Check content for update
          const contentChanged = this.nodeContentChanged(oldChild, newChild)
          if (contentChanged) {
            ops.push({
              kind: 'update',
              node: newChild,
              oldNode: oldChild,
              oldIndex: oldIdx,
              newIndex: newIdx,
              parentId: parent.id,
            })
            stats.updates++
          } else {
            ops.push({
              kind: 'move',
              node: newChild,
              oldNode: oldChild,
              oldIndex: oldIdx,
              newIndex: newIdx,
              parentId: parent.id,
            })
            stats.moves++
          }
        } else {
          // Same position, check content
          const contentChanged = this.nodeContentChanged(oldChild, newChild)
          if (contentChanged) {
            ops.push({
              kind: 'update',
              node: newChild,
              oldNode: oldChild,
              oldIndex: oldIdx,
              newIndex: newIdx,
              parentId: parent.id,
            })
            stats.updates++
          } else {
            ops.push({
              kind: 'preserve',
              node: newChild,
              oldNode: oldChild,
              oldIndex: oldIdx,
              newIndex: newIdx,
              parentId: parent.id,
            })
            stats.preserves++
          }

          // Recurse into children
          if (oldChild.children.length > 0 || newChild.children.length > 0) {
            this.diffChildren(oldChild.children, newChild.children, newChild, ops, stats)
          }
        }
      }
    })

    // Attempt to pair unmatched inserts and deletes based on content
    const finalDeletes = new Set<string>(deletedNodes.keys())
    
    for (const { newChild, newIdx } of unmatchedNewNodes) {
      let matchedOldNode: RedNode | null = null
      let matchedOldId: string | null = null
      
      for (const [deletedId, deletedNode] of deletedNodes.entries()) {
        if (finalDeletes.has(deletedId) && this.nodesAreEquivalent(deletedNode, newChild)) {
          matchedOldNode = deletedNode
          matchedOldId = deletedId
          break
        }
      }
      
      if (matchedOldNode && matchedOldId) {
        finalDeletes.delete(matchedOldId)
        const oldIdx = oldIndexMap.get(matchedOldId)!
        if (oldIdx !== newIdx) {
          ops.push({
            kind: 'move',
            node: newChild,
            oldNode: matchedOldNode,
            oldIndex: oldIdx,
            newIndex: newIdx,
            parentId: parent.id,
          })
          stats.moves++
        } else {
          ops.push({
            kind: 'update', // Treat as update since ID changed
            node: newChild,
            oldNode: matchedOldNode,
            oldIndex: oldIdx,
            newIndex: newIdx,
            parentId: parent.id,
          })
          stats.updates++
        }
        
        // Recurse into children (though they are equivalent, we might need to emit preserves)
        if (matchedOldNode.children.length > 0 || newChild.children.length > 0) {
          this.diffChildren(matchedOldNode.children, newChild.children, newChild, ops, stats)
        }
      } else {
        ops.push({
          kind: 'insert',
          node: newChild,
          newIndex: newIdx,
          parentId: parent.id,
        })
        stats.inserts++
      }
    }

    // Unmatched deletes remain deletes
    for (const deletedId of finalDeletes) {
      ops.push({
        kind: 'delete',
        node: deletedNodes.get(deletedId)!,
        oldIndex: oldIndexMap.get(deletedId),
        parentId: parent.id,
      })
      stats.deletes++
    }
  }

  /**
   * Check if a node's content has changed.
   */
  private nodeContentChanged(oldNode: RedNode, newNode: RedNode): boolean {
    if (oldNode.kind !== newNode.kind) return true
    if (oldNode.text !== newNode.text) return true
    if (oldNode.children.length !== newNode.children.length) return true
    return false
  }

  /**
   * Deep equality check for content equivalence when pairing unmatched nodes.
   */
  private nodesAreEquivalent(oldNode: RedNode, newNode: RedNode): boolean {
    if (oldNode.kind !== newNode.kind) return false
    if (oldNode.text !== newNode.text) return false
    if (oldNode.children.length !== newNode.children.length) return false
    for (let i = 0; i < oldNode.children.length; i++) {
      if (!this.nodesAreEquivalent(oldNode.children[i], newNode.children[i])) {
        return false
      }
    }
    return true
  }
}
