/**
 * DocumentEngine — Transaction
 *
 * Groups operations into an atomic, undoable unit.
 * Every modification to the document MUST go through a Transaction.
 *
 * Inspired by ProseMirror's Transaction system.
 */

import { RedNode } from '../Syntax/RedNode'
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
   * The operation kinds `apply` carries out on a red tree. The others
   * (`set_text`, `update_attributes`, the text-span kinds, `split_node`,
   * `merge_nodes`) have no tree-side implementation, and a transaction that
   * holds one is refused whole: it used to skip them and report success.
   */
  static readonly APPLICABLE: ReadonlySet<Operation['kind']> = new Set<Operation['kind']>([
    'insert_node', 'delete_node', 'replace_node', 'move_node',
  ])

  /** Whether every operation is of a kind `apply` carries out. */
  canApply(): boolean {
    return this.operations.every(op => Transaction.APPLICABLE.has(op.kind))
  }

  /**
   * Apply the transaction to a RedNode tree.
   * Returns the updated tree, or null if application failed: an operation
   * of a kind `apply` does not carry out (nothing is touched then), or one
   * whose target is missing (the tree may then be partly changed — rebuild
   * it from its source, as `DocumentModel.transact` does).
   */
  apply(root: RedNode): RedNode | null {
    if (this._applied) return null
    if (!this.canApply()) {
      console.warn('[Transaction] Refused: it holds operations apply does not carry out')
      return null
    }
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
      default:
        throw new Error(`[Transaction] ${operation.kind} is not applied to a tree`)
    }
  }

  private applyInsert(root: RedNode, op: Operation & { kind: 'insert_node' }): void {
    const parent = root.findById(op.parentId)
    if (!parent) throw new Error(`[Transaction] insert_node: no parent ${op.parentId}`)
    // A copy of the whole subtree, metadata included: the node may belong to
    // another tree, and inserting a bare `new GreenNode(kind, text)` used to
    // drop its children — `[b]bold[/b]` went in as an empty `[b]`.
    parent.insertChildAt(Math.min(op.index, parent.children.length), copySubtree(op.node))
  }

  private applyDelete(root: RedNode, op: Operation & { kind: 'delete_node' }): void {
    const parent = root.findById(op.parentId)
    if (!parent) throw new Error(`[Transaction] delete_node: no parent ${op.parentId}`)
    if (!parent.removeChild(op.nodeId)) throw new Error(`[Transaction] delete_node: no child ${op.nodeId}`)
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
    if (!parent) throw new Error(`[Transaction] replace_node: no node ${op.nodeId}`)
    
    parent.replaceChild(op.nodeId, newNode)
  }

  private applyMove(root: RedNode, op: Operation & { kind: 'move_node' }): void {
    const fromParent = root.findById(op.fromParentId)
    const toParent = root.findById(op.toParentId)
    if (!fromParent || !toParent) throw new Error('[Transaction] move_node: missing parent')

    const node = fromParent.removeChild(op.nodeId)
    if (!node) throw new Error(`[Transaction] move_node: no child ${op.nodeId}`)
    toParent.insertChildAt(Math.min(op.toIndex, toParent.children.length), node)
  }
}

/** A detached copy of `node` and everything under it, with fresh ids. */
function copySubtree(node: RedNode): RedNode {
  const copy = new RedNode(node.green, { kind: node.kind, metadata: node.metadata })
  if (node.children.length > 0) {
    copy.initChildren(node.children.map(copySubtree))
  }
  return copy
}
