/**
 * Alignment as a TOGGLE — `[centre]`, `[left]`, `[right]` and `[align=…]` are
 * one family, and the three buttons are one choice, not three wrappers.
 *
 * The bug this removes: Centre inside a `[centre]` produced
 * `[centre][centre]…[/centre][/centre]`, and Centre then Right produced
 * `[centre][right]…[/right][/centre]` — the inner tag wins, so the page did
 * not even move. The answer is a state: same family → take it off, another
 * family → rename it in place, none → wrap the selection.
 *
 * ─── Own vs inherited ──────────────────────────────────────────────────────
 *
 * A `[centre]` can belong to the node (it wraps just that line) or to a
 * bigger section (it wraps several lines/blocks and the node lives inside).
 * Removing a section's tag because a line was clicked would move the whole
 * page, so that one is INHERITED and does not count as the node's state:
 * the button is not marked, re-applying the same alignment is a no-op, and
 * choosing a different one wraps the node locally.
 *
 * «Own» means one of:
 *  - the selection covers the whole content of the tag (select a section to
 *    unalign it), or
 *  - the tag has a single content child and the selection is inside it.
 *
 * `spacing`/`empty_line` are layout, not content: a newline at the edge of
 * `[centre]` does not make it somebody else's.
 *
 * It works on the TREE, not on the text, because «already centred» is an
 * ANCESTOR question: the node under the cursor is usually not the `[centre]`,
 * its container is. Only `[align=…]` carries the value in an attribute; the
 * rest are kinds of their own.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { TextChange } from '../Incremental/ChangeTracker'

export type Alignment = 'left' | 'centre' | 'right'

/** The kind → alignment map. `center` is the deprecated alias of `centre`. */
const KIND_ALIGNMENT: Readonly<Record<string, Alignment>> = {
  center: 'centre',
  left: 'left',
  right: 'right',
}

/** Children that separate content without being another aligned node. */
const LAYOUT_KINDS = new Set(['spacing', 'empty_line', 'box_tail'])

/** What alignment this node IS, or null when it is not an alignment node. */
export function alignmentOf(node: RedNode): Alignment | null {
  if (node.kind === 'align') {
    const value = String(node.metadata?.align ?? '').toLowerCase()
    return value === 'left' || value === 'right' ? value : 'centre'
  }
  return KIND_ALIGNMENT[node.kind] ?? null
}

function contentChildren(host: RedNode): RedNode[] {
  return host.children.filter((child) => !LAYOUT_KINDS.has(child.kind))
}

/**
 * Whether `host` is the OWN alignment of `[start, end]`, and not the one of a
 * larger section. A `[centre]` with two lines is the section's, even when the
 * selection sits in the first: stripping it would move the second as well.
 */
function owns(host: RedNode, start: number, end: number): boolean {
  const content = contentChildren(host)
  if (content.length === 0) return false
  // Selecting the whole content of the tag makes it the selection's.
  const first = content[0].range.start
  const last = content[content.length - 1].range.end
  if (start <= first && last <= end) return true
  // Or the tag wraps a single child, and the selection is inside it.
  return content.length === 1 && content[0].range.start <= start && end <= content[0].range.end
}

/** The alignment ANY ancestor imposes at `offset`, own or inherited. */
function inheritedAlignmentAt(root: RedNode | null, offset: number): Alignment | null {
  if (!root) return null
  for (let node: RedNode | null = root.findNodeAtOffset(offset); node && node.parent; node = node.parent) {
    const alignment = alignmentOf(node)
    if (alignment) return alignment
  }
  return null
}

/**
 * The alignment that belongs to `[start, end]` — not one inherited from a
 * container that wraps other nodes too. This is what the toolbar marks.
 */
export function alignmentAt(root: RedNode | null, start: number, end = start): Alignment | null {
  if (!root) return null
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  for (let node: RedNode | null = root.findNodeAtOffset(from); node && node.parent; node = node.parent) {
    const alignment = alignmentOf(node)
    if (alignment && owns(node, from, to)) return alignment
  }
  return null
}

/** Removes the tags of `node`, keeping its content. */
function strip(node: RedNode): TextChange[] {
  return [
    { start: node.range.start, end: node.innerStart, text: '' },
    { start: node.innerEnd, end: node.range.end, text: '' },
  ]
}

/** Writes `tag` over the tags of `node`, keeping everything inside them. */
function rename(node: RedNode, tag: Alignment): TextChange[] {
  if (node.kind === 'align') {
    return [{ start: node.range.start, end: node.innerStart, text: `[align=${tag === 'centre' ? 'center' : tag}]` }]
  }
  return [
    { start: node.range.start, end: node.innerStart, text: `[${tag}]` },
    { start: node.innerEnd, end: node.range.end, text: `[/${tag}]` },
  ]
}

/** The hosts that are not inside another host (a `[centre]` in a `[centre]`). */
function outermost(hosts: readonly RedNode[]): RedNode[] {
  return hosts.filter((host) => !hosts.some((other) =>
    other !== host && other.range.start <= host.range.start && other.range.end >= host.range.end))
}

/**
 * Centre/left/right ON the selection, or OFF it when it already has that
 * alignment; another alignment is renamed in place, never nested.
 *
 * Only an OWN tag is toggled. When the alignment comes from a section that
 * wraps several nodes, the same alignment is a no-op (the node already looks
 * like that) and another one wraps the selection locally — the section's tag
 * is never removed from one of its lines.
 *
 * A collapsed selection has no text to align and answers null. With no tree
 * (Aporhelion runs the document) it degrades to a plain wrap.
 */
export function toggleAlignment(
  root: RedNode | null,
  selection: { start: number; end: number },
  tag: Alignment,
): { changes: TextChange[] } | null {
  const start = Math.min(selection.start, selection.end)
  const end = Math.max(selection.start, selection.end)
  if (end <= start) return null

  const hosts: RedNode[] = []
  if (root) {
    for (const offset of [start, end]) {
      for (let node: RedNode | null = root.findNodeAtOffset(offset); node && node.parent; node = node.parent) {
        const alignment = alignmentOf(node)
        if (!alignment) continue
        if (owns(node, start, end) && !hosts.includes(node)) hosts.push(node)
        break
      }
    }
  }

  if (hosts.length > 0) {
    const changes: TextChange[] = []
    for (const host of outermost(hosts)) {
      const current = alignmentOf(host)!
      changes.push(...(current === tag ? strip(host) : rename(host, tag)))
    }
    return { changes }
  }

  // Etiqueta heredada con la misma alineación: el nodo ya se ve así. Envolverlo
  // otra vez solo anidaría etiquetas sin cambiar nada.
  if (inheritedAlignmentAt(root, start) === tag) return { changes: [] }

  return {
    changes: [
      { start, end: start, text: `[${tag}]` },
      { start: end, end, text: `[/${tag}]` },
    ],
  }
}
