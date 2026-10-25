/**
 * DocumentEngine — SymbolTable
 *
 * Definitions and references in a document, for the IDE features that need
 * them: go-to-definition, find-all-references, rename, and the document
 * outline.
 *
 * BBCode has no declaration syntax of its own, so symbols come from two
 * places:
 *
 *  - **Headings.** A `[heading]Title[/heading]` defines `#title`; a
 *    `[url=#title]` link refers to it. This is a table of contents that every
 *    real userpage already writes, and it needs no new syntax.
 *  - **Metadata.** A tag or plugin can carry `id` (a definition) or `goto`
 *    (a reference). The built-in tag set produces neither, but the extension
 *    point stays available.
 *
 * What this module did not deliver before:
 *
 *  - `getSymbolForNode` looked the symbol ID up in a map keyed by NAME, so it
 *    returned `undefined` for every node it was ever asked about;
 *  - a `goto` that appeared before its `id` was dropped, because references
 *    were resolved in the same single walk that was still discovering
 *    definitions;
 *  - symbol IDs embedded `Date.now()`, so two builds of identical text
 *    disagreed — the opposite of what an ID is for.
 *
 * Built in passes over the tree, in document order, with IDs derived from the
 * definition's name and offset. Deterministic, and stable for as long as the
 * bytes are.
 */

import { RedNode } from '../Syntax/RedNode'
import { extractTextContent } from '../Model/TagRegistry'
import type { SymbolInfo, Reference, SymbolSearchResult } from '../Types/symbols'

/**
 * Turn heading text into the fragment an author links to.
 *
 * The rules are deliberately boring and deterministic: compatibility-decompose
 * and drop accents, lowercase, collapse every run of non-alphanumerics to one
 * hyphen, trim hyphens. A heading with no letters or digits becomes `section`,
 * and the caller appends `-2`, `-3` for duplicates. `#section` is what a table
 * of contents would link to, so that is what the symbol is called.
 *
 * Unicode property escapes are ES2018, the package targets ES2022, and Node,
 * Blink and Tauri all support them.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'section' : slug
}

/** The plain text of a heading, or `''` for a heading with no text. */
function headingText(node: RedNode): string {
  return extractTextContent(node).replace(/\s+/g, ' ').trim()
}

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
  build(root: RedNode, source?: string): void {
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

    // Pass 2: headings. BBCode has no declaration syntax, but a heading and a
    // `[url=#fragment]` link to it are a definition and a reference that every
    // real userpage already writes. Before this, the table only understood
    // `id`/`goto` metadata that no built-in tag produced, so a document with a
    // table of contents had no symbols at all.
    this.buildHeadingSymbols(nodes, root)

    // Pass 3: references, now that every definition exists.
    const byLowerName = new Map<string, SymbolInfo>()
    for (const symbol of this.symbols.values()) {
      byLowerName.set(symbol.name.toLowerCase(), symbol)
    }

    for (const node of nodes) {
      const goto = node.metadata?.goto
      if (typeof goto === 'string' && goto !== '') {
        // A node that both defines and refers to the same name is not its own
        // reference; counting it would show a phantom usage.
        if (node.metadata?.id !== goto) {
          const symbol = this.symbols.get(goto)
          if (symbol) {
            this.addReference(symbol, node, { start: node.range.start, end: node.range.end }, goto)
          }
        }
        continue
      }

      if (node.kind !== 'url') continue
      const href = node.metadata?.href
      if (typeof href !== 'string' || !href.startsWith('#')) continue

      const fragment = href.slice(1)
      let decoded = fragment
      try {
        decoded = decodeURIComponent(fragment)
      } catch {
        // A malformed escape is still a fragment the author wrote; match it as
        // it appears rather than throw.
      }
      const symbol = byLowerName.get(decoded.toLowerCase())
      if (!symbol) continue

      // Point at the fragment itself, not the whole `[url=…]` tag. Without the
      // source there is no exact span, so the whole node is the honest answer.
      let range = { start: node.range.start, end: node.range.end }
      if (source !== undefined) {
        const delimiter = source.slice(node.range.start, node.innerStart)
        const at = delimiter.indexOf(href)
        if (at >= 0) {
          const start = node.range.start + at
          range = { start, end: start + href.length }
        }
      }
      this.addReference(symbol, node, range, symbol.name)
    }
  }

  /**
   * One symbol per heading, named by its fragment. Duplicate headings get
   * `-2`, `-3`, in document order — the same rule a static-site generator uses,
   * and the only one that keeps `#intro` and a second "Intro" addressable.
   */
  private buildHeadingSymbols(nodes: readonly RedNode[], root: RedNode): void {
    for (const node of nodes) {
      if (node.kind !== 'heading') continue

      const text = headingText(node)
      const base = slugifyHeading(text)
      let name = base
      for (let n = 2; this.symbols.has(name); n++) name = `${base}-${n}`

      const symbol: SymbolInfo = {
        id: symbolId(name, node.innerStart),
        name,
        kind: 'id_definition',
        definitionNodeId: node.id,
        definitionRange: { start: node.innerStart, end: node.innerEnd },
        containerNodeId: root.id,
        references: [],
        data: {
          origin: 'heading',
          text,
          nodeRange: { start: node.range.start, end: node.range.end },
          innerRange: { start: node.innerStart, end: node.innerEnd },
        },
      }
      this.symbols.set(name, symbol)
      this.nodeToSymbolName.set(node.id, name)
    }
  }

  private addReference(
    symbol: SymbolInfo,
    node: RedNode,
    range: { start: number; end: number },
    name: string,
  ): void {
    const reference: Reference = { nodeId: node.id, range, kind: 'reference' }
    symbol.references.push(reference)
    this.nodeToSymbolName.set(node.id, name)
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
