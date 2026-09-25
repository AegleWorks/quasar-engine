/**
 * Anchors, layer 2: an anchor ⇄ a node of any tree built from the same text.
 *
 * A structural node is anchored by its OPENING DELIMITER (`[box=Title]`):
 * typing in its body never touches that range, so the anchor is as stable as
 * the node itself, and renaming the title edits inside it, which the anchor
 * follows. Binding is by position, so the same anchor finds the box in the
 * default parse, in the osu! preview tree and in a fresh parse after a reload.
 * See docs/11-Anchors-Plan.md.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import type { AddAnchorOptions, Anchor, AnchorSet } from './AnchorSet'

/** The range an anchor for `node` covers: its opening delimiter. */
export function openerRange(node: RedNode): { start: number; end: number } {
  const start = node.range.start
  return { start, end: start + node.green.leadingWidth }
}

/**
 * Anchors `node` in `set` by its opening delimiter. Defaults to
 * `'never-grows'`: text typed right before the opener or right after it (the
 * start of the body) is not the opener.
 */
export function anchorForNode(set: AnchorSet, node: RedNode, options: AddAnchorOptions = {}): Anchor {
  if (node.green.leadingWidth === 0) {
    throw new Error(`a ${node.kind} node has no opening delimiter to anchor`)
  }
  const { start, end } = openerRange(node)
  return set.add(start, end, { stickiness: 'never-grows', ...options })
}

/**
 * The node of one of `kinds` whose opening delimiter `anchor` still covers,
 * in `root`'s tree — or null when the anchored text was deleted or no longer
 * opens such a node (an edit turned `[box=T]` into plain text, say).
 *
 * Descends into the one child whose range holds the anchor's start, found by
 * binary search, so it costs O(depth · log width), not the size of the tree.
 */
export function resolveNode(root: RedNode, anchor: Anchor, kinds: ReadonlySet<NodeKind | string>): RedNode | null {
  if (anchor.deleted || anchor.start === anchor.end) return null
  let best: RedNode | null = null
  let node: RedNode = root
  for (;;) {
    const children = node.children
    // The last child starting at or before the anchor.
    let lo = 0
    let hi = children.length - 1
    let at = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (children[mid].range.start <= anchor.start) { at = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (at < 0) return best
    const child = children[at]
    if (anchor.start >= child.range.end) return best
    if (kinds.has(child.kind) && child.green.leadingWidth > 0) {
      const opener = openerRange(child)
      // Overlap with the opener; an exact match wins over a partial one.
      if (opener.start < anchor.end && anchor.start < opener.end) {
        if (opener.start === anchor.start && opener.end === anchor.end) return child
        best ??= child
      }
    }
    node = child
  }
}
