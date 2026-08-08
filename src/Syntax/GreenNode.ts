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
 * Evaluated once at module load, so the hot path sees a constant. The `typeof`
 * guard is because this engine also runs inside Workers, where a bundler may
 * not have shimmed `process`.
 */
const FREEZE_CHILDREN =
  typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

// ─── Green Node ────────────────────────────────────────────────

export class GreenNode {
  /** Syntax kind — maps to TokenKind for leaves, NodeKind for internals */
  readonly kind: string
  /** Raw text of this node (empty for internal nodes) */
  readonly text: string
  /** Child nodes */
  readonly children: readonly GreenNode[]
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
   * @param ownWidth  Width of a childless node's own content: the length of a
   *                  `text` token, or the 1-2 characters of a newline. Ignored
   *                  when there are children, whose widths sum to the same
   *                  thing. An empty element like `[b][/b]` passes 0 and gets
   *                  its width from its two delimiters.
   */
  constructor(
    kind: string,
    text: string,
    children: GreenNode[] = [],
    leadingWidth: number = 0,
    trailingWidth: number = 0,
    ownWidth: number = 0,
  ) {
    this.kind = kind
    this.text = text
    const count = children.length
    this.children =
      count === 0
        ? NO_CHILDREN
        : FREEZE_CHILDREN
          ? Object.freeze([...children])
          : [...children]
    this.isLeaf = count === 0
    this.leadingWidth = leadingWidth
    this.trailingWidth = trailingWidth

    let inner = ownWidth
    if (children.length > 0) {
      inner = 0
      for (let i = 0; i < children.length; i++) inner += children[i].width
    }
    this.width = leadingWidth + inner + trailingWidth

    // -1 is the "not yet computed" sentinel: `_hash` is always `>>> 0`, so it
    // can never legitimately be negative.
    this._hashCache = -1
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

  /** Get child at index */
  childAt(index: number): GreenNode | undefined {
    return this.children[index] as GreenNode | undefined
  }

  /** Find first child matching predicate */
  findChild(predicate: (n: GreenNode) => boolean): GreenNode | undefined {
    return (this.children as GreenNode[]).find(predicate)
  }

  /** Count of direct children */
  get childCount(): number {
    return this.children.length
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
  return new GreenNode(kind, text, [], 0, 0, width)
}
