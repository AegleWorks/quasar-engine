/**
 * Quasar — LanguageService
 *
 * The editor-facing answers over one `DocumentModel`, in the shape Roslyn puts
 * them in: diagnostics, quick info, navigation, rename, completion, semantic
 * classification, folding and code actions, all derived from the same tree and
 * cached per document version.
 *
 * ## Why a service and not more model methods
 *
 * `DocumentModel` owns the document: text, tree, transactions, versions. A
 * language service owns ANSWERS: which node is under the caret, what the
 * outline is, which bytes a rename would rewrite. Keeping them apart means a
 * service can cache on a version without mutating one, and a headless
 * consumer (CLI, LSP bridge, test) can build answers without inventing its own
 * selectors and range arithmetic — the exact drift that produced the
 * `SymbolTable` bugs fixed in the 2026-10 audit.
 *
 * ## Caching contract
 *
 * Every structural answer is keyed by `model.version`. An edit through the
 * model increments it; the next call discards the cached outline, tokens,
 * folding and symbol table and rebuilds them from the new tree. Nothing is
 * cached across a document object, and no answer holds a red node beyond the
 * call that produced it (nodes are carried only as ids).
 *
 * Diagnostics are different: the model already memoizes analysis and
 * debounces it after a keystroke, so this service calls `ensureAnalyzed()` and
 * returns what the model has. That keeps one analysis, not two.
 *
 * @see SymbolTable — headings and `[url=#fragment]` links, plus `id`/`goto`
 * @see LightbulbHost — quick fixes and refactorings
 */

import type { DocumentModel } from '../Model/DocumentModel'
import type { RedNode } from '../Syntax/RedNode'
import type { GreenNode } from '../Syntax/GreenNode'
import type { NodeKind, SourceRange } from '../Types/core'
import type { Diagnostic } from '../Types/diagnostics'
import type { SymbolInfo } from '../Types/symbols'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import type {
  CompletionItem,
  FoldingRange,
  LanguageDiagnostics,
  LanguageLocation,
  LanguageServiceStats,
  LanguageSymbol,
  QuickInfo,
  RenameResult,
  SemanticToken,
} from '../Types/language'
import { SymbolTable, slugifyHeading } from '../Symbols/SymbolTable'
import { isBlockKind, getBBCodeTagNames } from '../BBCode/BBCodeToGreenNode'
import { extractTextContent } from '../Model/TagRegistry'
import { attributeVocabularyFor } from '../Utils/TagVocabulary'
import { LightbulbHost, type LightbulbAction } from '../Fixes/LightbulbHost'

/** Blocks that exist for the engine but that an author did not write. */
const NOT_IN_OUTLINE: ReadonlySet<NodeKind> = new Set([
  'document',
  'paragraph',
  'spacing',
  'empty_line',
  'list_item',
  'discarded_tag',
  'discarded_box_close',
  'box_tail',
])

/** Kinds whose content is literal and therefore not completed or classified. */
const OPAQUE_KINDS: ReadonlySet<NodeKind> = new Set(['code', 'inline_code'])

const PREVIEW_MAX = 60

// ── Delimiter helpers ────────────────────────────────────────────

interface TagNameInDelimiter {
  readonly name: string
  /** Offsets relative to the delimiter, not to the document. */
  readonly start: number
  readonly end: number
}

/** The tag name at the head of `[name…]` or `[/name]`, if there is one. */
function tagNameInDelimiter(delimiter: string): TagNameInDelimiter | null {
  if (delimiter.length < 2 || delimiter[0] !== '[') return null
  let i = 1
  if (delimiter[i] === '/') i++
  while (i < delimiter.length && (delimiter[i] === ' ' || delimiter[i] === '\t')) i++
  const start = i
  while (i < delimiter.length && !/[\s\]=]/.test(delimiter[i])) i++
  if (i === start) return null
  return { name: delimiter.slice(start, i), start, end: i }
}

/** The opening delimiter of a node: `[colour=#fff]`. */
function openingDelimiter(node: RedNode, source: string): string {
  return source.slice(node.range.start, node.innerStart)
}

/** The closing delimiter of a node: `[/colour]`. */
function closingDelimiter(node: RedNode, source: string): string {
  return source.slice(node.innerEnd, node.range.end)
}

