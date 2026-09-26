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
import { SWALLOWED_NEWLINE_ATTR } from '../Visitors/domMarkers'

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
  if (node.nodeType === 1) {
    const structural = structuralOffset(root, container, node as Element, offset)
    if (structural !== null) return structural
  }
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

  // A heading painted from the opener's attribute — `[box=Mi Caja]` — is text
  // of the source, just not a leaf: it lives in the tag. `node.text` is that
  // attribute, `=` included, ending right before the opener's `]`.
  const value = (text.nodeValue ?? '').replace(ZWSP, '')
  const attr = scope.parent && scope.range.start < scope.innerStart ? scope.text : ''
  const inAttr = value.trim() !== '' ? attr.indexOf(value) : -1
  if (inAttr > 0) return scope.innerStart - 1 - attr.length + inAttr + visibleBefore(text.nodeValue ?? '', at)

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

const isBreak = (n: RedNode | null) => n !== null && (n.kind === 'spacing' || n.kind === 'empty_line')

/**
 * A caret where there is no text to pair: right before a rendered line break,
 * or inside an element that holds none — an empty line, a list item just
 * created by Enter. Null when the point is ordinary.
 */
function structuralOffset(root: RedNode, container: HTMLElement, el: Element, offset: number): number | null {
  // A line opened after a `<br>` (`revealLine`) sits at that break's end.
  const after = el.closest(`[${REVEALED_AFTER_ATTR}]`)?.getAttribute(REVEALED_AFTER_ATTR)
  const br = after ? root.findById(after as NodeId) : null
  if (br && (el.textContent ?? '').replace(ZWSP, '').trim() === '') return br.range.end
  const boundary = el.childNodes[offset]
  if (boundary && boundary.nodeType === 1) {
    const id = (boundary as Element).getAttribute('data-node-id')
    const n = id ? root.findById(id as NodeId) : null
    if (isBreak(n)) return n!.range.start
  }
  if ((el.textContent ?? '').replace(ZWSP, '').trim() !== '') return null
  const { node: scope } = scopeOf(root, container, el)
  if (!scope.parent || textLeaves(scope).length > 0) return null
  if (!isBreak(scope)) return scope.innerStart
  // A line `revealLine` opened after its break sits at the break's end.
  return el.closest(`[${REVEALED_LINE_ATTR}]`)?.getAttribute(REVEALED_LINE_ATTR) === 'end' ? scope.range.end : scope.range.start
}

/**
 * The text leaf whose span holds `offset`, edges included — preferring the one
 * that starts there. Down the tree (`findNodeAtOffset`), not across every
 * leaf: on the 547 KB fixture the walk was most of placing a caret.
 */
function leafHolding(root: RedNode, offset: number): RedNode | null {
  const here = root.findNodeAtOffset(offset)
  if (here && here.kind === 'text' && here.range.start <= offset && offset < here.range.end) return here
  const before = offset > 0 ? root.findNodeAtOffset(offset - 1) : null
  if (before && before.kind === 'text' && before.range.end === offset) return before
  return null
}

/** Where a caret goes in a break's element: inside an empty line, before a `<br>`, on a marker. */
function pointIn(el: Element): { node: Node; offset: number } {
  // A break rendered as `<br>` holds no caret: stand right before it.
  if (el.tagName === 'BR' && el.parentNode) {
    return { node: el.parentNode, offset: Array.prototype.indexOf.call(el.parentNode.childNodes, el) }
  }
  return { node: el, offset: 0 }
}

/**
 * The DOM point of an offset no text leaf holds: on an empty line, in an empty
 * list item, between two rendered breaks.
 */
