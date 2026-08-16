/**
 * DocumentEngine — SemanticAnalyzer
 *
 * Walks the Red Tree and produces diagnostics by applying
 * semantic rules to the syntax tree.
 *
 * This is where language-specific validation happens.
 * The analyzer is extensible via registered validators.
 *
 * Inspired by Roslyn's Semantic Model and LSP diagnostics.
 */

import { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticCollection,
} from '../Types/diagnostics'
import {
  createDiagnosticCollection,
  createDiagnostic,
  addDiagnostic,
} from '../Types/diagnostics'

/**
 * Run one validator and file whatever it returns, both on the collection and on
 * the node itself.
 *
 * Attaching here is the point: a diagnostic is produced while its own node is
 * in hand, so pairing them later — by building an id→node Map of the whole
 * document and looking each one up — was solving a problem that only existed
 * because the two steps had been separated.
 *
 * The `try` is per validator, deliberately: one that throws must not take the
 * rest of the analysis down with it.
 */
function runValidator(
  validator: Validator,
  node: RedNode,
  context: AnalyzerContext,
  diagnostics: DiagnosticCollection,
): void {
  try {
    const result = validator.validate(node, context)
    if (result === null || result === undefined) return
    if (Array.isArray(result)) {
      for (let i = 0; i < result.length; i++) {
        addDiagnostic(diagnostics, result[i])
        node.diagnostics.push(result[i])
      }
    } else {
      addDiagnostic(diagnostics, result)
      node.diagnostics.push(result)
    }
  } catch (error) {
    // Validator error should not break the analysis
    console.warn(`[DocumentEngine] Validator ${validator.code} error:`, error)
  }
}

// ─── Validator Interface ───────────────────────────────────────

export interface Validator {
  /** Unique code for this validator (e.g. 'invalid-color') */
  code: string
  /** Severity of issues found by this validator */
  severity: DiagnosticSeverity
  /**
   * Node kinds this validator can ever fire on. Omit to run on every node.
   *
   * Three of the five built-ins open with nothing but a kind test, so on a
   * document of 1736 nodes they were called 1736 times each to answer a
   * question the dispatcher can answer once. Declaring the kinds turns the
   * call into a lookup that never happens.
   */
  kinds?: readonly string[]
  /** Validate a node. Return diagnostics or null */
  validate(node: RedNode, context: AnalyzerContext): Diagnostic | Diagnostic[] | null
}

export interface AnalyzerContext {
  /**
   * Every node in the tree, by id, for cross-reference validation.
   *
   * A getter, and deliberately: building this Map cost a second full walk of
   * the tree plus 1736 `Map.set` calls — 23% of `analyze()` — and **no
   * validator has ever read it**. It was built so that the caller could look up
   * by id the node to attach each diagnostic to, which is the node the
   * validator was looking at when it produced it. Validators that genuinely
   * need cross-references still get it; everyone else stops paying for it.
   */
  readonly allNodes: Map<string, RedNode>
  /** Previously collected diagnostics */
  diagnostics: DiagnosticCollection
  /** Source text for position lookups */
  source: string
}

// ─── Analyze Result ────────────────────────────────────────────

export interface AnalyzeResult {
  diagnostics: DiagnosticCollection
  /** Time taken in ms */
  duration: number
  /** Number of nodes analyzed */
  nodesAnalyzed: number
}

/**
 * What `analyze()` actually returns: an {@link AnalyzeResult} plus the node
 * index it had to build anyway for cross-reference lookups.
 *
 * Kept as a separate type, and deliberately NOT part of `AnalyzeResult`,
 * because the index holds a strong reference to every node in the tree. A
 * caller that stores an `AnalyzeResult` long-term (as `DocumentModel` does)
 * must not pin an entire stale tree; one that needs the index gets it here and
 * owns that decision explicitly.
 */
export interface IndexedAnalyzeResult extends AnalyzeResult {
  allNodes: Map<string, RedNode>
}

// ─── Validator helpers ─────────────────────────────────────────