function tagNameOf(node: RedNode, source: string): string | null {
  return tagNameInDelimiter(openingDelimiter(node, source))?.name ?? null
}

/**
 * The span of the `=value` part of a tag's opening delimiter, value only —
 * quotes and surrounding spaces excluded.
 *
 * Rename edits values, never the `=`, the quotes or the spacing the author
 * chose. Returns `null` for a tag with no attribute or an empty one.
 */
function attributeValueRange(node: RedNode, source: string): SourceRange | null {
  const delimiterStart = node.range.start
  const delimiter = openingDelimiter(node, source)
  const eq = delimiter.indexOf('=')
  if (eq < 0) return null

  let start = eq + 1
  while (start < delimiter.length && /\s/.test(delimiter[start])) start++

  let end = delimiter.length
  if (delimiter[end - 1] === ']') end--

  let quote = ''
  if (delimiter[start] === '"' || delimiter[start] === "'") {
    quote = delimiter[start]
    start++
    if (delimiter[end - 1] === quote) end--
  }

  while (end > start && /\s/.test(delimiter[end - 1])) end--
  if (end <= start) return null
  return { start: delimiterStart + start, end: delimiterStart + end }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function preview(text: string): string {
  const flat = collapseWhitespace(text)
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat
}

/** Shift every range in an outline subtree by `delta`, preserving ids. */
function shiftSymbols(symbols: readonly LanguageSymbol[], delta: number): readonly LanguageSymbol[] {
  if (delta === 0 || symbols.length === 0) return symbols
  return symbols.map(symbol => ({
    ...symbol,
    range: { start: symbol.range.start + delta, end: symbol.range.end + delta },
    selectionRange: {
      start: symbol.selectionRange.start + delta,
      end: symbol.selectionRange.end + delta,
    },
    children: shiftSymbols(symbol.children, delta),
  }))
}

/**
 * Tokens for one top-level block, cached by the block's green node.
 *
 * Green identity is the right key: it is exactly "this subtree's text and
 * structure did not change". A block that was edited gets new green nodes and
 * is re-tokenized; every other block is reused, with ranges shifted by
 * whatever the edit moved it. `tokens` is absolute for `base`; only one copy
 * per block is kept.
 */
interface BlockTokens {
  base: number
  tokens: readonly SemanticToken[]
}

/**
 * Outline entries for one top-level block, cached by green identity and tied to
 * the red node that produced them.
 *
 * The red-node check keeps `nodeId` honest: a block whose green was shared but
 * whose red node was rebuilt needs its entries rebuilt too, or go-to-node
 * would point at last version's node. Adopted red nodes keep their ids, which
 * is the normal incremental case.
 */
interface BlockOutline {
  node: RedNode
  base: number
  symbols: readonly LanguageSymbol[]
}

/**
 * Folding ranges for one top-level block, with line numbers relative to the
 * block's first line. Moving the block moves the ranges by the same line
 * delta; an edit inside it gives it new green nodes and it is walked again.
 */
interface BlockFolding {
  node: RedNode
  ranges: readonly FoldingRange[]
}

// ── Service ──────────────────────────────────────────────────────

export class LanguageService {
  private readonly model: DocumentModel
  private readonly symbols = new SymbolTable()
  private readonly lightbulb = new LightbulbHost()

  private _version = -1
  private _symbolsBuiltFor = -1
  private _documentSymbols: readonly LanguageSymbol[] | null = null
  private _tokens: readonly SemanticToken[] | null = null
  /** Version `_tokens` describes. Kept across edits for the incremental path. */
  private _tokensVersion = -1
  /** Token lists by green block; see `BlockTokens`. */
  private _blockTokens = new WeakMap<GreenNode, BlockTokens>()
  /** Outline entries by green block; see `BlockOutline`. */
  private _blockOutlines = new WeakMap<GreenNode, BlockOutline>()
  /** Folding ranges by green block; see `BlockFolding`. */
  private _blockFolding = new WeakMap<GreenNode, BlockFolding>()
  private _folding: readonly FoldingRange[] | null = null
  private _cacheHits = 0
  private _cacheMisses = 0
  private _symbolBuilds = 0
  private _tokenBlocksReused = 0
  private _tokenBlocksBuilt = 0
  private _outlineBlocksReused = 0
  private _outlineBlocksBuilt = 0

  constructor(model: DocumentModel) {
    this.model = model
  }

  /** The dialect of a BBCode model; `miliastry` for the base engine. */
  private get dialect(): 'osu' | 'miliastry' | 'lyne' {
    const value = (this.model as DocumentModel & { dialect?: unknown }).dialect
    return value === 'osu' || value === 'lyne' ? value : 'miliastry'
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  /**
   * The current document's diagnostics.
   *
   * A debounced analysis is flushed first (`ensureAnalyzed`), because a caller
   * asking for diagnostics means the current text, not the text from three
   * keystrokes ago. With `autoAnalyze: false` the model has no diagnostics to
   * return and this is an empty list, not a stale one.
   */
  getDiagnostics(): LanguageDiagnostics {
    this.model.ensureAnalyzed()
    return {
      version: this.model.version,
      diagnostics: this.model.diagnostics?.items ?? [],
    }
  }

  // ── Outline ─────────────────────────────────────────────────────

  /**
   * The document outline, nested by containment.
   *
   * Every block the author wrote gets an entry (headings, boxes, quotes, code,
   * lists…), named by its title or first words. Block kinds that exist for the
   * engine — document, paragraph, spacing, list items — are skipped: an
   * outline of `[*]` rows is noise, not navigation.
   */
  getDocumentSymbols(): readonly LanguageSymbol[] {
    this.ensureCurrent()
    if (this._documentSymbols !== null) {
      this._cacheHits++
      return this._documentSymbols
    }
    this._cacheMisses++
    const root = this.model.redRoot
    if (root === null) {
      this._documentSymbols = []
      return this._documentSymbols
    }

    // Same idea as tokens: an unchanged top-level block has the same outline
    // whatever the edit did to its neighbours. Entries are cached per green
    // block and shifted when the block moves; only the block that changed is
    // re-walked (10.9 ms → almost nothing on the 547 KB fixture).
    const out: LanguageSymbol[] = []
    for (const block of root.children) {
      const base = block.range.start
      const cached = this._blockOutlines.get(block.green)
      if (cached !== undefined && cached.node === block) {
        this._outlineBlocksReused++
        if (cached.base !== base) {
          const delta = base - cached.base
          cached.symbols = shiftSymbols(cached.symbols, delta)
          cached.base = base
        }
        for (const symbol of cached.symbols) out.push(symbol)
        continue
      }

      this._outlineBlocksBuilt++
      const symbols = this.outlineBlock(block)
      this._blockOutlines.set(block.green, { node: block, base, symbols })
      for (const symbol of symbols) out.push(symbol)
    }

    this._documentSymbols = out
    return this._documentSymbols
  }

  /** Outline entries produced by a top-level block (usually zero or one). */
  private outlineBlock(block: RedNode): LanguageSymbol[] {
    const out: LanguageSymbol[] = []
    this.collectOutline(block, out)
    return out
  }

  private collectOutline(node: RedNode, out: LanguageSymbol[]): void {
    if (!isBlockKind(node.kind) || NOT_IN_OUTLINE.has(node.kind)) {
      for (const child of node.children) this.collectOutline(child, out)
      return
    }

    out.push({
      name: this.nameOf(node, this.model.source),
      detail: tagNameOf(node, this.model.source) ?? node.kind,
      kind: node.kind,
      range: { start: node.range.start, end: node.range.end },
      selectionRange: { start: node.range.start, end: node.innerStart },
      nodeId: node.id,
      children: this.outlineChildren(node),
    })
  }

  private outlineChildren(node: RedNode): LanguageSymbol[] {
    const out: LanguageSymbol[] = []
    for (const child of node.children) this.collectOutline(child, out)
    return out
  }

  private nameOf(node: RedNode, source: string): string {
    const title = node.metadata?.title ?? node.metadata?.source ?? node.metadata?.username
    if (typeof title === 'string' && title.trim() !== '') return preview(title)

    if (node.kind === 'heading') {
      const text = preview(extractTextContent(node))
      if (text !== '') return text
    }

    const definition = this.model.tagRegistry.getByKind(node.kind)
    const label = definition?.label ?? node.kind

    const text = preview(extractTextContent(node))
    return text === '' ? label : `${label}: ${text}`
  }

  // ── Quick info ──────────────────────────────────────────────────

  /**
   * What the caret is on: a tag, an attribute, or a symbol.
   *
   * Tags answer from the registry (label, category, deprecation, known
   * properties); symbols answer from the symbol table, including a heading's
   * incoming link count. A caret in ordinary text gets `null` — there is
   * nothing to explain, and inventing a tooltip for every word is noise.
   */
  getQuickInfo(offset: number): QuickInfo | null {
    const root = this.model.redRoot
    if (root === null) return null
    const node = root.findNodeAtOffset(offset)
    if (node === null) return null
    const source = this.model.source

    const inOpening = offset >= node.range.start && offset < node.innerStart
    const inClosing = offset >= node.innerEnd && offset < node.range.end
    if (inOpening || inClosing) {
      const delimiter = inOpening ? openingDelimiter(node, source) : closingDelimiter(node, source)
      const delimiterRange = inOpening
        ? { start: node.range.start, end: node.innerStart }
        : { start: node.innerEnd, end: node.range.end }
      const parsed = tagNameInDelimiter(delimiter)
      if (parsed !== null) {
        const definition = this.model.tagRegistry.get(parsed.name) ??
          this.model.tagRegistry.getByKind(node.kind)

        // A caret after the `=` is asking about the value, not the tag.
        const eq = inOpening ? delimiter.indexOf('=') : -1
        if (eq >= 0 && offset - node.range.start > eq) {
          const vocabulary = attributeVocabularyFor(parsed.name)
          const valueText = vocabulary === null
            ? ''
            : `\nValues: ${vocabulary.values.join(', ')}${vocabulary.syntax === 'flags' ? ' (combinable)' : ''}.`
          return {
            kind: 'attribute',
            name: parsed.name,
            documentation: `Attribute value for [${parsed.name}].${valueText}`,
            range: delimiterRange,
            nodeId: node.id,
          }
        }

        if (definition !== undefined) {
          const properties = definition.properties?.map(p => p.name).join(', ')
          const isDeprecated = definition.isDeprecated === true
          const deprecatedNote = isDeprecated
            ? ` Deprecated${definition.deprecatedReplacement ? `; use [${definition.deprecatedReplacement}]` : ''}.`
            : ''
          return {
            kind: 'tag',
            name: parsed.name,
            documentation:
              `[${parsed.name}] — ${definition.label}` +
              (definition.category ? ` (${definition.category}).` : '.') +
              deprecatedNote +
              (properties ? `\nAttributes: ${properties}.` : ''),
            range: delimiterRange,
            nodeId: node.id,
            tag: {
              label: definition.label,
              category: definition.category,
              deprecated: isDeprecated,
              replacement: definition.deprecatedReplacement,
            },
          }
        }

        return {
          kind: 'tag',
          name: parsed.name,
          documentation: `[${parsed.name}] — recognised by the ${this.dialect} dialect.`,
          range: delimiterRange,
          nodeId: node.id,
        }
      }
    }

    const symbol = this.symbolForNode(node)
    if (symbol !== null) {
      return {
        kind: 'symbol',
        name: symbol.symbol.name,
        documentation:
          `#${symbol.symbol.name} — ${symbol.symbol.references.length} reference` +
          `${symbol.symbol.references.length === 1 ? '' : 's'}.`,
        range: { start: symbol.symbol.definitionRange.start, end: symbol.symbol.definitionRange.end },
        nodeId: symbol.symbol.definitionNodeId,
        referenceCount: symbol.symbol.references.length,
      }
    }

    return null
  }

  // ── Navigation and rename ──────────────────────────────────────

  /**
   * The definition of the symbol at `offset`, or `null` for ordinary text.
   *
   * A `[url=#intro]` link and the `[heading]` it points at are the built-in
   * case; a tag carrying `id`/`goto` metadata (a plugin) resolves the same way.
   */
  getDefinition(offset: number): LanguageLocation | null {
    const found = this.symbolAtOffset(offset)
    if (found === null) return null
    return {
      range: {
        start: found.symbol.definitionRange.start,
        end: found.symbol.definitionRange.end,
      },
      nodeId: found.symbol.definitionNodeId,
    }
  }

  /**
   * Every place the symbol at `offset` is defined or referenced, in source
   * order. The definition is included, as LSP does by default: a rename UI
   * needs to show the declaration too.
   */
  findReferences(offset: number): readonly LanguageLocation[] {
    const found = this.symbolAtOffset(offset)
    if (found === null) return []

    const locations: LanguageLocation[] = [
      {
        range: {
          start: found.symbol.definitionRange.start,
          end: found.symbol.definitionRange.end,
        },
        nodeId: found.symbol.definitionNodeId,
      },
      ...found.symbol.references.map(reference => ({
        range: { start: reference.range.start, end: reference.range.end },
        nodeId: reference.nodeId,
      })),
    ]

    locations.sort((a, b) => a.range.start - b.range.start)
    return locations
  }

  /**
   * Rename the symbol at `offset`.
   *
   * Headings rename to a visible text and update every `[url=#old]` to the new
   * slug; `id`/`goto` metadata renames the value in place and preserves the
   * author's quoting. A rich heading — one containing tags rather than text —
   * is refused rather than flattened: replacing `[b]Intro[/b]` with "Intro"
   * would lose the markup, and a rename that silently drops formatting is worse
   * than one that says no.
   *
   * Returns edits against the current source, or `null` when the caret is not
   * on a symbol or the rename cannot be expressed safely.
   */
  rename(offset: number, newName: string): RenameResult | null {
    const found = this.symbolAtOffset(offset)
    if (found === null) return null
    const { symbol } = found
    const requested = collapseWhitespace(newName)
    if (requested === '' || requested === symbol.name) return null

    const source = this.model.source
    const edits: SurgicalEdit[] = []

    if (symbol.data?.origin === 'heading') {
      if (/[[\]]/.test(requested)) return null
      const node = this.model.findNode(symbol.definitionNodeId)
      if (node === null) return null
      const rich = node.children.some(
        child => child.kind !== 'text' && child.kind !== 'spacing' && child.kind !== 'empty_line',
      )
      if (rich) return null

      const slug = slugifyHeading(requested)
      edits.push({ start: node.innerStart, end: node.innerEnd, text: requested })
      for (const reference of symbol.references) {
        edits.push({ start: reference.range.start, end: reference.range.end, text: `#${slug}` })
      }
      edits.sort((a, b) => a.start - b.start || a.end - b.end)
      return { oldName: symbol.name, newName: requested, edits }
    }

    // Metadata-backed symbols (`id`/`goto`): rewrite only the value bytes.
    const definition = this.model.findNode(symbol.definitionNodeId)
    if (definition === null) return null
    const definitionRange = attributeValueRange(definition, source)
    if (definitionRange === null) return null
    edits.push({ ...definitionRange, text: requested })

    for (const reference of symbol.references) {
      const node = this.model.findNode(reference.nodeId)
      if (node === null) return null
      const range = attributeValueRange(node, source)
      if (range === null) return null
      edits.push({ ...range, text: requested })
    }

    edits.sort((a, b) => a.start - b.start || a.end - b.end)
    return { oldName: symbol.name, newName: requested, edits }
  }

  // ── Code actions ────────────────────────────────────────────────

  /**
   * Quick fixes and refactorings at a caret/range — the lightbulb.
   *
   * The model's analysis is flushed first, so the diagnostics the host sees
   * describe the current text. The source is never mutated; every action's
   * `edits` are against the current source and its `preview` is lazy.
   */
  getCodeActions(offset: number, range: number | SourceRange | null = null): LightbulbAction[] {
    const diagnostics = this.getDiagnostics().diagnostics
    const root = this.model.redRoot
    const normalized: SourceRange | null =
      typeof range === 'number'
        ? { start: range, end: range }
        : range

    return this.lightbulb.query({
      source: this.model.source,
      root,
      offset,
      range: normalized,
      diagnostics: diagnostics as Diagnostic[],
      documentDiagnostics: diagnostics as Diagnostic[],
    })
  }

  // ── Completion ──────────────────────────────────────────────────

  /**
   * Completions inside a tag delimiter.
   *
   * Three contexts, all derived from the same text the tree was built from:
   *
   *  - after `[/` — the open ancestors, nearest first, as closing tags;
   *  - after `[tag=` — the enumerated vocabulary for that tag, when it has one;
   *  - after `[pre` — tag names, built-ins for the dialect plus plugin tags.
   *
   * Outside a delimiter the list is empty. A tag name may contain `*`
   * (`[*]`), so the scanner does not assume a letter.
   */
  getCompletions(offset: number, limit = 50): CompletionItem[] {
    const source = this.model.source
    if (offset < 0 || offset > source.length) return []

    let open = -1
    for (let i = offset - 1; i >= 0; i--) {
      const ch = source[i]
      if (ch === ']') break
      if (ch === '[') {
        open = i
        break
      }
    }
    if (open < 0) return []

    const root = this.model.redRoot
    // At EOF `findNodeAtOffset` answers with the root; for ancestors we want
    // the node the caret is actually inside, which is the last character's
    // node. The same fallback covers a caret placed just past a closing tag.
    const probe = offset >= source.length && source.length > 0 ? offset - 1 : offset
    const nodeAt = root?.findNodeAtOffset(probe) ?? null
    for (let node = nodeAt; node !== null; node = node.parent) {
      if (OPAQUE_KINDS.has(node.kind)) return []
      if (node.kind === 'document') break
    }

    const inner = source.slice(open + 1, offset)
    const closesAlready = source[offset] === ']'
    const closeSuffix = closesAlready ? '' : ']'

    // Closing a tag: offer the ancestors, nearest first.
    if (inner.startsWith('/')) {
      const typed = inner.slice(1).trim().toLowerCase()
      const seen = new Set<string>()
      const items: CompletionItem[] = []
      for (let node = nodeAt; node !== null; node = node.parent) {
        if (node.kind === 'document' || node.kind === 'paragraph') continue
        const name = tagNameOf(node, source)
        if (name === null || seen.has(name) || !name.toLowerCase().startsWith(typed)) continue
        seen.add(name)
        items.push({
          label: `/${name}`,
          kind: 'closing-tag',
          detail: `Close [${name}]`,
          insertText: `/${name}${closeSuffix}`,
          replaceRange: { start: open + 1, end: offset },
        })
        if (items.length >= limit) break
      }
      return items
    }

    const eq = inner.indexOf('=')
    if (eq >= 0) {
      const tag = inner.slice(0, eq).trim().toLowerCase()
      const vocabulary = attributeVocabularyFor(tag)
      if (vocabulary === null) return []

      let valueStart = open + 1 + eq + 1
      while (valueStart < offset && /\s/.test(source[valueStart])) valueStart++
      const typed = source.slice(valueStart, offset).toLowerCase()
      return vocabulary.values
        .filter(value => value.startsWith(typed))
        .slice(0, limit)
        .map(value => ({
          label: value,
          kind: 'value' as const,
          detail: `${tag} value`,
          documentation: vocabulary.syntax === 'flags'
            ? 'Combinable with commas or spaces.'
            : 'One of the values the renderer handles.',
          insertText: value,
          replaceRange: { start: valueStart, end: offset },
        }))
    }

    // Tag names. Leading spaces are legal (`[ colour=red]` was accepted by the
    // lexer long before this service existed), so replacement starts after them.
    let typedStart = open + 1
    while (typedStart < offset && /\s/.test(source[typedStart])) typedStart++
    const typed = source.slice(typedStart, offset).toLowerCase()
    if (typed.includes(' ')) return []

    const names = new Set<string>(getBBCodeTagNames(this.dialect))
    for (const definition of this.model.tagRegistry.getAll()) names.add(definition.name)

    const items: CompletionItem[] = []
    for (const name of names) {
      if (!name.toLowerCase().startsWith(typed)) continue
      const definition = this.model.tagRegistry.get(name)
      items.push({
        label: name,
        kind: 'tag',
        detail: definition ? `${definition.label}${definition.category ? ` · ${definition.category}` : ''}` : 'tag',
        documentation: definition?.isDeprecated
          ? `Deprecated${definition.deprecatedReplacement ? `; use [${definition.deprecatedReplacement}]` : ''}.`
          : undefined,
        insertText: name,
        replaceRange: { start: typedStart, end: offset },
      })
    }

    items.sort((a, b) => a.label.localeCompare(b.label))
    return items.slice(0, limit)
  }

  // ── Semantic tokens and folding ────────────────────────────────

  /**
   * A flat, non-overlapping classification of the document.
   *
   * Tag names, attribute bytes, text, literal code, punctuation and discarded
   * tags are all that a BBCode document contains. The walk emits them in source
   * order, which is the order LSP expects and the order a renderer consumes.
   */
  getSemanticTokens(): readonly SemanticToken[] {
    this.ensureCurrent()
    const version = this.model.version
    if (this._tokens !== null && this._tokensVersion === version) {
      this._cacheHits++
      return this._tokens
    }

    this._cacheMisses++
    const root = this.model.redRoot
    if (root === null) {
      this._tokens = []
      this._tokensVersion = version
      return this._tokens
    }

    // Tokens are rebuilt block by block, keyed by green identity. An edit
    // creates new green nodes only along the path it touched; every other
    // top-level block is the same immutable subtree, so its token list is
    // still correct after a shift. On the 547 KB fixture that is one block
    // re-tokenized per keystroke instead of all 134 713 tokens.
    const tokens: SemanticToken[] = []
    const source = this.model.source
    for (const block of root.children) {
      const base = block.range.start
      const cached = this._blockTokens.get(block.green)
      if (cached !== undefined) {
        this._tokenBlocksReused++
        if (cached.base === base) {
          for (const token of cached.tokens) tokens.push(token)
        } else {
          // The block moved: shift the list it already has by the delta. No
          // second, relative copy is kept — one array per green block is the
          // whole cache, and the old array becomes garbage with the version.
          const delta = base - cached.base
          const shifted = cached.tokens.map(token => ({
            type: token.type,
            range: { start: token.range.start + delta, end: token.range.end + delta },
          }))
          cached.base = base
          cached.tokens = shifted
          for (const token of shifted) tokens.push(token)
        }
        continue
      }

      this._tokenBlocksBuilt++
      const absolute: SemanticToken[] = []
      this.tokenize(block, source, absolute)
      this._blockTokens.set(block.green, { base, tokens: absolute })
      for (const token of absolute) tokens.push(token)
    }

    this._tokens = tokens
    this._tokensVersion = version
    return tokens
  }

  private tokenize(node: RedNode, source: string, sink: SemanticToken[]): void {
    if (node.kind === 'text') {
      if (node.text !== '') {
        sink.push({ type: 'text', range: { start: node.range.start, end: node.range.end } })
      }
      return
    }

    if (node.kind === 'spacing' || node.kind === 'empty_line') {
      sink.push({ type: 'whitespace', range: { start: node.range.start, end: node.range.end } })
      return
    }

    if (node.kind === 'discarded_tag' || node.kind === 'discarded_box_close') {
      sink.push({ type: 'invalid', range: { start: node.range.start, end: node.range.end } })
      return
    }

    const open = openingDelimiter(node, source)
    if (open !== '') this.classifyDelimiter(open, node.range.start, sink)

    if (OPAQUE_KINDS.has(node.kind)) {
      if (node.innerEnd > node.innerStart) {
        sink.push({
          type: 'string',
          range: { start: node.innerStart, end: node.innerEnd },
        })
      }
    } else {
      for (const child of node.children) this.tokenize(child, source, sink)
    }

    const close = closingDelimiter(node, source)
    if (close !== '') this.classifyDelimiter(close, node.innerEnd, sink)
  }

  private classifyDelimiter(delimiter: string, base: number, sink: SemanticToken[]): void {
    if (delimiter.length === 0) return
    if (delimiter[0] !== '[') {
      sink.push({ type: 'tag', range: { start: base, end: base + delimiter.length } })
      return
    }

    sink.push({ type: 'punctuation', range: { start: base, end: base + 1 } })

    const parsed = tagNameInDelimiter(delimiter)
    if (parsed !== null) {
      sink.push({
        type: 'tag',
        range: { start: base + parsed.start, end: base + parsed.end },
      })
    }

    // Everything after the name and before the final `]` is the attribute,
    // including its `=` and spaces: the renderer treats it as one opaque value
    // and nested BBCode inside a rich box title has its own nodes.
    const close = delimiter.lastIndexOf(']')
    const bodyEnd = close >= 0 ? close : delimiter.length
    const attributeStart = parsed !== null ? parsed.end : 1
    if (bodyEnd > attributeStart) {
      sink.push({
        type: 'attribute',
        range: { start: base + attributeStart, end: base + bodyEnd },
      })
    }

    if (close >= 0) {
      sink.push({ type: 'punctuation', range: { start: base + close, end: base + close + 1 } })
    }
  }

  /**
   * Folding ranges for every block that spans more than one line.
   *
   * Lines are 0-based, like `SourceText.positionAt`; `endLine` is inclusive
   * and never points past the line the block's last character is on.
   */
  getFoldingRanges(): readonly FoldingRange[] {
    this.ensureCurrent()
    if (this._folding !== null) {
      this._cacheHits++
      return this._folding
    }
    this._cacheMisses++

    const root = this.model.redRoot
    const ranges: FoldingRange[] = []
    if (root !== null) {
      const text = this.model.sourceText
      for (const block of root.children) {
        const blockLine = text.positionAt(block.range.start).line
        const cached = this._blockFolding.get(block.green)
        if (cached !== undefined && cached.node === block) {
          for (const range of cached.ranges) {
            ranges.push({
              startLine: range.startLine + blockLine,
              endLine: range.endLine + blockLine,
              kind: range.kind,
            })
          }
          continue
        }

        const relative: FoldingRange[] = []
        this.collectFolding(block, text, blockLine, relative)
        this._blockFolding.set(block.green, { node: block, ranges: relative })
        for (const range of relative) {
          ranges.push({
            startLine: range.startLine + blockLine,
            endLine: range.endLine + blockLine,
            kind: range.kind,
          })
        }
      }
    }

    ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
    this._folding = ranges
    return ranges
  }

  private collectFolding(
    node: RedNode,
    text: DocumentModel['sourceText'],
    blockLine: number,
    out: FoldingRange[],
  ): void {
    if (isBlockKind(node.kind) && !NOT_IN_OUTLINE.has(node.kind) && node.range.end > node.range.start) {
      const startLine = text.positionAt(node.range.start).line - blockLine
      const endLine = text.positionAt(node.range.end - 1).line - blockLine
      if (endLine > startLine) out.push({ startLine, endLine, kind: 'block' })
    }
    for (const child of node.children) this.collectFolding(child, text, blockLine, out)
  }

  // ── Cache and stats ─────────────────────────────────────────────

  /** Drop every cached answer. The next read rebuilds from the current tree. */
  invalidate(): void {
    this._version = -1
    this._documentSymbols = null
    this._tokens = null
    this._tokensVersion = -1
    this._blockTokens = new WeakMap()
    this._blockOutlines = new WeakMap()
    this._blockFolding = new WeakMap()
    this._folding = null
    this._symbolsBuiltFor = -1
  }

  get stats(): LanguageServiceStats {
    return {
      version: this._version,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      symbolBuilds: this._symbolBuilds,
      tokenBlocksReused: this._tokenBlocksReused,
      tokenBlocksBuilt: this._tokenBlocksBuilt,
      outlineBlocksReused: this._outlineBlocksReused,
      outlineBlocksBuilt: this._outlineBlocksBuilt,
    }
  }

  private ensureCurrent(): void {
    if (this._version === this.model.version) return
    this._version = this.model.version
    this._documentSymbols = null
    // `_tokens` deliberately survives: `getSemanticTokens` decides whether the
    // edit can be patched or needs a full pass. See `tokensAfterEdit`.
    this._folding = null
    this._symbolsBuiltFor = -1
  }

  private symbolTable(): SymbolTable {
    const version = this.model.version
    if (this._symbolsBuiltFor === version) return this.symbols
    const root = this.model.redRoot
    if (root === null) {
      this.symbols.clear()
    } else {
      this.symbols.build(root, this.model.source)
    }
    this._symbolsBuiltFor = version
    this._symbolBuilds++
    return this.symbols
  }

  private symbolAtOffset(offset: number): { symbol: SymbolInfo; node: RedNode } | null {
    const root = this.model.redRoot
    if (root === null) return null
    const node = root.findNodeAtOffset(offset)
    if (node === null) return null
    return this.symbolForNode(node)
  }

  private symbolForNode(node: RedNode): { symbol: SymbolInfo; node: RedNode } | null {
    const table = this.symbolTable()
    for (let current: RedNode | null = node; current !== null; current = current.parent) {
      const symbol = table.getSymbolForNode(current.id)
      if (symbol !== undefined) return { symbol, node: current }
      if (current.kind === 'document') break
    }
    return null
  }
}
