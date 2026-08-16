/**
 * DocumentEngine — ChangeTracker
 *
 * Tracks text changes made to the document source.
 * Used by IncrementalParser to determine what needs to be re-parsed.
 */

export interface TextChange {
  start: number
  end: number
  text: string
}

/**
 * Source range of a text edit, in BOTH coordinate systems.
 *
 * An edit sits between two documents: `start`/`end` describe the changed
 * region in NEW-source coordinates (the current document), while `endOld` is
 * the end of the replaced region in OLD-source coordinates. The incremental
 * preview (`BlockPatcher`) uses `start`/`endOld` to locate the affected blocks
 * in the PREVIOUS tree (whose offsets are pre-edit) and `start`/`end` in the
 * new one — insertions or deletions between the two make the naive single-`end`
 * wrong, which is exactly why both ends are kept.
 */
export interface TextChangeRange {
  /** Start of the edited region (identical in both coordinate systems). */
  start: number
  /** End of the edited region, in new-source coordinates. */
  end: number
  /** End of the replaced region, in old-source coordinates. */
  endOld: number
}

export interface TextChangeStats {
  totalChanges: number
  totalInserted: number
  totalDeleted: number
  lastChange: TextChange | null
}

export class ChangeTracker {
  private changes: TextChange[] = []
  private maxHistory: number = 100

  constructor(maxHistory?: number) {
    if (maxHistory) this.maxHistory = maxHistory
  }

  /**
   * Track a text change.
   */
  track(change: TextChange): void {
    this.changes.push(change)
    if (this.changes.length > this.maxHistory) {
      this.changes.shift()
    }
  }

  /**
   * Get all tracked changes.
   */
  getAll(): TextChange[] {
    return [...this.changes]
  }

  /**
   * Get the most recent change.
   */
  getLast(): TextChange | null {
    return this.changes.length > 0 ? this.changes[this.changes.length - 1] : null
  }

  /**
   * Get the affected range for the last N changes.
   * Returns null if no changes have been tracked.
   */
  getAffectedRange(count: number = 1): { start: number; end: number } | null {
    if (this.changes.length === 0) return null

    const relevant = this.changes.slice(-count)
    return {
      start: Math.min(...relevant.map(c => c.start)),
      end: Math.max(...relevant.map(c => c.end)),
    }
  }

  /**
   * Clear change history.
   */
  clear(): void {
    this.changes = []
  }

  /**
   * Get statistics about tracked changes.
   */
  getStats(): TextChangeStats {
    return {
      totalChanges: this.changes.length,
      totalInserted: this.changes.reduce((sum, c) => sum + c.text.length, 0),
      totalDeleted: this.changes.reduce((sum, c) => sum + (c.end - c.start), 0),
      lastChange: this.getLast(),
    }
  }
}
