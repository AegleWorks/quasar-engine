/**
 * DocumentEngine — GreenNodePool (Structural Sharing via Interning)
 *
 * Roslyn-grade GreenNode Deduplication Pool.
 *
 * Ensures that structurally identical subtrees share the EXACT SAME
 * GreenNode memory address in RAM. This is structural sharing:
 * when the same BBCode block is pasted 10 times, the parser creates
 * GreenNodes for it ONCE, and all 10 copies reference the same objects.
 *
 * Architecture:
 * - Flyweight Pattern: GreenNodes are pure structural data without parent pointers.
 * - Hash-based lookup: O(1) amortized via _hash property on GreenNode.
 * - Reference-equality verification: identical children = same reference (because
 *   children are interned first, bottom-up construction guarantees this).
 * - Per-document scope: interners are created per BBCodeDocumentModel, cleared on dispose.
 *
 * Key insight: because GreenNodes are immutable and children are interned bottom-up,
 * two nodes with the same (kind, text, widths, children-references) are structurally
 * identical. We use _hash for fast lookup, then verify with reference equality on
 * children.
 *
 * ─── Why this used to be broken (roadmap S2) ────────────────────────────────
 *
 * Green nodes used to carry an absolute `range`, and the two halves of the pool
 * disagreed about what to do with it:
 *
 *  - `internLeaf` keyed on `kind:text` alone, so the second `"Hello"` in a
 *    document got back the node built for the FIRST one — carrying the first
 *    one's offsets. Enabling the interner made every position downstream lie
 *    silently: incremental reparse, `findNodeAtOffset`, diagnostics, the
 *    Monaco↔AST mapping.
 *  - `internNode` did the opposite and required identical start AND end before
 *    deduplicating, which no two distinct occurrences can have. The same block
 *    pasted ten times gave 0% dedup and 100% of the scanning cost.
 *
 * Neither was fixable while position lived on the green node, because those are
 * the only two options: ignore it and lie, or respect it and never match. The
 * fix was to remove position from the green tree entirely — see `GreenNode.ts`.
 * Now `kind:text:width` genuinely identifies a leaf, and interning is simply
 * correct.
 */

import { GreenNode } from './GreenNode'

export interface GreenNodePoolStats {
  size: number
  hits: number
  misses: number
  deduplicatedCount: number
  /** Number of hash collisions that were verified as true duplicates */
  collisionHits: number
  /** Number of hash collisions that were false positives */
  collisionMisses: number
}

/**
 * How much of the tree to deduplicate.
 *
 * Measured on the 19.6 KB reference document, against no interning at all:
 *
 * | mode     | parse time | green tree memory |
 * |----------|------------|-------------------|
 * | `leaves` | +16%       | −42%              |
 * | `full`   | +110%      | −56%              |
 *
 * `leaves` is the default because it buys three quarters of the memory for a
 * seventh of the time. Interning an internal node means hashing its whole
 * subtree — `_hash` is lazy, so a parse that never interns never pays for it —
 * and then walking its children to verify a bucket hit. Leaves cost one string
 * key and one Map lookup, and they are where the duplication is: the reference
 * document has 930 leaves and only 122 distinct ones.
 */
export type InterningMode = 'leaves' | 'full'

export class GreenNodePool {
  private static _instance: GreenNodePool | null = null
  private readonly _mode: InterningMode
  private _leafCache = new Map<string, GreenNode>()
  private _nodeCache = new Map<number, GreenNode[]>()
  private _hits = 0
  private _misses = 0
  private _collisionHits = 0
  private _collisionMisses = 0

  /** Singleton instance accessor (for backward compatibility) */
  static get instance(): GreenNodePool {
    if (!GreenNodePool._instance) {
      GreenNodePool._instance = new GreenNodePool()
    }
    return GreenNodePool._instance
  }

  constructor(mode: InterningMode = 'leaves') {
    this._mode = mode
  }

  /**
   * Create a new isolated interner (for per-document use).
   * The returned pool shares no cache with the singleton.
   */
  static create(mode: InterningMode = 'leaves'): GreenNodePool {
    return new GreenNodePool(mode)
  }