/**
 * Tags that still work but have a preferred modern spelling.
 *
 * `kind` is not redundant. Several nodes can share a starting offset — a
 * `document`, the `paragraph` inside it and the tag itself all begin at 0 for
 * `[strike]x[/strike]` — so reading the source at that offset alone reports the
 * same tag three times. Requiring the node's kind to be the one the tag
 * produces pins the diagnostic to the node that actually is that tag.
 */
const DEPRECATED_TAGS: Record<string, { kind: NodeKind, message: string }> = {
  strike: { kind: 'strikethrough', message: 'Use [s] instead of [strike]' },
  center: { kind: 'center', message: 'Use [centre] instead of [center]' },
}

/**
 * The kinds any deprecated spelling can produce.
 *
 * Cheap pre-filter: the validator runs on every node of every parse, and
 * reading the source back is only meaningful for the handful of kinds a
 * deprecated tag can even yield. Testing the kind first keeps that work off the
 * keystroke path — measured at +14% on `analyze` without it.
 */
const DEPRECATED_KINDS = new Set<NodeKind>(
  Object.values(DEPRECATED_TAGS).map(entry => entry.kind),
)

/** Matches anything shaped like a BBCode tag. */
const BBCODE_TAG_RE = /\[\/?[a-zA-Z0-9_*-]+(?:=[^\]]*)?\]/

/**
 * Reads the tag name at the start of a node's range: `[quote="x"]` → `quote`.
 *
 * Sticky (`y`) so it can be anchored at an arbitrary offset via `lastIndex`.
 * The obvious `source.slice(start, start + 32)` allocates a string for every
 * tag node of every parse; this matches in place.
 */
