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
 * paired with the node's text leaves in document order, by equal text — or,
 * for a leaf an effect paints a letter at a time, by a run of text nodes that
 * add up to it. DOM text that pairs with nothing is text the renderer made
 * up — a `[quote]` author line, a box heading, a newline — and a point in it
 * resolves to the nearest paired neighbour, which is where a caret there
 * belongs anyway.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeId } from '../Types/core'
import { SWALLOWED_NEWLINE_ATTR, TERMINAL_LINE_ATTR } from '../Visitors/domMarkers'

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

/** The leaf a DOM text renders, and how many of the leaf's characters come before it. */
interface Piece {
  leaf: RedNode
  from: number
}

const visible = (t: Text) => (t.nodeValue ?? '').replace(ZWSP, '')

/**
 * The texts from `i` on that add up to exactly `want`, each with where it
 * starts in it; null when they do not. An effect that paints each letter its
 * own colour renders ONE leaf as one text node per letter.
 */
function splitRun(texts: Text[], i: number, want: string): Text[] | null {
  const run: Text[] = []
  let have = 0
  for (let m = i; m < texts.length && have < want.length; m++) {
    const v = visible(texts[m])
    if (!want.startsWith(v, have)) return null
    run.push(texts[m])
    have += v.length
  }
  return have === want.length && run.length > 1 ? run : null
}

