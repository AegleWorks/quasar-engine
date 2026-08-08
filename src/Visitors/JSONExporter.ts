/**
 * DocumentEngine — JSONExporter
 *
 * Exports the Document Model to JSON.
 * Useful for:
 * - Saving/loading documents in a structured format
 * - Sending over the wire (collaboration)
 * - Debugging and inspecting the document tree
 * - Import/export between different tools
 */

import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'

export interface JSONDocument {
  version: number
  kind: string
  nodes: JSONNode[]
  metadata?: Record<string, unknown>
}

export interface JSONNode {
  id: string
  kind: string
  text: string
  version: number
  children: JSONNode[]
  attributes?: Record<string, unknown>
  metadata?: Record<string, unknown>
  range?: { start: number; end: number }
}

export class JSONExporter extends Visitor<string> {
  /**
   * Export a RedNode tree to a JSON string.
   */
  visit(node: RedNode): string {
    return JSON.stringify(this.toJSON(node), null, 2)
  }

  /**
   * Export to a JSON object.
   */
  toJSON(node: RedNode): JSONDocument {
    return {
      version: node.version,
      kind: node.kind,
      nodes: node.children.map(c => this.serializeNode(c)),
    }
  }

  private serializeNode(node: RedNode): JSONNode {
    return {
      id: node.id,
      kind: node.kind,
      text: node.text,
      version: node.version,
      children: node.children.map(c => this.serializeNode(c)),
      attributes: node.metadata?.tagName
        ? { tag: node.metadata.tagName as string }
        : undefined,
      metadata: Object.keys(node.metadata).length > 0 ? node.metadata : undefined,
      range: { start: node.range.start, end: node.range.end },
    }
  }
}
