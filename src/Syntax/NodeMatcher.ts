/**
 * DocumentEngine — NodeMatcher
 *
 * Matches nodes between old and new syntax trees after edits.
 * Uses stable IDs, fingerprints, and source ranges to determine
 * which nodes were moved, inserted, deleted, or unchanged.
 *
 * Critical for:
 * - Maintaining selection across re-parses
 * - Preserving scroll position
 * - Smooth animations in visual blocks mode
 * - Undo/redo integrity
 */

import { RedNode } from './RedNode'
import type { NodeId } from '../Types/core'
import { FNV_OFFSET, FNV_OFFSET_ALT, hashString, hashUint32 } from './hash'

// ─── Match Result ──────────────────────────────────────────────

export type MatchStatus =
  | 'exact'       // Same ID, same fingerprint
  | 'moved'       // Same ID, different position
  | 'updated'     // Same ID, different content
  | 'inserted'    // New node (no match)
  | 'deleted'     // Old node (no longer present)
  | 'merged'      // Two old nodes became one
  | 'split'       // One old node became two

export interface MatchResult {
  oldNode: RedNode | null
  newNode: RedNode | null
  status: MatchStatus
  confidence: number // 0-1
}

export interface NodeMatch {
  /** Map from old node ID to new node */
  oldToNew: Map<NodeId, RedNode>
  /** Map from new node ID to old node */
  newToOld: Map<NodeId, RedNode>
  /** All matches */
  matches: MatchResult[]
  /** Statistics */
  stats: {
    exact: number
    moved: number
    updated: number
    inserted: number
    deleted: number
  }
}

// ─── NodeMatcher ───────────────────────────────────────────────

export class NodeMatcher {
  /**
   * Match nodes between old and new trees.
   *
   * Strategy (in order):
   * 1. Match by stable ID (if present)
   * 2. Match by fingerprint (content hash)
   * 3. Match by source range overlap
   * 4. Fall back to positional heuristic
   */
  match(oldRoot: RedNode, newRoot: RedNode): NodeMatch {
    const oldToNew = new Map<NodeId, RedNode>()
    const newToOld = new Map<NodeId, RedNode>()
    const matches: MatchResult[] = []
    const stats = { exact: 0, moved: 0, updated: 0, inserted: 0, deleted: 0 }

    // Flatten both trees in document order.
    const oldNodes: RedNode[] = []
    collect(oldRoot, oldNodes)

    const newNodes: RedNode[] = []
    collect(newRoot, newNodes)

    const newById = new Map<NodeId, RedNode>()
    for (const node of newNodes) newById.set(node.id, node)

    const matchedOld = new Set<RedNode>()
    const matchedNew = new Set<RedNode>()

    // ── Phase 0: Pair structurally unchanged subtrees ──────────
    //
    // A keystroke changes one text node, so only the nodes on the path from the
    // root to the edit actually differ — everything hanging off that path is
    // untouched. `GreenNode._hash` already summarises (kind, text, children)
    // and excludes position, so it identifies those untouched subtrees for free.
    //
    // Pairing them here keeps them out of Phase 2, which is the expensive one:
    // it builds a fingerprint string plus several Map/Set entries per node.
    this.pairUnchanged(
      oldRoot, newRoot,
      oldToNew, newToOld, matches, stats, matchedOld, matchedNew,
    )

    // ── Phase 1: Match by stable ID ────────────────────────────
    for (const oldNode of oldNodes) {
      if (matchedOld.has(oldNode)) continue
      const newNode = newById.get(oldNode.id)
      if (!newNode || matchedNew.has(newNode)) continue

      // `index` is O(1) (cached on RedNode), so the traversal no longer has to
      // carry a side table of positions.
      const isSamePosition =
        oldNode.parent?.id === newNode.parent?.id &&
        oldNode.index === newNode.index
      const isSameContent =
        oldNode.text === newNode.text && oldNode.kind === newNode.kind

      oldToNew.set(oldNode.id, newNode)
      newToOld.set(newNode.id, oldNode)
      matchedOld.add(oldNode)
      matchedNew.add(newNode)

      let status: MatchStatus = 'exact'
      if (!isSameContent) status = 'updated'
      else if (!isSamePosition) status = 'moved'

      matches.push({ oldNode, newNode, status, confidence: 1.0 })

      if (status === 'exact') stats.exact++
      else if (status === 'moved') stats.moved++
      else stats.updated++
    }

    // ── Phase 2: Match remaining by subtree fingerprint ────────
    //
    // Previously a nested loop over (unmatchedOld x unmatchedNew) that
    // recomputed a full subtree walk on every comparison — O(n^2 * subtree),
    // which cost 380 ms for a one-character edit on a 20 KB document.
    //
    // Fingerprints are now memoized and computed bottom-up (O(n) for the whole
    // tree), then bucketed so each old node consults only the new nodes that
    // could possibly match. Candidates are consumed in document order, which
    // preserves the pairing the nested loop produced.
    const fingerprints = newFingerprintCache()

    const buckets = new Map<string, RedNode[]>()
    for (const node of newNodes) {
      if (matchedNew.has(node)) continue
      const key = this.fingerprintInto(node, fingerprints)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(node)
      else buckets.set(key, [node])
    }

    // Cursor per bucket: consuming with `shift()` would reintroduce O(n^2).
    const cursors = new Map<string, number>()

    for (const oldNode of oldNodes) {
      if (matchedOld.has(oldNode)) continue

      const key = this.fingerprintInto(oldNode, fingerprints)
      const bucket = buckets.get(key)
      if (!bucket) continue

      const cursor = cursors.get(key) ?? 0
      if (cursor >= bucket.length) continue

      const newNode = bucket[cursor]
      cursors.set(key, cursor + 1)

      oldToNew.set(oldNode.id, newNode)
      newToOld.set(newNode.id, oldNode)
      matchedOld.add(oldNode)
      matchedNew.add(newNode)

      matches.push({ oldNode, newNode, status: 'moved', confidence: 0.8 })
      stats.moved++
    }

    // ── Phase 3: Remaining unmatched = deleted / inserted ──────
    // The previous implementation never pruned matched nodes from the "old"
    // set, so every node was reported as moved AND deleted simultaneously.
    for (const node of oldNodes) {
      if (matchedOld.has(node)) continue
      matches.push({ oldNode: node, newNode: null, status: 'deleted', confidence: 1.0 })
      stats.deleted++
    }

    for (const node of newNodes) {
      if (matchedNew.has(node)) continue
      matches.push({ oldNode: null, newNode: node, status: 'inserted', confidence: 1.0 })
      stats.inserted++
    }

    return { oldToNew, newToOld, matches, stats }
  }

