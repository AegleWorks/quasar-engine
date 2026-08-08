/**
 * DocumentEngine — RedNodeStore
 *
 * Canonical store for RedNodes. Ensures that structurally identical subtrees
 * share the EXACT SAME RedNode instance in RAM.
 *
 * This is the RedNode-level complement to GreenNodePool (which handles
 * structural sharing at the GreenNode level).
 *
 * Architecture:
 * - Keyed by GreenNode._hash (deterministic structural hash)
 * - Bottom-up: children are stored first, then parents reference them
 * - Immutable structural data: once a RedNode is in the store, its `children`
 *   array and `green` reference never change
 * - Mutable metadata: the store's RedNode has canonical metadata (derived from
 *   green.text). Position-specific metadata lives in PositionRef.localOverlay.
 *
 * Benefits:
 * - Memory deduplication: 100 identical blocks = 1 RedNode + 99 lightweight refs
 * - Render caching: BBCodeCanvas can memoize by canonicalId
 * - Faster incremental parse: unchanged subtrees keep their RedNode identity
 * - HTMLRenderer cache: same canonicalId = same HTML (cache hits)
 */

import { GreenNode } from './GreenNode'
import { RedNode } from './RedNode'
import type { NodeKind, NodeMetadata } from '../Types/core'

/**
 * Derives a node's canonical metadata from its GreenNode.
 *
 * Injected rather than hardcoded: metadata extraction is *language* semantics
 * (what `=#ff0000,#00ff00` means for a `gradient`), and this module sits in the
 * language-agnostic `Syntax` layer. The BBCode implementation lives in
 * `BBCode/BBCodeToGreenNode.ts`; pass it via the constructor.
 */
export type MetadataExtractor = (green: GreenNode) => NodeMetadata

/** Default for callers with no language semantics to contribute. */
const NO_METADATA: MetadataExtractor = () => ({})

export class RedNodeStore {
  private canonicals = new Map<string, RedNode>()
  private _hits = 0
  private _misses = 0
  private readonly extractMetadata: MetadataExtractor

  /**
   * @param extractMetadata  How to derive canonical metadata from a green node.
   *   Defaults to producing none — the store stays language-agnostic unless a
   *   caller supplies the mapping.
   */
  constructor(extractMetadata: MetadataExtractor = NO_METADATA) {
    this.extractMetadata = extractMetadata
  }

  /**
   * Get or create a canonical RedNode for the given GreenNode.
   *
   * If a RedNode with the same structural hash already exists,
   * returns the existing instance (structural sharing).
   * If not, creates a new RedNode, recursively stores its children,
   * and caches it.
   *
   * @param green  The GreenNode to wrap
   * @param metadata  Optional metadata to set (overrides intrinsic metadata)
   * @param kind  Optional kind override
   * @returns The canonical RedNode (shared if already exists)
   */
  getOrCreate(
    green: GreenNode,
    metadata?: NodeMetadata,
    kind?: NodeKind,
  ): RedNode {
    const hash = green._hash.toString()
    const existing = this.canonicals.get(hash)
    if (existing) {
      this._hits++
      return existing
    }

    this._misses++

    // First, recursively store children (bottom-up construction)
    const childRedNodes: RedNode[] = []
    for (const childGreen of green.children as GreenNode[]) {
      // Children inherit parent's kind from green, no metadata override
      childRedNodes.push(this.getOrCreate(childGreen))
    }

    // Create the RedNode with canonical metadata from green.text
    const red = new RedNode(green, {
      kind: kind ?? (green.kind as NodeKind),
      metadata: metadata ?? this.extractMetadata(green),
    })

    // Populate children (construction-time, outside the mutation lock)
    red.initChildren(childRedNodes)

    this.canonicals.set(hash, red)
    return red
  }

  /**
   * Look up a canonical RedNode by its structural hash.
   */
  getByHash(hash: string): RedNode | undefined {
    return this.canonicals.get(hash)
  }

  /**
   * Check if a GreenNode already has a canonical RedNode.
   */
  has(green: GreenNode): boolean {
    return this.canonicals.has(green._hash.toString())
  }

  /**
   * Get the number of unique canonical nodes.
   */
  get size(): number {
    return this.canonicals.size
  }

  /**
   * Get store statistics.
   */
  get stats() {
    return {
      size: this.canonicals.size,
      hits: this._hits,
      misses: this._misses,
      deduplicationRatio: this._hits > 0
        ? (this._hits / (this._hits + this._misses) * 100).toFixed(1) + '%'
        : '0%',
    }
  }

  /**
   * Clear all canonical nodes.
   */
  clear(): void {
    this.canonicals.clear()
    this._hits = 0
    this._misses = 0
  }
}
