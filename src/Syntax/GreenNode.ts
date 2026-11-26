/**
 * DocumentEngine — GreenNode (Immutable Syntax Tree)
 *
 * The Green Tree is IMMUTABLE. It never changes after creation.
 * This is the "compiled" representation of the source text.
 *
 * Properties:
 * - Fully immutable (readonly)
 * - Contains only structural information (kind, text, children, widths)
 * - **No absolute position** — see below
 * - No parent references
 * - No identity (IDs live in Red Tree)
 * - Can be shared across document versions
 * - Safe to cache
 *
 * ─── Why there is no `range` ────────────────────────────────────────────────
 *
 * A green node knows how WIDE it is, not WHERE it is. That is the whole point:
 * the two `[color=#e8b04b]` runs in a gradient are the same structure, and if
 * each carried its own offsets they could never be the same object. Measured on
 * the reference document: 1736 nodes, but only 702 distinct structures — 59.6%
 * of the tree is duplicate.
 *
 * Position is a property of a node's PLACE in a tree, so it lives on the red
 * node, which is the thing that has a place. `RedNode.range` computes it once
 * at construction by accumulating widths from the root and caches it, so
 * consumers see exactly the same `{start, end}` they always did.
 *
 * This also makes incremental editing cheaper: text inserted before a subtree
 * changes where it is, not what it is, so nothing about it needs rebuilding.
 * `shiftGreen` — which used to deep-copy every following sibling to bump its
 * offsets — no longer exists, because there is nothing left to shift.
 *
 * ─── Why `width` is derived and never passed ────────────────────────────────
 *
 * `width = leadingWidth + (children ? Σ child widths : ownWidth) + trailingWidth`
 *
 * The partition invariant of roadmap point 14 — every character owned exactly
 * once — used to be a runtime check that a careless caller could violate. Now
 * it is arithmetic the constructor performs, so a tree that does not partition
 * its source cannot be built. `Syntax/partition.ts` still exists to verify the
 * one thing this cannot: that the root's width matches the source length.
 *
 * Inspired by Roslyn's Green Tree and SwiftSyntax.
 */

import { FNV_OFFSET, hashString, hashUint32 } from './hash'
import {
  SUM_TREE_THRESHOLD,
  buildGreenSumTree,
  flattenGreenSumTree,
  greenSumAt,
  greenSumFindAtOffset,
  greenSumOffsetOfIndex,
  greenSumSlice,
  type GreenSumNode,
} from './ChildSumTree'

/**
 * Shared frozen empty array for childless nodes.
 *
 * Over half the nodes in a document are leaves, and each was allocating and
 * freezing its own empty array — 930 of them on the reference document, for
 * 17% of the parser. They cannot differ from one another; one instance does.
 */
const NO_CHILDREN: readonly GreenNode[] = Object.freeze([])

/**
 * Whether to freeze children lists at all.
 *
 * `Object.freeze` per node cost 32% of the parser, buying a runtime guard
 * against a mutation that `readonly GreenNode[]` already rejects at compile
 * time. Keeping it outside production means the throw still happens where
 * mistakes are made and caught — in development and in the test suite — and
 * production pays nothing for a check that has never once fired there.
 *
 * Evaluated once at module load, so the hot path sees a constant. Without a
 * `process` at all (a browser bundle nobody shimmed, a Worker) there is no
 * way to tell development from production, and the answer is the fast one:
 * the guard is a development aid, and it used to be the other way round —
 * on in exactly the places where nothing could turn it off.
 */
const FREEZE_CHILDREN =
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

// ─── Green Node ────────────────────────────────────────────────

export class GreenNode {
  /** Syntax kind — maps to TokenKind for leaves, NodeKind for internals */
  readonly kind: string
  /** Raw text of this node (empty for internal nodes) */
  readonly text: string
  /** Backing flat children array (null when backed by a persistent SumTree until lazily read). */
  private declare _childrenArr: readonly GreenNode[] | null
  /** Persistent B-Tree backing wide nodes (`count >= SUM_TREE_THRESHOLD`), or null for small nodes. */
  private declare _sumTree: GreenSumNode | null
  /** Total width of this node in characters, delimiters included */
  readonly width: number
  /** Whether this is a leaf (token) or internal node */
  readonly isLeaf: boolean

  /**
   * Characters this node owns BEFORE its first child — its opening delimiter.
   * For `[b]hola[/b]` that is the 3 characters of `[b]`.
   *
   * `declare` is load-bearing here for the same reason as `_hashCache` below:
   * a plain field declaration would emit a `defineProperty` per construction.
   */
  declare readonly leadingWidth: number
  /** Characters this node owns AFTER its last child — its closing delimiter. */
  declare readonly trailingWidth: number

