/**
 * Lines — what "the line the caret is on" means, derived from the tree.
 *
 * At the root of a document the parser groups inline content into `paragraph`
 * nodes, so a line there is a node. Inside a container it is not: the body of
 * `[box]una\notra [b]x[/b][/box]` is `text, spacing, text, bold` — the tree is
 * faithful to the source, and BBCode has no syntax for a paragraph. A line is
 * a presentation concept, and this is where it is defined: a maximal run of
 * inline children of a line-bearing container, between two breaks (a newline,
 * an empty line, or a block child).
 *
 * Derived, not stored, on purpose — the Roslyn split: the syntax tree stays
 * the source's shape, and meaning built on top of it lives beside it. Growing
 * paragraphs inside every container would have changed the tree that the
 * incremental parser, the exporters and the osu! newline rules all read.
 *
 * Consumers: the HTML renderer wraps each line in an element carrying its id,
 * and the editor resolves a caret or a click to a line through the same
 * functions, so both sides agree on where one ends.
 *
 * ─── Identity ───────────────────────────────────────────────────────────
 *
 * A line is named after its first node: `line:<id of the first child>`. Node
 * ids are kept across edits (`preserveNodeIds`, red-tree reuse), so typing in
 * a line leaves its id — and the attribute the preview carries — unchanged,
 * which is what lets the DOM morpher skip it. A line whose first node goes
 * away is a different line, and resolving its old id answers null.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeId, NodeKind } from '../Types/core'
import { isBlockKind } from '../BBCode/BBCodeToGreenNode'

/** Prefix of a line's id. Node ids never contain `:`. */
export const LINE_ID_PREFIX = 'line:'

/**
 * Containers whose children flow as text, and so have lines.
 *
 * Not the root (it has `paragraph` nodes), not `paragraph` or `heading` (each
 * is one line already), not containers of structure (`list` holds items,
 * `tables` rows, `columns` and `gallery` cells, `imagemap` hotspots), and not
 * raw ones (`code`).
 */
const LINE_CONTAINERS: ReadonlySet<string> = new Set([
  'box', 'boxw', 'spoilerbox', 'notice', 'wnotice', 'quote', 'list_item',
  'center', 'left', 'right', 'align', 'scroll', 'container',
])

/** Children that end a line rather than belong to one. */
export function breaksLine(kind: string): boolean {
  return isBlockKind(kind as NodeKind) || kind === 'box_tail'
}

/** A line inside `container`: its children `[from, to)` and their span. */
export interface TextLine {
  readonly id: string
  readonly container: RedNode
  readonly from: number
  readonly to: number
  readonly start: number
  readonly end: number
}

/** Whether `kind` is a container whose content is split into lines. */
export function hasLines(kind: string): boolean {
  return LINE_CONTAINERS.has(kind)
}

export function isLineId(id: string): boolean {
  return id.startsWith(LINE_ID_PREFIX)
}

/** The line of `container` that begins at child `from` (which must not break a line). */
function lineAt(container: RedNode, from: number): TextLine {
  const children = container.children
  let to = from
  while (to < children.length && !breaksLine(children[to].kind)) to++
  return {
    id: LINE_ID_PREFIX + children[from].id,
    container,
    from,
    to,
    start: children[from].range.start,
    end: children[to - 1].range.end,
  }
}

/** Every line of `container`, in order. Empty when it has no lines. */
export function linesOf(container: RedNode): TextLine[] {
  if (!hasLines(container.kind)) return []
  const lines: TextLine[] = []
  const children = container.children
  let i = 0
  while (i < children.length) {
    if (breaksLine(children[i].kind)) {
      i++
      continue
    }
    const line = lineAt(container, i)
    lines.push(line)
    i = line.to
  }
  return lines
}

/**
 * The line `node` belongs to, or null when it is in none: at the root (where
 * the line is the `paragraph` node itself), inside a container without lines,
 * or a node that is itself a break or a block.
 *
 * Climbs through inline ancestors, so a text leaf inside `[b]` inside a box
 * belongs to the box's line that holds the `[b]`.
 */
export function lineOf(node: RedNode): TextLine | null {
  let child: RedNode = node
  let parent = node.parent
  while (parent !== null && !hasLines(parent.kind)) {
    if (breaksLine(parent.kind)) return null
    child = parent
    parent = parent.parent
  }
  if (parent === null || breaksLine(child.kind)) return null
  const children = parent.children
  let from = child.index
  while (from > 0 && !breaksLine(children[from - 1].kind)) from--
  return lineAt(parent, from)
}

/**
 * The line a `line:` id names in `root`, or null when that id is not a line
 * id, its first node is gone, or that node no longer begins a line.
 */
export function resolveLineId(root: RedNode, id: string): TextLine | null {
  if (!isLineId(id)) return null
  const first = root.findById(id.slice(LINE_ID_PREFIX.length) as NodeId)
  const container = first?.parent
  if (!first || !container || !hasLines(container.kind) || breaksLine(first.kind)) return null
  const index = first.index
  if (index > 0 && !breaksLine(container.children[index - 1].kind)) return null
  return lineAt(container, index)
}
