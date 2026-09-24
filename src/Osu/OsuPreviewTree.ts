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
import type { GreenNode } from '../Syntax/GreenNode'
import type { RedNode } from '../Syntax/RedNode'
import type { TextChangeRange } from '../Incremental/ChangeTracker'

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

    const t0 = performance.now()
    const green = this.parser.parse(source)
    const t1 = performance.now()

    const old = this._root
    const reuse = { adopted: 0 }
    let root: RedNode
    let change: TextChangeRange | null = null
    try {
      if (old !== null) {
        root = greenToRedNodeReusing(green, old, 0, reuse, true)
        // With nothing adopted every block is new: no window to point at.
        if (reuse.adopted > 0) change = churnedSpan(old, root)
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