function structuralPoint(root: RedNode, container: HTMLElement, offset: number): { node: Node; offset: number } | null {
  // The line a caret starts is named by a break: the one starting at the
  // caret, or — at the end of a box or of the document, where the one after
  // it may not be rendered at all — the one ending there.
  const here = root.findNodeAtOffset(offset)
  const before = offset > 0 ? root.findNodeAtOffset(offset - 1) : null
  for (const n of [here, before]) {
    if (!isBreak(n) || (n === here && n!.range.start !== offset) || (n === before && n!.range.end !== offset)) continue
    const el = container.querySelector(`[data-node-id="${n!.id}"]`)
    if (!el) continue
    // A marker in an element with nothing else to show — an empty list item —
    // leaves the caret to that element, which holds one on its own.
    const host = el.parentElement
    if (el.hasAttribute(SWALLOWED_NEWLINE_ATTR) && host && host !== container && (host.textContent ?? '').replace(ZWSP, '').trim() === '') {
      return { node: host, offset: Array.prototype.indexOf.call(host.childNodes, el) }
    }
    return pointIn(el)
  }
  for (let n: RedNode | null = here; n && n.parent; n = n.parent) {
    const el = container.querySelector(`[data-node-id="${n.id}"]`)
    if (el) return pointIn(el)
  }
  return null
}

/** Whether anything visible follows `br` in its block — then the line after it shows on its own. */
function hasLineAfter(br: Element): boolean {
  for (let n = br.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 3 && (n.nodeValue ?? '').trim() !== '') return true
    if (n.nodeType === 1 && !(n as Element).hasAttribute(SWALLOWED_NEWLINE_ATTR)) return true
  }
  return false
}

/** Marks a line `revealLine` made editable, and on which side of its break typing goes. */
export const REVEALED_LINE_ATTR = 'data-bb-at'
/** A line `revealLine` opened after a `<br>`: the id of that break, whose end is where typing goes. */
export const REVEALED_AFTER_ATTR = 'data-bb-after'

/**
 * Makes the line at `offset` editable when it has no layout of its own.
 *
 * A newline the renderer swallows — the last lines of a box, the end of the
 * document — paints as a hidden marker, and a hidden element holds no caret:
 * after Enter there, typing landed on the next line that had one, outside the
 * box. The marker becomes an empty line carrying the same node id and the side
 * of that break the caret is on (`start`: typing goes before its `\n`; `end`:
 * after it), which is all the reconciler needs to insert what is typed there
 * at exactly that offset. Only the canvas changes; the source already has the
 * line.
 *
 * Returns the point to put the caret at, or null when `point` is not on a marker.
 */
export function revealLine(root: RedNode, point: { node: Node; offset: number }, offset: number): { node: Node; offset: number } | null {
  // After a trailing `<br>` — the end of the document — the line exists in the
  // source but a last `<br>` makes none in HTML: open one right after it.
  const beforeBr = point.node.childNodes[point.offset] as Element | undefined
  if (beforeBr && beforeBr.nodeType === 1 && beforeBr.tagName === 'BR') {
    const id = beforeBr.getAttribute('data-node-id')
    const brNode = id ? root.findById(id as NodeId) : null
    if (brNode && brNode.range.end === offset && !hasLineAfter(beforeBr)) {
      const line = beforeBr.ownerDocument.createElement('div')
      line.className = 'bb-empty-line'
      line.setAttribute(REVEALED_AFTER_ATTR, id!)
      line.appendChild(beforeBr.ownerDocument.createElement('br'))
      beforeBr.after(line)
      return { node: line, offset: 0 }
    }
  }
  const marker = point.node
  if (marker.nodeType !== 1 || !(marker as Element).hasAttribute(SWALLOWED_NEWLINE_ATTR)) return null
  const id = (marker as Element).getAttribute('data-node-id')
  const node = id ? root.findById(id as NodeId) : null
  if (!node) return null
  const line = marker.ownerDocument!.createElement('div')
  line.className = 'bb-empty-line'
  line.setAttribute('data-node-id', id!)
  line.setAttribute(REVEALED_LINE_ATTR, offset === node.range.start ? 'start' : 'end')
  line.appendChild(marker.ownerDocument!.createElement('br'))
  marker.parentNode!.replaceChild(line, marker)
  return { node: line, offset: 0 }
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
export function domPointOfSourceOffset(root: RedNode, container: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const holding = leafHolding(root, offset)
  if (!holding) {
    const point = structuralPoint(root, container, offset)
    if (point) return point
  }
  const leaf = holding ?? leafFor(root, offset)
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
