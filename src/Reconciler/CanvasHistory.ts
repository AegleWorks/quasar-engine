/**
 * Undo for a canvas that owns its document.
 *
 * With a shared document the text editor owns undo. A canvas on its own had only
 * the browser's, which remembers DOM mutations it made itself: every edit the
 * canvas applies is invisible to it, so Ctrl+Z after Enter did nothing and after
 * typing it took apart a DOM the document no longer matched. This one remembers
 * text changes, the unit everything here already speaks.
 *
 * An entry stays valid while the document changes from outside (the Text Studio
 * rewrites the tag around the text on every palette change): `rebase` carries
 * every offset through such a change.
 */

import type { TextChange } from '../Incremental/ChangeTracker'

/** A selection as offsets into the source. */
interface Offsets {
  start: number
  end: number
}

/** The changes that take a step (or take it back), and the selection it leaves. */
export interface HistoryStep {
  changes: TextChange[]
  selection: Offsets | null
}

/** A change and its inverse, against the source just before and just after it. */
interface Edit {
  forward: TextChange[]
  backward: TextChange[]
}

interface Entry {
  edits: Edit[]
  before: Offsets | null
  after: Offsets | null
}

const LIMIT = 200

function inverseOf(source: string, changes: readonly TextChange[]): TextChange[] {
  const sorted = [...changes].sort((a, b) => a.start - b.start)
  let shift = 0
  return sorted.map(c => {
    const start = c.start + shift
    shift += c.text.length - (c.end - c.start)
    return { start, end: start + c.text.length, text: source.slice(c.start, c.end) }
  })
}

export class CanvasHistory {
  private past: Entry[] = []
  private future: Entry[] = []

  /**
   * An edit about to be applied to `source`. `join` folds it into the last entry,
   * so a run of keystrokes is one step.
   */
  record(source: string, changes: readonly TextChange[], selection: { before: Offsets | null; after: Offsets | null }, join = false): void {
    const edit = { forward: [...changes], backward: inverseOf(source, changes) }
    this.future = []
    const last = this.past[this.past.length - 1]
    if (join && last) {
      last.edits.push(edit)
      last.after = selection.after
      return
    }
    this.past.push({ edits: [edit], ...selection })
    if (this.past.length > LIMIT) this.past.shift()
  }

  /** The steps that undo the last entry, in the order they apply. Null with nothing to undo. */
  undo(): HistoryStep[] | null {
    const entry = this.past.pop()
    if (!entry) return null
    this.future.push(entry)
    const steps = [...entry.edits].reverse().map(e => ({ changes: e.backward, selection: null as Offsets | null }))
    steps[steps.length - 1].selection = entry.before
    return steps
  }

  redo(): HistoryStep[] | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push(entry)
    const steps = entry.edits.map(e => ({ changes: e.forward, selection: null as Offsets | null }))
    steps[steps.length - 1].selection = entry.after
    return steps
  }

  /** Forgets everything: what it remembers no longer describes the document. */
  clear(): void {
    this.past = []
    this.future = []
  }

  /**
   * The document changed from outside. Offsets past the change move with it;
   * when an entry's edits touch what it replaced they mean nothing any more and
   * the whole history goes.
   */
  rebase(change: TextChange): void {
    const delta = change.text.length - (change.end - change.start)
    if (delta === 0 && change.text === '') return
    const entries = [...this.past, ...this.future]
    const moved = (o: number): number | null => (o <= change.start ? o : o >= change.end ? o + delta : null)
    const shift = (c: TextChange): TextChange | null => {
      const start = moved(c.start)
      const end = moved(c.end)
      return start === null || end === null ? null : { start, end, text: c.text }
    }
    for (const entry of entries) {
      for (const edit of entry.edits) {
        const forward = edit.forward.map(shift)
        const backward = edit.backward.map(shift)
        if (forward.includes(null) || backward.includes(null)) {
          this.clear()
          return
        }
        edit.forward = forward as TextChange[]
        edit.backward = backward as TextChange[]
      }
      for (const key of ['before', 'after'] as const) {
        const selection = entry[key]
        if (!selection) continue
        const start = moved(selection.start)
        const end = moved(selection.end)
        entry[key] = start === null || end === null ? null : { start, end }
      }
    }
  }
}
