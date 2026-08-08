/**
 * DocumentEngine — UndoManager
 *
 * Manages the undo/redo history stack.
 *
 * Entries are source-text snapshots, not stored tree mutations: the model
 * rebuilds from text on undo/redo, so an entry stays replayable even after
 * intervening rebuilds have replaced every node id it could have referenced.
 * (The previous design stored `Transaction`s, whose `invert()` was only
 * defined for one of the six operation kinds and whose one-shot `_applied`
 * flag made redo a silent no-op.)
 *
 * Inspired by VSCode's undo stack.
 */

export interface UndoEntry {
  /** Source text before the change */
  before: string
  /** Source text after the change */
  after: string
  label: string
  timestamp: number
}

export class UndoManager {
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private maxSize: number

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize
  }

  /**
   * Push a change (as before/after source snapshots) onto the undo stack.
   */
  push(snapshot: { before: string; after: string }, label?: string): void {
    this.undoStack.push({
      before: snapshot.before,
      after: snapshot.after,
      label: label ?? 'Edit',
      timestamp: Date.now(),
    })

    // Clear redo stack on new action
    this.redoStack = []

    // Enforce stack size limit
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift()
    }
  }

  /**
   * Undo the last change.
   */
  undo(): UndoEntry | null {
    const entry = this.undoStack.pop()
    if (!entry) return null

    this.redoStack.push(entry)
    return entry
  }

  /**
   * Redo the last undone change.
   */
  redo(): UndoEntry | null {
    const entry = this.redoStack.pop()
    if (!entry) return null

    this.undoStack.push(entry)
    return entry
  }

  /**
   * Peek at the top of the undo stack without removing.
   */
  peekUndo(): UndoEntry | null {
    return this.undoStack[this.undoStack.length - 1] ?? null
  }

  /**
   * Peek at the top of the redo stack without removing.
   */
  peekRedo(): UndoEntry | null {
    return this.redoStack[this.redoStack.length - 1] ?? null
  }

  /**
   * Clear both stacks.
   */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  /**
   * Get the number of undoable actions.
   */
  get undoCount(): number {
    return this.undoStack.length
  }

  /**
   * Get the number of redoable actions.
   */
  get redoCount(): number {
    return this.redoStack.length
  }
}