  /**
   * Phase 0 — descend in lockstep, pairing every subtree that did not change.
   *
   * At each level the common prefix and common suffix are trimmed by comparing
   * `green._hash`, and only the window between them is descended into. That is
   * what makes this robust to an edit that changes the number of children:
   * requiring equal child counts before recursing sounds reasonable but means a
   * single inserted node near the root disables the fast path for the whole
   * tree — measured, it left `match` at 5.11 ms instead of 0.96 ms.
   *
   * Whatever is left in the middle window is handed to the fingerprint
   * heuristic, which is the part that can cope with reordering.
   */
  private pairUnchanged(
    oldNode: RedNode,
    newNode: RedNode,
    oldToNew: Map<NodeId, RedNode>,
    newToOld: Map<NodeId, RedNode>,
    matches: MatchResult[],
    stats: NodeMatch['stats'],
    matchedOld: Set<RedNode>,
    matchedNew: Set<RedNode>,
  ): void {
    if (oldNode.green._hash === newNode.green._hash) {
      const pairs: RedNode[] = []
      if (verifyIdentical(oldNode, newNode, pairs)) {
        for (let i = 0; i < pairs.length; i += 2) {
          const o = pairs[i]
          const n = pairs[i + 1]
          oldToNew.set(o.id, n)
          newToOld.set(n.id, o)
          matchedOld.add(o)
          matchedNew.add(n)
          matches.push({ oldNode: o, newNode: n, status: 'exact', confidence: 1.0 })
          stats.exact++
        }
        return
      }
      // Hash collision. `_hash` is 32-bit, so this is astronomically rare, but
      // "rare" is not "never" and a false pair would show stale content in the
      // preview. Falling through costs one wasted subtree walk.
    }

    const oldKids = oldNode.children
    const newKids = newNode.children
    const limit = Math.min(oldKids.length, newKids.length)

    // Common prefix.
    let lo = 0
    while (lo < limit && oldKids[lo].green._hash === newKids[lo].green._hash) {
      this.pairUnchanged(
        oldKids[lo], newKids[lo],
        oldToNew, newToOld, matches, stats, matchedOld, matchedNew,
      )
      lo++
    }

    // Common suffix, stopping before the prefix already consumed.
    let oldHi = oldKids.length - 1
    let newHi = newKids.length - 1
    while (
      oldHi >= lo && newHi >= lo &&
      oldKids[oldHi].green._hash === newKids[newHi].green._hash
    ) {
      this.pairUnchanged(
        oldKids[oldHi], newKids[newHi],
        oldToNew, newToOld, matches, stats, matchedOld, matchedNew,
      )
      oldHi--
      newHi--
    }

    // A single changed child on both sides is the shape a keystroke produces:
    // descend so its own untouched children still get paired.
    if (oldHi === lo && newHi === lo) {
      this.pairUnchanged(
        oldKids[lo], newKids[lo],
        oldToNew, newToOld, matches, stats, matchedOld, matchedNew,
      )
    }
  }

