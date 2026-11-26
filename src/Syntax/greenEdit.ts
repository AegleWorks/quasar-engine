/**
 * DocumentEngine — Green tree editing primitives
 *
 * The green tree is immutable, so an edit is not a mutation: it is a new tree
 * that shares everything the edit did not touch.
 *
 * ─── What used to be here ───────────────────────────────────────────────────
 *
 * `shiftGreen(node, delta)` — a deep copy of a subtree with every range moved.
 * It existed because green nodes carried absolute positions, so inserting three
 * characters near the top of a document meant rebuilding every node after the
 * insertion point just to renumber it. On a 19.6 KB document that was 14% of
 * the cost of an incremental reparse, spent entirely on producing structurally
 * identical copies of nodes that had not changed.
 *
 * It is gone, and there is nothing to replace it with. Green nodes have widths,
 * not positions (see `GreenNode.ts`), so text inserted before a subtree changes
 * where it is — which is the red tree's business — and not what it is. A
 * sibling after an edit is now shared by reference, exactly like a sibling
 * before it always was.
 */

import { GreenNode, greenNode } from './GreenNode'
import { SUM_TREE_THRESHOLD, greenSumReplaceAt, greenSumSplice, flattenGreenSumTree } from './ChildSumTree'

/** One step of the descent from the root to the node being replaced. */
export interface SpineStep {
  /** The ancestor. */
  node: GreenNode
  /** Index of the child that the descent continued into. */
  index: number
}

/**
 * Rebuild the ancestor spine after replacing one node.
 *
 * `spine` runs root-first; `replacement` takes the place of
 * `spine[spine.length - 1].node.children[spine[spine.length - 1].index]`.
 *
 * Only the spine itself is rebuilt — one new node per level of nesting, and
 * every other subtree in the document is carried over by reference. The
 * ancestors' widths follow from their new children automatically, so there is
 * no delta to propagate and no way to get the arithmetic wrong.
 */
export function spliceGreen(
  spine: readonly SpineStep[],
  replacement: GreenNode,
): GreenNode {
  let current = replacement

  for (let i = spine.length - 1; i >= 0; i--) {
    const { node, index } = spine[i]
    const tree = node.sumTree
    if (tree !== null) {
      const nextTree = greenSumReplaceAt(tree, index, current)
      current = GreenNode.fromSumTree(node.kind, node.text, nextTree, node.leadingWidth, node.trailingWidth)
      continue
    }
    const oldChildren = node.children as readonly GreenNode[]
    const children = new Array<GreenNode>(oldChildren.length)

    for (let j = 0; j < oldChildren.length; j++) children[j] = oldChildren[j]
    const replacedWidth = oldChildren[index].width
    children[index] = current

    const innerWidth = node.innerWidth - replacedWidth + current.width
    const delta = current.width - replacedWidth
    current = new GreenNode(
      node.kind,
      node.text,
      children,
      node.leadingWidth,
      node.trailingWidth,
      innerWidth,
      true,
      node.shiftChunkOffsets(index, delta),
    )
  }

  return current
}

/**
 * Replace a node's children while keeping the node itself — its kind, its
 * attributes and, above all, its delimiters.
 *
 * The incremental parser re-parses a span strictly INSIDE a node, so that
 * node's own `[centre]` and `[/centre]` never pass through the parser again and
 * cannot be reinterpreted. `leadingWidth`/`trailingWidth` carry across
 * untouched; the new width follows from the new children.
 */
export function withChildren(node: GreenNode, children: GreenNode[]): GreenNode {
  return greenNode(node.kind, node.text, children, node.leadingWidth, node.trailingWidth)
}

/**
 * Replace the children `[from, to)` of `node` with `replacement`.
 *
 * The unit an edit actually touches is a RUN OF SIBLINGS, not a whole node.
 * Re-parsing a container's entire contents because one character changed
 * somewhere inside it meant that typing into a large `[notice]` re-lexed 66% of
 * the document per keystroke; and an edit at document level had no enclosing
 * container at all, so it fell back to a full rebuild — which is where the
 * caret sits while you write the end of a post, the single most common case.
 *
 * Everything outside `[from, to)` is carried over by reference.
 */
export function withChildrenSpliced(
  node: GreenNode,
  from: number,
  to: number,
  replacement: readonly GreenNode[],
): GreenNode {
  const tree = node.sumTree
  if (tree !== null) {
    const nextTree = greenSumSplice(tree, from, to, replacement)
    if (nextTree.count < SUM_TREE_THRESHOLD) {
      return new GreenNode(node.kind, node.text, flattenGreenSumTree(nextTree), node.leadingWidth, node.trailingWidth, nextTree.width, true)
    }
    return GreenNode.fromSumTree(node.kind, node.text, nextTree, node.leadingWidth, node.trailingWidth)
  }
  const old = node.children as readonly GreenNode[]
  const children = new Array<GreenNode>(from + replacement.length + (old.length - to))

  let w = 0
  for (let i = 0; i < from; i++) children[w++] = old[i]
  let addedWidth = 0
  for (let i = 0; i < replacement.length; i++) {
    const r = replacement[i]
    children[w++] = r
    addedWidth += r.width
  }
  for (let i = to; i < old.length; i++) children[w++] = old[i]

  let removedWidth = 0
  for (let i = from; i < to; i++) removedWidth += old[i].width
  const innerWidth = node.innerWidth - removedWidth + addedWidth
  const sameLength = old.length === children.length && to - from === 1
  const chunkOffsets = sameLength ? node.shiftChunkOffsets(from, addedWidth - removedWidth) : null

  return new GreenNode(node.kind, node.text, children, node.leadingWidth, node.trailingWidth, innerWidth, true, chunkOffsets)
}
