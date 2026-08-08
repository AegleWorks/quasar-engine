/**
 * DocumentEngine — Transaction
 *
 * Groups operations into an atomic, undoable unit.
 * Every modification to the document MUST go through a Transaction.
 *
 * Inspired by ProseMirror's Transaction system.
 */

import { RedNode } from '../Syntax/RedNode'
import { GreenNode } from '../Syntax/GreenNode'
import type { Operation } from '../Types/operations'
import { createOperationId } from '../Types/operations'

export class Transaction {
  readonly operations: Operation[]
  readonly id: string
  readonly timestamp: number
  private _applied: boolean = false

  constructor(operations: Operation[]) {
    this.operations = operations.map(op => ({
      ...op,
      id: op.id || createOperationId(),
      timestamp: Date.now(),
    }))
    this.id = createOperationId()
    this.timestamp = Date.now()
  }

  /**
   * Apply the transaction to a RedNode tree.
   * Returns the updated tree or null if application failed.
   */
  apply(root: RedNode): RedNode | null {
    if (this._applied) return null
    this._applied = true

    try {
      RedNode.allowMutation(() => {
        for (const op of this.operations) {
          this.applyOperation(root, op)
        }
      })
      return root
    } catch (error) {
      console.warn('[Transaction] Apply failed:', error)
      return null
    }
  }

  /**
   * Create the inverse transaction (for undo).
   */
  invert(root: RedNode): Transaction {
    const invertedOps: Operation[] = [...this.operations].reverse().map(op => {
      if (op.kind === 'replace_node') {
        return {
          ...op,
          newNode: op.oldNode,
          oldNode: op.newNode
        } as Operation
      }
      return op
    })
    return new Transaction(invertedOps)
  }

  /**
   * Get a human-readable label for this transaction.
   */
  getLabel(): string {
    if (this.operations.length === 0) return 'Empty transaction'
    if (this.operations.length === 1) {
      const op = this.operations[0]
      const labels: Record<string, string> = {
        insert_node: 'Insert',
        delete_node: 'Delete',
        replace_node: 'Replace',
        move_node: 'Move',
        update_attributes: 'Update attributes',
        set_text: 'Edit text',
        insert_text: 'Type',
        delete_text: 'Delete',
        replace_text: 'Replace text',
        wrap_in_tag: 'Wrap in tag',
        unwrap_node: 'Unwrap',
        split_node: 'Split',
        merge_nodes: 'Merge',
      }
      return labels[op.kind] || 'Edit'
    }
    return `${this.operations.length} operations`
  }

  private applyOperation(root: RedNode, operation: Operation): void {
    switch (operation.kind) {
      case 'insert_node':
        this.applyInsert(root, operation)
        break
      case 'delete_node':
        this.applyDelete(root, operation)
        break
      case 'replace_node':
        this.applyReplace(root, operation)
        break
      case 'move_node':
        this.applyMove(root, operation)
        break
      case 'update_attributes':
        // Attributes are stored in metadata; update in place
        break
      case 'set_text':
        this.applySetText(root, operation)
        break
      default:
        break
    }
  }

  private applyInsert(root: RedNode, op: Operation & { kind: 'insert_node' }): void {
    const parent = root.findById(op.parentId)
    if (!parent) return
    const childNode = new RedNode(
      new GreenNode(op.node.kind, op.node.text),
      { kind: op.node.kind },
    )
    parent.insertChildAt(Math.min(op.index, parent.children.length), childNode)
  }

  private applyDelete(root: RedNode, op: Operation & { kind: 'delete_node' }): void {
    const parent = root.findById(op.parentId)
    if (!parent) return
    parent.removeChild(op.nodeId)
  }

  private applyReplace(root: RedNode, op: Operation & { kind: 'replace_node' }): void {
    const newNode = op.newNode as RedNode
    
    if (op.nodeId === root.id) {
      // Cannot replace the root instance itself because the model holds a reference to it.
      // Instead, we clear its children and append the children of the replacement node.
      while (root.children.length > 0) {
        root.removeChild(root.children[0].id)
      }
      for (const child of newNode.children) {
        root.appendChild(child)
      }
      return
    }

    const parent = root.findById(op.nodeId)?.parent
    if (!parent) return
    
    parent.replaceChild(op.nodeId, newNode)
  }

  private applyMove(root: RedNode, op: Operation & { kind: 'move_node' }): void {
    const fromParent = root.findById(op.fromParentId)
    const toParent = root.findById(op.toParentId)
    if (!fromParent || !toParent) return

    const node = fromParent.removeChild(op.nodeId)
    if (node) {
      toParent.insertChildAt(Math.min(op.toIndex, toParent.children.length), node)
    }
  }

  private applySetText(root: RedNode, op: Operation & { kind: 'set_text' }): void {
    const node = root.findById(op.nodeId)
    if (!node) return
    // Text is stored in GreenNode which is immutable.
    // For mutable text, we should use the RedNode's text or metadata.
    node.bumpVersion()
  }
}
