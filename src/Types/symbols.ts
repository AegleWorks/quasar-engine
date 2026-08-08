/**
 * DocumentEngine — Symbol Types
 *
 * Symbol system for definitions and references in BBCode documents.
 * Enables: go-to-definition, find-all-references, rename, etc.
 *
 * Inspired by Language Server Protocol (LSP).
 */

import type { NodeId, NodeKind, SourceRange } from './core'

// ─── Symbol Kind ───────────────────────────────────────────────

export type SymbolKind =
  | 'tag'
  | 'id_definition'
  | 'id_reference'
  | 'class'
  | 'property'
  | 'variable'
  | 'function'
  | 'module'
  | 'snippet'
  | 'template'
  | 'other'

// ─── Symbol Info ───────────────────────────────────────────────

export interface SymbolInfo {
  /** Unique ID for this symbol */
  id: string
  /** Symbol name (e.g. 'hero', 'my-block') */
  name: string
  /** Symbol kind */
  kind: SymbolKind
  /** The node that defines this symbol */
  definitionNodeId: NodeId
  /** Source range of the definition */
  definitionRange: SourceRange
  /** Container node (e.g. the document) */
  containerNodeId: NodeId
  /** All references to this symbol */
  references: Reference[]
  /** Additional data */
  data?: Record<string, unknown>
}

// ─── Reference ─────────────────────────────────────────────────

export interface Reference {
  nodeId: NodeId
  range: SourceRange
  kind: 'definition' | 'reference' | 'implementation'
}

// ─── Symbol Table ──────────────────────────────────────────────

export interface SymbolTableData {
  symbols: Map<string, SymbolInfo>
  /** Quick lookup: node ID → symbol */
  nodeToSymbol: Map<NodeId, string>
}

// ─── Symbol Search ─────────────────────────────────────────────

export interface SymbolSearchResult {
  symbol: SymbolInfo
  score: number
}