  /**
   * Memoized structural hash — computed on first access, never invalidated.
   *
   * `declare` is load-bearing: with `target: ES2022`, TypeScript defaults
   * `useDefineForClassFields` to true, so a plain field declaration emits a
   * per-construction `defineProperty`. Measured on a 19.6 KB document that
   * cost 23% of the parse phase (0.583 ms → 0.718 ms) for a slot most nodes
   * never read. `declare` emits nothing; the constructor assigns it directly,
   * which keeps the object shape monomorphic without the field-init overhead.
   */
  private declare _hashCache: number
  /**
   * Lazy chunked prefix-sum index for medium-wide flat nodes (`128 <= len < SUM_TREE_THRESHOLD`).
   * Nodes with `>= SUM_TREE_THRESHOLD` children use `_sumTree` directly.
   */
  private declare _chunkOffsets: Float64Array | null

  /**
   * @param ownWidth  Width of a childless node's own content: the length of a
   *                  `text` token, or the 1-2 characters of a newline. Ignored
   *                  when there are children, whose widths sum to the same
   *                  thing. An empty element like `[b][/b]` passes 0 and gets
   *                  its width from its two delimiters.
   * @param adoptExact  Internal fast path for structural splices (`greenEdit.ts`):
   *                    takes ownership of a freshly-built exact-sized `children`
   *                    array and trusts `ownWidth` as the precomputed sum of
   *                    child widths, avoiding a redundant O(N) copy and sum.
   * @param chunkOffsets Optional pre-shifted chunk prefix-sum index carried over
   *                     from a previous version of this node.
   * @param sumTree Optional pre-built persistent `GreenSumNode` (O(1) adoption).
   */
  constructor(
    kind: string,
    text: string,
    children: GreenNode[] = [],
    leadingWidth: number = 0,
    trailingWidth: number = 0,
    ownWidth: number = 0,
    adoptExact: boolean = false,
    chunkOffsets: Float64Array | null = null,
    sumTree: GreenSumNode | null = null,
  ) {
    this.kind = kind
    this.text = text
    this.leadingWidth = leadingWidth
    this.trailingWidth = trailingWidth

    if (sumTree !== null) {
      this._sumTree = sumTree
      this._childrenArr = null
      this.isLeaf = sumTree.count === 0
      this.width = leadingWidth + sumTree.width + trailingWidth
      this._hashCache = -1
      this._chunkOffsets = null
      return
    }

    const count = children.length
    if (count >= SUM_TREE_THRESHOLD) {
      const tree = buildGreenSumTree(children)
      this._sumTree = tree
      this._childrenArr = null
      this.isLeaf = false
      this.width = leadingWidth + tree.width + trailingWidth
      this._hashCache = -1
      this._chunkOffsets = null
      return
    }

    this._sumTree = null
    this._childrenArr =
      count === 0
        ? NO_CHILDREN
        : adoptExact
          ? (FREEZE_CHILDREN ? Object.freeze(children) : children)
          : FREEZE_CHILDREN
            ? Object.freeze([...children])
            : [...children]
    this.isLeaf = count === 0

    let inner = ownWidth
    if (count > 0 && !adoptExact) {
      inner = 0
      for (let i = 0; i < count; i++) inner += children[i].width
    }
    this.width = leadingWidth + inner + trailingWidth

    // -1 is the "not yet computed" sentinel: `_hash` is always `>>> 0`, so it
    // can never legitimately be negative.
    this._hashCache = -1
    this._chunkOffsets = chunkOffsets
  }

  /** Construct a wide `GreenNode` directly from an existing persistent `GreenSumNode` in O(1). */
  static fromSumTree(
    kind: string,
    text: string,
    sumTree: GreenSumNode,
    leadingWidth: number = 0,
    trailingWidth: number = 0,
  ): GreenNode {
    return new GreenNode(kind, text, NO_CHILDREN as GreenNode[], leadingWidth, trailingWidth, 0, false, null, sumTree)
  }

  /** Persistent SumTree backing this node when wide, or null. */
  get sumTree(): GreenSumNode | null {
    return this._sumTree
  }

  /** Child nodes (lazily flattened if backed by a persistent SumTree). */
  get children(): readonly GreenNode[] {
    let arr = this._childrenArr
    if (arr === null) {
      const flat = flattenGreenSumTree(this._sumTree!)
      arr = FREEZE_CHILDREN ? Object.freeze(flat) : flat
      this._childrenArr = arr
    }
    return arr
  }

  // ─── Structural Identity ─────────────────────────────────

