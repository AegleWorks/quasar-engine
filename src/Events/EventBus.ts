/**
 * DocumentEngine — EventBus
 *
 * Publish/subscribe event system for document changes.
 * Each DocumentModel has its own EventBus instance.
 *
 * Events include:
 * - document_changed (rebuild, edit, undo/redo)
 * - node_changed (insert, delete, update, move)
 * - diagnostic_updated
 * - transaction_applied
 * - cursor_moved
 * - selection_changed
 */

import type { DocumentChangeKind, NodeId } from '../Types/core'
import type { Operation } from '../Types/operations'
import type { NodeMatch } from '../Syntax/NodeMatcher'
import type { TextChange } from '../Incremental/ChangeTracker'

export type DocumentEventType =
  | 'document_changed'
  | 'node_inserted'
  | 'node_deleted'
  | 'node_updated'
  | 'diagnostics_updated'
  | 'transaction_applied'
  | 'undo_performed'
  | 'redo_performed'
  | 'cursor_moved'
  | 'selection_changed'

export interface DocumentEvent {
  type: DocumentEventType
  kind?: DocumentChangeKind
  version?: number
  source?: string
  nodeId?: NodeId
  nodeMatch?: NodeMatch | null
  change?: TextChange
  operations?: Operation[]
  /**
   * Where the change came from: `'local'` for user editing, anything else for
   * programmatic/synced sources. Lets a collaboration layer ignore the echo
   * of changes it applied itself. Absent on events with no single cause.
   */
  origin?: string
  timestamp: number
  [key: string]: unknown
}

export type DocumentEventHandler = (event: DocumentEvent) => void

export class DocumentEventBus {
  private listeners: Map<DocumentEventType, Set<DocumentEventHandler>> = new Map()
  private history: DocumentEvent[] = []
  private maxHistory: number = 50

  /**
   * Record emitted events so `getHistory()` returns them. Off by default:
   * nothing reads the history today, and a retained event pins its `source`
   * string — and, through the lazy `nodeMatch` accessor, the entire previous
   * red/green tree — so an always-on history held megabytes per document
   * for nobody. Turn it on for debugging or replay tooling.
   */
  recordHistory: boolean = false

  /**
   * Subscribe to an event type.
   */
  on(type: DocumentEventType, handler: DocumentEventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(handler)
    }
  }

  /**
   * Whether any handler is subscribed to `type` (or to anything, if omitted).
   *
   * Emitters use this to skip building event payloads nobody will see — the
   * common case, since a headless model has no subscribers at all.
   */
  hasListeners(type?: DocumentEventType): boolean {
    if (type !== undefined) {
      return (this.listeners.get(type)?.size ?? 0) > 0
    }
    for (const handlers of this.listeners.values()) {
      if (handlers.size > 0) return true
    }
    return false
  }

  /**
   * Subscribe to all events.
   */
  onAny(handler: DocumentEventHandler): () => void {
    const unsubscribers: (() => void)[] = []
    const types: DocumentEventType[] = [
      'document_changed', 'node_inserted', 'node_deleted', 'node_updated',
      'diagnostics_updated', 'transaction_applied', 'undo_performed', 'redo_performed',
      'cursor_moved', 'selection_changed',
    ]
    for (const type of types) {
      unsubscribers.push(this.on(type, handler))
    }
    return () => unsubscribers.forEach(u => u())
  }

  /**
   * Emit an event.
   */
  emit(event: DocumentEvent): void {
    const handlers = this.listeners.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch (error) {
          console.warn(`[EventBus] Handler error for ${event.type}:`, error)
        }
      }
    }

    // Store in history — only when someone opted in (see `recordHistory`).
    if (this.recordHistory) {
      this.history.push(event)
      if (this.history.length > this.maxHistory) {
        this.history.shift()
      }
    }
  }

  /**
   * Remove a specific handler.
   */
  off(type: DocumentEventType, handler: DocumentEventHandler): void {
    this.listeners.get(type)?.delete(handler)
  }

  /**
   * Get event history.
   */
  getHistory(): DocumentEvent[] {
    return [...this.history]
  }

  /**
   * Clear all listeners and history.
   */
  clear(): void {
    this.listeners.clear()
    this.history = []
  }
}
