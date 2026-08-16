/**
 * DocumentEngine — BBCodeDocumentModel
 *
 * A DocumentModel subclass that uses the DocumentEngine's built-in
 * BBCode Lexer + Parser to produce GreenNode/RedNode trees.
 *
 * This COMPLETELY replaces the old BBCode parser (MiliastryNovaFeatures/BBCode/Parser).
 * The old parser is DEPRECATED.
 *
 * Architecture:
 *   BBCode text
 *     ↓ BBCodeLexer.scanBBCode()
 *   BBCodeToken[]
 *     ↓ Parser.parseTokensToGreen()
 *   GreenNode
 *     ↓ BBCodeToGreenNode.greenToRedNode()
 *   RedNode
 *     ↓ HTMLRenderer.render()
 *   HTML preview
 *
 * Usage:
 *   const model = new BBCodeDocumentModel({ source: '[b]Hello[/b]' })
 *   const html = new HTMLRenderer().render(model.redRoot!)
 */

import { DocumentModel, type DocumentModelOptions } from '../Model/DocumentModel'
import type { ReparseParseOptions } from '../Incremental/IncrementalParser'
import { GreenNodePool, type InterningMode } from '../Syntax/GreenNodePool'
import { GreenNode, greenLeaf } from '../Syntax/GreenNode'
import { RedNode } from '../Syntax/RedNode'
import { greenToRedNode, greenToRedNodeReusing, type BBCodeDialect } from './BBCodeToGreenNode'
import { parseTokensToGreen } from './Parser'
import { scanBBCode } from '../Lexer/BBCodeLexer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

export interface BBCodeDocumentModelOptions extends DocumentModelOptions {
  /** Source BBCode text to parse */
  source?: string
  /** Language identifier (default: 'bbcode') */
  language?: string
  /** Enforce strict tag nesting (disables osu! auto-close legacy behavior) */
  strictMode?: boolean
  /** BBCode dialect to parse against ('osu' | 'miliastry' | 'lyne'). Default: 'miliastry'. */
  dialect?: BBCodeDialect
  /** Alias for dialect ('osu' | 'miliastry' | 'lyne') */
  mode?: BBCodeDialect
  /**
   * Deduplicate structurally identical green nodes across the document.
   *
   * Off by default. It is correct now — see the header of `GreenNodePool.ts`
   * for why it was not — but it is a memory/latency trade, and this engine's
   * declared budget is latency: on the 19.6 KB reference document `'leaves'`
   * costs 16% more parse time to save 42% of the green tree's memory. Turn it
   * on for workloads that hold many documents at once; leave it off to type
   * into one.
   */
  interning?: InterningMode
}

// ─── BBCodeDocumentModel ────────────────────────────────────

export class BBCodeDocumentModel extends DocumentModel {
  private _strictMode: boolean
  private _dialect: BBCodeDialect
  /** Per-document interner, or null when interning is off. */
  private _interner: GreenNodePool | null
  /** Memoized parser `extraTags`, rebuilt only when the registry changes. */
  private _extraTags: ReadonlyMap<string, import('../Types/core').NodeKind> | null = null
  private _extraTagsVersion: number = -1

  constructor(options: BBCodeDocumentModelOptions = {}) {
    // `source` is deliberately empty here: the base constructor would parse it
    // with `parseToGreen`, which runs before this subclass has set
    // `_strictMode`. The initial parse happens below instead.
    //
    // Everything else must be forwarded. It previously was not, so `autoAnalyze`
    // and `maxUndo` were silently dropped and semantic analysis could not be
    // turned off at all.
    super({
      source: '',
      language: options.language ?? 'bbcode',
      maxUndo: options.maxUndo,
      autoAnalyze: options.autoAnalyze,
      incremental: options.incremental,
      reuseRed: options.reuseRed,
    })
    this._strictMode = options.strictMode ?? false
    this._dialect = options.dialect ?? options.mode ?? 'miliastry'
    this._interner = options.interning ? GreenNodePool.create(options.interning) : null
    if (options.source) {
      this.rebuild(options.source)
    }
  }

  get dialect(): BBCodeDialect {
    return this._dialect
  }

  get root(): RedNode | null {
    return this.redRoot
  }

  toHTML(renderer?: HTMLRenderer): string {
    if (!this.redRoot) return ''
    const r = renderer ?? new HTMLRenderer({ dialect: this._dialect, theme: this._dialect === 'lyne' ? 'lyne' : 'osu' })
    return r.render(this.redRoot)
  }

  /**
   * Parse BBCode text directly to a GreenNode tree using the
   * DocumentEngine's built-in BBCode Lexer + Parser.
   * No dependency on the deprecated old parser.
   */
  protected parseToGreen(source: string, options?: ReparseParseOptions): GreenNode {
    try {
      // 1. Lex: BBCode text → tokens (with explicit newline tokens)
      const tokens = scanBBCode(source)

      // Plugin tags reach the parser here. Memoized against the registry's
      // version: with no plugins (the common case) this is one integer
      // compare and `extraTags` stays undefined — the parser's zero-cost path.
      if (this._extraTagsVersion !== this.tagRegistry.version) {
        this._extraTags = this.tagRegistry.customTags()
        this._extraTagsVersion = this.tagRegistry.version
      }

      // 2. Parse: tokens → GreenNode (with proper empty_line handling)
      const green = parseTokensToGreen(tokens, source, {
        strictMode: this._strictMode,
        dialect: this._dialect,
        normalizeParagraphs: options?.normalizeParagraphs ?? true,
        interner: this._interner ?? undefined,
        extraTags: this._extraTags ?? undefined,
      })

      return green
    } catch (error) {
      console.warn('[BBCodeDocumentModel] Parse error:', error)
      // Fallback: preserve source as a text node
      return greenLeaf('text', source)
    }
  }

  /**
   * Build a RedNode from a GreenNode, extracting metadata
   * from BBCode attributes in the process.
   */
  protected buildRedFromGreen(green: GreenNode): RedNode {
    return greenToRedNode(green)
  }

  /**
   * Reuse-aware red build for the incremental path: adopts old red subtrees
   * wherever the splice shared their green by reference. See the contract on
   * `greenToRedNodeReusing` — the old tree is consumed.
   */
  protected buildRedFromGreenReusing(
    green: GreenNode,
    oldRed: RedNode,
    stats?: { adopted: number },
  ): RedNode {
    return greenToRedNodeReusing(green, oldRed, 0, stats)
  }

  /**
   * Serialize the red tree back to BBCode, so `transact`/`undo`/`redo` can
   * rebuild from text. Target 'miliastry' keeps native tags (gradient, grow,
   * …) as-is instead of expanding them, which is what round-tripping needs.
   */
  protected exportSource(root: RedNode): string {
    const exportTarget = this._dialect === 'lyne' ? 'lyne' : this._dialect === 'osu' ? 'osu' : 'miliastry'
    return new BBCodeExporter(this.tagRegistry, exportTarget).export(root)
  }
}
