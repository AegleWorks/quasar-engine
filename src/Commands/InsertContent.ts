/**
 * Pasting and inserting as a text edit — where the content goes, decided on
 * the tree and never on the DOM.
 *
 * The canvas used to put the rendered HTML of a paste (or of a toolbar block)
 * into the DOM and let the reconciler work out what it was. Markup with no
 * node ids behind it is exactly what the reconciler cannot pair, so pasting a
 * `[notice]` or inserting a box re-serialised the WHOLE document from HTML —
 * the author's style elsewhere lost with it, and in a shared document a
 * collaborator's concurrent typing overwritten.
 *
 * ─── Where it goes ─────────────────────────────────────────────────────────
 *
 * Where the caret is. The caret is the author's intent: in the middle of a
 * paragraph the content goes in the middle of that paragraph, inside a box it
 * goes inside the box. Only when that place cannot sensibly hold the content
 * does it move, to the nearest place that can:
 *
 *   | caret in                          | inline content | block content                                  |
 *   |-----------------------------------|----------------|------------------------------------------------|
 *   | text, a box, a notice, a list…    | at the caret   | at the caret                                   |
 *   | `[b]`, `[i]`, `[color]`, `[url]`… | at the caret   | end of the line, outside every inline tag      |
 *   | a `[heading]`                     | at the caret   | right after the heading                        |
 *   | a box's heading (`[box=…]`)       | at the caret   | first line of that box's content               |
 *   | `[code]`                          | literally, at the caret, whatever it is             |
 *
 * osu! would accept a box inside a `[b]` (it all turns bold) and even a
 * `[notice]` inside a box's heading (it paints inside the clickable title) —
 * both checked on osu! itself. Moving the block out is a choice of style, not
 * a correction: nobody pastes a notice meaning "and put it in the title".
 * Written by hand in the source, those forms stay exactly as written.
 *
 * A selection is replaced: deleted first (`deleteSelection`, so no tag it cut
 * is left orphaned), then the content goes where that leaves the caret.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import type { TextChange } from '../Incremental/ChangeTracker'
import type { FormatEdit, SourceSelection } from './InlineFormat'
import { isBlockKind } from '../BBCode/BBCodeToGreenNode'
import { deleteSelection } from './StructuralEdits'

/** Parses a source the way the document is parsed (its dialect, its pairing). */
export type ParseSource = (source: string) => RedNode

/** Block kinds that are only layout: content made of these alone is inline. */
const LAYOUT: ReadonlySet<string> = new Set(['document', 'paragraph', 'spacing', 'empty_line'])

/** Kinds whose content is raw text: anything pasted there is literal. */
const RAW: ReadonlySet<string> = new Set(['code', 'inline_code'])

/** Whether `content`, once parsed, holds a block — a box, a notice, a list… */
export function isBlockContent(content: string, parse: ParseSource): boolean {
  const walk = (n: RedNode): boolean =>
    (!LAYOUT.has(n.kind) && isBlockKind(n.kind as NodeKind)) || n.children.some(walk)
  return walk(parse(content))
}

function hasTags(n: RedNode): boolean {
  return n.parent !== null && n.range.start < n.innerStart
}

/** The deepest node around `at`, preferring the one that contains it over the one it ends. */
function nodeAround(root: RedNode, at: number): RedNode {
  return root.findNodeAtOffset(at) ?? root
}

/**
 * Where block content lands for a caret at `at`, by the table above. Null
 * means "at the caret".
 */
function blockTarget(root: RedNode, source: string, at: number): { at: number; before: string; after: string } | null {
  // A box heading: the caret sits inside the opener, `[box=Mi Ca|ja]`.
  for (let n: RedNode | null = nodeAround(root, at); n; n = n.parent) {
    if (!hasTags(n) || at <= n.range.start || at >= n.innerStart) continue
    // Into the first line of its content, after the author's `[box=…]⏎`.
    const edge = source[n.innerStart] === '\n' ? 1 : 0
    const into = n.innerStart + edge
    return { at: into, before: edge ? '' : '\n', after: source[into] === '\n' ? '' : '\n' }
  }

  // Outside every inline tag and every one-line block, to the end of the line.
  let escape: RedNode | null = null
  for (let n: RedNode | null = nodeAround(root, at); n && n.parent; n = n.parent) {
    if (!hasTags(n) || at < n.innerStart || at > n.innerEnd) continue
    if (n.kind === 'heading') {
      escape = n
      break
    }
    if (isBlockKind(n.kind as NodeKind)) break
    escape = n
  }
  if (!escape) return null
  if (escape.kind === 'heading') return { at: escape.range.end, before: '', after: '' }

  // The line goes on past the outermost inline tag until a break or a block.
  const siblings = escape.parent!.children
  let end = escape.range.end
  for (let i = escape.index + 1; i < siblings.length; i++) {
    const k = siblings[i].kind
    if (k === 'spacing' || k === 'empty_line' || isBlockKind(k as NodeKind)) break
    end = siblings[i].range.end
  }
  return { at: end, before: '', after: '' }
}

function inRaw(root: RedNode, at: number): boolean {
  for (let n: RedNode | null = nodeAround(root, at); n; n = n.parent) {
    if (RAW.has(n.kind) && at >= n.innerStart && at <= n.innerEnd) return true
  }
  return false
}

/** The one change that turns `a` into `b`: their common prefix and suffix kept. */
function difference(a: string, b: string): TextChange {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  return { start: s, end: ea, text: b.slice(s, eb) }
}

/**
 * Inserts `content` (BBCode, or plain text) at the selection, by the rules
 * above. `parse` reads a source the way the document is read — its dialect
 * and pairing decide what a block is and where a tag ends.
 */
export function insertContent(
  root: RedNode,
  source: string,
  selection: SourceSelection,
  content: string,
  parse: ParseSource,
): FormatEdit | null {
  if (content === '') return selection.start === selection.end ? null : deleteSelection(root, source, selection)

  // A range is replaced: delete it (keeping the tags it cuts), then insert
  // where that leaves the caret — decided on the tree AFTER the deletion.
  if (selection.start !== selection.end) {
    const del = deleteSelection(root, source, selection)
    if (!del) return null
    let cleared = source
    for (let i = del.changes.length - 1; i >= 0; i--) {
      const c = del.changes[i]
      cleared = cleared.slice(0, c.start) + c.text + cleared.slice(c.end)
    }
    // Everything deleted — select-all and type — leaves nothing to decide on.
    const then = cleared === ''
      ? { changes: [{ start: 0, end: 0, text: content }], selection: { start: content.length, end: content.length }, action: 'insert' as const }
      : insertContent(parse(cleared), cleared, del.selection, content, parse)
    if (!then) return null
    let final = cleared
    for (let i = then.changes.length - 1; i >= 0; i--) {
      const c = then.changes[i]
      final = final.slice(0, c.start) + c.text + final.slice(c.end)
    }
    // One change against the ORIGINAL source: what an editor and a
    // collaborator receive is a single replacement, not two steps to replay.
    return { changes: [difference(source, final)], selection: then.selection, action: 'insert' }
  }

  const at = selection.start
  let place = { at, before: '', after: '' }
  if (!inRaw(root, at) && isBlockContent(content, parse)) place = blockTarget(root, source, at) ?? place

  const text = place.before + content + place.after
  const caret = place.at + place.before.length + content.length
  return { changes: [{ start: place.at, end: place.at, text }], selection: { start: caret, end: caret }, action: 'insert' }
}
