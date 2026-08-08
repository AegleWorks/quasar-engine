/**
 * DocumentEngine — SymbolTable
 *
 * Tracks symbols (definitions and references) in the document.
 * Enables IDE features like:
 * - Go to definition
 * - Find all references
 * - Rename symbol
 * - Document outline
 *
 * In BBCode, symbols include:
 * - [id=hero] → Definition
 * - [goto=hero] → Reference
 * - Named anchors and targets
 */

import { RedNode } from '../Syntax/RedNode'
import type { SymbolInfo, SymbolKind, Reference, SymbolSearchResult } from '../Types/symbols'

export class SymbolTable {
  private symbols: Map<string, SymbolInfo> = new Map()
  private nodeToSymbolId: Map<string, string> = new Map()

  /**
   * Build the symbol table from a RedNode tree.
   */
  build(root: RedNode): void {
    this.symbols.clear()
    this.nodeToSymbolId.clear()

    root.walk(node => {
      // Check for id attributes (definitions)
      const id = node.metadata?.id as string | undefined
      if (id) {
        this.addSymbol({
          id: this.createSymbolId(id),
          name: id,
          kind: 'id_definition',
          definitionNodeId: node.id,
          definitionRange: { start: node.range.start, end: node.range.end },
          containerNodeId: root.id,
          references: [],
        })
      }

      // Check for goto attributes (references)
      const goto = node.metadata?.goto as string | undefined
      if (goto && id !== goto) {
        const existing = this.symbols.get(goto)
        if (existing) {
          existing.references.push({
            nodeId: node.id,
            range: { start: node.range.start, end: node.range.end },
            kind: 'reference',
          })
        }
      }
    })
  }

  /**
   * Get a symbol by name.
   */
  get(name: string): SymbolInfo | undefined {
    return this.symbols.get(name)
  }

  /**
   * Get the symbol associated with a node.
   */
  getSymbolForNode(nodeId: string): SymbolInfo | undefined {
    const symbolId = this.nodeToSymbolId.get(nodeId)
    if (!symbolId) return undefined
    return this.symbols.get(symbolId)
  }

  /**
   * Search for symbols by name.
   */
  search(query: string, maxResults: number = 10): SymbolSearchResult[] {
    const lower = query.toLowerCase()
    const results: SymbolSearchResult[] = []

    for (const [, symbol] of this.symbols) {
      if (results.length >= maxResults) break
      const name = symbol.name.toLowerCase()
      let score = 0

      if (name === lower) score = 100
      else if (name.startsWith(lower)) score = 75
      else if (name.includes(lower)) score = 50

      if (score > 0) {
        results.push({ symbol, score })
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  /**
   * Get all symbols.
   */
  getAll(): SymbolInfo[] {
    return Array.from(this.symbols.values())
  }

  /**
   * Clear all symbols.
   */
  clear(): void {
    this.symbols.clear()
    this.nodeToSymbolId.clear()
  }

  private addSymbol(symbol: SymbolInfo): void {
    this.symbols.set(symbol.name, symbol)
    this.nodeToSymbolId.set(symbol.definitionNodeId, symbol.id)
  }

  private createSymbolId(name: string): string {
    return `sym-${name}-${Date.now()}`
  }
}
