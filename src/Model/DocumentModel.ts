/**
 * DocumentEngine — DocumentModel
 *
 * THE CORE of the Language Platform.
 *
 * The DocumentModel is the single source of truth for the document.
 * BBCode is just ONE representation of this model.
 * The model is language-agnostic and format-agnostic.
 *
 * Responsibilities:
 * - Hold the current Red Tree
 * - Manage incremental parsing
 * - Coordinate transactions (undo/redo)
 * - Emit change events
 * - Provide query/find capabilities
 * - Manage diagnostics
 *
 * Inspired by ProseMirror's EditorState and Roslyn's Document.
 */

import { RedNode } from '../Syntax/RedNode'
import { GreenNode } from '../Syntax/GreenNode'
import { preserveNodeIds } from '../Syntax/preserveNodeIds'
import { NodeMatcher } from '../Syntax/NodeMatcher'
import type { NodeMatch } from '../Syntax/NodeMatcher'
import {
  IncrementalParser,
  type ReparseParseOptions,
  type FallbackReason,
} from '../Incremental/IncrementalParser'
import { ChangeTracker } from '../Incremental/ChangeTracker'
import type { TextChange, TextChangeRange } from '../Incremental/ChangeTracker'
import { SemanticAnalyzer } from '../Semantic/SemanticAnalyzer'
import type { AnalyzeResult, Validator } from '../Semantic/SemanticAnalyzer'
import { Transaction } from '../Transactions/Transaction'
import type { Operation } from '../Types/operations'
import { UndoManager } from '../Transactions/UndoManager'
import { TreeBuilder } from '../Syntax/TreeBuilder'
import { ArrayTokenStream } from '../Types/tokens'
import { QueryEngine } from '../Queries/QueryEngine'
import type { Query, QueryResult } from '../Types/queries'
import type {
  DocumentNode,
  DocumentChangeEvent,
  DocumentChangeKind,
  NodeId,
  NodeKind,
} from '../Types/core'
import { findById, walkPreOrder } from '../Types/core'
import type { DiagnosticCollection } from '../Types/diagnostics'
import { DocumentEventBus } from '../Events/EventBus'
import type { DocumentEvent } from '../Events/EventBus'
import { NodeFactory } from './NodeFactory'
import { TagRegistry } from './TagRegistry'

export interface DocumentModelOptions {
  /** Initial source text */
  source?: string
  /** Language identifier */
  language?: string
  /** Maximum undo stack size */
  maxUndo?: number
  /** Whether to auto-analyze on change */
  autoAnalyze?: boolean
  /**
   * Attempt incremental reparse on `applyChange`. Default `true`.
   *
   * Setting this to `false` makes every change a full rebuild. The result is
   * identical either way — that is the incremental parser's contract, checked
   * differentially over 22.100 edits — so this is a performance switch and a
   * debugging aid, not a correctness one.
   */
  incremental?: boolean
  /**
   * Reuse red subtrees across incremental reparses. Default `true`.
   *
   * When the splice shares a green subtree by reference, the old red subtree
   * is adopted into the new tree instead of being rebuilt — building red was
   * the largest phase of a keystroke. The trade is a contract: the previous
   * `redRoot` is consumed by the adoption and must not be walked afterwards.
   * No engine or app code does; this switch exists for any future consumer
   * that needs the superseded tree to stay intact.
   */
  reuseRed?: boolean
}

export class DocumentModel {
  // ── Core State ──
  private _source: string
  private _language: string
  private _redRoot: RedNode | null = null
  private _greenRoot: GreenNode | null = null
  private _version: number = 0

  // ── Subsystems ──
  readonly tagRegistry: TagRegistry
  readonly nodeFactory: NodeFactory
  readonly treeBuilder: TreeBuilder
  readonly nodeMatcher: NodeMatcher
  readonly semanticAnalyzer: SemanticAnalyzer
  readonly incrementalParser: IncrementalParser
  readonly changeTracker: ChangeTracker
  readonly undoManager: UndoManager
  readonly queryEngine: QueryEngine
  readonly events: DocumentEventBus