const OPENING_TAG_RE = /\[\/?([a-zA-Z0-9_*-]+)/y

/**
 * Kinds that are not written tags, so no closing-tag rule applies to them.
 *
 * The check below reads the source at a node's boundaries, and several nodes
 * can share an offset — a `paragraph` wrapping `[b]x` starts at the same `[` as
 * the `bold` inside it, and would otherwise be judged as an unclosed `[b]`.
 * `list_item` is here because `[*]` has no closing form in BBCode at all.
 */
const NOT_A_WRITTEN_TAG = new Set<NodeKind>([
  'document', 'paragraph', 'group', 'text', 'spacing', 'empty_line', 'list_item', 'error',
])

/**
 * Whether the parser had to close this tag itself because the author never did.
 *
 * Exact, not heuristic. A tag the author closed ends exactly at its own
 * `[/tag]`, because that is where the parser sets the node's end. A tag closed
 * *for* the author ends wherever the parser gave up — at the end of the
 * document, or at the mismatched `[/other]` that forced the issue — and the
 * text up to that point does not end in its closing form.
 *
 * That single rule covers both shapes: `[b]x` (never closed) and `[b][i]x[/b]`
 * (where `[i]` is auto-closed by the legacy nesting rules).
 */
function isUnclosedTag(node: RedNode, source: string): boolean {
  if (NOT_A_WRITTEN_TAG.has(node.kind)) return false

  const name = openingTagName(node, source)
  if (!name || name === '*') return false

  return !endsWithClosingTag(source, node.range.end, name)
}

/**
 * The tag name as the author actually spelled it, read back from the source.
 *
 * The tree cannot answer this. Several spellings collapse onto one `NodeKind`
 * — `[strike]` and `[s]` both become `strikethrough` — and a node's `text`
 * holds its attributes, not its name. A node's range does start at the opening
 * bracket, so the name is the identifier immediately after it.
 *
 * Returns null for nodes that do not correspond to a written tag.
 */
function openingTagName(node: RedNode, source: string): string | null {
  const { start } = node.range
  if (start < 0 || start >= source.length || source.charCodeAt(start) !== 0x5b /* [ */) return null
  OPENING_TAG_RE.lastIndex = start
  const match = OPENING_TAG_RE.exec(source)
  return match ? match[1].toLowerCase() : null
}

/**
 * Does `source` end with `[/name]` at offset `end`?
 *
 * Compared in place rather than via `slice().toLowerCase()`: this runs for
 * every tag node on the keystroke path, and two throwaway strings per node adds
 * up. ASCII case folding is `| 32`, which is why the letter range is checked
 * first — folding a digit or `_` would corrupt it.
 */
function endsWithClosingTag(source: string, end: number, name: string): boolean {
  const start = end - name.length - 3
  if (start < 0) return false
  if (source.charCodeAt(start) !== 0x5b /* [ */) return false
  if (source.charCodeAt(start + 1) !== 0x2f /* / */) return false
  if (source.charCodeAt(end - 1) !== 0x5d /* ] */) return false

  for (let i = 0; i < name.length; i++) {
    let c = source.charCodeAt(start + 2 + i)
    if (c >= 0x41 && c <= 0x5a) c |= 32 // A-Z → a-z; `name` is already lowercase
    if (c !== name.charCodeAt(i)) return false
  }
  return true
}

// ─── SemanticAnalyzer ──────────────────────────────────────────

export class SemanticAnalyzer {
  private validators: Map<string, Validator> = new Map()

  /**
   * The same validators, arranged for the walk instead of for lookup.
   *
   * `_always` run on every node; `_byKind` are the ones that declared their
   * kinds. Iterating the Map itself allocated an iterator and a destructuring
   * pair per node — 9% of `analyze()` spent on bookkeeping, not on validating.
   *
   * Rebuilt on register/unregister, which happen once at construction and
   * essentially never afterwards.
   */
  private _always: Validator[] = []
  private _byKind: Map<string, Validator[]> = new Map()

  constructor() {
    this.registerBuiltinValidators()
  }

  /**
   * Register a validator.
   */
  register(validator: Validator): void {
    this.validators.set(validator.code, validator)
    this.rebuildDispatch()
  }

  /**
   * Remove a validator.
   */
  unregister(code: string): void {
    this.validators.delete(code)
    this.rebuildDispatch()
  }

  private rebuildDispatch(): void {
    this._always = []
    this._byKind = new Map()
    for (const validator of this.validators.values()) {
      if (validator.kinds === undefined) {
        this._always.push(validator)
        continue
      }
      for (const kind of validator.kinds) {
        const list = this._byKind.get(kind)
        if (list) list.push(validator)
        else this._byKind.set(kind, [validator])
      }
    }
  }

  /**
   * Analyze a Red Tree and produce diagnostics.
   */
  analyze(root: RedNode, source: string): IndexedAnalyzeResult {
    const startTime = performance.now()
    const diagnostics = createDiagnosticCollection()
    let nodesAnalyzed = 0

    // `allNodes` is a getter so the Map is only built if a validator asks for
    // it — see the note on `AnalyzerContext.allNodes`. `root` is captured, so
    // the walk that builds it happens at most once per analyze.
    let allNodesCache: Map<string, RedNode> | null = null
    const context: AnalyzerContext = {
      get allNodes(): Map<string, RedNode> {
        if (allNodesCache === null) {
          allNodesCache = new Map<string, RedNode>()
          root.walk(node => { allNodesCache!.set(node.id, node) })
        }
        return allNodesCache
      },
      diagnostics,
      source,
    }

    const always = this._always
    const byKind = this._byKind

    root.walk(node => {
      nodesAnalyzed++

      // Clear here rather than in a pass of its own, and only when there is
      // something to clear: a fresh `[]` per node meant an allocation for every
      // node in the document, and almost none of them carry diagnostics.
      if (node.diagnostics.length > 0) node.diagnostics = []

      const specific = byKind.get(node.kind)
      for (let i = 0; i < always.length; i++) {
        runValidator(always[i], node, context, diagnostics)
      }
      if (specific !== undefined) {
        for (let i = 0; i < specific.length; i++) {
          runValidator(specific[i], node, context, diagnostics)
        }
      }
    })

    const duration = performance.now() - startTime

    return {
      diagnostics,
      duration,
      nodesAnalyzed,
      get allNodes(): Map<string, RedNode> { return context.allNodes },
    }
  }

  // ─── Built-in Validators ─────────────────────────────────

  private registerBuiltinValidators(): void {
    // Unknown tag validator
    this.register({
      code: 'unknown-tag',
      severity: 'warning',
      kinds: ['custom'],
      validate: (node) => {
        if (node.kind === 'custom' && node.green.isLeaf) {
          return createDiagnostic(
            'unknown-tag',
            `Unknown BBCode tag: [${node.text}]`,
            'warning',
            { nodeId: node.id, nodeKind: node.kind, range: node.range },
          )
        }
        return null
      },
    })

    // Deprecated tag validator
    this.register({
      code: 'deprecated-tag',
      severity: 'info',
      // Same set the validator's own first line tests, hoisted into dispatch.
      kinds: [...DEPRECATED_KINDS],
      validate: (node, ctx) => {
        // Looked up `deprecated[node.text]` before, which could never match:
        // `node.text` holds the tag's *attributes*, not its name. And the name
        // is not on the node either — `[strike]` and `[s]` both parse to kind
        // `strikethrough`, so the spelling the author used only survives in the
        // source. The node's range points at the opening bracket, so read it
        // back from there.
        if (!DEPRECATED_KINDS.has(node.kind)) return null

        const spelling = openingTagName(node, ctx.source)
        if (!spelling) return null

        const found = DEPRECATED_TAGS[spelling]
        if (!found || found.kind !== node.kind) return null

        return createDiagnostic(
          'deprecated-tag',
          found.message,
          'info',
          { nodeId: node.id, nodeKind: node.kind, range: node.range, tags: ['deprecated'] },
        )
      },
    })

    // Empty tag validator
    // Excludes structural kinds that are intentionally contentless (empty_line, spacing)
    this.register({
      code: 'empty-tag',
      severity: 'hint',
      validate: (node) => {
        if (
          node.children.length === 0 &&
          node.text === '' &&
          node.kind !== 'text' &&
          node.kind !== 'empty_line' &&
          node.kind !== 'spacing'
        ) {
          return createDiagnostic(
            'empty-tag',
            `Empty tag: ${node.kind}`,
            'hint',
            { nodeId: node.id, nodeKind: node.kind, range: node.range, tags: ['unnecessary'] },
          )
        }
        return null
      },
    })

    // Unclosed tag validator
    //
    // The one BBCode mistake people actually make. The legacy parser closes
    // these silently by design — the preview still looks plausible — so without
    // a diagnostic there is nothing anywhere telling the author a tag is
    // missing.
    this.register({
      code: 'unclosed-tag',
      severity: 'warning',
      validate: (node, ctx) => {
        if (!isUnclosedTag(node, ctx.source)) return null

        const name = openingTagName(node, ctx.source)
        return createDiagnostic(
          'unclosed-tag',
          `Missing [/${name}] — the tag was closed automatically`,
          'warning',
          { nodeId: node.id, nodeKind: node.kind, range: node.range },
        )
      },
    })

    // Potentially nested structure validator
    this.register({
      code: 'nested-structure',
      kinds: ['code', 'inline_code'],
      severity: 'warning',
      validate: (node) => {
        if (node.kind !== 'code' && node.kind !== 'inline_code') return null

        // Instead of underlining the entire [code] block, we find the exact
        // positions of the tags inside the text and yield a diagnostic for each.
        const diagnostics: Diagnostic[] = []
        const regex = /\[\/?[a-zA-Z0-9_*-]+(?:=[^\]]*)?\]/g

        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i]
          if (child.kind !== 'text') continue

          let match: RegExpExecArray | null
          while ((match = regex.exec(child.text)) !== null) {
            const start = child.range.start + match.index
            const end = start + match[0].length

            diagnostics.push(createDiagnostic(
              'nested-tags-in-code',
              'BBCode tags inside [code] blocks are not rendered by osu!',
              'warning',
              { nodeId: node.id, nodeKind: node.kind, range: { start, end } },
            ))
          }
        }

        return diagnostics.length > 0 ? diagnostics : null
      },
    })
  }

  /**
   * Create a validator for a specific tag/kind.
   * Convenience method for plugin authors.
   */
  createValidator(
    code: string,
    severity: DiagnosticSeverity,
    predicate: (node: RedNode, ctx: AnalyzerContext) => string | null,
  ): Validator {
    return {
      code,
      severity,
      validate: (node, ctx) => {
        const message = predicate(node, ctx)
        if (message) {
          return createDiagnostic(code, message, severity, {
            nodeId: node.id,
            nodeKind: node.kind,
          })
        }
        return null
      },
    }
  }
}

