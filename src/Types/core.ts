/**
 * DocumentEngine — Core Types
 *
 * The foundational types for the entire Language Platform.
 * Every layer builds on these.
 */

import type { Diagnostic } from './diagnostics'
import type { Range } from './tokens'

// ─── Node Identity ─────────────────────────────────────────────

/** Stable identifier that survives incremental re-parses */
export type NodeId = string & { readonly __brand: 'NodeId' }

/**
 * Monotonic counter backing `createNodeId`.
 *
 * Deliberately NOT a UUID. Node IDs are process-local and ephemeral — they are
 * regenerated on every parse and never restored from persistence — so the
 * randomness of `crypto.randomUUID()` bought nothing while costing on two axes:
 * it is ~7x slower per call (and a full document parse mints one per node), and
 * its 36 characters are echoed into *every* element as `data-node-id`, inflating
 * the emitted HTML and the work the DOM morpher has to diff.
 *
 * A counter is unique within the process, which is the only scope where node IDs
 * are ever compared.
 */
let _nodeIdCounter = 0

export function createNodeId(): NodeId {
  return `n${_nodeIdCounter++}` as NodeId
}

/**
 * Reset the node ID counter. Test-only: lets a suite assert on stable IDs.
 * Never call this while a document tree is alive — reusing IDs across live
 * trees would break every `Map<NodeId, …>` in the engine.
 */
export function __resetNodeIdCounter(): void {
  _nodeIdCounter = 0
}

// ─── Node Kind ─────────────────────────────────────────────────

/**
 * The semantic kind of a node in the document tree.
 *
 * Language-agnostic at the core — BBCode tags, Markdown headings,
 * HTML elements, etc. all map to these.
 */
export type NodeKind =
  | 'document'
  | 'paragraph'
  | 'text'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'color'
  | 'font_size'
  | 'font'
  | 'code'
  | 'inline_code'
  | 'spoiler'
  | 'heading'
  | 'center'
  | 'right'
  | 'left'
  | 'url'
  | 'email'
  | 'profile'
  | 'image'
  | 'video'
  | 'audio'
  | 'imagemap'
  | 'imagemap_area'
  | 'svg'
  | 'quote'
  | 'notice'
  | 'spoilerbox'
  | 'box'
  | 'boxw'
  | 'list'
  | 'list_item'
  | 'zalgo'
  | 'aesthetic'
  | 'sparkle'
  | 'bubble'
  | 'flower'
  | 'gradient'
  | 'grow'
  | 'sinewave'
  | 'rainbow'
  | 'paint'
  | 'spacing'
  | 'empty_line'
  /**
   * Una etiqueta de cierre que no cerró nada y que no debe verse.
   *
   * Nace cuando un cierre llega tarde: su etiqueta ya se cerró sola porque un
   * cierre anterior pasó por encima de ella (ver `Parser.ts`, modo legacy).
   * osu! tira esos cierres, así que el renderer los omite.
   *
   * Existe como nodo, y no como texto, por dos razones. Conserva su rango, que
   * es lo que necesita el parser incremental para saber a qué nodo pertenece
   * cada carácter. Y el exportador puede saltárselo: escrito como texto volvía
   * a salir por el otro lado convertido en etiqueta viva, y el documento no
   * era estable al reexportarlo.
   */
  | 'discarded_tag'
  /**
   * An orphan `[/box]`/`[/spoilerbox]` — one with no matching opener at
   * all — parsed under `ParseOptions.pairing: 'osu'`.
   *
   * osu!'s `strtr` pass seals every `[/box]`/`[/spoilerbox]` unconditionally,
   * orphan or not, and its renderer eats the newlines around it before
   * HTMLPurifier drops the resulting unmatched closing div. That is a
   * different budget from `discarded_tag` (which renders invisible too, but
   * eats nothing around it), so this is its own kind rather than a reuse —
   * see `Parser.ts`'s orphan-close branch and `HTMLRenderer.NEWLINE_RULES`.
   * Never produced under the default `'quasar'` pairing.
   */
  | 'discarded_box_close'
  /**
   * `pairing: 'osu'` only, `box`/`spoilerbox` only — content collected after
   * a crossing closer consumed the frame's BODY div while its WRAPPER stayed
   * open (`Parser.ts`'s `closeDivUnits`/`closeFrame`). A single trailing
   * child of the `box`/`spoilerbox` node, added only when that tail is
   * non-empty: never changes the shape of an ordinary, non-crossing close.
   * No delimiter of its own (`leadingWidth`/`trailingWidth` both 0) — see
   * `HTMLRenderer.WIDTHLESS_OPEN`/`WIDTHLESS_CLOSE`, which treat it as
   * transparent for newline-budget purposes, same as `paragraph`/`group`.
   * `HTMLRenderer` renders its content inside the wrapper, after the body —
   * osu!'s own HTML puts it there too (measured:
   * `[centre][box=a]x[/centre]y[/box]` → `<div box><a/><div body>x</div>
   * y</div>`). Never produced under the default `'quasar'` pairing.
   */
  | 'box_tail'
  | 'group'
  | 'wnotice'
  | 'align'
  | 'tables'
  | 'table_row'
  | 'table_col'
  | 'table_th'
  | 'gallery'
  | 'columns'
  | 'separator'
  | 'scroll'
  | 'sup'
  | 'sub'
  | 'abbr'
  | 'mark'
  | 'kbd'
  | 'tooltip'
  | 'flip'
  | 'raw'
  | 'plain'
  | 'effect'
  | 'anim'
  | 'container'
  | 'style_tag'
  | 'guild'
  | 'map'
  | 'custom'
  | 'error'
  | 'unknown'