  // ── State ──
  private _diagnostics: DiagnosticCollection | null = null
  private _lastAnalyzeResult: AnalyzeResult | null = null
  /**
   * Source range of the last applied edit — see {@link TextChangeRange}.
   * `null` after a full rebuild, which is not an edit.
   */
  private _lastChangeRange: TextChangeRange | null = null
  private _options: Required<DocumentModelOptions>
  private _analyzeTimeout: ReturnType<typeof setTimeout> | null = null
  /** The debounced post-edit work, kept so `ensureAnalyzed` can run it early. */
  private _pendingAnalyze: (() => void) | null = null

  // ── Diagnostics info ──
  /** Last reparse timings breakdown (exposed for debugging) */
  lastReparsePath: string = ''
  /** Why the last reparse fell back to a full rebuild, if it did. */
  lastReparseFallbackReason: FallbackReason | null = null
  lastReparseTimings: { findAffected: number; safeBoundary: number; parse: number; buildRed: number; mutate: number; other: number } | null = null

  constructor(options: DocumentModelOptions = {}) {
    this._options = {
      source: options.source ?? '',
      language: options.language ?? 'bbcode',
      maxUndo: options.maxUndo ?? 50,
      autoAnalyze: options.autoAnalyze ?? true,
      incremental: options.incremental ?? true,
      reuseRed: options.reuseRed ?? true,
    }

    this._source = this._options.source
    this._language = this._options.language

    // Initialize subsystems
    this.tagRegistry = new TagRegistry()
    this.nodeFactory = new NodeFactory(this.tagRegistry)
    this.treeBuilder = new TreeBuilder()
    this.nodeMatcher = new NodeMatcher()
    this.semanticAnalyzer = new SemanticAnalyzer()
    this.incrementalParser = new IncrementalParser()
    this.changeTracker = new ChangeTracker()
    this.undoManager = new UndoManager(this._options.maxUndo)
    this.queryEngine = new QueryEngine()
    this.events = new DocumentEventBus()

    // Bootstrap: parse initial source
    if (this._source) {
      this.rebuild(this._source)
    }
  }

  // ── Properties ──

  get source(): string {
    return this._source
  }

  get language(): string {
    return this._language
  }

  get version(): number {
    return this._version
  }

  get redRoot(): RedNode | null {
    return this._redRoot
  }

  get greenRoot(): GreenNode | null {
    return this._greenRoot
  }

  get diagnostics(): DiagnosticCollection | null {
    return this._diagnostics
  }

  get lastAnalyze(): AnalyzeResult | null {
    return this._lastAnalyzeResult
  }

  /**
   * The source range of the last applied edit, in new-source coordinates.
   *
   * `null` after a `rebuild` (there is no incremental edit to point at). The
   * BlockPatcher reads this to reconcile only the blocks around the edit
   * instead of walking the whole document. The same range is also attached to
   * the current `redRoot` (`__changeRange`), so a consumer that only holds the
   * AST — like the live preview — can find it without plumbing the model.
   */
  get lastChangeRange(): TextChangeRange | null {
    return this._lastChangeRange
  }

  // ── Document Operations ──

  /**
   * Full rebuild from source text.
   * Used for initial load or when incremental parsing isn't possible.
   */
  rebuild(source: string): void {
    const oldRoot = this._redRoot

    // Parse via the tree builder (overridable by language-specific parser)
    this._source = source
    this._greenRoot = this.parseToGreen(source)
    this._redRoot = this.buildRedFromGreen(this._greenRoot)
    // A rebuild is not an edit: there is no "changed region" to reconcile
    // incrementally, so the range is cleared and the preview falls back to its
    // full reconcile (which is what it must do for undo/redo/load anyway).
    this._lastChangeRange = null
    this._attachChangeRange(this._redRoot)
    // Unchanged nodes keep the identity they had before the rebuild, so the
    // HTML of untouched subtrees stays byte-identical between renders and the
    // DOMMorpher's isEqualNode fast path actually fires.
    if (oldRoot) {
      preserveNodeIds(oldRoot, this._redRoot)
    }
    this._version++

    // Run semantic analysis
    if (this._options.autoAnalyze) {
      this.analyze()
    }

    // Emit event — building the payload (and the lazy nodeMatch accessor) is
    // pointless when nobody subscribed, which is the common case. An opted-in
    // history counts as a subscriber.
    if (this.events.hasListeners('document_changed') || this.events.recordHistory) {
      const event = {
        type: 'document_changed' as const,
        kind: 'full_rebuild' as const,
        version: this._version,
        source: this._source,
        timestamp: Date.now(),
      }
      this.defineLazyNodeMatch(event, oldRoot, this._redRoot)
      this.events.emit(event as DocumentEvent)
    }
  }

