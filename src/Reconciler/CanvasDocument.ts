/**
 * CanvasDocument — a WYSIWYG canvas kept as the render of its document, and
 * everything it does done incrementally.
 *
 * The canvas used to repaint by parsing the whole source and replacing its
 * whole `innerHTML`, and to reconcile a keystroke by re-rendering every
 * top-level block to pair them with the DOM. Measured in Chromium on the
 * 547 KB fixture: ~150 ms per command (Enter, Bold, paste), of which the
 * command itself was under 1 ms, and 200–290 ms per keystroke. The pieces to
 * do better already existed for the preview; this puts them together for the
 * canvas:
 *
 *   - a `DocumentModel` of its own, so an edit is `applyChange`: the
 *     incremental parser, with node ids kept across it;
 *   - `patchBlocksInto`, windowed on the edit's range, so only the blocks it
 *     touched are re-rendered and morphed (an open box stays open);
 *   - a `MutationObserver` that notes which top-level blocks the USER changed,
 *     so a keystroke reconciles those blocks and nothing else.
 *
 * The invariant it keeps: after `load`, `applyChanges` and `sync`, the canvas
 * is exactly the render of `root`. Between a keystroke and the `applyChanges`
 * of its reconciled edits, the DOM is ahead of the model by that keystroke,
 * which is what `reconcile` reads.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { TextChange, TextChangeRange } from '../Incremental/ChangeTracker'
import type { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { patchBlocksInto, type PatchBlocksStats } from '../Visitors/BlockPatcher'
import { reconcileVisualDOMToBBCode, type ReconcileResult } from './SurgicalReconciler'

/** The part of a document model the canvas uses. */
export interface CanvasModel {
  readonly source: string
  readonly redRoot: RedNode | null
  readonly lastChangeRange: TextChangeRange | null
  applyChange(change: TextChange, origin?: string, resultingSource?: string): void
}

export interface CanvasDocumentOptions {
  /** A model for `source`, parsed as the document is (its dialect, its pairing). */
  createModel: (source: string) => CanvasModel
  /** The renderer that paints the canvas — and that the reconciler compares with. */
  renderer: HTMLRenderer
  /** The exporter for the canvas' dialect. */
  exporter: BBCodeExporter
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

export class CanvasDocument {
  private model: CanvasModel | null = null
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
    return this.model?.source ?? ''
  }

  /** The tree the canvas is the render of. */
  get root(): RedNode | null {
    return this.model?.redRoot ?? null
  }

  /** A renderer or exporter change (the dialect): the next `load` uses them. */
  configure(options: CanvasDocumentOptions): void {
    this.options = options
  }

  /** Paints `source` from scratch: a new model, the whole canvas. Once per document. */
  load(source: string): PatchBlocksStats {
    this.model = this.options.createModel(source)
    return this.patch({ forceRebuild: true })
  }

  /**
   * Applies changes made to the source — a command's, a keystroke's once
   * reconciled — to the model, and repaints only the blocks they touched.
   * Null when there was nothing to apply.
   */
  applyChanges(changes: readonly TextChange[]): PatchBlocksStats | null {
    if (!this.model) return null
    const change = spanOf(this.model.source, changes)
    if (!change) return null
    this.model.applyChange(change, 'canvas')
    return this.patch({ change: this.model.lastChangeRange ?? undefined })
  }

  /**
   * Brings the canvas to `source`, an edit made elsewhere (the text editor, a
   * collaborator, an undo): the difference is one change, applied like any other.
   */
  sync(source: string): PatchBlocksStats | null {
    if (!this.model) return this.load(source)
    const change = changeBetween(this.model.source, source)
    return change ? this.applyChanges([change]) : null
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

  private patch(extra: { forceRebuild?: boolean; change?: TextChangeRange }): PatchBlocksStats {
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
