/**
 * DocumentEngine — OsuPreviewTree
 *
 * The red tree the "Render what osu! actually shows" preview paints, kept
 * across successive full parses so an unchanged block keeps its identity.
 *
 * Why this exists: osu! pairing is document-global (lazy per tag family, block
 * tags closed by div count — see `osuPairing.ts`), so the osu tree cannot be
 * reparsed incrementally and is rebuilt from the whole source on every change.
 * Built as a fresh `BBCodeDocumentModel`, every node of that tree got a NEW id
 * from the global counter, so `BlockPatcher` matched no block and rewrote the
 * whole document: measured on the 547 KB fixture in Chromium, 157 ms of patch
 * plus 168 ms of forced layout per rebuild, on top of the 95 ms parse.
 *
 * What it does instead: the parse is still full (same lexer, same parser, same
 * options as a `BBCodeDocumentModel` built with `pairing: 'osu'`), but the red
 * tree is built with `greenToRedNodeReusing` in `structural` mode against the
 * previous one: every subtree whose green is EQUAL to the previous parse's is
 * the previous RedNode object — id, metadata and all — moved to its new offset
 * with the lazy shift. Only the blocks the edit really changed are new. That is
 * the shape `BlockPatcher`'s windowed reconcile expects (churn = the blocks
 * that are not reference-identical), so the attached change range
 * (`__changeRange`, the span between the blocks kept at both ends — see
 * `churnedSpan`) lets it patch O(edit) instead of O(document).
 *
 * The tree is equal to a full osu parse: the green is one, and the red is a
 * function of the green plus offsets (see `greenToRedNodeReusing`). Only ids
 * differ, which are never portable across parses anyway.
 *
 * Deliberately NOT done: interning greens across parses with a pool.
 * `'full'` interning would make unchanged blocks reference-equal, but it costs
 * more than the whole-tree equality walk it replaces (measured, see the design
 * note), and the pool would need a bound. The equality walk keeps nothing
 * beyond the previous tree, which the preview holds anyway.
 *
 * ⚠ Like the incremental parser's red reuse, `update` CONSUMES the previous
 * root: adopted subtrees are reparented into the new one. Hold only the root
 * the last `update` returned.
 */