  /**
   * Install `nodeMatch` on an event as an accessor, so the match is only
   * computed if a subscriber actually reads it.
   *
   * Matching two 1736-node trees costs ~3.5 ms and allocates a result entry per
   * node plus five Maps/Sets — and it ran on *every* keystroke to populate a
   * field that no subscriber in this codebase reads. The capability is real
   * (preserving selection and scroll across re-parses is what it is for), so it
   * stays available; it just stops running speculatively.
   *
   * Callers still write `event.nodeMatch` and see a `NodeMatch | null`. Note the
   * closure keeps `oldRoot` alive for as long as the event object is retained.
   */
  private defineLazyNodeMatch(
    event: object,
    oldRoot: RedNode | null,
    newRoot: RedNode | null,
  ): void {
    if (!oldRoot || !newRoot) {
      Object.defineProperty(event, 'nodeMatch', { value: null, enumerable: true })
      return
    }

    const matcher = this.nodeMatcher
    let memo: NodeMatch | null = null

    Object.defineProperty(event, 'nodeMatch', {
      enumerable: true,
      configurable: true,
      get(): NodeMatch {
        if (memo === null) memo = matcher.match(oldRoot, newRoot)
        return memo
      },
    })
  }

  /**
   * Attach the last change range to a root node.
   *
   * The range travels with the AST so the preview can read it from the root it
   * is about to patch — no prop drilling through workspace → window → preview.
   * `__changeRange` is deliberately not part of RedNode's API; it is a runtime
   * marker owned by the model (the BlockPatcher reads it with a cast).
   */
  private _attachChangeRange(root: RedNode | null): void {
    if (root) {
      ;(root as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange = this._lastChangeRange
    }
  }

  /**
   * Apply a source text change (e.g. from Monaco editor input).
   * Uses incremental parsing when possible.
   *
   * `origin` tags where the change came from — `'local'` (default) for the
   * user's own editing, anything else for programmatic or synced sources
   * (`'remote'`, `'sync'`, a peer id…). It travels on the emitted events, so
   * a collaboration layer can tell its own echo apart from user edits — the
   * classic infinite-loop bug when wiring a CRDT. See `QuasarCollab.MD`.
   */
  applyChange(change: TextChange, origin: string = 'local'): void {
    const oldRoot = this._redRoot

    // Track the change
    this.changeTracker.track(change)

    // The edit range, in both coordinate systems. `change.end` is the OLD
    // end; `start + change.text.length` is the NEW end after the splice.
    this._lastChangeRange = {
      start: change.start,
      end: change.start + change.text.length,
      endOld: change.end,
    }

    // Apply to source
    const before = this._source.slice(0, change.start)
    const after = this._source.slice(change.end)
    this._source = before + change.text + after

    // Note: this._source is later overwritten with the flat `newSource`
    // from the textarea (in applyTextUpdate) to prevent ConsString build-up.

    // Incremental parse (or fall back to full rebuild)
    if (this._redRoot && this._greenRoot && this._options.incremental) {
      try {
        // With `reuseRed`, subtrees whose green is shared by reference are
        // adopted from the old red tree instead of rebuilt. This CONSUMES
        // `oldRoot` (adopted nodes are reparented into the new tree) — safe
        // because nothing walks a superseded red tree, and `oldRoot` is only
        // used below for id preservation and the lazy nodeMatch, both of
        // which tolerate shared nodes.
        // `adopted` counts nodes carried over from the old tree. It decides
        // below which mechanism preserved identity — the two must never both
        // run over the same tree.
        const reuse = { adopted: 0 }
        const buildRed = this._options.reuseRed && oldRoot
          ? (green: GreenNode) => this.buildRedFromGreenReusing(green, oldRoot, reuse)
          : (green: GreenNode) => this.buildRedFromGreen(green)
        const result = this.incrementalParser.reparse(
          this._redRoot,
          this._greenRoot,
          change,
          this._source,
          (text: string, opts?: ReparseParseOptions) => this.parseToGreen(text, opts),
          buildRed,
        )
        // `reparse` always returns a result now: when it cannot splice safely
        // it does the full rebuild itself rather than handing back a null the
        // caller has to interpret.
        this.lastReparsePath = result.path
        this.lastReparseFallbackReason = result.reason ?? null
        this.lastReparseTimings = result.timings
        this._greenRoot = result.green
        this._redRoot = result.red
        // Identity across the edit, by whichever mechanism applies.
        //
        // When subtrees were reused, they ARE the previous nodes and already
        // carry their ids — and running the id walk on top would actively
        // corrupt them: it pairs positionally, so inserting a block makes it
        // pair each survivor with its neighbour and overwrite a live node's
        // id with a different node's (duplicating ids, and changing the
        // `data-node-id` of blocks that never changed). The nodes it would
        // renumber are the re-parsed ones, which are genuinely new.
        //
        // Without reuse every node is fresh, so the walk is what carries
        // identity across — same as in `rebuild`. Note `reparse` can decide
        // on a full rebuild internally, and then nothing is adopted even
        // though reuse was enabled: the count, not the option, is what tells
        // the two situations apart.
        if (oldRoot && reuse.adopted === 0) {
          preserveNodeIds(oldRoot, this._redRoot)
        }
        this._version++
        // The incremental path resolved: the range stays attached to the new
        // root so the preview can find the edited region.
        this._attachChangeRange(this._redRoot)
      } catch {
        this.lastReparsePath = 'full_rebuild'
        this.lastReparseTimings = null
        this.rebuild(this._source)
        return
      }
    } else {
      this.rebuild(this._source)
      return
    }

    // Emit event immediately
    if (this.events.hasListeners('document_changed') || this.events.recordHistory) {
      this.events.emit({
        type: 'document_changed',
        kind: 'text_changed',
        version: this._version,
        source: this._source,
        nodeMatch: null,
        change,
        origin,
        timestamp: Date.now(),
      })
    }

    // Debounced background task for heavy phases
    if (this._analyzeTimeout) {
      clearTimeout(this._analyzeTimeout)
    }
    const runPendingAnalyze = () => {
      this._analyzeTimeout = null
      this._pendingAnalyze = null

      // Background Phase 1: Semantic Analysis
      if (this._options.autoAnalyze) {
        this.analyze()
      }

      // Background Phase 2: Notify UI that semantics are ready — if some UI
      // is listening. `nodeMatch` is lazy here too — see `defineLazyNodeMatch`.
      if (this.events.hasListeners('diagnostics_updated') || this.events.recordHistory) {
        const diagnosticsEvent = {
          type: 'diagnostics_updated' as const,
          version: this._version,
          source: this._source,
          diagnostics: this._diagnostics,
          timestamp: Date.now()
        }
        this.defineLazyNodeMatch(diagnosticsEvent, oldRoot, this._redRoot)
        this.events.emit(diagnosticsEvent as DocumentEvent)
      }
    }
    this._pendingAnalyze = runPendingAnalyze
    this._analyzeTimeout = setTimeout(runPendingAnalyze, 10)
  }

  /**
   * Flush the debounced post-edit analysis, so `diagnostics` describes the
   * *current* tree.
   *
   * `applyChange` defers analysis by a few milliseconds to keep the keystroke
   * path lean. A caller that reads `diagnostics` synchronously right after an
   * edit would otherwise be looking at the previous document's errors — which
   * is exactly what the editor's error panel did.
   */
  ensureAnalyzed(): void {
    const pending = this._pendingAnalyze
    if (!pending) return
    if (this._analyzeTimeout) {
      clearTimeout(this._analyzeTimeout)
    }
    pending()
  }

  /**
   * Calculate a simple diff between the current source and the new source,
   * then apply the change.
   */
  applyTextUpdate(newSource: string, origin: string = 'local'): void {
    if (this._source === newSource) return

    // One forward pass and one backward pass, and that is the whole diff.
    //
    // There used to be two `startsWith` fast paths in front of this, for "pure
    // append" and "pure delete at the end". They were not shortcuts: both are
    // just this scan with a particular answer, and reaching that answer took a
    // full comparison of the shared prefix — which the general case then
    // repeated from scratch. An edit in the middle of a document paid for the
    // same prefix twice, once to rule out the fast path and once to compute
    // the diff it was going to compute anyway.
    //
    // The two cases still come out right, they are simply not special: an
    // append leaves `start === oldLen` and the backward pass stops on the spot,
    // a delete at the end leaves `start === newLen` and likewise.
    const oldSource = this._source
    const oldLen = oldSource.length
    const newLen = newSource.length
    const shared = oldLen < newLen ? oldLen : newLen

    let start = 0
    while (start < shared && oldSource.charCodeAt(start) === newSource.charCodeAt(start)) {
      start++
    }

    let oldEnd = oldLen
    let newEnd = newLen
    while (
      oldEnd > start &&
      newEnd > start &&
      oldSource.charCodeAt(oldEnd - 1) === newSource.charCodeAt(newEnd - 1)
    ) {
      oldEnd--
      newEnd--
    }

    this.applyChange({ start, end: oldEnd, text: newSource.slice(start, newEnd) }, origin)

    // The diff computed here is authoritative: `newEnd`/`oldEnd` are the exact
    // boundary in each coordinate system (applyChange derived the same values
    // from the TextChange — this just re-states them and re-attaches, since
    // the range must ride the current root).
    this._lastChangeRange = { start, end: newEnd, endOld: oldEnd }
    this._attachChangeRange(this._redRoot)

    // Overwrite with the flat source from the textarea to prevent
    // deep ConsStrings from accumulating across edits.
    this._source = newSource
  }

  /**
   * Execute operations within a transaction (undoable).
   *
   * Coherence contract: after a `transact` the model's `source`, green tree
   * and red tree all describe the same document. The transaction mutates the
   * red tree, the result is serialized back to text via `exportSource`, and
   * the model rebuilds from that text — parse stays the single source of
   * truth, exactly as in `applyChange`. (The previous implementation swapped
   * `_redRoot` and left `_source`/`_greenRoot` describing the old document,
   * so the next text edit diffed against a source the tree no longer matched.)
   *
   * Returns `true` if the document changed.
   */
  transact(operations: Operation[], label?: string): boolean {
    if (!this._redRoot) return false

    const before = this._source
    const tx = new Transaction(operations)
    const applied = tx.apply(this._redRoot)
    if (!applied) return false

    // The transaction mutated the red tree in place, so even a no-op result
    // must go through export + rebuild to restore red/green coherence.
    const after = this.exportSource(applied)
    this.rebuild(after)

    if (after === before) return false
    this.undoManager.push({ before, after }, label ?? tx.getLabel())
    return true
  }

  /**
   * Undo the last transaction.
   *
   * Undo/redo replay *source snapshots*, not stored tree mutations: a rebuild
   * replaces every node id, so a retained `Transaction` could never be
   * re-applied against the current tree — and its `invert()` was only defined
   * for one of the six operation kinds anyway. Text is always replayable.
   */
  undo(): boolean {
    const entry = this.undoManager.undo()
    if (!entry) return false
    this.rebuild(entry.before)
    return true
  }

  /**
   * Redo the last undone transaction. See `undo` for why this replays text.
   */
  redo(): boolean {
    const entry = this.undoManager.redo()
    if (!entry) return false
    this.rebuild(entry.after)
    return true
  }

  /**
   * Run semantic analysis on the current tree.
   */
  analyze(): AnalyzeResult {
    if (!this._redRoot) {
      throw new Error('Cannot analyze: no document loaded')
    }
    const result = this.semanticAnalyzer.analyze(this._redRoot, this._source)
    this._diagnostics = result.diagnostics

    // Keep the id index out of the retained result: holding it would pin every
    // RedNode of the *previous* tree alive until the next analyze — a leak in
    // all but name, and measured at +1.3 ms per rebuild in GC pressure alone.
    // It is a getter now, so simply not reading it also means never building it.
    this._lastAnalyzeResult = {
      diagnostics: result.diagnostics,
      duration: result.duration,
      nodesAnalyzed: result.nodesAnalyzed,
    }

    // Attaching diagnostics to nodes used to happen here, and needed an id→node
    // Map of the whole document to do it — a second full walk plus 1736
    // `Map.set` calls, 23% of `analyze()`. The analyzer attaches them during
    // its own walk instead: it has the node in hand at the moment the
    // diagnostic is produced, so both the index and the walk that built it were
    // solving a problem created by separating the two steps.

    return this._lastAnalyzeResult
  }

  /**
   * Find a node by its ID.
   */
  findNode(id: NodeId): RedNode | null {
    return this._redRoot?.findById(id) ?? null
  }

  /**
   * Query the document tree.
   */
  query(q: Query): QueryResult {
    if (!this._redRoot) {
      return { matches: [], total: 0, time: 0 }
    }
    return this.queryEngine.execute(q, this._redRoot)
  }

  /**
   * Register a semantic validator.
   */
  registerValidator(validator: Validator): void {
    this.semanticAnalyzer.register(validator)
  }

  // ── Serialization ──

  /**
   * Get the current document as a DocumentNode tree.
   */
  toDocumentNode(): DocumentNode | null {
    return this._redRoot?.toDocumentNode() ?? null
  }

  /**
   * Get the current source text.
   */
  toString(): string {
    return this._source
  }

  // ── Internal ──

  /**
   * Parse source text to a GreenNode tree.
   * Override this for language-specific parsing.
   *
   * `options.normalizeParagraphs === false` means the text is the inner span
   * of a container rather than a whole document, and root-level grouping must
   * be skipped. Languages without such grouping can ignore it.
   */
  protected parseToGreen(source: string, options?: ReparseParseOptions): GreenNode {
    // Default: use the TreeBuilder
    // Language-specific overrides (BBCodeParser) will provide
    // proper tag-aware parsing.
    return this.treeBuilder.build(
      new ArrayTokenStream([]),
    ).green
  }

  /**
   * Build a RedNode tree from a GreenNode.
   */
  protected buildRedFromGreen(green: GreenNode): RedNode {
    return this.treeBuilder.buildRed(green)
  }

  /**
   * Build a red tree for `green`, reusing subtrees of `oldRed` where the green
   * is shared by reference. The base model has no reuse-aware builder, so it
   * falls back to a full build; language models override this
   * (BBCodeDocumentModel uses `greenToRedNodeReusing`).
   */
  protected buildRedFromGreenReusing(
    green: GreenNode,
    oldRed: RedNode,
    stats?: { adopted: number },
  ): RedNode {
    return this.buildRedFromGreen(green)
  }

  /**
   * Serialize a red tree back to source text. `transact`/`undo`/`redo` rebuild
   * from this text to keep source, green and red coherent.
   *
   * The base model has no syntax to serialize to, so this throws; language
   * models override it (BBCodeDocumentModel uses the BBCodeExporter).
   * Failing loudly here beats the alternative: silently desynchronizing the
   * model's three representations.
   */
  protected exportSource(root: RedNode): string {
    throw new Error(
      `DocumentModel.exportSource is not implemented for language '${this._language}' — ` +
        'override it in the language-specific model to enable transact/undo/redo',
    )
  }
}
