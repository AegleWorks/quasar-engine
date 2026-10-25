/**
 * Quasar — Language service types
 *
 * Offsets, ranges and node kinds are the engine's own vocabulary; this module
 * adds only the shapes an editor asks for. Deliberately LSP-shaped but not LSP:
 * no positions, no JSON-RPC, no `Uri` — the caller already has a DocumentModel
 * and a string. A bridge to LSP can convert these without guessing.
 */

import type { NodeId, NodeKind, SourceRange } from './core'
import type { Diagnostic } from './diagnostics'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

// ── Outline ──────────────────────────────────────────────────────

/**
 * One entry in the document outline: a block the author can navigate to.
 *
 * Nested the way the document is nested — a box inside a quote hangs off the
 * quote — so a breadcrumb or a Ctrl+Shift+O tree does not have to rebuild the
 * containment from ranges.
 */
export interface LanguageSymbol {
  readonly name: string
  /** What the tag is, in a few words; `details`, not the symbol's name. */
  readonly detail: string
  readonly kind: NodeKind
  /** The whole block, opening tag included. */
  readonly range: SourceRange
  /** Where to put the caret when the entry is chosen: the opening tag. */
  readonly selectionRange: SourceRange
  readonly nodeId: NodeId
  readonly children: readonly LanguageSymbol[]
}

// ── Quick info ───────────────────────────────────────────────────

export type QuickInfoKind = 'tag' | 'symbol' | 'attribute'

/**
 * What a hover card needs. `documentation` is plain text, not markdown: Quasar
 * has no locale and no renderer for either, and a UI that wants to style it can.
 */
export interface QuickInfo {
  readonly kind: QuickInfoKind
  /** Tag name (`colour` → `color`), symbol name, or attribute name. */
  readonly name: string
  readonly documentation: string
  /** The source span the answer describes. */
  readonly range: SourceRange
  readonly nodeId: NodeId
  /** Present on `tag`: the registry entry's label, category and deprecation. */
  readonly tag?: {
    readonly label: string
    readonly category?: string
    readonly deprecated: boolean
    readonly replacement?: string
  }
  /** Present on `symbol`: how many links point at it. */
  readonly referenceCount?: number
}

// ── Navigation and rename ────────────────────────────────────────

/** A span and the node it belongs to. */
export interface LanguageLocation {
  readonly range: SourceRange
  readonly nodeId: NodeId
}

/**
 * The result of a rename: edits against the CURRENT source, plus the names
 * involved. The caller applies them (Monaco or `applyEditsToSource`); the
 * document is never mutated.
 */
export interface RenameResult {
  readonly oldName: string
  readonly newName: string
  readonly edits: readonly SurgicalEdit[]
}

// ── Completion ───────────────────────────────────────────────────

export type CompletionItemKind = 'tag' | 'closing-tag' | 'attribute' | 'value'

export interface CompletionItem {
  readonly label: string
  readonly kind: CompletionItemKind
  readonly detail: string
  readonly documentation?: string
  /** Text to insert, when it differs from the label. */
  readonly insertText?: string
  /**
   * Replace this span with the item. Present when completing inside an
   * existing `[tag` or `[tag=…` so the provider does not have to guess how
   * much of the word is already there.
   */
  readonly replaceRange?: SourceRange
}

// ── Semantic tokens and folding ──────────────────────────────────

export type SemanticTokenType =
  | 'tag'
  | 'attribute'
  | 'text'
  | 'string'
  | 'punctuation'
  | 'invalid'
  | 'whitespace'

/** A classified span. Tokens are non-overlapping and in source order. */
export interface SemanticToken {
  readonly type: SemanticTokenType
  readonly range: SourceRange
}

export interface FoldingRange {
  /** 0-based, like `SourceText.positionAt`. */
  readonly startLine: number
  /** Inclusive. */
  readonly endLine: number
  readonly kind: 'block' | 'region'
}

// ── Service result payloads ──────────────────────────────────────

export interface LanguageDiagnostics {
  readonly version: number
  readonly diagnostics: readonly Diagnostic[]
}

export interface LanguageServiceStats {
  /** Document version the cached answers belong to. */
  readonly version: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly symbolBuilds: number
  /** Top-level blocks whose token list was reused from a previous version. */
  readonly tokenBlocksReused: number
  /** Top-level blocks tokenized from scratch. */
  readonly tokenBlocksBuilt: number
  /** Top-level blocks whose outline was reused from a previous version. */
  readonly outlineBlocksReused: number
  /** Top-level blocks whose outline was walked from scratch. */
  readonly outlineBlocksBuilt: number
}
