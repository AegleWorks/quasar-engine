/**
 * DocumentEngine — RedNode (Mutable Syntax Tree)
 *
 * The Red Tree wraps GreenNode and adds mutable state:
 * - Parent references
 * - Stable Node IDs
 * - Version tracking
 * - Diagnostic storage
 *
 * Multiple Red Trees can reference the same Green Tree
 * (different views, different versions of edits).
 *
 * Inspired by Roslyn's Red Tree.
 */

import { GreenNode } from './GreenNode'
import type { NodeId, DocumentNode, NodeKind, NodeAttributes, NodeMetadata } from '../Types/core'
import { createNodeId } from '../Types/core'
import type { Diagnostic } from '../Types/diagnostics'
import type { Range } from '../Types/tokens'

// ─── Shared empties ────────────────────────────────────────────
//
// Most red nodes are leaves with no children, no diagnostics and no metadata,
// and every one of them used to get three fresh empty objects of its own —
// about 60 bytes and three allocations per node, 38.522 nodes on the 547 KB
// fixture, all surviving into the old generation for the collector to copy.
// They share these instead. Frozen, so a writer that assumed it owned the
// empty fails loudly rather than writing into every node at once: the
// mutators below swap in an own array first (`ownChildren`), and the one
// writer of `diagnostics` does the same (`ownDiagnostics`).

const NO_CHILDREN: readonly RedNode[] = Object.freeze([])
/** The `diagnostics` of a node that has none. Frozen; see `ownDiagnostics`. */
export const NO_DIAGNOSTICS: Diagnostic[] = Object.freeze([]) as unknown as Diagnostic[]
/** The `metadata` of a node that has none. Frozen: replace it, never write into it. */
export const NO_METADATA: NodeMetadata = Object.freeze({}) as NodeMetadata

// ─── Red Node ──────────────────────────────────────────────────

export class RedNode {
  /** The underlying immutable green node */
  readonly green: GreenNode
  /**
   * Minted on first read, not at construction (see `id`). `declare`: no
   * field initialiser, the constructor assigns it.
   */
  private declare _id: NodeId | undefined
  /** Parent reference (null for root) */
  parent: RedNode | null
  /**
   * Children as red nodes.
   *
   * Read-only to everyone but this class: `readonly` on both the field and
   * the array makes an outside `push`, `splice`, `pop` or reassignment a
   * compile error, so the only way to change a tree's shape is through the
   * mutators below, inside a mutation boundary, keeping `parent` and the
   * index cache right. (It used to be a public mutable array, and five
   * `cloned.children = []` writes in the effect transformers went around the
   * boundary entirely.) Same array at runtime — the guarantee costs nothing.
   */
  readonly children: readonly RedNode[]
  /** Version counter for change tracking */
  version: number
  /** Diagnostics for this node */
  diagnostics: Diagnostic[]
  /** The semantic kind */
  kind: NodeKind
  /** Additional metadata */
  metadata: NodeMetadata

  /**
   * Cached position of this node inside `parent.children`.
   *
   * `declare` is load-bearing — see the note on `GreenNode._hashCache`: with
   * `target: ES2022` a plain field declaration emits a `defineProperty` on every
   * construction, and this class is instantiated once per node per parse.
   *
   * The cache is *self-validating*: `index` only trusts it when
   * `parent.children[_idxCache] === this`. That single reference compare is what
   * makes it safe against code that mutates the `children` array directly
   * (`treeTransformers` does `cloned.children = []`) instead of going through the
   * mutation methods — a stale entry is detected and recomputed rather than
   * silently returning a wrong index. `-1` never validates, so it is a safe
   * initial value.
   */
  private declare _idxCache: number

  /**
   * Absolute start offset. The end is always `_start + green.width` — every
   * shift moves both by the same delta — so it is not stored.
   *
   * `declare` for the usual reason: no `defineProperty` per construction.
   */
  private declare _start: number

  /**
   * The `range` object, made the first time anyone reads `range` and kept in
   * step with `_start` from then on (`moveBy`), so a caller holding it sees
   * the same live object it always did.
   *
   * Not made at construction: the renderer never reads `range`, and a cold
   * open of the 547 KB fixture built 38.522 of these objects for nobody —
   * each one surviving into the old generation for the collector to copy.
   */
  private declare _rangeObj: Range | undefined

