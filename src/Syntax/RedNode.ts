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

// ─── Red Node ──────────────────────────────────────────────────

export class RedNode {
  /** The underlying immutable green node */
  readonly green: GreenNode
  /** Stable identity */
  readonly id: NodeId
  /** Parent reference (null for root) */
  parent: RedNode | null
  /** Children as red nodes */
  children: RedNode[]
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
   * Absolute start offset in the source.
   *
   * This is the red tree's job now: a green node knows its width, not its
   * place, so that identical structures can be the same object (see the header
   * of `GreenNode.ts`). The offset is accumulated on the way down during
   * construction — one addition per node — and stored, so `range` stays the
   * O(1) property every consumer already assumes it is.
   *
   * Held as the `Range` object itself rather than a number plus a getter that
   * builds one: `range` is read from 148 call sites, and allocating there would
   * trade a parse-time win for a read-time cost on every consumer. This is the
   * same shape green nodes used to hold, so nothing downstream changes.
   *
   * `declare` for the usual reason: no `defineProperty` per construction.
   */
  private declare _range: Range

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
    this.id = options?.id ?? createNodeId()
    this.parent = options?.parent ?? null
    this.children = []
    this.version = 1
    this.diagnostics = options?.diagnostics ?? []
    this.metadata = options?.metadata ?? {}
    this.kind = options?.kind ?? (green.kind as NodeKind)
    this._idxCache = -1
    const start = options?.start ?? 0
    this._range = { start, end: start + green.width }
  }

  /**
   * Move this node (and its subtree) to a new absolute offset.
   *
   * Only for the tree-building paths, which create a node before they know
   * where its parent will put it. Callers that mutate a live tree should
   * rebuild instead — a red node's offset must always agree with its place.
   */
  setStart(start: number): void {
    const delta = start - this._range.start
    if (delta === 0) return
    const stack: RedNode[] = [this]
    while (stack.length > 0) {
      const node = stack.pop()!
      node._range.start += delta
      node._range.end += delta
      for (const child of node.children) stack.push(child)
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

  get text(): string {
    return this.green.text
  }

  /** Absolute span in the source. */
  get range(): Range {
    return this._range
  }

  /** Absolute offset of this node's first child, past its opening delimiter. */
  get innerStart(): number {
    return this._range.start + this.green.leadingWidth
  }

  /** Absolute offset where this node's closing delimiter begins. */
  get innerEnd(): number {
    return this._range.end - this.green.trailingWidth
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
    const { start, end } = this._range
    const isEndOfDocument = offset === end && this.parent === null
    if ((offset < start || offset >= end) && !isEndOfDocument) return null

    for (const child of this.children) {
      const found = child.findNodeAtOffset(offset)
      if (found) return found
    }

    return this
  }

  // ─── Construction ────────────────────────────────────────

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
   * `appendChild` and friends for anything after that.
   */
  initChildren(children: RedNode[]): void {
    const own = this.children
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      child.parent = this
      child._idxCache = i
      own.push(child)
    }
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
    this.children.push(child)
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
    this.children.splice(index, 0, child)
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
    const [removed] = this.children.splice(idx, 1)
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
    this.children[idx] = newChild
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
