/**
 * DocumentEngine — preserveNodeIds
 *
 * Carry `RedNode.id` across a reparse, so a node that did not change keeps
 * the identity it had in the previous tree.
 *
 * Why this exists: every element in the rendered HTML embeds `data-node-id`
 * (the preview→Monaco click mapping reads it), and ids used to be regenerated
 * on every parse. That made the HTML of *unchanged* subtrees differ between
 * keystrokes, which defeated the DOMMorpher's `isEqualNode` fast path —
 * measured on a one-character edit, only 2 of 5 top-level subtrees compared
 * equal with ids embedded, versus 4 of 5 without them. Stable ids also make
 * any future node-identity feature (selection preservation, collaboration)
 * possible at all: two versions of a document can refer to the same node.
 *
 * The pairing strategy mirrors `NodeMatcher`'s Phase 0, which is validated at
 * scale: walk both trees in lockstep, trim the common prefix and suffix of
 * every child list, and only descend into the changed window when it is the
 * single-child shape a keystroke produces. Three tiers of matching:
 *
 *   1. Reference-equal greens — the incremental splice shares untouched
 *      subtrees by reference, so this covers almost everything while typing.
 *      Identical by construction; adopt the whole subtree, no checks.
 *   2. Hash-equal greens — the full-rebuild path reparses everything, so
 *      nothing is reference-equal but unchanged subtrees hash the same.
 *      Verified structurally before adopting (a 32-bit hash is not proof).
 *   3. Same kind at the same position — the node itself changed (it is the
 *      one being typed into) but it is still "the same element", so it keeps
 *      its id and its children get the prefix/suffix treatment.
 *
 * Uniqueness is preserved by construction: the walk is strictly positional
 * (old child i pairs with at most one new child), so an old id is adopted at
 * most once, and ids never adopted stay as freshly generated — the global
 * counter guarantees those cannot collide with anything older.
 */

import type { RedNode } from './RedNode'
import type { NodeId } from '../Types/core'

export interface PreserveIdsStats {
  /** Nodes that kept their previous id */
  adopted: number
  /** Nodes in the new tree that kept a fresh id */
  fresh: number
}

/**
 * Copy ids from `oldRoot`'s tree onto the matching nodes of `newRoot`'s tree.
 * Returns how many nodes were matched, for tests and diagnostics.
 */
export function preserveNodeIds(oldRoot: RedNode, newRoot: RedNode): PreserveIdsStats {
  const stats: PreserveIdsStats = { adopted: 0, fresh: 0 }
  preserve(oldRoot, newRoot, stats)
  stats.fresh = countNodes(newRoot) - stats.adopted
  return stats
}

function preserve(oldNode: RedNode, newNode: RedNode, stats: PreserveIdsStats): void {
  // Tier 0: with red-subtree reuse, "both" nodes are often the SAME object,
  // adopted from the old tree — its ids are already its own. Note these
  // subtrees are not counted in `adopted`.
  if (oldNode === newNode) return

  // Tier 1: the splice shared this subtree by reference — identical by
  // construction, adopt wholesale.
  if (oldNode.green === newNode.green) {
    adoptSubtree(oldNode, newNode, stats)
    return
  }

  // Tier 2: same hash across a full reparse. Verify before trusting it —
  // a false adoption would be harmless for correctness (the morpher compares
  // content, not ids) but would pair ids across genuinely different nodes.
  if (oldNode.green._hash === newNode.green._hash && verifyAndAdopt(oldNode, newNode, stats)) {
    return
  }

  // Tier 3: the changed path itself. Same kind at the same position is the
  // same element with different content — keep its identity and descend.
  if (oldNode.kind !== newNode.kind) return
  adoptId(oldNode, newNode, stats)

  const oldKids = oldNode.children
  const newKids = newNode.children
  const limit = Math.min(oldKids.length, newKids.length)

  // Common prefix.
  let lo = 0
  while (lo < limit && matchable(oldKids[lo], newKids[lo])) {
    preserve(oldKids[lo], newKids[lo], stats)
    lo++
  }

  // Common suffix, stopping before the prefix already consumed.
  let oldHi = oldKids.length - 1
  let newHi = newKids.length - 1
  while (oldHi >= lo && newHi >= lo && matchable(oldKids[oldHi], newKids[newHi])) {
    preserve(oldKids[oldHi], newKids[newHi], stats)
    oldHi--
    newHi--
  }

  // A single changed child on both sides is the shape a keystroke produces:
  // descend so its own untouched children still keep their ids. A wider
  // window (multi-block paste, reordering) keeps fresh ids — guessing there
  // would risk pairing unrelated nodes.
  if (oldHi === lo && newHi === lo) {
    preserve(oldKids[lo], newKids[lo], stats)
  }
}

/**
 * Whether two positionally aligned children are the SAME content, and so can
 * be walked in lockstep while trimming the common prefix and suffix.
 *
 * Deliberately not "same kind": that is true of any two paragraphs, so a
 * single inserted block would let the trim march through the whole list
 * pairing each survivor with its neighbour — renumbering every block after
 * the insertion and, worse, assigning ids that are still in use elsewhere.
 * Evidence of sameness has to be content-based; kind similarity is only
 * enough for the one changed child in the middle, which `preserve` handles.
 */
function matchable(oldNode: RedNode, newNode: RedNode): boolean {
  return (
    oldNode.green === newNode.green ||
    oldNode.green._hash === newNode.green._hash
  )
}

/**
 * Adopt every id of a subtree pair whose greens are the same object.
 *
 * Reference-equal greens guarantee identical *green* structure, but a red
 * tree can be mutated directly (`transact` deletes red children without
 * touching green, and with interning on, an old mutated red can still sit on
 * a pool-shared green). When the red child lists disagree, fall back to the
 * full tiered walk for that level instead of indexing out of bounds.
 */
function adoptSubtree(oldNode: RedNode, newNode: RedNode, stats: PreserveIdsStats): void {
  if (oldNode === newNode) return
  adoptId(oldNode, newNode, stats)
  const oldKids = oldNode.children
  const newKids = newNode.children
  if (oldKids.length !== newKids.length) {
    const limit = Math.min(oldKids.length, newKids.length)
    for (let i = 0; i < limit; i++) {
      if (!matchable(oldKids[i], newKids[i])) break
      preserve(oldKids[i], newKids[i], stats)
    }
    return
  }
  for (let i = 0; i < oldKids.length; i++) {
    adoptSubtree(oldKids[i], newKids[i], stats)
  }
}

/**
 * Structurally verify a hash match and, only if the whole subtree confirms,
 * adopt every id. Mirrors `NodeMatcher.verifyIdentical`: pairs are collected
 * during the check and committed atomically, so a mismatch (hash collision)
 * leaves nothing half-adopted before the caller falls through to Tier 3.
 */
function verifyAndAdopt(oldNode: RedNode, newNode: RedNode, stats: PreserveIdsStats): boolean {
  const pairs: RedNode[] = []
  if (!verifyIdentical(oldNode, newNode, pairs)) return false
  for (let i = 0; i < pairs.length; i += 2) {
    adoptId(pairs[i], pairs[i + 1], stats)
  }
  return true
}

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

function adoptId(oldNode: RedNode, newNode: RedNode, stats: PreserveIdsStats): void {
  // `id` is readonly for consumers; this module is the one sanctioned writer.
  ;(newNode as { id: NodeId }).id = oldNode.id
  stats.adopted++
}

function countNodes(root: RedNode): number {
  let n = 1
  for (const child of root.children) n += countNodes(child)
  return n
}