// ─── Attributes ────────────────────────────────────────────────

export type NodeAttributes = Record<string, string | number | boolean | null | undefined>

// ─── Metadata ──────────────────────────────────────────────────

export interface NodeMetadata {
  /** Arbitrary extensions data (plugins can add here) */
  [key: string]: unknown
}

// ─── Source Range ──────────────────────────────────────────────

export interface SourceRange {
  start: number
  end: number
}

// ─── Document Node ─────────────────────────────────────────────

/**
 * The primary user-facing node in the Document Model.
 *
 * This is the Red Tree node — mutable, with identity.
 * It wraps/holds reference to the Green Tree node for structural info.
 */
export interface DocumentNode {
  /** Stable ID that survives incremental re-parses */
  id: NodeId
  /** Monotonically increasing version number for change tracking */
  version: number
  /** Semantic kind */
  kind: NodeKind
  /** Raw text content (for text leaves) */
  text: string
  /** Tag-level attributes (e.g. color=#ff0000, size=150) */
  attributes: NodeAttributes
  /** Arbitrary metadata (extensible by plugins) */
  metadata: NodeMetadata
  /** Child nodes */
  children: DocumentNode[]
  /** Diagnostics attached to this specific node */
  diagnostics: Diagnostic[]
  /** Source position in the original text (for mapping back) */
  sourceRange: SourceRange | null
  /** Reference back to parent (null for root) */
  parentId: NodeId | null
  /** Whether this node is "synthetic" (not from source, e.g. auto-generated) */
  isSynthetic: boolean
}

// ─── Document ──────────────────────────────────────────────────

export interface DocumentSnapshot {
  root: DocumentNode
  source: string
  language: string
  version: number
  createdAt: number
}

export type DocumentChangeKind =
  | 'node_inserted'
  | 'node_deleted'
  | 'node_updated'
  | 'node_moved'
  | 'attribute_changed'
  | 'text_changed'
  | 'source_changed'
  | 'full_rebuild'

export interface DocumentChangeEvent {
  kind: DocumentChangeKind
  nodeId: NodeId
  /** The affected node (after the change) */
  node: DocumentNode | null
  /** Previous version of the node (before the change) */
  previousNode: DocumentNode | null
  /** Additional context data */
  metadata?: Record<string, unknown>
}

// ─── Helpers ───────────────────────────────────────────────────

export function createDocumentNode(
  kind: NodeKind,
  text: string = '',
  attributes: NodeAttributes = {},
  children: DocumentNode[] = [],
): DocumentNode {
  return {
    id: createNodeId(),
    version: 1,
    kind,
    text,
    attributes,
    metadata: {},
    children,
    diagnostics: [],
    sourceRange: null,
    parentId: null,
    isSynthetic: false,
  }
}

export function cloneNode(node: DocumentNode, deep: boolean = false): DocumentNode {
  return {
    ...node,
    id: node.id,
    version: node.version + 1,
    children: deep ? node.children.map(c => cloneNode(c, true)) : [...node.children],
    diagnostics: [...node.diagnostics],
  }
}

/** Get the text content of a node and all its descendants */
export function getNodeText(node: DocumentNode): string {
  if (node.children.length === 0) return node.text
  return node.children.map(getNodeText).join('')
}

/** Walk all descendants in pre-order */
export function walkPreOrder(
  node: DocumentNode,
  visitor: (n: DocumentNode, depth: number) => void | 'skip',
  depth: number = 0,
): void {
  const result = visitor(node, depth)
  if (result !== 'skip') {
    for (const child of node.children) {
      walkPreOrder(child, visitor, depth + 1)
    }
  }
}

/** Find a node by ID */
export function findById(root: DocumentNode, id: NodeId): DocumentNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}