import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { greenToRedNode, greenToRedNodeReusing, type BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { greenNode, type GreenNode } from '../Syntax/GreenNode'
import { spliceGreen, type SpineStep } from '../Syntax/greenEdit'
import type { RedNode } from '../Syntax/RedNode'
import type { TextChangeRange } from '../Incremental/ChangeTracker'

/**
 * Ancestor kinds whose text content participates in osu! pairing, URL/email
 * validation, or raw-block semantics — a prose edit inside one of these must
 * fall back to a full osu parse.
 */
const UNSAFE_PROSE_ANCESTORS: ReadonlySet<string> = new Set([
  'image', 'audio', 'video', 'url', 'email', 'profile', 'imagemap',
  'code', 'youtube', 'box_title', 'autolink', 'flag', 'osu_icon',
  'divider', 'composition', 'pane', 'error', 'discarded_tag',
])

/** Characters that could open/close tags, cross lines, or form/split autolinks. */
const SYNTAX_CHAR_RE = /[\[\]\r\n:.@\/\\<>(&]/

/** Existing text that may border an autolink or tag — fall back to full parse. */
const RISKY_LEAF_RE = /:\/\/|www\.|@|\[|\]/i

/**
 * O(log N) prose fast-path for `OsuPreviewTree`: when an edit only inserts or
 * deletes plain prose characters strictly inside a safe `text` leaf (no `[`,
 * `]`, newlines, or autolink delimiters added/removed, leaf stays non-empty,
 * and no ancestor validates its text), osu!'s global pairing cannot possibly
 * change anywhere in the document. Splice just the ancestor spine in O(depth)
 * and let `greenToRedNodeReusing` adopt every untouched subtree by reference.
 */
function trySpliceProseGreen(
  oldRoot: RedNode,
  oldSource: string,
  newSource: string,
): { green: GreenNode; change: TextChangeRange } | null {
  const oldLen = oldSource.length
  const newLen = newSource.length
  const minLen = Math.min(oldLen, newLen)

  // Single-span common prefix / suffix diff using 4 KB SIMD-backed slice
  // comparisons before narrowing byte-by-byte (~50x faster on 400 KB+ docs).
  const CHUNK = 4096
  let start = 0
  while (start + CHUNK <= minLen && oldSource.slice(start, start + CHUNK) === newSource.slice(start, start + CHUNK)) {
    start += CHUNK
  }
  while (start < minLen && oldSource.charCodeAt(start) === newSource.charCodeAt(start)) start++

  let suffix = 0
  const maxSuffix = minLen - start
  while (
    suffix + CHUNK <= maxSuffix &&
    oldSource.slice(oldLen - suffix - CHUNK, oldLen - suffix) === newSource.slice(newLen - suffix - CHUNK, newLen - suffix)
  ) {
    suffix += CHUNK
  }
  while (
    suffix < maxSuffix &&
    oldSource.charCodeAt(oldLen - 1 - suffix) === newSource.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++
  }

  const oldEnd = oldLen - suffix
  const newEnd = newLen - suffix
  const removed = oldSource.slice(start, oldEnd)
  const inserted = newSource.slice(start, newEnd)

  if (SYNTAX_CHAR_RE.test(removed) || SYNTAX_CHAR_RE.test(inserted)) return null

  // Descend from oldRoot to the unique leaf containing `[start, oldEnd]`.
  // Using `findChildAt` / binary search over child ranges stays O(depth * log N).
  const spine: SpineStep[] = []
  let node: RedNode = oldRoot
  let probe = start
  if (probe > 0 && probe === oldEnd && probe >= oldRoot.range.end) probe = oldRoot.range.end - 1

  while (node.children.length > 0) {
    const kids = node.children
    // Binary search for child whose range contains `probe` (or ends at `probe` for pure insertion at leaf tail).
    let lo = 0
    let hi = kids.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const c = kids[mid]
      if (probe < c.range.start) {
        hi = mid - 1
      } else if (probe > c.range.end || (probe === c.range.end && oldEnd > c.range.end)) {
        lo = mid + 1
      } else if (probe === c.range.end && mid + 1 < kids.length && kids[mid + 1].range.start === probe && oldEnd === probe) {
        // Pure insertion right on the boundary between two siblings: prefer a plain text leaf if present.
        if (c.kind === 'text') { idx = mid; break }
        lo = mid + 1
      } else {
        idx = mid
        break
      }
    }
    if (idx === -1) return null
    const child = kids[idx]
    if (start < child.range.start || oldEnd > child.range.end) return null
    if (UNSAFE_PROSE_ANCESTORS.has(child.kind)) return null
    spine.push({ node: node.green, index: idx })
    node = child
  }

  if (spine.length === 0) return null
  if (node.kind !== 'text') return null
  if (node.green.leadingWidth !== 0 || node.green.trailingWidth !== 0) return null
  if (node.text.length !== node.green.width) return null
  if (start < node.range.start || oldEnd > node.range.end) return null
  if (RISKY_LEAF_RE.test(node.text)) return null

  // Guard adjacent siblings: if the previous or next text sibling holds an
  // unclosed `[` / `]` (e.g. `[` followed by `size=150...`), editing next to
  // it could form or break a BBCode tag.
  const parentKids = spine[spine.length - 1].node.children
  const leafIdx = spine[spine.length - 1].index
  if (leafIdx > 0 && parentKids[leafIdx - 1].kind === 'text' && RISKY_LEAF_RE.test(parentKids[leafIdx - 1].text)) {
    return null
  }
  if (leafIdx + 1 < parentKids.length && parentKids[leafIdx + 1].kind === 'text' && RISKY_LEAF_RE.test(parentKids[leafIdx + 1].text)) {
    return null
  }

  const relStart = start - node.range.start
  const relEnd = oldEnd - node.range.start
  const newText = node.text.slice(0, relStart) + inserted + node.text.slice(relEnd)
  if (newText.length === 0) return null
  if (RISKY_LEAF_RE.test(newText)) return null

  const replacement = greenNode('text', newText, [], 0, 0, newText.length)
  const green = spliceGreen(spine, replacement)

  // Block-level change span (matching `churnedSpan`) in O(1) from the single
  // touched top-level child so `BlockPatcher` always takes the windowed path.
  const topIdx = spine[0].index
  const oldTop = oldRoot.children[topIdx]
  const topStart = oldTop.range.start
  const topOldEnd = oldTop.range.end
  const delta = newLen - oldLen
  return { green, change: { start: topStart, end: topOldEnd + delta, endOld: topOldEnd } }
}

export interface OsuPreviewTreeOptions {
  dialect?: BBCodeDialect
}

export interface OsuPreviewUpdateStats {
  /** Lexing + parsing to green, ms. */
  parseMs: number
  /** Building (or adopting) the red tree, ms. */
  buildMs: number
  /** Red subtrees carried over from the previous tree. */
  adopted: number
  /** The churned span handed to the patcher, or null for a from-scratch build. */
  change: TextChangeRange | null
}

/**
 * The parse a `BBCodeDocumentModel` does in `rebuild`, without the red build
 * and the id walk around it. A subclass so the lexer/parser options stay the
 * model's own, not a copy that could drift from it.
 */
class OsuGreenParser extends BBCodeDocumentModel {
  constructor(dialect: BBCodeDialect | undefined) {
    super({ dialect, pairing: 'osu', incremental: false, autoAnalyze: false, maxUndo: 0 })
  }

  parse(source: string): GreenNode {
    return this.parseToGreen(source)
  }
}

export class OsuPreviewTree {
  private readonly parser: OsuGreenParser
  private _source: string | null = null
  private _root: RedNode | null = null
  /** What the last `update` that did work cost; for benches and diagnostics. */
  lastStats: OsuPreviewUpdateStats | null = null

  constructor(options: OsuPreviewTreeOptions = {}) {
    this.parser = new OsuGreenParser(options.dialect)
  }

  get root(): RedNode | null {
    return this._root
  }

  get source(): string | null {
    return this._source
  }

  /**
   * The osu tree of `source`. Same source as last time → the same root, so a
   * caller may ask twice (React's double render) without consuming anything.
   */
  update(source: string): RedNode {
    if (this._root !== null && source === this._source) return this._root

    const old = this._root
    const oldSource = this._source
    const t0 = performance.now()

    // Fast path: pure prose edit strictly inside a safe text leaf.
    // O(depth * log N) instead of a full document lex + osuPairing + parse.
    if (old !== null && oldSource !== null) {
      const fast = trySpliceProseGreen(old, oldSource, source)
      if (fast !== null) {
        const t1 = performance.now()
        const reuse = { adopted: 0 }
        try {
          const root = greenToRedNodeReusing(fast.green, old, 0, reuse, false)
          ;(root as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange = fast.change
          const t2 = performance.now()
          this._root = root
          this._source = source
          this.lastStats = { parseMs: t1 - t0, buildMs: t2 - t1, adopted: reuse.adopted, change: fast.change }
          return root
        } catch {
          // If anything unexpected happens during adoption, drop the old tree
          // and fall through to a clean full parse below.
          this.dispose()
        }
      }
    }

    const green = this.parser.parse(source)
    const t1 = performance.now()

    const prev = this._root
    const reuse = { adopted: 0 }
    let root: RedNode
    let change: TextChangeRange | null = null
    try {
      if (prev !== null) {
        root = greenToRedNodeReusing(green, prev, 0, reuse, true)
        // With nothing adopted every block is new: no window to point at.
        if (reuse.adopted > 0) change = churnedSpan(prev, root)
      } else {
        root = greenToRedNode(green)
      }
    } catch (err) {
      // Adoption reparents as it goes: a throw leaves the old tree half
      // consumed. Start the next update from scratch rather than from it.
      this.dispose()
      throw err
    }
    // The patcher reads the edited span from the root (see
    // `DocumentModel._attachChangeRange`); null sends it to the keyed walk.
    ;(root as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange = change
    const t2 = performance.now()

    this._root = root
    this._source = source
    this.lastStats = { parseMs: t1 - t0, buildMs: t2 - t1, adopted: reuse.adopted, change }
    return root
  }

  /** Drop the tree (toggle off, dialect change, document closed). */
  dispose(): void {
    this._root = null
    this._source = null
    this.lastStats = null
  }
}

/**
 * The span the patcher must reconcile: everything between the blocks kept at
 * the head and the blocks kept at the tail, end given in both coordinate
 * systems.
 *
 * Taken from the TREE, not from a diff of the two texts, and that is the whole
 * point. osu! pairing is document-global: an orphan `[/box]` typed at the end
 * re-pairs a box opened at the top, so the blocks that changed can lie far
 * outside the edited text. The windowed reconcile locates the OLD runs by this
 * span, and a text-diff span there left the re-paired blocks' old elements in
 * the DOM next to their new ones (caught by the random-edit test). The kept
 * blocks at both ends are equal greens, hence equal text, so this span always
 * contains the text edit too: a common prefix of blocks is a common prefix of
 * text.
 */
function churnedSpan(oldRoot: RedNode, newRoot: RedNode): TextChangeRange | null {
  const oldKids = oldRoot.children
  const newKids = newRoot.children
  const limit = Math.min(oldKids.length, newKids.length)
  let head = 0
  let start = newRoot.green.leadingWidth
  while (head < limit && newKids[head] === oldKids[head]) {
    start += newKids[head].green.width
    head++
  }
  // Same trailing delimiter width in both trees: the root kind never changes.
  let tailWidth = newRoot.green.trailingWidth
  let tail = 0
  while (
    tail < limit - head &&
    newKids[newKids.length - 1 - tail] === oldKids[oldKids.length - 1 - tail]
  ) {
    tailWidth += newKids[newKids.length - 1 - tail].green.width
    tail++
  }
  if (head === newKids.length && head === oldKids.length) return null
  return { start, end: newRoot.green.width - tailWidth, endOld: oldRoot.green.width - tailWidth }
}