  /**
   * Intern (deduplicate) a leaf GreenNode.
   * If an identical leaf exists in the pool, returns the cached instance.
   * Leaf key: `kind:text` — deterministic, no collision possible.
   */
  internLeaf(kind: string, text: string, width = text.length): GreenNode {
    // `width` belongs in the key: `spacing` carries no text but occupies one or
    // two characters depending on whether the source used `\n` or `\r\n`, and
    // those are different tokens.
    const key = `${kind}:${width}:${text}`
    const existing = this._leafCache.get(key)
    if (existing) {
      this._hits++
      return existing
    }

    this._misses++
    const newNode = new GreenNode(kind, text, [], 0, 0, width)
    this._leafCache.set(key, newNode)
    return newNode
  }

  /**
   * Intern an internal GreenNode (structural sharing).
   *
   * Strategy:
   * 1. Compute hash from (kind, text, children's _hash values) — O(n) where n = children count
   * 2. Look up hash in bucket — O(1) amortized
   * 3. Verify with reference equality on children — O(n) but cache-friendly
   * 4. If verified, return existing (structural sharing achieved)
   * 5. If not, store and return new node
   *
   * Because children are interned bottom-up, identical children are the same reference.
   * This makes reference equality a perfect structural equality check.
   */
  internNode(
    kind: string,
    text: string,
    children: GreenNode[],
    leadingWidth = 0,
    trailingWidth = 0,
  ): GreenNode {
    if (this._mode === 'leaves') {
      return new GreenNode(kind, text, children, leadingWidth, trailingWidth)
    }
    // Fast path: check if we already have this exact node by hash
    // For nodes with same kind+text+children-count, the hash is likely unique.
    // We use the hash as the bucket key, then verify all children by reference.
    const bucketKey = this.computeBucketKey(kind, text, children, leadingWidth, trailingWidth)
    const bucket = this._nodeCache.get(bucketKey)
    if (bucket) {
      for (const existing of bucket) {
        if (existing.kind === kind
          && existing.text === text
          && existing.children.length === children.length
          && existing.leadingWidth === leadingWidth
          && existing.trailingWidth === trailingWidth) {
          // Verify children by reference (O(n) but cache-linear)
          let allMatch = true
          for (let i = 0; i < children.length; i++) {
            if (existing.children[i] !== children[i]) {
              allMatch = false
              break
            }
          }
          if (allMatch) {
            this._hits++
            this._collisionHits++
            return existing
          }
        }
      }
      // Hash collision — different node with same bucket key
      this._collisionMisses++
    }

    this._misses++
    const newNode = new GreenNode(kind, text, children, leadingWidth, trailingWidth)

    if (bucket) {
      bucket.push(newNode)
    } else {
      this._nodeCache.set(bucketKey, [newNode])
    }

    return newNode
  }

  /**
   * Compute a bucket key for internal nodes.
   * Uses (kind, text, children-count, first-child-hash) for fast bucketing.
   * This gives O(1) bucket lookup in the common case.
   */
  private computeBucketKey(
    kind: string,
    text: string,
    children: GreenNode[],
    leadingWidth: number,
    trailingWidth: number,
  ): number {
    let h = this.fnv1a(kind)
    h = this.hashCombine(h, this.fnv1a(text))
    h = this.hashCombine(h, leadingWidth)
    h = this.hashCombine(h, trailingWidth)
    h = this.hashCombine(h, children.length)
    if (children.length > 0) {
      h = this.hashCombine(h, children[0]._hash)
    }
    return h
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }

  private hashCombine(seed: number, value: number): number {
    seed ^= value
    seed = Math.imul(seed, 0x01000193)
    return seed >>> 0
  }

  /** Clear the pool cache */
  clear(): void {
    this._leafCache.clear()
    this._nodeCache.clear()
    this._hits = 0
    this._misses = 0
    this._collisionHits = 0
    this._collisionMisses = 0
  }

  /** Get current pool statistics */
  get stats(): GreenNodePoolStats {
    return {
      size: this._leafCache.size + this._nodeCache.size,
      hits: this._hits,
      misses: this._misses,
      deduplicatedCount: this._hits,
      collisionHits: this._collisionHits,
      collisionMisses: this._collisionMisses,
    }
  }
}

/** Convenience helper for interning green leaves */
export function internGreenLeaf(kind: string, text: string, width = text.length): GreenNode {
  return GreenNodePool.instance.internLeaf(kind, text, width)
}

/** Convenience helper for interning green nodes */
export function internGreenNode(
  kind: string,
  text: string,
  children: GreenNode[],
  leadingWidth = 0,
  trailingWidth = 0,
): GreenNode {
  return GreenNodePool.instance.internNode(kind, text, children, leadingWidth, trailingWidth)
}
