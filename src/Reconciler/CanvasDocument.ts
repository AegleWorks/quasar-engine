/**
 * CanvasDocument — a WYSIWYG canvas as a VIEW of a document it does not own,
 * and everything it does done incrementally.
 *
 * ─── One document, many views ─────────────────────────────────────────────
 *
 * The canvas used to parse its own copy of the text: its own model, kept in
 * step with the editor's by string comparisons and an echo guard (a text the
 * canvas emitted could come back late and undo a keystroke). Two copies of the
 * truth. Roslyn has one: a workspace holds the document, and every view — the
 * editor, the analyzers, a refactoring preview — reads the same snapshot and
 * sends its edits back through the workspace (`TryApplyChanges`).
 *
 * Here the workspace is the `CanvasHost`: `current()` is the snapshot (the
 * text and the tree parsed from exactly that text), `apply()` sends edits to
 * the document — to the text editor that owns undo, to the collaboration
 * transport — and returns once the document has them. The canvas reads the
 * host's tree, never parses, and never decides which of two texts is newer:
 * there is only the host's.
 *
 * A caller without a document of its own (a comment box) uses
 * `OwnedCanvasHost`, a private model — the old behaviour, behind the same door.
 *
 * ─── Incremental ──────────────────────────────────────────────────────────
 *
 *   - `patchBlocksInto`, windowed on what changed between the snapshot the
 *     canvas painted and the one it shows, so only those blocks are
 *     re-rendered and morphed (an open box stays open);
 *   - a `MutationObserver` that notes which top-level blocks the USER changed,
 *     so a keystroke reconciles those blocks and nothing else.
 *
 * Measured in Chromium on the 547 KB fixture, with the old full repaint as the
 * baseline: ~150 ms → ~2 ms per command, 200–290 ms → ~7 ms per keystroke.
 *
 * The invariant it keeps: after `show` (and `edit`, which ends in one), the
 * canvas is exactly the render of the snapshot it painted, `root`. Between a
 * keystroke and the `edit` of its reconciled changes, the DOM is ahead of that
 * snapshot by the keystroke, which is what `reconcile` reads.
 *
 * What the host must guarantee: the painted `root` stays valid until the next
 * `show`. A model that recycles red nodes across edits (Quasar's does, for
 * speed) invalidates the previous root when it applies the next change — so
 * the host shows every change as it happens (subscribe → `show()`), and
 * anything the canvas must read in the OLD coordinates (the caret, before an
 * edit from elsewhere) is read before the document changes.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { TextChange, TextChangeRange } from '../Incremental/ChangeTracker'
import type { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { patchBlocksInto, type PatchBlocksStats } from '../Visitors/BlockPatcher'
import { reconcileVisualDOMToBBCode, type ReconcileResult } from './SurgicalReconciler'

/** A document as the canvas sees it: a text and the tree parsed from exactly it. */
export interface CanvasSnapshot {
  readonly source: string
  readonly root: RedNode | null
}

/**
 * The document a canvas is a view of — the workspace, in Roslyn's terms.
 */
export interface CanvasHost {
  /** The document now. `root` must be the parse of `source`, not an older one. */
  current(): CanvasSnapshot
  /**
   * Sends changes (non-overlapping, against `current().source`) to the
   * document. Synchronous: when it returns, `current()` has them — or has
   * whatever the document made of them (a read-only session refuses them).
   */
  apply(changes: readonly TextChange[]): void
}

/**
 * Non-overlapping changes, all against `source`, as the ONE change that spans
 * them: the incremental parser reparses one window, and the patcher reads one
 * range. A Bold is two insertions a word apart; the span is the word.
 */
export function spanOf(source: string, changes: readonly TextChange[]): TextChange | null {
  if (changes.length === 0) return null
  if (changes.length === 1) return changes[0]
  const sorted = [...changes].sort((a, b) => a.start - b.start)
  const start = sorted[0].start
  let end = start
  let text = ''
  for (const c of sorted) {
    text += source.slice(end, c.start) + c.text
    end = c.end
  }
  return { start, end, text }
}

/** The one change that turns `a` into `b`: their common prefix and suffix kept. */
export function changeBetween(a: string, b: string): TextChange | null {
  if (a === b) return null
  let s = 0
  const max = Math.min(a.length, b.length)
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) {
    ea--
    eb--
  }
  return { start: s, end: ea, text: b.slice(s, eb) }
}

/** The part of a document model `OwnedCanvasHost` uses. */
export interface CanvasModel {
  readonly source: string
  readonly redRoot: RedNode | null
  applyChange(change: TextChange, origin?: string, resultingSource?: string): void
}

/**
 * A document of the canvas' own: for a canvas nobody else edits (a comment
 * box), or a test. `load` starts a new one; `sync` brings it to a text
 * written elsewhere, as one incremental change.
 */
export class OwnedCanvasHost implements CanvasHost {
  private model: CanvasModel | null = null

  constructor(private readonly createModel: (source: string) => CanvasModel) {}

  current(): CanvasSnapshot {
    return { source: this.model?.source ?? '', root: this.model?.redRoot ?? null }
  }

  apply(changes: readonly TextChange[]): void {
    if (!this.model) {
      this.load(applyChanges('', changes))
      return
    }
    const change = spanOf(this.model.source, changes)
    if (change) this.model.applyChange(change, 'canvas')
  }

  /** A new document: its tree shares nothing with the last one (show it with `repaint`). */
  load(source: string): void {
    this.model = this.createModel(source)
  }