  /**
   * Structural hash of this subtree: `(kind, text, widths, children hashes)`.
   *
   * Two subtrees that render identically at different offsets ARE structurally
   * identical — that is the entire premise of structural sharing, and now that
   * green nodes carry no position it is simply true rather than something the
   * hash had to be careful to arrange.
   *
   * The widths ARE folded in: they are structure, not position. A `text` leaf
   * of width 4 and one of width 5 are different nodes.
   *
   * Computed lazily: parsing paths that never intern pay nothing. Safe to
   * memoize because a GreenNode is immutable once constructed.
   */
  get _hash(): number {
    let h = this._hashCache
    if (h === -1) {
      h = hashString(FNV_OFFSET, this.kind)
      h = hashString(h, this.text)
      h = hashUint32(h, this.width)
      h = hashUint32(h, this.leadingWidth)
      h = hashUint32(h, this.trailingWidth)
      h = hashUint32(h, this.children.length)
      for (const child of this.children as GreenNode[]) {
        h = hashUint32(h, child._hash)
      }
      this._hashCache = h
    }
    return h
  }

  // ─── Query Methods ───────────────────────────────────────

  /** Get child at index in O(1) (flat) or O(log N) (SumTree). */
  childAt(index: number): GreenNode | undefined {
    if (this._sumTree !== null) return greenSumAt(this._sumTree, index)
    return this._childrenArr![index]
  }

  /** Slice children `[start, end)` in O(log N + K) without flattening a SumTree. */
  sliceChildren(start: number, end: number): GreenNode[] {
    if (this._sumTree !== null) return greenSumSlice(this._sumTree, start, end)
    return (this._childrenArr as GreenNode[]).slice(start, end)
  }

  /** Find first child matching predicate */
  findChild(predicate: (n: GreenNode) => boolean): GreenNode | undefined {
    return (this.children as GreenNode[]).find(predicate)
  }

  /** Count of direct children in O(1) without flattening a SumTree. */
  get childCount(): number {
    return this._sumTree !== null ? this._sumTree.count : this._childrenArr!.length
  }

  /** Check if this node has a specific kind */
  isKind(kind: string): boolean {
    return this.kind === kind
  }

  /**
   * Offset of this node's first child, relative to this node's own start.
   * Equal to `leadingWidth`; named for the places that read it as a position.
   */
  get innerOffset(): number {
    return this.leadingWidth
  }

  /** Width of the span between this node's delimiters. */
  get innerWidth(): number {
    return this.width - this.leadingWidth - this.trailingWidth
  }

  /**
   * Return the lazy chunk prefix-sum table (1 entry per 64 children) for wide
   * nodes (`children.length >= 128`), building it once on first demand.
   */
  private ensureChunkOffsets(): Float64Array {
    let table = this._chunkOffsets
    if (table !== null) return table
    const kids = this.children as readonly GreenNode[]
    const chunks = ((kids.length + 63) >> 6) + 1
    table = new Float64Array(chunks)
    let acc = 0
    for (let i = 0; i < kids.length; i++) {
      if ((i & 63) === 0) table[i >> 6] = acc
      acc += kids[i].width
    }
    table[chunks - 1] = acc
    this._chunkOffsets = table
    return table
  }

  /**
   * Copy and shift this node's existing chunk table after an in-place child
   * replacement at `index` with width delta `delta`, if the table was already
   * built. Returns `null` when no table existed (stays lazy).
   */
  shiftChunkOffsets(index: number, delta: number): Float64Array | null {
    const prev = this._chunkOffsets
    if (prev === null) return null
    const next = new Float64Array(prev)
    if (delta !== 0) {
      const firstShifted = (index >> 6) + 1
      for (let c = firstShifted; c < next.length; c++) {
        next[c] += delta
      }
    }
    return next
  }

  /**
   * Start offset of `children[index]` relative to `leadingWidth`.
   * O(log N) for SumTree-backed nodes, O(1) (<=63 steps) for chunked flat nodes.
   */
  childStartOffset(index: number): number {
    if (this._sumTree !== null) return greenSumOffsetOfIndex(this._sumTree, index)
    const kids = this._childrenArr!
    const clamped = index < 0 ? 0 : index > kids.length ? kids.length : index
    if (kids.length >= 128) {
      const table = this.ensureChunkOffsets()
      const chunk = clamped >> 6
      let offset = table[chunk]
      for (let i = chunk << 6; i < clamped; i++) offset += kids[i].width
      return offset
    }
    let offset = 0
    for (let i = 0; i < clamped; i++) offset += kids[i].width
    return offset
  }