  /**
   * Pending offset shift for this subtree, applied on first read.
   *
   * `setStart` defers the walk: it records how far the subtree moved instead of
   * adding the delta to every node's `_start` on the spot. The shift is a single
   * integer here, on the adopted subtree ROOT — the node `setStart` was called
   * on. Any offset read (`range`, `innerStart`, `innerEnd`, `findNodeAtOffset`)
   * materializes the nearest pending ancestor's subtree via {@link materialize}.
   *
   * Why this is sound: a mid-document edit displaces every adopted block after
   * it by the same delta, so adoption alone (thousands of `setStart` calls) was
   * walking thousands of nodes per keystroke — measured as the dominant phase
   * of `buildRed` (3.5-5.8 ms on the 547 KB fixture). The BlockPatcher locates
   * the edited window by reference identity and only ever reads the few changed
   * blocks' ranges, so the displaced-but-unchanged subtrees stay pending
   * indefinitely — the walk never happens.
   *
   * Contract for future readers: app-layer interaction code (hover, links,
   * selection ranges) DOES read `range` on user interaction. The first such
   * read after a mid-document edit fires the deferred walk for the displaced
   * tail — a one-time cost off the keystroke path, which is exactly the trade
   * the laziness makes. Do not "optimize" by reading ranges back into the
   * per-keystroke pipeline; the patcher stays churn-based by design.
   *
   * Composition across reparses: a node re-adopted while its ancestor is still
   * pending must end up at the SUM of both deltas. `setStart` recomputes the
   * delta from the untouched base `_start`, which is exactly the pending
   * ancestor's base too, so composing during `materialize` (add the ancestor's
   * delta into a child's pending delta) stays consistent.
   */
  private declare _lazyShift: number

  constructor(
    green: GreenNode,
    options?: {
      id?: NodeId
      parent?: RedNode | null
      kind?: NodeKind
      diagnostics?: Diagnostic[]
      metadata?: NodeMetadata
      /** Absolute start offset. Defaults to the parent's inner offset. */
      start?: number
    },
  ) {
    this.green = green
    this._id = options?.id
    this.parent = options?.parent ?? null
    this.children = NO_CHILDREN
    this.version = 1
    this.diagnostics = options?.diagnostics ?? NO_DIAGNOSTICS
    this.metadata = options?.metadata ?? NO_METADATA
    this.kind = options?.kind ?? (green.kind as NodeKind)
    this._idxCache = -1
    this._lazyShift = 0
    this._start = options?.start ?? 0
    this._rangeObj = undefined
  }

  /**
   * Move this node (and its subtree) to a new absolute offset.
   *
   * Only for the tree-building paths, which create a node before they know
   * where its parent will put it. Callers that mutate a live tree should
   * rebuild instead — a red node's offset must always agree with its place.
   *
   * The move is deferred, not walked: the delta is recorded as a pending
   * shift and applied by any offset read the first time the subtree is
   * actually touched. Adoption calls this once per displaced block (thousands
   * on a mid-document edit), and almost none of those subtrees are read on the
   * same keystroke's hot path — the BlockPatcher locates the edit window by
   * reference identity and only reads the few changed blocks.
   *
   * Re-adoption composes: a node whose subtree was shifted in a previous
   * reparse and never read still carries a pending `_lazyShift`. The new
   * target is absolute, so the delta is measured from the CURRENT effective
   * start (`_start + _lazyShift`) and accumulated, not overwritten —
   * otherwise the earlier shift would be applied twice.
   */
  setStart(start: number): void {
    const delta = start - (this._start + this._lazyShift)
    if (delta === 0) return
    this._lazyShift += delta
  }

  /**
   * Apply `delta` to `node`'s subtree, composing with any nested pending shift.
   *
   * A node with its own pending shift has a base `_start` the parent's delta is
   * relative to as well (both were computed from the same pre-shift tree), so
   * the parent's delta can be folded into the child's pending delta instead of
   * into its `_start` — the child's later materialization applies the sum. This
   * is what makes nested shifts across reparses compose without double counting.
   */
  private static applyShift(node: RedNode, delta: number): void {
    if (delta === 0) return
    if (node._lazyShift !== 0) {
      node._lazyShift += delta
      return
    }
    node.moveBy(delta)
    RedNode.shiftDescendants(node, delta)
  }