  /**
   * Compute a content fingerprint for a node's subtree.
   *
   * Two nodes share a fingerprint iff their subtrees have the same pre-order
   * sequence of (kind, text) pairs — the same equivalence the previous
   * string-concatenating implementation tested, but as a 64-bit structural
   * hash instead of an O(subtree) string built on every comparison.
   */
  fingerprint(node: RedNode): string {
    return this.fingerprintInto(node, newFingerprintCache())
  }

  /** Memoized, bottom-up fingerprint. O(n) across a whole tree. */
  private fingerprintInto(node: RedNode, memo: FingerprintCache): string {
    const cachedKey = memo.keys.get(node)
    if (cachedKey !== undefined) return cachedKey

    // Two independent lanes give a 64-bit key: with ~10^4 nodes the collision
    // probability is ~10^-11, far below the rate at which the heuristic itself
    // mispairs nodes.
    let h1 = hashString(FNV_OFFSET, node.kind)
    h1 = hashString(h1, node.text)
    h1 = hashUint32(h1, node.children.length)

    let h2 = hashString(FNV_OFFSET_ALT, node.kind)
    h2 = hashString(h2, node.text)
    h2 = hashUint32(h2, node.children.length)

    // Fold in each child's numeric lanes rather than re-hashing its key
    // string: the string form is only needed for the bucket map, so it is
    // built once per node instead of once per parent-child edge.
    for (const child of node.children) {
      this.fingerprintInto(child, memo)
      h1 = hashUint32(h1, memo.lane1.get(child)!)
      h2 = hashUint32(h2, memo.lane2.get(child)!)
    }

    memo.lane1.set(node, h1)
    memo.lane2.set(node, h2)
    const key = h1.toString(36) + ':' + h2.toString(36)
    memo.keys.set(node, key)
    return key
  }
}

/** Per-`match()` memo. Never reused across calls: RedNodes are mutable. */
interface FingerprintCache {
  lane1: Map<RedNode, number>
  lane2: Map<RedNode, number>
  keys: Map<RedNode, string>
}

function newFingerprintCache(): FingerprintCache {
  return { lane1: new Map(), lane2: new Map(), keys: new Map() }
}

/**
 * Confirm two subtrees really are identical, collecting the node pairs as it
 * goes so a successful check does not need a second traversal.
 *
 * `pairs` is filled as a flat [old, new, old, new, …] list and is only valid
 * when this returns true; callers must discard it otherwise, since the walk
 * bails out the moment it finds a difference.
 */
function verifyIdentical(oldNode: RedNode, newNode: RedNode, pairs: RedNode[]): boolean {
  if (
    oldNode.kind !== newNode.kind ||
    oldNode.text !== newNode.text ||
    oldNode.children.length !== newNode.children.length
  ) {
    return false
  }

  pairs.push(oldNode, newNode)

  const oldKids = oldNode.children
  const newKids = newNode.children
  for (let i = 0; i < oldKids.length; i++) {
    if (!verifyIdentical(oldKids[i], newKids[i], pairs)) return false
  }
  return true
}

/** Flatten a tree in pre-order. */
function collect(root: RedNode, out: RedNode[]): void {
  const stack: RedNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    out.push(node)
    const children = node.children
    // Reverse push so popping yields left-to-right document order.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i])
    }
  }
}
