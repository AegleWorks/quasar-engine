/**
 * Enter, Backspace and Delete as text edits — what line structure means in
 * BBCode, computed from the tree and never from the DOM.
 *
 * In BBCode a new line is a `\n` in the source, and that is the whole story
 * for most of the document: a paragraph, the body of a box, a notice. Left to
 * the browser, the same keystroke splits elements, clones their `data-node-id`
 * into both halves and makes the reconciler rewrite the whole document from
 * HTML (`duplicate-ids`). Here the edit is the character itself, plus the few
 * places where a line is more than a character:
 *
 *  - a list item: Enter starts the next `[*]`; on an empty last item it leaves
 *    the list instead, as every editor does;
 *  - a heading holds one line: Enter at an edge moves the break outside it,
 *    and in the middle closes it and opens it again, spelled as the author did;
 *  - the newline right after a container's opening tag (`[box=T]⏎`) or right
 *    before its closing tag is the author's layout, invisible on the canvas:
 *    Backspace and Delete leave it alone rather than eat it without a trace.
 *
 * Deleting a selection keeps every tag the selection cuts through, so a range
 * from a paragraph into `[b]Negrita[/b]` never leaves an orphan `[/b]`.
 *
 * Every command answers a `FormatEdit` (the same shape the toolbar's use), an
 * edit with NO changes when the keystroke must do nothing, or null when the
 * caller should let the browser have it.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { TextChange } from '../Incremental/ChangeTracker'
import type { FormatEdit, SourceSelection } from './InlineFormat'
import type { NodeKind } from '../Types/core'
import { isBlockKind } from '../BBCode/BBCodeToGreenNode'

/** Kinds that hold exactly one line: Enter inside them is a way out. */
const ONE_LINE: ReadonlySet<string> = new Set(['heading'])

function caret(at: number): SourceSelection {
  return { start: at, end: at }
}

/** `node` and its ancestors up to the root, nearest first. */
function* ancestors(node: RedNode | null): Generator<RedNode> {
  for (let n = node; n; n = n.parent) yield n
}

/** The deepest node whose span holds `offset`, preferring one that starts or ends there. */
function nodeAt(root: RedNode, offset: number): RedNode {
  return root.findNodeAtOffset(offset) ?? root
}

/** The list item the caret is in, if any. */
function itemAt(root: RedNode, offset: number): RedNode | null {
  // `[*]x|` sits at the item's content end, which is the start of its own `\n`.
  for (const n of ancestors(nodeAt(root, offset))) if (n.kind === 'list_item') return n
  const before = offset > 0 ? root.findNodeAtOffset(offset - 1) : null
  for (const n of ancestors(before)) if (n.kind === 'list_item') return n
  return null
}

/** Where an item's text ends: before the `\n` that closes it, if it has one. */
function itemTextEnd(item: RedNode): number {
  const last = item.children[item.children.length - 1]
  return last && last.kind === 'spacing' ? last.range.start : item.innerEnd
}

/**
 * Block containers whose edge newlines the renderers swallow: `[box=T]⏎` and
 * `⏎[/box]` are layout, not lines. Not the root (no tags), not list items
 * (their `⏎` ends the item), not inline formats (a `⏎` inside `[b]` is a line).
 */
function hasSwallowedEdges(node: RedNode): boolean {
  // Only a node with tags has edges: a root paragraph or a break has none.
  if (node.parent === null || node.range.start === node.innerStart) return false
  return node.kind !== 'list_item' && node.kind !== 'list' && isBlockKind(node.kind as NodeKind)
}

/** Whether the `\n` at `at` is a block container's own edge (right after its opener or right before its closer). */
function isEdgeNewline(root: RedNode, at: number): boolean {
  const node = root.findNodeAtOffset(at)
  if (!node || (node.kind !== 'spacing' && node.kind !== 'empty_line')) return false
  const parent = node.parent
  if (!parent || !hasSwallowedEdges(parent)) return false
  return node.range.start === parent.innerStart || node.range.end === parent.innerEnd
}

