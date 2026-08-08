/**
 * DocumentEngine — Diagnostic Types
 *
 * Diagnostics are messages attached to specific nodes or ranges
 * in the document tree. Inspired by VSCode's diagnostic model.
 */

import type { Range } from './tokens'
import type { NodeId, NodeKind } from './core'

// ─── Severity ──────────────────────────────────────────────────

export type DiagnosticSeverity = 'hint' | 'info' | 'warning' | 'error'

export const DIAGNOSTIC_SEVERITY: Record<DiagnosticSeverity, number> = {
  hint: 0,
  info: 1,
  warning: 2,
  error: 3,
}

// ─── Tags ──────────────────────────────────────────────────────

export type DiagnosticTag =
  | 'unnecessary'
  | 'deprecated'
  | 'unused'
  | 'redundant'

// ─── Diagnostic ────────────────────────────────────────────────

export interface Diagnostic {
  // There is deliberately no `id` field. Each diagnostic used to mint a
  // crypto.randomUUID() that no reader in the engine or the app ever
  // consumed — measured at 14% of analyze() on error-heavy documents. A
  // diagnostic is identified by what it says and where: (code, range, nodeId).
  /** Machine-readable code (e.g. 'invalid-color', 'missing-close-tag') */
  code: string
  /** Human-readable message */
  message: string
  /** Severity level */
  severity: DiagnosticSeverity
  /** Optional tags for additional categorization */
  tags: DiagnosticTag[]
  /** Source range in the original text */
  range: Range | null
  /** Node ID this diagnostic is attached to */
  nodeId: NodeId | null
  /** Node kind for context */
  nodeKind: NodeKind | null
  /** Source of this diagnostic (built-in, plugin name, etc.) */
  source: string
  /** Optional related information */
  related?: DiagnosticRelatedInfo[]
  /** Optional fix suggestions */
  fixes?: DiagnosticFix[]
}

export interface DiagnosticRelatedInfo {
  message: string
  range: Range | null
  nodeId: NodeId | null
}

export interface DiagnosticFix {
  description: string
  /** Whether this fix is automatic or requires user confirmation */
  isAutomatic: boolean
  /** The operations to apply as a fix */
  operations: FixOperation[]
}

export type FixOperation =
  | { kind: 'replace_text'; range: Range; newText: string }
  | { kind: 'insert_text'; position: number; text: string }
  | { kind: 'delete_range'; range: Range }
  | { kind: 'wrap_in_tag'; tagName: string; range: Range }

// ─── Diagnostic Collection ─────────────────────────────────────

export interface DiagnosticCollection {
  /** All diagnostics */
  items: Diagnostic[]
  /** Count by severity */
  errorCount: number
  warningCount: number
  infoCount: number
  hintCount: number
  /** Quick access: only errors */
  errors: Diagnostic[]
  /** Quick access: only warnings */
  warnings: Diagnostic[]
}

export function createDiagnosticCollection(): DiagnosticCollection {
  return {
    items: [],
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    hintCount: 0,
    errors: [],
    warnings: [],
  }
}

export function createDiagnostic(
  code: string,
  message: string,
  severity: DiagnosticSeverity,
  options?: {
    nodeId?: NodeId | null
    nodeKind?: NodeKind | null
    range?: Range | null
    tags?: DiagnosticTag[]
    source?: string
    related?: DiagnosticRelatedInfo[]
    fixes?: DiagnosticFix[]
  },
): Diagnostic {
  return {
    code,
    message,
    severity,
    tags: options?.tags ?? [],
    range: options?.range ?? null,
    nodeId: options?.nodeId ?? null,
    nodeKind: options?.nodeKind ?? null,
    source: options?.source ?? 'document-engine',
    related: options?.related,
    fixes: options?.fixes,
  }
}

export function addDiagnostic(
  collection: DiagnosticCollection,
  diagnostic: Diagnostic,
): void {
  collection.items.push(diagnostic)
  switch (diagnostic.severity) {
    case 'error':
      collection.errorCount++
      collection.errors.push(diagnostic)
      break
    case 'warning':
      collection.warningCount++
      collection.warnings.push(diagnostic)
      break
    case 'info':
      collection.infoCount++
      break
    case 'hint':
      collection.hintCount++
      break
  }
}