  /**
   * Push `delta` into every red node that lives under `node` — its title nodes
   * as well as its children.
   *
   * The title subtree of a rich `[box=[b]heading[/b]]` is stored in
   * `metadata.titleNodes`, never appended to `children`, so a loop over
   * `children` alone leaves it at pre-edit offsets. That is not cosmetic:
   * `findNodeAtOffset` consults `metadata.titleNodes` BEFORE `children`, so a
   * stale title range mis-resolves caret, hover and selection inside the
   * heading. Both shift paths — the recursive one and `materialize`'s ancestor
   * loop — route through here so they cannot drift apart again.
   */
  private static shiftDescendants(node: RedNode, delta: number): void {
    const titleNodes = node.metadata?.titleNodes as RedNode[] | undefined
    if (titleNodes) {
      for (let i = 0; i < titleNodes.length; i++) {
        RedNode.applyShift(titleNodes[i], delta)
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      RedNode.applyShift(node.children[i], delta)
    }
  }

  /**
   * Materialize every pending shift on the path from here to the root.
   *
   * Walks ancestors top-down (root-most first), applying each pending delta to
   * its subtree. Top-down order matters: an ancestor's delta must land in a
   * child's pending delta BEFORE the child's own materialization runs, or the
   * two shifts would be applied to different bases. After the ancestors are
   * settled, this node itself is materialized if it still carries a shift.
   *
   * The common case — nothing pending anywhere on the path — is one upward
   * pointer walk that allocates nothing: `range` is read from 148 call sites,
   * and a per-read allocation there would show up in every phase. The chain
   * array is only built after a pending shift is actually found.
   */
  private materialize(): void {
    // Fast path: no pending shift on this node or any ancestor.
    let node: RedNode | null = this
    while (node !== null && node._lazyShift === 0) {
      node = node.parent
    }
    if (node === null) return

    // Slow path: collect the ancestor chain, root-most last (so we pop
    // root-first), and materialize each pending shift top-down.
    const chain: RedNode[] = []
    let n: RedNode | null = this
    while (n !== null) {
      chain.push(n)
      n = n.parent
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const ancestor = chain[i]
      const delta = ancestor._lazyShift
      if (delta === 0) continue
      ancestor._lazyShift = 0
      ancestor.moveBy(delta)
      RedNode.shiftDescendants(ancestor, delta)
    }
  }

  // ─── Mutation boundary ───────────────────────────────────
  //
  // What this is, stated plainly, because the documentation used to claim more:
  // a **convention enforcer**, not an isolation mechanism and not a concurrency
  // guarantee.
  //
  // It cannot be an isolation mechanism. The flag is a single static boolean, so
  // opening a boundary anywhere opens it everywhere — there is no scoping by
  // document, transaction or thread. Scoping it per document would mean walking
  // to the root on every mutation and threading a root through all 26 call
  // sites, to catch cross-document mutation: a bug class a single-threaded
  // editor does not have.
  //
  // It cannot be airtight either. `children` is a public mutable array, and
  // `treeTransformers` assigns to it directly in five places, bypassing these
  // methods entirely. Sealing that means making `children` private, which is a
  // large API change for the same small benefit.
  //
  // What it does earn: wrapping a structural edit marks intent at the call site,
  // and mutating outside a boundary fails loudly instead of silently. That is
  // worth one boolean check, so it stays — described honestly.

  private static _isMutating = false

  /**
   * Run `fn` inside a mutation boundary, so the structural mutators below are
   * allowed to run. Nests safely; the previous state is restored on exit.
   *
   * Not needed for building a fresh subtree — see {@link initChildren}.
   */
  static allowMutation<T>(fn: () => T): T {
    const wasMutating = RedNode._isMutating
    RedNode._isMutating = true
    try {
      return fn()
    } finally {
      RedNode._isMutating = wasMutating
    }
  }

  private assertMutating(): void {
    if (!RedNode._isMutating) {
      throw new Error('RedNode mutation is only allowed within a mutation boundary (use RedNode.allowMutation).')
    }
  }

  // ─── Properties ──────────────────────────────────────────

  /**
   * Stable identity, minted the first time anything asks for it.
   *
   * A cold open of the 547 KB fixture builds 38.522 red nodes, and the
   * renderer reads the id of the block-level ones only (`HTMLRenderer.idMode`):
   * the 22.000 text leaves were each paying for a string nobody read. Ids are
   * unique per process either way; only the ORDER they are minted in changes,
   * and nothing compares ids by order.
   */
  get id(): NodeId {
    return (this._id ??= createNodeId())
  }

  /** Only `preserveNodeIds` carries an id across trees. */
  set id(id: NodeId) {
    this._id = id
  }

  get text(): string {
    return this.green.text
  }

  /** Absolute span in the source. */
  get range(): Range {
    this.materialize()
    let range = this._rangeObj
    if (range === undefined) {
      range = { start: this._start, end: this._start + this.green.width }
      this._rangeObj = range
    }
    return range
  }

  /** Move this node alone by `delta`, and its `range` object if it has one. */
  private moveBy(delta: number): void {
    this._start += delta
    const range = this._rangeObj
    if (range !== undefined) {
      range.start += delta
      range.end += delta
    }
  }

  /** Absolute offset of this node's first child, past its opening delimiter. */
  get innerStart(): number {
    this.materialize()
    return this._start + this.green.leadingWidth
  }

  /** Absolute offset where this node's closing delimiter begins. */
  get innerEnd(): number {
    this.materialize()
    return this._start + this.green.width - this.green.trailingWidth
  }

  get isLeaf(): boolean {
    return this.green.isLeaf
  }

  get childCount(): number {
    return this.children.length
  }

  // ─── Navigation ──────────────────────────────────────────

  childAt(index: number): RedNode | undefined {
    return this.children[index]
  }

  /** Get the root of the tree */
  get root(): RedNode {
    let node: RedNode = this
    while (node.parent) {
      node = node.parent
    }
    return node
  }

  /** Get the depth from root */
  get depth(): number {
    let d = 0
    let node: RedNode | null = this.parent
    while (node) {
      d++
      node = node.parent
    }
    return d
  }

  /** Get previous sibling */
  get previousSibling(): RedNode | null {
    const parent = this.parent
    if (!parent) return null
    const idx = this.index
    return idx > 0 ? parent.children[idx - 1] : null
  }

  /** Get next sibling */
  get nextSibling(): RedNode | null {
    const parent = this.parent
    if (!parent) return null
    const idx = this.index
    return idx >= 0 && idx < parent.children.length - 1 ? parent.children[idx + 1] : null
  }

  /**
   * Position of this node within its parent, or -1 for a root.
   *
   * O(1) in the steady state. The cached index is seeded by the mutation methods
   * (so the construction path never searches at all) and verified by a single
   * reference compare on read, falling back to `indexOf` only when it is stale.
   *
   * This getter is hot: `HTMLRenderer.isPrevBlockBoundary` walks siblings
   * backwards, so an O(n) implementation here made rendering quadratic —
   * measured 14.11 ms for 4000 root siblings, growing 2.6x per doubling.
   */
  get index(): number {
    const parent = this.parent
    if (!parent) return -1
    const siblings = parent.children
    const cached = this._idxCache
    if (siblings[cached] === this) return cached
    const idx = siblings.indexOf(this)
    this._idxCache = idx
    return idx
  }

  /** Walk all descendants in pre-order */
  walk(visitor: (node: RedNode, depth: number) => void | 'skip', depth: number = 0): void {
    const result = visitor(this, depth)
    if (result !== 'skip') {
      for (const child of this.children) {
        child.walk(visitor, depth + 1)
      }
    }
  }

  /** Find a descendant by ID */
  findById(id: NodeId): RedNode | null {
    if (this.id === id) return this
    for (const child of this.children) {
      const found = child.findById(id)
      if (found) return found
    }
    return null
  }

  /**
   * Find the deepest RedNode containing the given text offset.
   *
   * The range is half-open — a node owns `[start, end)` — y eso no es un
   * detalle: con el final inclusivo, un offset que cae justo en una frontera
   * pertenecía a DOS nodos, al que termina ahí y al que empieza. Como los
   * hijos se recorren en orden, ganaba el que termina, así que preguntar por
   * el principio de un nodo devolvía **el nodo anterior**.
   *
   * Se veía en el preview: en un degradado, cada carácter es su propio nodo
   * de color, y hacer clic en la `m` de «Welcome» resaltaba la `o`. Monaco
   * seleccionaba bien —usa el rango del nodo, no esta búsqueda—, así que el
   * desfase era solo del resaltado, que es justo lo que hacía difícil verlo.
   *
   * La única excepción es el final del documento: un cursor aparcado tras el
   * último carácter no tiene carácter que lo contenga, y la raíz lo reclama
   * para que quien pregunte reciba algo con sentido.
   */
  findNodeAtOffset(offset: number): RedNode | null {
    this.materialize()
    const start = this._start
    const end = start + this.green.width
    const isEndOfDocument = offset === end && this.parent === null
    if ((offset < start || offset >= end) && !isEndOfDocument) return null

    const titleNodes = this.metadata?.titleNodes as RedNode[] | undefined
    if (titleNodes) {
      for (const titleChild of titleNodes) {
        const found = titleChild.findNodeAtOffset(offset)
        if (found) return found
      }
    }

    for (const child of this.children) {
      const found = child.findNodeAtOffset(offset)
      if (found) return found
    }

    return this
  }

  // ─── Construction ────────────────────────────────────────

  /** The writable view of `children`, for this class's own mutators only. */
  private get ownChildren(): RedNode[] {
    if (this.children === NO_CHILDREN) (this as { children: readonly RedNode[] }).children = []
    return this.children as RedNode[]
  }

  /** `diagnostics`, as an array this node owns and a writer may push into. */
  ownDiagnostics(): Diagnostic[] {
    if (this.diagnostics === NO_DIAGNOSTICS) this.diagnostics = []
    return this.diagnostics
  }

  /**
   * Adopt a fully-built array of children in one shot.
   *
   * Construction-only, and deliberately outside the mutation lock. The tree
   * builders used to call `allowMutation(() => { for (…) appendChild(…) })` once
   * **per node**, which on a 1736-node document meant 1736 closures, 1736
   * `try/finally` frames and 1736 static-flag saves — pure ceremony, since a
   * node that no caller has seen yet cannot be observed mid-mutation. This
   * populates `children`, `parent` and the index cache in a single pass instead.
   *
   * `version` intentionally stays at 1: a freshly built node has not been
   * *edited*, and bumping once per child would make the initial version an
   * accidental child count.
   *
   * Only safe while `this` is still unreachable from the rest of the tree. Use
   * `appendChild` and friends for anything after that. Takes ownership of
   * `children`: the caller must not keep or change that array.
   */
  initChildren(children: readonly RedNode[]): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      child.parent = this
      child._idxCache = i
    }
    if (children.length === 0) return
    // The array is TAKEN, not copied: every builder hands over one it made for
    // this call and never touches again. Copying it pushed each child into a
    // second array that grew by reallocation — a spare array per node, plus
    // slack, on the hottest allocation path of a cold parse.
    if (this.children === NO_CHILDREN) (this as { children: readonly RedNode[] }).children = children
    else this.ownChildren.push(...children)
  }

  // ─── Mutation ────────────────────────────────────────────

  /**
   * Append a child node.
   * This creates a new RedNode wrapping the green node.
   */
  appendChild(child: RedNode): void {
    this.assertMutating()
    child.parent = this
    child._idxCache = this.children.length
    this.ownChildren.push(child)
    this.version++
  }

  /**
   * Refresh the cached index of every child from `from` onwards.
   *
   * Called after a splice, which shifts the tail. This is O(n) but so is the
   * splice it follows, so it costs nothing asymptotically and keeps reads O(1).
   */
  private reindexFrom(from: number): void {
    const children = this.children
    for (let i = from; i < children.length; i++) {
      children[i]._idxCache = i
    }
  }

  /**
   * Insert a child at a specific index.
   */
  insertChildAt(index: number, child: RedNode): void {
    this.assertMutating()
    child.parent = this
    this.ownChildren.splice(index, 0, child)
    this.reindexFrom(index)
    this.version++
  }

  /**
   * Remove a child by ID.
   */
  removeChild(id: NodeId): RedNode | null {
    this.assertMutating()
    const idx = this.children.findIndex(c => c.id === id)
    if (idx === -1) return null
    const [removed] = this.ownChildren.splice(idx, 1)
    removed.parent = null
    removed._idxCache = -1
    this.reindexFrom(idx)
    this.version++
    return removed
  }

  /**
   * Replace a child with a new one by ID.
   */
  replaceChild(id: NodeId, newChild: RedNode): boolean {
    this.assertMutating()
    const idx = this.children.findIndex(c => c.id === id)
    if (idx === -1) return false
    newChild.parent = this
    newChild._idxCache = idx
    this.ownChildren[idx] = newChild
    this.version++
    return true
  }

  /**
   * Bump version (when attributes/metadata change without structural change).
   */
  bumpVersion(): void {
    this.assertMutating()
    this.version++
  }

  // ─── Conversion ──────────────────────────────────────────

  /** Convert to the public DocumentNode interface */
  toDocumentNode(): DocumentNode {
    return {
      id: this.id,
      version: this.version,
      kind: this.kind,
      text: this.text,
      attributes: {},
      metadata: { ...this.metadata },
      children: this.children.map(c => c.toDocumentNode()),
      diagnostics: [...this.diagnostics],
      sourceRange: { start: this.range.start, end: this.range.end },
      parentId: this.parent?.id ?? null,
      isSynthetic: this.green.kind === 'synthetic',
    }
  }

  /** Debug string */
  toString(depth: number = 0): string {
    const indent = '  '.repeat(depth)
    const rangeStr = `[${this.range.start}..${this.range.end}]`
    const textPreview = this.text.length > 30
      ? this.text.slice(0, 30) + '...'
      : this.text
    return `${indent}${this.kind} #${this.id} ${rangeStr} v${this.version} "${textPreview}"` +
      (this.children.length > 0
        ? '\n' + this.children.map(c => c.toString(depth + 1)).join('\n')
        : '')
  }
}
