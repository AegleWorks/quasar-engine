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