  /**
   * Locate the first child index `i` whose end offset (`relStart + width`) is
   * `>= relOffset` (relative to `leadingWidth`), returning `{ index, offset }`.
   * Uses O(log N) SumTree descent or chunked binary search for wide nodes.
   */
  findChildAtRelOffset(relOffset: number): { index: number; offset: number } {
    if (this._sumTree !== null) return greenSumFindAtOffset(this._sumTree, relOffset)
    const kids = this._childrenArr!
    const len = kids.length
    if (len === 0) return { index: 0, offset: 0 }
    let i = 0
    let offset = 0
    if (len >= 128) {
      const table = this.ensureChunkOffsets()
      // Binary search for the last chunk `c` with `table[c] < relOffset`.
      let lo = 0
      let hi = table.length - 2 // last valid chunk index
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (table[mid] < relOffset) lo = mid
        else hi = mid - 1
      }
      i = lo << 6
      offset = table[lo]
    }
    while (i < len && offset + kids[i].width < relOffset) {
      offset += kids[i].width
      i++
    }
    return { index: i, offset }
  }

  /** Walk all descendants in pre-order */
  walk(visitor: (node: GreenNode, depth: number) => void | 'skip', depth: number = 0): void {
    const result = visitor(this, depth)
    if (result !== 'skip') {
      for (const child of this.children as GreenNode[]) {
        child.walk(visitor, depth + 1)
      }
    }
  }

  /**
   * Walk all descendants in pre-order, with each node's absolute offset.
   *
   * The replacement for the walks that used to read `node.range`. Offsets are
   * accumulated on the way down, which is the only place they exist.
   */
  walkWithOffset(
    visitor: (node: GreenNode, start: number, depth: number) => void | 'skip',
    start: number = 0,
    depth: number = 0,
  ): void {
    if (visitor(this, start, depth) === 'skip') return
    let offset = start + this.leadingWidth
    for (const child of this.children as GreenNode[]) {
      child.walkWithOffset(visitor, offset, depth + 1)
      offset += child.width
    }
  }

  /** Convert to a debug string */
  toString(depth: number = 0, start: number = 0): string {
    const indent = '  '.repeat(depth)
    const rangeStr = `[${start}..${start + this.width}]`
    const textPreview = this.text.length > 20
      ? this.text.slice(0, 20) + '...'
      : this.text

    let result = `${indent}${this.kind} ${rangeStr} "${textPreview}"`
    if (this.children.length > 0) {
      let offset = start + this.leadingWidth
      const parts: string[] = []
      for (const child of this.children as GreenNode[]) {
        parts.push(child.toString(depth + 1, offset))
        offset += child.width
      }
      result += '\n' + parts.join('\n')
    }
    return result
  }

  /** Get the source text for this node, given where it starts. */
  getSourceText(source: string, start: number): string {
    return source.slice(start, start + this.width)
  }
}

// ─── Green Tree Factory ────────────────────────────────────────

/**
 * Build an internal node. Its width comes from its children plus its own
 * delimiters — there is no way to declare a width that disagrees with them.
 */
export function greenNode(
  kind: string,
  text: string,
  children: GreenNode[] = [],
  leadingWidth: number = 0,
  trailingWidth: number = 0,
  ownWidth: number = 0,
): GreenNode {
  return new GreenNode(kind, text, children, leadingWidth, trailingWidth, ownWidth)
}

/**
 * Absolute offsets of `node`'s children, given where `node` itself starts.
 *
 * Returns `children.length + 1` entries: entry `i` is where child `i` begins
 * and entry `i + 1` is where it ends, so a run of children `[a, b)` spans
 * `offsets[a] .. offsets[b]`.
 *
 * For code that walks the green tree and needs source positions — analyzers
 * reporting diagnostics, transforms recording what they collapsed. Green nodes
 * have no positions of their own, so a walk that needs them accumulates them,
 * and this is the one-liner for doing that at a single level.
 */
export function childOffsets(node: GreenNode, start: number): number[] {
  const children = node.children as readonly GreenNode[]
  const offsets = new Array<number>(children.length + 1)
  let offset = start + node.leadingWidth
  for (let i = 0; i < children.length; i++) {
    offsets[i] = offset
    offset += children[i].width
  }
  offsets[children.length] = offset
  return offsets
}

/**
 * Build a token. `width` defaults to the text's own length, which is right for
 * every leaf whose text IS its source (`text` nodes). Leaves whose `text` holds
 * something else — `spacing` and `empty_line` carry `''` but occupy 1-2
 * characters, element nodes carry their attributes — must pass it.
 */
export function greenLeaf(kind: string, text: string, width: number = text.length): GreenNode {
  return new GreenNode(kind, text, NO_CHILDREN as GreenNode[], 0, 0, width)
}