  /** The text written elsewhere, as one change. False when there was nothing to do. */
  sync(source: string): boolean {
    if (!this.model) {
      this.load(source)
      return true
    }
    const change = changeBetween(this.model.source, source)
    if (change) this.model.applyChange(change, 'sync')
    return change !== null
  }
}

function applyChanges(source: string, changes: readonly TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

export interface CanvasDocumentOptions {
  /** The document the canvas shows and edits. */
  host: CanvasHost
  /** The renderer that paints the canvas — and that the reconciler compares with. */
  renderer: HTMLRenderer
  /** The exporter for the canvas' dialect. */
  exporter: BBCodeExporter
}

export interface ShowOptions {
  /**
   * Paint from scratch: the snapshot is not a continuation of the painted one
   * (another document, another dialect — node ids that share nothing).
   */
  repaint?: boolean
}

export class CanvasDocument {
  /** The snapshot the canvas is the render of; null before the first `show`. */
  private painted: CanvasSnapshot | null = null
  /** The renderer or exporter changed: the next `show` repaints. */
  private stale = false
  private readonly observer: MutationObserver | null
  /** Top-level children the user changed since the canvas last matched its render. */
  private readonly dirty = new Set<Node>()
  /** The container's own children were added, removed or moved: only the full reconcile can tell. */
  private structural = false

  constructor(readonly container: HTMLElement, private options: CanvasDocumentOptions) {
    const MO = (container.ownerDocument?.defaultView as (Window & typeof globalThis) | null)?.MutationObserver
    this.observer = MO ? new MO(records => this.note(records)) : null
    this.observer?.observe(container, { subtree: true, childList: true, characterData: true, attributes: true })
  }

  /** The source the canvas shows. */
  get source(): string {
    return this.painted?.source ?? ''
  }

  /** The tree the canvas is the render of. */
  get root(): RedNode | null {
    return this.painted?.root ?? null
  }

  get host(): CanvasHost {
    return this.options.host
  }

  /**
   * Another host, renderer or exporter. Another host or renderer paints
   * differently: the next `show` repaints. The exporter only reads the DOM.
   */
  configure(options: CanvasDocumentOptions): void {
    if (options.renderer !== this.options.renderer || options.host !== this.options.host) this.stale = true
    this.options = options
  }

  /**
   * Brings the canvas to the host's snapshot — an edit made anywhere: here,
   * in the text editor, by a collaborator, an undo. Only the blocks that
   * changed between the two snapshots are repainted. Null when the canvas
   * already showed it.
   */
  show(options: ShowOptions = {}): PatchBlocksStats | null {
    const next = this.options.host.current()
    const prev = this.painted
    const repaint = options.repaint || this.stale || !prev
    if (!repaint && next.source === prev!.source && next.root === prev!.root) return null
    this.painted = next
    this.stale = false
    if (repaint) return this.patch({ forceRebuild: true })
    const change = changeBetween(prev!.source, next.source)
    // The same text as another tree (reparsed): compare every block.
    if (!change) return this.patch({ change: null })
    return this.patch({ change: { start: change.start, end: change.start + change.text.length, endOld: change.end } })
  }

  /**
   * Sends changes made on the canvas — a command's, a keystroke's once
   * reconciled — to the document, and shows what it made of them. When the
   * document refused them (a read-only session), the canvas is painted again
   * from it: the DOM holds a keystroke the document does not, and only a
   * repaint is sure to take it out (the patcher compares renders, not DOM).
   */
  edit(changes: readonly TextChange[]): PatchBlocksStats | null {
    if (changes.length === 0 || !this.painted) return null
    const expected = applyChanges(this.painted.source, changes)
    this.options.host.apply(changes)
    const stats = this.show()
    if (this.painted.source !== expected) return this.patch({ forceRebuild: true })
    return stats
  }

  /**
   * How many top-level blocks the last `reconcile` looked at, or null when it
   * had to compare them all (a structural change). For tests and benches.
   */
  lastDirtyBlocks: number | null = null

  /** The canvas' DOM, back into edits against `source` — only the blocks the user touched. */
  reconcile(): ReconcileResult {
    this.collect()
    const dirty = this.structural ? undefined : [...this.dirty]
    this.lastDirtyBlocks = dirty ? dirty.length : null
    const result = reconcileVisualDOMToBBCode(
      this.source,
      this.root,
      this.container,
      this.options.exporter,
      this.options.renderer,
      { dirty },
    )
    this.dirty.clear()
    this.structural = false
    return result
  }

  /** Stops watching the DOM. */
  dispose(): void {
    this.observer?.disconnect()
  }

  private patch(extra: { forceRebuild?: boolean; change?: TextChangeRange | null }): PatchBlocksStats {
    this.collect()
    const stats = patchBlocksInto(this.container, this.root, { renderer: this.options.renderer, ...extra })
    // The patch's own mutations are not the user's; and after it the canvas
    // matches its render again.
    this.observer?.takeRecords()
    this.dirty.clear()
    this.structural = false
    return stats
  }

  private collect(): void {
    if (this.observer) this.note(this.observer.takeRecords())
  }

  private note(records: MutationRecord[]): void {
    for (const r of records) {
      // Opening a box is the view's state, not the document's (the reconciler
      // ignores it too): it must not make the next keystroke compare that box.
      if (r.type === 'attributes' && r.attributeName === 'open') continue
      if (r.type === 'childList' && r.target === this.container) {
        this.structural = true
        continue
      }
      let n: Node | null = r.target
      while (n && n.parentNode !== this.container) n = n.parentNode
      if (n) this.dirty.add(n)
      else this.structural = true
    }
  }
}
