/**
 * Canvas positions — a point in a rendered canvas as a source offset, and back.
 *
 * A command on the WYSIWYG canvas (Bold on a selection) is computed on the
 * source, so the DOM selection has to become offsets first, and the edited
 * source's selection has to become a DOM range again once the canvas is
 * repainted. Both directions rest on the same pairing, and both require the
 * canvas to be exactly the render of `root` — the caller repaints before
 * asking if the user has typed since.
 *
 * ─── The pairing ────────────────────────────────────────────────────────────
 *
 * Elements carry their node's id (`data-node-id`), text does not: a text leaf
 * renders as a bare DOM text node. So a point is first scoped to the nearest
 * element with an id and its node, and inside that scope DOM text nodes are
 * paired with the node's text leaves in document order, by equal text. DOM
 * text that pairs with nothing is text the renderer made up — a `[quote]`
 * author line, a box heading, a newline — and a point in it resolves to the
 * nearest paired neighbour, which is where a caret there belongs anyway.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeId } from '../Types/core'

const ZWSP = /​/g

/** Text leaves under `node` in render order: title nodes first, then children. */
function textLeaves(node: RedNode, out: RedNode[] = []): RedNode[] {
  if (node.kind === 'text') {
    out.push(node)
    return out
  }
  const titles = node.metadata?.titleNodes as RedNode[] | undefined
  if (titles) for (const t of titles) textLeaves(t, out)
  for (const child of node.children) textLeaves(child, out)
  return out
}

function domTexts(scope: Node): Text[] {
  const out: Text[] = []
  const doc = scope.ownerDocument ?? (scope as Document)
  const walker = doc.createTreeWalker(scope, 4 /* SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** How far ahead a DOM text may look for its leaf past leaves it could not match. */
const LOOKAHEAD = 4

/** DOM text node → the text leaf it renders, for every text that pairs. */
function pair(scope: Node, node: RedNode): Map<Text, RedNode> {
  const leaves = textLeaves(node)
  const pairs = new Map<Text, RedNode>()
  let j = 0
  for (const t of domTexts(scope)) {
    const text = (t.nodeValue ?? '').replace(ZWSP, '')
    if (text === '') continue
    for (let k = j; k < leaves.length && k <= j + LOOKAHEAD; k++) {
      if (leaves[k].text === text) {
        pairs.set(t, leaves[k])
        j = k + 1
        break
      }
    }
  }
  return pairs
}

/** The element with an id nearest `from` inside `container`, and its node. */
function scopeOf(root: RedNode, container: HTMLElement, from: Node): { el: Node; node: RedNode } {
  let el: Element | null = from.nodeType === 1 ? (from as Element) : from.parentElement
  while (el && el !== container && container.contains(el)) {
    const id = el.getAttribute('data-node-id')
    const node = id ? root.findById(id as NodeId) : null
    if (node) return { el, node }
    el = el.parentElement
  }
  return { el: container, node: root }
}

/** Characters of `value` before `offset`, zero-width spaces not counted. */
function visibleBefore(value: string, offset: number): number {
  return value.slice(0, offset).replace(ZWSP, '').length
}

/**
 * The source offset of a DOM point in a canvas painted from `root`, or null
 * when the point is outside the canvas.
 */
export function sourceOffsetOfDomPoint(root: RedNode, container: HTMLElement, node: Node, offset: number): number | null {
  if (node !== container && !container.contains(node)) return null

  // An element boundary: the text right after it, or the end of the text before.
  let text: Text | null = null
  let at = 0
  if (node.nodeType === 3) {
    text = node as Text
    at = offset
  } else {
    const all = domTexts(container)
    const boundary = node.childNodes[offset] ?? null
    if (boundary) {
      text = all.find(t => boundary === t || boundary.contains(t) || (boundary.compareDocumentPosition(t) & 4) !== 0) ?? null
      at = 0
    }
    if (!text) {
      const before = all.filter(t => (node.compareDocumentPosition(t) & 16) !== 0 || (node.compareDocumentPosition(t) & 2) !== 0)
      text = before[before.length - 1] ?? null
      at = text?.nodeValue?.length ?? 0
    }
    if (!text) return root.range.start
  }

  const { el, node: scope } = scopeOf(root, container, text)
  const pairs = pair(el, scope)
  const leaf = pairs.get(text)
  if (leaf) {
    const width = leaf.range.end - leaf.range.start
    return leaf.range.start + Math.min(width, visibleBefore(text.nodeValue ?? '', at))
  }

  // Made-up text: the nearest paired text before it, else after it.
  const texts = domTexts(el)
  const i = texts.indexOf(text)
  for (let k = i - 1; k >= 0; k--) {
    const l = pairs.get(texts[k])
    if (l) return l.range.end
  }
  for (let k = i + 1; k < texts.length; k++) {
    const l = pairs.get(texts[k])
    if (l) return l.range.start
  }
  return scope.parent ? scope.innerStart : scope.range.start
}

/** The text leaf holding `offset`, else the next one after it, else the last one before it. */
function leafFor(root: RedNode, offset: number): RedNode | null {
  let endingHere: RedNode | null = null
  let last: RedNode | null = null
  for (const leaf of textLeaves(root)) {
    const { start, end } = leaf.range
    if (start <= offset && offset < end) return leaf
    if (end === offset) endingHere = leaf
    else if (start > offset) return endingHere ?? leaf
    last = leaf
  }
  return endingHere ?? last
}

/**
 * The DOM point of a source offset in a canvas painted from `root`, or null
 * when the canvas has no text to put it in.
 */
export function domPointOfSourceOffset(root: RedNode, container: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const leaf = leafFor(root, offset)
  if (!leaf) return null

  let el: Node = container
  let scope: RedNode = root
  for (let n: RedNode | null = leaf.parent; n && n.parent; n = n.parent) {
    const found = container.querySelector(`[data-node-id="${n.id}"]`)
    if (found) {
      el = found
      scope = n
      break
    }
  }
  for (const [text, l] of pair(el, scope)) {
    if (l !== leaf) continue
    const within = Math.max(0, Math.min(offset, leaf.range.end) - leaf.range.start)
    // Back from visible characters to a DOM offset, stepping over zero-width spaces.
    const value = text.nodeValue ?? ''
    let seen = 0
    let i = 0
    while (i < value.length && seen < within) {
      if (value[i] !== '​') seen++
      i++
    }
    return { node: text, offset: i }
  }
  return null
}