/** The block container whose content starts or ends exactly at `at`, if any. */
function blockEdgeAt(root: RedNode, at: number): RedNode | null {
  for (const n of ancestors(nodeAt(root, at))) {
    if (!hasSwallowedEdges(n)) continue
    return at === n.innerStart || at === n.innerEnd ? n : null
  }
  return null
}

/**
 * Enter at a caret.
 *
 * Null for a range (the caller deletes it first, or lets the browser do it).
 */
export function insertLineBreak(root: RedNode, source: string, selection: SourceSelection): FormatEdit | null {
  if (selection.start !== selection.end) return null
  const at = selection.start

  const item = itemAt(root, at)
  if (item && at >= item.innerStart && at <= itemTextEnd(item)) {
    const empty = source.slice(item.innerStart, itemTextEnd(item)).trim() === ''
    const list = item.parent
    const last = list && list.children.filter(c => c.kind === 'list_item').pop() === item
    if (empty && list && last) {
      // Out of the list: the empty item goes, and the caret lands on a new
      // line right after `[/list]`.
      const changes: TextChange[] = [
        { start: item.range.start, end: item.range.end, text: '' },
        { start: list.range.end, end: list.range.end, text: '\n' },
      ]
      const removed = item.range.end - item.range.start
      return { changes, selection: caret(list.range.end - removed + 1), action: 'break' }
    }
    const opener = source.slice(item.range.start, item.innerStart)
    return { changes: [{ start: at, end: at, text: `\n${opener}` }], selection: caret(at + 1 + opener.length), action: 'break' }
  }

  for (const n of ancestors(nodeAt(root, at))) {
    if (!ONE_LINE.has(n.kind)) continue
    if (at < n.innerStart || at > n.innerEnd) break
    if (at === n.innerEnd) {
      return { changes: [{ start: n.range.end, end: n.range.end, text: '\n' }], selection: caret(n.range.end + 1), action: 'break' }
    }
    if (at === n.innerStart) {
      return { changes: [{ start: n.range.start, end: n.range.start, text: '\n' }], selection: caret(n.range.start + 1 + (at - n.range.start)), action: 'break' }
    }
    const open = source.slice(n.range.start, n.innerStart)
    const close = source.slice(n.innerEnd, n.range.end)
    const text = `${close}\n${open}`
    return { changes: [{ start: at, end: at, text }], selection: caret(at + text.length), action: 'break' }
  }

  // Right at a block's edge a single `\n` would be swallowed as layout and the
  // Enter would show nothing: it takes a second one to make a line.
  const edge = blockEdgeAt(root, at)
  if (edge && !isEdgeNewline(root, at === edge.innerStart ? at : at - 1)) {
    const lands = at === edge.innerStart && at !== edge.innerEnd ? at + 2 : at + 1
    return { changes: [{ start: at, end: at, text: '\n\n' }], selection: caret(lands), action: 'break' }
  }

  return { changes: [{ start: at, end: at, text: '\n' }], selection: caret(at + 1), action: 'break' }
}

/**
 * Backspace at a caret: joins a line with the one before it.
 *
 * Null anywhere else — deleting a character is ordinary typing, which the
 * reconciler already turns into a surgical edit.
 */
export function joinBackward(root: RedNode, source: string, selection: SourceSelection): FormatEdit | null {
  if (selection.start !== selection.end) return deleteSelection(root, source, selection)
  const at = selection.start
  if (at === 0) return { changes: [], selection: caret(0), action: 'join' }

  const item = itemAt(root, at)
  if (item && at === item.innerStart) {
    const siblings = item.parent?.children.filter(c => c.kind === 'list_item') ?? []
    const index = siblings.indexOf(item)
    // The first item has nothing to join with; the browser turns it into text.
    if (index <= 0) return null
    const from = source[item.range.start - 1] === '\n' ? item.range.start - 1 : item.range.start
    return { changes: [{ start: from, end: item.innerStart, text: '' }], selection: caret(from), action: 'join' }
  }

  // Indentation before the caret is not a line's start on the canvas — spaces
  // there collapse — so the caret after `⏎␣␣` is at the start of its line.
  let line = at
  while (line > 0 && (source[line - 1] === ' ' || source[line - 1] === '\t')) line--
  if (source[line - 1] !== '\n') return null
  if (isEdgeNewline(root, line - 1)) return { changes: [], selection: caret(at), action: 'join' }
  return { changes: [{ start: line - 1, end: line, text: '' }], selection: caret(at - 1), action: 'join' }
}

