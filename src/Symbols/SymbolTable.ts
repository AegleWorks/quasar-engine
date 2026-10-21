/**
 * DocumentEngine — SymbolTable
 *
 * Definitions and references in a document, for the IDE features that need
 * them: go-to-definition, find-all-references, rename, and the document
 * outline.
 *
 * BBCode has no declaration syntax of its own, so the engine records two
 * metadata keys when a tag or plugin provides them:
 *
 *   `id`    a definition, e.g. `[anchor=hero]`
 *   `goto`  a reference, e.g. `[goto=hero]`
 *
 * The built-in tag set does not currently produce either (an `[id=…]` tag
 * parses as literal text), but plugins can, and the type has always promised
 * the lookup. What it did not deliver:
 *
 *  - `getSymbolForNode` looked the symbol ID up in a map keyed by NAME, so it
 *    returned `undefined` for every node it was ever asked about;
 *  - a `goto` that appeared before its `id` was dropped, because references
 *    were resolved in the same single walk that was still discovering
 *    definitions;
 *  - symbol IDs embedded `Date.now()`, so two builds of identical text
 *    disagreed — the opposite of what an ID is for.
 *
 * Built in two passes over the tree, in document order, with IDs derived from
 * the definition's name and offset. Deterministic, and stable for as long as
 * the bytes are.
 */

import { RedNode } from '../Syntax/RedNode'
import type { SymbolInfo, Reference, SymbolSearchResult } from '../Types/symbols'

export class SymbolTable {
  private symbols: Map<string, SymbolInfo> = new Map()
  /** Node ID → symbol name. Definitions and references both point at it. */
  private nodeToSymbolName: Map<string, string> = new Map()

  /**
   * Build the symbol table from a red tree.
   *
   * Replaces any previous table. Symbols are keyed by name; when the same name
   * is defined twice the FIRST definition owns the symbol, and later
   * definitions are still mapped to it (a duplicate definition and a reference
   * are the same navigation target as far as go-to-definition is concerned).
   */
  build(root: RedNode): void {
    this.symbols.clear()
    this.nodeToSymbolName.clear()

    const nodes: RedNode[] = []
    root.walk(node => { nodes.push(node) })

    // Pass 1: definitions, so a reference before its definition resolves.
    for (const node of nodes) {
      const id = node.metadata?.id
      if (typeof id !== 'string' || id === '') continue
      const existing = this.symbols.get(id)
      if (existing) {
        // Duplicate definition: keep the first, point this node at it.
        this.nodeToSymbolName.set(node.id, id)
        continue
      }
      const symbol: SymbolInfo = {
        id: symbolId(id, node.range.start),
        name: id,
        kind: 'id_definition',
        definitionNodeId: node.id,
        definitionRange: { start: node.range.start, end: node.range.end },
        containerNodeId: root.id,
        references: [],
      }
      this.symbols.set(id, symbol)
      this.nodeToSymbolName.set(node.id, id)
    }

    // Pass 2: references, now that every definition exists.
    for (const node of nodes) {
      const goto = node.metadata?.goto
      if (typeof goto !== 'string' || goto === '') continue
      // A node that both defines and refers to the same name is not its own
      // reference; counting it would show a phantom usage.
      if (node.metadata?.id === goto) continue
      const symbol = this.symbols.get(goto)
      if (!symbol) {
        // A `goto` with no definition is not a reference to anything yet.
        continue
      }
      const reference: Reference = {
        nodeId: node.id,
        range: { start: node.range.start, end: node.range.end },
        kind: 'reference',
      }
      symbol.references.push(reference)
      this.nodeToSymbolName.set(node.id, goto)
    }
  }

  /** Get a symbol by name. */
  get(name: string): SymbolInfo | undefined {
    return this.symbols.get(name)
  }

  /**
   * The symbol a node defines or references.
   *
   * Returns `undefined` for a node that carries neither `id` nor `goto`.
   */
  getSymbolForNode(nodeId: string): SymbolInfo | undefined {
    const name = this.nodeToSymbolName.get(nodeId)
    return name === undefined ? undefined : this.symbols.get(name)
  }

  /** Search symbols by name. Exact > prefix > substring; ties keep build order. */
  search(query: string, maxResults: number = 10): SymbolSearchResult[] {
    const lower = query.toLowerCase()
    const results: SymbolSearchResult[] = []

    for (const [, symbol] of this.symbols) {
      const name = symbol.name.toLowerCase()
      let score = 0

      if (name === lower) score = 100
      else if (name.startsWith(lower)) score = 75
      else if (name.includes(lower)) score = 50

      if (score > 0) results.push({ symbol, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, maxResults)
  }

  /** Every symbol, in definition order. */
  getAll(): SymbolInfo[] {
    return Array.from(this.symbols.values())
  }

  /** Forget every symbol. */
  clear(): void {
    this.symbols.clear()
    this.nodeToSymbolName.clear()
  }
}

/**
 * An ID derived from what the symbol IS, not from when it was built.
 *
 * The offset disambiguates two same-named symbols in different places; the
 * name keeps it readable in a snapshot. No clock, no counter, no randomness.
 */
function symbolId(name: string, offset: number): string {
  return `sym:${name}@${offset}`
}
