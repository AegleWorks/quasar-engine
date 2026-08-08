/**
 * DocumentEngine — Operation & Transaction Types
 *
 * Operations are the atomic units of change in the document.
 * Every modification goes through operations, never direct mutation.
 *
 * Inspired by ProseMirror and Roslyn.
 */

import type { NodeId, NodeKind, NodeAttributes } from './core'
import type { Range } from './tokens'
import type { RedNode } from '../Syntax/RedNode'

// ─── Operation ─────────────────────────────────────────────────

export type OperationKind =
  | 'insert_node'
  | 'delete_node'
  | 'replace_node'
  | 'move_node'
  | 'update_attributes'
  | 'set_text'
  | 'insert_text'
  | 'delete_text'
  | 'replace_text'
  | 'wrap_in_tag'
  | 'unwrap_node'
  | 'split_node'
  | 'merge_nodes'

export interface BaseOperation {
  kind: OperationKind
  /** Stable ID for the operation (for undo/redo pairing) */
  id: string
  /** Whether this operation can be undone */
  undoable: boolean
  /** Timestamp */
  timestamp: number
}

export interface InsertNodeOperation extends BaseOperation {
  kind: 'insert_node'
  parentId: NodeId
  index: number
  node: RedNode
}

export interface DeleteNodeOperation extends BaseOperation {
  kind: 'delete_node'
  nodeId: NodeId
  /** The deleted node (stored for undo) */
  node: RedNode
  parentId: NodeId
  index: number
}

export interface ReplaceNodeOperation extends BaseOperation {
  kind: 'replace_node'
  nodeId: NodeId
  newNode: RedNode
  oldNode: RedNode
}

export interface MoveNodeOperation extends BaseOperation {
  kind: 'move_node'
  nodeId: NodeId
  fromParentId: NodeId
  fromIndex: number
  toParentId: NodeId
  toIndex: number
}

export interface UpdateAttributesOperation extends BaseOperation {
  kind: 'update_attributes'
  nodeId: NodeId
  newAttributes: NodeAttributes
  oldAttributes: NodeAttributes
}

export interface SetTextOperation extends BaseOperation {
  kind: 'set_text'
  nodeId: NodeId
  newText: string
  oldText: string
}

export interface InsertTextOperation extends BaseOperation {
  kind: 'insert_text'
  nodeId: NodeId
  position: number
  text: string
}

export interface DeleteTextOperation extends BaseOperation {
  kind: 'delete_text'
  nodeId: NodeId
  position: number
  length: number
  text: string
}

export interface ReplaceTextOperation extends BaseOperation {
  kind: 'replace_text'
  nodeId: NodeId
  position: number
  length: number
  newText: string
  oldText: string
}

export interface WrapInTagOperation extends BaseOperation {
  kind: 'wrap_in_tag'
  nodeId: NodeId
  tagName: string
  attributes: NodeAttributes
}

export interface UnwrapNodeOperation extends BaseOperation {
  kind: 'unwrap_node'
  nodeId: NodeId
  parentId: NodeId
  children: RedNode[]
}

export interface SplitNodeOperation extends BaseOperation {
  kind: 'split_node'
  nodeId: NodeId
  position: number
  leftNode: RedNode
  rightNode: RedNode
}

export interface MergeNodesOperation extends BaseOperation {
  kind: 'merge_nodes'
  leftNodeId: NodeId
  rightNodeId: NodeId
  mergedNode: RedNode
}

export type Operation =
  | InsertNodeOperation
  | DeleteNodeOperation
  | ReplaceNodeOperation
  | MoveNodeOperation
  | UpdateAttributesOperation
  | SetTextOperation
  | InsertTextOperation
  | DeleteTextOperation
  | ReplaceTextOperation
  | WrapInTagOperation
  | UnwrapNodeOperation
  | SplitNodeOperation
  | MergeNodesOperation

// ─── Operation Helpers ─────────────────────────────────────────

let opCounter = 0

export function createOperationId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

export function operationLabel(op: Operation): string {
  const labels: Record<OperationKind, string> = {
    insert_node: 'Insert Node',
    delete_node: 'Delete Node',
    replace_node: 'Replace Node',
    move_node: 'Move Node',
    update_attributes: 'Update Attributes',
    set_text: 'Set Text',
    insert_text: 'Insert Text',
    delete_text: 'Delete Text',
    replace_text: 'Replace Text',
    wrap_in_tag: 'Wrap in Tag',
    unwrap_node: 'Unwrap Node',
    split_node: 'Split Node',
    merge_nodes: 'Merge Nodes',
  }
  return labels[op.kind]
}
