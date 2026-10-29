/**
 * Stateless BBCode compile + render, and the bounded batch loop built on it.
 *
 * `BBCodeDocumentModel` is the right tool for a document someone is editing:
 * it owns undo, events, incremental parsing and semantic analysis. A feed of
 * userpages is not being edited; paying for those subsystems per page was
 * always waste. This module goes straight through the same measured phases —
 * lexer → parser → red tree → `HTMLRenderer` — with one registry and one
 * renderer per batch, and no model retained between pages.
 *
 * Output is the same as `BBCodeDocumentModel.renderForum` for the same options
 * (that method now delegates here). `BBCodeBatchRenderer` is sequential by
 * design: JavaScript rendering is CPU-bound, and one reusable renderer is
 * faster than N interleaved ones. A consumer that needs to keep memory flat
 * can use `stream`, which yields one page at a time instead of retaining every
 * HTML string.
 */

import type { TagRegistry } from '../Model/TagRegistry'
import { TagRegistry as Registry } from '../Model/TagRegistry'
import type { BBCodeToken } from '../Lexer/BBCodeLexer'
import { createBBCodeScanner } from '../Lexer/BBCodeLexer'
import { parseTokensToGreen } from './Parser'
import { greenToRedNode, type BBCodeDialect } from './BBCodeToGreenNode'
import { HTMLRenderer, type HTMLRendererOptions } from '../Visitors/HTMLRenderer'

export interface BBCodeRenderOptions extends HTMLRendererOptions {
  /** Tag-pairing rule: `'quasar'` (default) or osu!'s measured sealing. */
  pairing?: 'quasar' | 'osu'
  /** Enforce strict tag nesting (disables osu!'s auto-close legacy behaviour). */
  strictMode?: boolean
}

/** One page's HTML plus the time each half of the pipeline took. */
export interface BBCodeRenderResult {
  html: string
  /** Lexing, parsing and building the red tree, in milliseconds. */
  parseMs: number
  /** Painting that tree through `HTMLRenderer`, in milliseconds. */
  renderMs: number
}

/** The source a blank page is parsed as, matching `renderForum`. */
const BLANK_SOURCE = ' '

function dialectOf(options: BBCodeRenderOptions): BBCodeDialect {
  return options.dialect ?? (options.theme === 'lyne' ? 'lyne' : 'miliastry')
}

/**
 * Lex → green → red. The caller owns the resulting tree.
 *
 * Kept private: a public tree-returning API would invite consumers to retain
 * every page's tree, which is exactly the memory shape this module exists to
 * avoid. A caller that needs the tree can build a model; a caller that needs
 * HTML should stay on the batch path.
 */
function compileToRed(source: string, options: BBCodeRenderOptions, registry: TagRegistry) {
  const effectiveSource = source || BLANK_SOURCE
  const dialect = dialectOf(options)
  const pairing = options.pairing ?? 'quasar'
  const extraTags = registry.customTags() ?? undefined
  const tokens: BBCodeToken[] | ReturnType<typeof createBBCodeScanner> =
    createBBCodeScanner(effectiveSource, { pairing })

  const green = parseTokensToGreen(tokens, effectiveSource, {
    strictMode: options.strictMode ?? false,
    dialect,
    normalizeParagraphs: true,
    extraTags,
    pairing,
  })
  return greenToRedNode(green)
}

function rendererOptions(
  options: BBCodeRenderOptions,
  registry: TagRegistry,
): HTMLRendererOptions {
  const dialect = dialectOf(options)
  return {
    ...options,
    dialect,
    registry: options.registry ?? registry,
    idMode: 'none',
  }
}

/**
 * Render one BBCode page without constructing a `DocumentModel`.
 *
 * This is the fast path for feeds, forum posts, comments and static previews:
 * no semantic analysis, no undo stack, no incremental parser, no editor ids.
 */
export function renderBBCode(source: string, options: BBCodeRenderOptions = {}): string {
  const registry = options.registry ?? new Registry()
  const renderer = new HTMLRenderer(rendererOptions(options, registry))
  return renderer.render(compileToRed(source, options, registry))
}

/**
 * Reusable batch renderer.
 *
 * `render` is deliberately non-reentrant: one renderer holds link, table and
 * cut state while painting a page, so a resolver callback must not recursively
 * call the same instance. Top-level {@link renderBBCode} creates a fresh
 * renderer and is safe to nest.
 */
export class BBCodeBatchRenderer {
  private readonly options: BBCodeRenderOptions
  private readonly registry: TagRegistry
  private readonly renderer: HTMLRenderer

  constructor(options: BBCodeRenderOptions = {}) {
    this.options = options
    this.registry = options.registry ?? new Registry()
    this.renderer = new HTMLRenderer(rendererOptions(options, this.registry))
  }

  /** The registry used for parsing plugin tags and rendering them. */
  get tagRegistry(): TagRegistry {
    return this.registry
  }

  render(source: string): string {
    return this.renderer.render(compileToRed(source, this.options, this.registry))
  }

  /**
   * Render one page and report where the time went.
   *
   * Kept separate from {@link render} so the hot path does not allocate a
   * result object per page: a viewer that shows parse/render timings (NovaLooky
   * does) can ask for them; a feed cannot pay for what it does not read.
   */
  renderDetailed(source: string): BBCodeRenderResult {
    const started = performance.now()
    const root = compileToRed(source, this.options, this.registry)
    const parsed = performance.now()
    const html = this.renderer.render(root)
    const rendered = performance.now()
    return { html, parseMs: parsed - started, renderMs: rendered - parsed }
  }

  /** Render an iterable eagerly. The result is one string per input page. */
  renderMany(sources: Iterable<string>): string[] {
    const out: string[] = []
    for (const source of sources) out.push(this.render(source))
    return out
  }

  /**
   * Render lazily, one page at a time.
   *
   * The generator retains only the current source and its tree; callers that
   * write each result as it arrives keep peak memory independent of how many
   * pages the feed contains.
   */
  *stream(sources: Iterable<string>): Generator<string, void, undefined> {
    for (const source of sources) yield this.render(source)
  }
}

/** Convenience wrapper over one reusable batch renderer. */
export function renderBBCodeMany(
  sources: Iterable<string>,
  options: BBCodeRenderOptions = {},
): string[] {
  return new BBCodeBatchRenderer(options).renderMany(sources)
}

/** Convenience wrapper that keeps only the page currently being rendered. */
export function renderBBCodeStream(
  sources: Iterable<string>,
  options: BBCodeRenderOptions = {},
): Generator<string, void, undefined> {
  return new BBCodeBatchRenderer(options).stream(sources)
}