/** DOM text node → the piece of the text leaf it renders, for every text that pairs. */
function pair(scope: Node, node: RedNode): Map<Text, Piece> {
  const leaves = textLeaves(node)
  const texts = domTexts(scope)
  const pairs = new Map<Text, Piece>()
  let j = 0
  for (let i = 0; i < texts.length; i++) {
    const text = visible(texts[i])
    if (text === '') continue
    for (let k = j; k < leaves.length && k <= j + LOOKAHEAD; k++) {
      if (leaves[k].text === text) {
        pairs.set(texts[i], { leaf: leaves[k], from: 0 })
        j = k + 1
        break
      }
      const run = splitRun(texts, i, leaves[k].text)
      if (run) {
        let from = 0
        for (const t of run) {
          pairs.set(t, { leaf: leaves[k], from })
          from += visible(t).length
        }
        i += run.length - 1
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
  return locate(root, container, node, offset)?.offset ?? null
}

/**
 * The same offset, only when text typed there would land exactly at that point
 * of the source. Null on text the source does not spell out at that spot: a
 * title held in a tag's attribute, a box's default heading, a quote's author
 * line. Those are edited through the DOM.
 */
export function exactSourceOffset(root: RedNode, container: HTMLElement, node: Node, offset: number): number | null {
  const found = locate(root, container, node, offset)
  return found?.exact ? found.offset : null
}

function locate(root: RedNode, container: HTMLElement, node: Node, offset: number): { offset: number; exact: boolean } | null {
  if (node !== container && !container.contains(node)) return null

  // An element boundary: the text right after it, or the end of the text before.
  let text: Text | null = null
  let at = 0
  if (node.nodeType === 1) {
    const structural = structuralOffset(root, container, node as Element, offset)
    if (structural !== null) return { offset: structural, exact: true }
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
    if (!text) return { offset: root.range.start, exact: true }
  }

  const { el, node: scope } = scopeOf(root, container, text)
  const pairs = pair(el, scope)
  const piece = pairs.get(text)
  if (piece) {
    const { leaf, from } = piece
    const width = leaf.range.end - leaf.range.start
    return { offset: leaf.range.start + Math.min(width, from + visibleBefore(text.nodeValue ?? '', at)), exact: true }
  }

  // A heading painted from the opener's attribute — `[box=Mi Caja]` — is text
  // of the source, just not a leaf: it lives in the tag. `node.text` is that
  // attribute, `=` included, ending right before the opener's `]`.
  const value = (text.nodeValue ?? '').replace(ZWSP, '')
  const attr = scope.parent && scope.range.start < scope.innerStart ? scope.text : ''
  const inAttr = value.trim() !== '' ? attr.indexOf(value) : -1
  if (inAttr > 0) return { offset: scope.innerStart - 1 - attr.length + inAttr + visibleBefore(text.nodeValue ?? '', at), exact: false }

  // Made-up text: the nearest paired text before it, else after it.
  const texts = domTexts(el)
  const i = texts.indexOf(text)
  for (let k = i - 1; k >= 0; k--) {
    const l = pairs.get(texts[k])?.leaf
    if (l) return { offset: l.range.end, exact: false }
  }
  for (let k = i + 1; k < texts.length; k++) {
    const l = pairs.get(texts[k])?.leaf
    if (l) return { offset: l.range.start, exact: false }
  }
  return { offset: scope.parent ? scope.innerStart : scope.range.start, exact: false }
}

const isBreak = (n: RedNode | null) => n !== null && (n.kind === 'spacing' || n.kind === 'empty_line')

/**
 * The `<br>` holding the line after raw text's last newline. That newline is in
 * the text, where no line follows it, so a caret past it stands before this.
 */
function isRawTail(node: Node | null): boolean {
  return node?.nodeName === 'BR' && (node as Element).hasAttribute(TERMINAL_LINE_ATTR)
}

/**
 * A caret where there is no text to pair: right before a rendered line break,
 * or inside an element that holds none — an empty line, a list item just
 * created by Enter. Null when the point is ordinary.
 */
function structuralOffset(root: RedNode, container: HTMLElement, el: Element, offset: number): number | null {
  // A flow's last newline: before its `<br>` is the end of the line it ends, and
  // everything else is the line after it.
  const tail = el.closest(`[${TERMINAL_LINE_ATTR}]`)
  const last = tail ? root.findById(tail.getAttribute('data-node-id') as NodeId) : null
  if (tail && last && (tail.textContent ?? '').replace(ZWSP, '') === '') {
    return el === tail && offset === 0 ? last.range.start : last.range.end
  }
  const boundary = el.childNodes[offset]
  if (boundary && boundary.nodeType === 1) {
    if (isRawTail(boundary)) return scopeOf(root, container, el).node.innerEnd
    const id = (boundary as Element).getAttribute('data-node-id')
    const n = id ? root.findById(id as NodeId) : null
    if (isBreak(n)) return n!.range.start
  }
  // Past a break that ends its element, the mirror of `pointIn`.
  const passed = boundary ? null : el.childNodes[offset - 1]
  if (passed?.nodeType === 1) {
    const n = root.findById((passed as Element).getAttribute('data-node-id') as NodeId)
    if (isBreak(n)) return n!.range.end
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

/**
 * Where a caret goes in a break's element: inside an empty line, on a marker,
 * before a `<br>` (which holds no caret), or, for an offset past its newline,
 * right after the element: the start of the next line.
 */
function pointIn(el: Element, past = false): { node: Node; offset: number } {
  const index = () => Array.prototype.indexOf.call(el.parentNode!.childNodes, el)
  if (past && el.parentNode && (el.tagName === 'BR' || el.classList.contains('bb-empty-line'))) return { node: el.parentNode, offset: index() + 1 }
  if (el.tagName === 'BR' && el.parentNode) return { node: el.parentNode, offset: index() }
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
    if (el.hasAttribute(TERMINAL_LINE_ATTR)) return { node: el, offset: n!.range.end === offset ? 1 : 0 }
    // A marker in an element with nothing else to show — an empty list item —
    // leaves the caret to that element, which holds one on its own.
    const host = el.parentElement
    if (el.hasAttribute(SWALLOWED_NEWLINE_ATTR) && host && host !== container && (host.textContent ?? '').replace(ZWSP, '').trim() === '') {
      return { node: host, offset: Array.prototype.indexOf.call(host.childNodes, el) }
    }
    return pointIn(el, n!.range.end === offset)
  }
  for (let n: RedNode | null = here; n && n.parent; n = n.parent) {
    const el = container.querySelector(`[data-node-id="${n.id}"]`)
    if (el) return pointIn(el)
  }
  return null
}

/** Marks a line `revealLine` made editable, and on which side of its break typing goes. */
export const REVEALED_LINE_ATTR = 'data-bb-at'

/**
 * Makes the line at `offset` editable when a swallowed newline hides it.
 *
 * A newline the renderer swallows — the last lines of a box — paints as a hidden
 * marker, and a hidden element holds no caret: after Enter there, typing landed
 * on the next line that had one, outside the box. The marker becomes an empty
 * line carrying the same node id and the side of that break the caret is on
 * (`start`: typing goes before its `\n`; `end`: after it), and so do the swallowed
 * newlines right before it, or a second Enter would show no second line. The
 * first newline after text only ends that text's line, so it stays hidden. Only
 * the canvas changes; the source already has the lines. The next paint takes them
 * back, which keeps a box's layout newlines off the page once the caret is gone.
 *
 * Returns the point to put the caret at, or null when `point` is not on a marker.
 */
export function revealLine(root: RedNode, point: { node: Node; offset: number }, offset: number): { node: Node; offset: number } | null {
  const marker = point.node
  if (marker.nodeType !== 1 || !(marker as Element).hasAttribute(SWALLOWED_NEWLINE_ATTR)) return null
  const id = (marker as Element).getAttribute('data-node-id')
  const node = id ? root.findById(id as NodeId) : null
  if (!node) return null

  const isMarker = (n: Node | null): n is Element => n?.nodeType === 1 && (n as Element).hasAttribute(SWALLOWED_NEWLINE_ATTR)
  const run: Element[] = []
  for (let n = marker.previousSibling; isMarker(n); n = n.previousSibling) run.unshift(n)
  const ended = run[0]?.previousSibling ?? null
  if (ended && !endsLine(ended)) run.shift()
  for (const hidden of run) {
    const held = root.findById(hidden.getAttribute('data-node-id') as NodeId)
    if (held) hidden.parentNode!.replaceChild(emptyLine(hidden, 'start'), hidden)
  }

  const side = offset === node.range.start ? 'start' : 'end'
  const line = emptyLine(marker as Element, side)
  // Past a newline that is not the first of its run (a dialect drops the marker
  // after it): the line it ends and the caret's are both on screen.
  const before = marker.previousSibling
  const emptyBefore = side === 'end' && (endsLine(before) || isMarker(before))
  if (emptyBefore) line.appendChild(marker.ownerDocument!.createElement('br'))
  marker.parentNode!.replaceChild(line, marker)
  return { node: line, offset: emptyBefore ? 1 : 0 }
}

function endsLine(node: Node | null): boolean {
  return node?.nodeType === 1 && ((node as Element).tagName === 'BR' || (node as Element).classList.contains('bb-empty-line'))
}

/** An editable empty line standing for a swallowed newline. */
function emptyLine(marker: Element, side: 'start' | 'end'): Element {
  const line = marker.ownerDocument.createElement('div')
  line.className = 'bb-empty-line'
  line.setAttribute('data-node-id', marker.getAttribute('data-node-id')!)
  line.setAttribute(REVEALED_LINE_ATTR, side)
  line.appendChild(marker.ownerDocument.createElement('br'))
  return line
}

/**
 * Where `offset` falls in the document's text with its markup taken out: the
 * coordinate two sources share when only their tags differ. Newlines count, so
 * the start of a line is not the end of the one above it.
 */
export function textOffsetOfSource(root: RedNode, offset: number): number {
  let seen = 0
  for (const leaf of contentLeaves(root)) {
    const { start, end } = leaf.range
    if (offset <= start) break
    seen += Math.min(offset, end) - start
  }
  return seen
}

/**
 * The inverse of `textOffsetOfSource`. Past a newline the offset goes to what
 * follows it, inside any tag that opens the line, so it stays on that line.
 */
export function sourceOffsetOfText(root: RedNode, offset: number): number {
  let seen = 0
  let last = root.range.start
  for (const leaf of contentLeaves(root)) {
    const { start, end } = leaf.range
    const width = end - start
    if (offset < seen + width) return start + (offset - seen)
    if (offset === seen + width && leaf.kind === 'text') return end
    seen += width
    last = end
  }
  return last
}

/** The text and newline leaves under `node`, in source order. */
function contentLeaves(node: RedNode, out: RedNode[] = []): RedNode[] {
  if (node.kind === 'text' || isBreak(node)) {
    out.push(node)
    return out
  }
  for (const child of node.children) contentLeaves(child, out)
  return out
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
  for (const [text, { leaf: l, from }] of pair(el, scope)) {
    if (l !== leaf) continue
    // A leaf painted a letter at a time: the piece that holds the offset, the
    // earlier one on a seam, so typing goes on in the letter just typed.
    const within = Math.max(0, Math.min(offset, leaf.range.end) - leaf.range.start) - from
    if (within > visible(text).length) continue
    if (within === visible(text).length && isRawTail(text.nextSibling)) {
      return { node: text.parentNode!, offset: Array.prototype.indexOf.call(text.parentNode!.childNodes, text.nextSibling) }
    }
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