/** Delete at a caret: joins a line with the one after it. The mirror of `joinBackward`. */
export function joinForward(root: RedNode, source: string, selection: SourceSelection): FormatEdit | null {
  if (selection.start !== selection.end) return deleteSelection(root, source, selection)
  const at = selection.start
  if (at >= source.length) return { changes: [], selection: caret(at), action: 'join' }

  const item = itemAt(root, at)
  if (item && at === itemTextEnd(item)) {
    const siblings = item.parent?.children.filter(c => c.kind === 'list_item') ?? []
    const next = siblings[siblings.indexOf(item) + 1]
    if (!next) return { changes: [], selection: caret(at), action: 'join' }
    return { changes: [{ start: at, end: next.innerStart, text: '' }], selection: caret(at), action: 'join' }
  }

  if (source[at] !== '\n') return null
  if (isEdgeNewline(root, at)) return { changes: [], selection: caret(at), action: 'join' }
  return { changes: [{ start: at, end: at + 1, text: '' }], selection: caret(at), action: 'join' }
}

/** Every tagged node overlapping `[s, e)`, in source order. */
function tagged(node: RedNode, s: number, e: number, out: RedNode[]): void {
  for (const child of node.children) {
    const r = child.range
    if (r.end <= s || r.start >= e) continue
    if (r.start < child.innerStart || child.innerEnd < r.end) out.push(child)
    tagged(child, s, e, out)
  }
}

/**
 * Deletes a range, keeping every tag it cuts through.
 *
 * A tag whose element lies wholly inside the range goes with it. A tag whose
 * element only starts (or ends) inside it stays, so what is left of that
 * element keeps its format: `pá«rrafo.⏎⏎[b]Neg»rita[/b]` becomes
 * `pá[b]rita[/b]`. List items are the exception — a range from one item into
 * the next joins them, so the next item's `[*]` goes too.
 */
export function deleteSelection(root: RedNode, source: string, selection: SourceSelection): FormatEdit | null {
  let s = Math.min(selection.start, selection.end)
  let e = Math.max(selection.start, selection.end)
  if (s === e) return null

  const nodes: RedNode[] = []
  tagged(root, s, e, nodes)
  // Never cut a tag in half: an edge inside one moves out of it.
  for (const n of nodes) {
    const spans = [[n.range.start, n.innerStart], [n.innerEnd, n.range.end]]
    for (const [a, b] of spans) {
      if (s > a && s < b) s = b
      if (e > a && e < b) e = a
    }
  }
  if (e <= s) return null

  const kept: { at: number; text: string }[] = []
  for (const n of nodes) {
    const inside = n.range.start >= s && n.range.end <= e
    if (inside) continue
    if (n.range.start >= s && n.innerStart <= e) {
      // Its opener is in the range, its content runs past it.
      const joinsItems = n.kind === 'list_item' && itemAt(root, s)?.parent === n.parent
      if (!joinsItems) kept.push({ at: n.range.start, text: source.slice(n.range.start, n.innerStart) })
    }
    if (n.innerEnd >= s && n.range.end <= e) kept.push({ at: n.innerEnd, text: source.slice(n.innerEnd, n.range.end) })
  }
  kept.sort((a, b) => a.at - b.at)
  // Closers first: what the range ended belongs before what it opens.
  const closers = kept.filter(k => source.startsWith('[/', k.at))
  const openers = kept.filter(k => !source.startsWith('[/', k.at))
  const text = [...closers, ...openers].map(k => k.text).join('')
  // The caret stays before the kept tags: what is typed next keeps the format
  // of where the deletion began, as document editors do.
  return { changes: [{ start: s, end: e, text }], selection: caret(s), action: 'delete' }
}
