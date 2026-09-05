/**
 * DocumentEngine — TagRegistry
 *
 * The central registry for all known tags/node kinds.
 * This is the plugin extension point for adding new BBCode tags,
 * custom node types, or even entire new languages.
 *
 * Each tag definition includes:
 * - Parser handler (how to parse this tag from tokens)
 * - Renderer (how to render this tag to HTML, Markdown, etc.)
 * - Validator (semantic validation rules)
 * - Toolbar definition (for the visual editor)
 * - Property editor (for the properties panel)
 *
 * Inspired by VSCode's contribution points.
 */

import type { NodeKind, NodeAttributes } from '../Types/core'
import type { RedNode } from '../Syntax/RedNode'
import { GreenNode } from '../Syntax/GreenNode'
import type { RenderNode } from '../RenderPipeline/RenderTree'
import type { Validator } from '../Semantic/SemanticAnalyzer'
import {
  evaluateEffect,
  type EffectKind, type EffectParams, type EffectSpan, type StyledSegment,
} from '../Utils/EffectMath'

// ─── Tag Handler ───────────────────────────────────────────────

export interface TagHandlerContext {
  node: RedNode
  source: string
  visitChildren: (node: RedNode) => string
  renderChild: (node: RedNode) => RenderNode
}

export interface TagDefinition {
  /** The tag name (e.g. 'color', 'b', 'img') */
  name: string
  /** Semantic kind */
  kind: NodeKind
  /** Human-readable label */
  label: string
  /** Category for grouping in UI */
  category?: 'formatting' | 'layout' | 'media' | 'special' | 'text'
  /** Icon name for UI */
  icon?: string
  /** Whether this tag is inline (span) or block (div) */
  isInline: boolean
  /** Whether this tag is self-closing */
  isSelfClosing: boolean
  /** Whether this tag can contain children */
  canHaveChildren: boolean
  /** Whether this tag is deprecated */
  isDeprecated?: boolean
  /** Replacement tag name if deprecated */
  deprecatedReplacement?: string

  // ─── Handlers ───────────────────────────────────────────

  /** Convert a RedNode back to BBCode text */
  toBBCode?: (ctx: TagHandlerContext) => string
  /** Convert a RedNode to a RenderNode for the render pipeline */
  toRenderNode?: (ctx: TagHandlerContext) => RenderNode
  /** Convert a RedNode to HTML string (legacy) */
  toHTML?: (ctx: TagHandlerContext) => string
  /** Default attributes for new instances */
  defaultAttributes?: () => NodeAttributes

  // ─── Validation ─────────────────────────────────────────

  /** Additional validator for this specific tag */
  validator?: Validator

  // ─── UI Metadata ────────────────────────────────────────

  /** Toolbar button definition */
  toolbar?: {
    group: string
    label: string
    icon?: string
    shortcut?: string
  }
  /** Properties panel definition */
  properties?: PropertyDefinition[]
}

// ─── Property Definition ───────────────────────────────────────

export interface PropertyDefinition {
  name: string
  label: string
  type: 'text' | 'color' | 'number' | 'select' | 'boolean' | 'slider'
  defaultValue?: string | number | boolean
  options?: { label: string; value: string }[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  description?: string
}

// ─── TagRegistry ───────────────────────────────────────────────

// ─── Internal tag helpers (gradient/grow export) ──────────────

/**
 * Recursively extract plain text from a RedNode tree.
 *
 * A line break is a childless `spacing` leaf with no text of its own, so
 * it has to be spelled out here or an effect spanning two lines is handed
 * one line and exports without its break — silent data loss, and the
 * reason every two-dimensional axis (`line`, `column`, `radial`) measured
 * a block one line tall.
 */
export function extractTextContent(node: RedNode): string {
  if (node.kind === 'text') return node.text
  if (node.kind === 'spacing' || node.kind === 'empty_line') return '\n'
  return node.children.map(extractTextContent).join('')
}

/** Escape [ and ] inside BBCode content so they're not parsed as tags */
function escapeBracket(ch: string): string {
  // BBCode has no standard escape. For internal tags produced by TextStudio,
  // text never contains brackets. If it does, we use the backslash escape
  // that some BBCode parsers support.
  return ch.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

// ─── Effect segments ──────────────────────────────────────────
//
// The maths lives in `Utils/EffectMath`, not here. It used to live in
// this file, in four `*Segments` functions, while Text Studio kept its
// own copy and the HTML renderer kept a third — so the same document
// exported one way, previewed another, and lost every parameter the
// studio grew. These handlers now only read the node and present the
// result.

/** Effect parameters carried on a node, plus its span in a longer effect. */
function effectParamsOf(node: RedNode): { params: EffectParams; span: EffectSpan } {
  const meta = (node.metadata ?? {}) as Record<string, unknown>
  const params: EffectParams = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'globalOffset' || key === 'documentLength') continue
    ;(params as Record<string, unknown>)[key] = value
  }
  return {
    params,
    span: {
      globalOffset: meta.globalOffset as number | undefined,
      documentLength: meta.documentLength as number | undefined,
    },
  }
}

function effectSegments(node: RedNode, kind: EffectKind): StyledSegment[] {
  const text = extractTextContent(node)
  if (!text) return []
  const { params, span } = effectParamsOf(node)
  return evaluateEffect(text, kind, params, span)
}

/** Present styled segments as osu!-compatible BBCode. */
function segmentsToBBCode(segments: StyledSegment[]): string {
  let out = ''
  for (const s of segments) {
    if (s.color !== undefined) out += `[color=${s.color}]${escapeBracket(s.text)}[/color]`
    else if (s.size !== undefined) out += `[size=${s.size}]${escapeBracket(s.text)}[/size]`
    else out += s.text
  }
  return out
}

/** Present styled segments as a RenderNode tree. */
function segmentsToRenderNode(kind: string, segments: StyledSegment[]): RenderNode {
  return {
    kind,
    text: '',
    children: segments.map((s): RenderNode => {
      const style: Record<string, string> =
        s.color !== undefined ? { color: s.color }
        : s.size !== undefined ? { fontSize: `${s.size}%` }
        : {}
      return { kind: 'text', text: s.text, children: [], props: {}, style }
    }),
    props: {},
  }
}

export type TagHandler = {
  [K in keyof TagDefinition]: TagDefinition[K]
}

/**
 * The language's own tags, built once for the process.
 *
 * `registerBuiltins` allocates ~130 definition objects, several of them
 * carrying closures. Constructing a registry cost 14.7 µs because of it, and
 * a registry is constructed by every `DocumentModel`, every
 * `SemanticAnalyzer` and every exporter that is handed no registry — so a
 * throwaway parse paid for the whole table three times over. The table never
 * changes, so it is shared, and a registry only takes a private copy when a
 * plugin actually mutates it.
 */
let BUILTIN_TAGS: ReadonlyMap<string, TagDefinition> | null = null
let BUILTIN_KINDS: ReadonlyMap<NodeKind, TagDefinition> | null = null
let BUILTIN_NAMES: ReadonlySet<string> | null = null

function ensureBuiltins(): void {
  if (BUILTIN_TAGS !== null) return
  const tags = new Map<string, TagDefinition>()
  const kinds = new Map<NodeKind, TagDefinition>()
  for (const tag of builtinTagDefinitions()) {
    tags.set(tag.name, tag)
    kinds.set(tag.kind, tag)
  }
  BUILTIN_TAGS = tags
  BUILTIN_KINDS = kinds
  BUILTIN_NAMES = new Set(tags.keys())
}

export class TagRegistry {
  private tags: Map<string, TagDefinition>
  private kinds: Map<NodeKind, TagDefinition>
  /** Names registered by the constructor — the language's own tags. */
  private builtins: ReadonlySet<string>
  /**
   * Whether `tags`/`kinds` are still the process-wide builtin maps. While
   * they are, this registry must not write to them.
   */
  private shared: boolean = true

  /**
   * Bumped on every register/unregister, so consumers that derive something
   * from the registry (the parser's `extraTags` map) can memoize against it
   * instead of rebuilding per parse.
   */
  version: number = 0

  constructor() {
    ensureBuiltins()
    this.tags = BUILTIN_TAGS as Map<string, TagDefinition>
    this.kinds = BUILTIN_KINDS as Map<NodeKind, TagDefinition>
    this.builtins = BUILTIN_NAMES!
  }

  /** Take a private copy of the builtin maps before the first write. */
  private own(): void {
    if (!this.shared) return
    this.tags = new Map(this.tags)
    this.kinds = new Map(this.kinds)
    this.shared = false
  }

  /**
   * Register a tag definition.
   */
  register(tag: TagDefinition): void {
    this.own()
    this.tags.set(tag.name, tag)
    this.kinds.set(tag.kind, tag)
    this.version++
  }

  /**
   * Unregister a tag definition.
   */
  unregister(name: string): void {
    if (!this.tags.has(name)) return
    this.own()
    const tag = this.tags.get(name)
    if (tag) {
      this.tags.delete(name)
      this.kinds.delete(tag.kind)
      this.version++
    }
  }

  /**
   * Whether `name` is one of the language's own tags, as opposed to a
   * plugin registration. The distinction matters: plugin tags must reach the
   * parser (via `ParseOptions.extraTags`) and serialize with their own name,
   * while builtins already have both behaviors hardcoded — routing them
   * through the plugin path would change engine semantics.
   */
  isBuiltin(name: string): boolean {
    return this.builtins.has(name)
  }

  /**
   * tag name → kind for every non-builtin registration: the parser's
   * `extraTags`. Returns `null` when there are none, so the common case
   * costs one size comparison and no allocation.
   */
  customTags(): Map<string, NodeKind> | null {
    if (this.shared) return null
    if (this.tags.size === this.builtins.size) return null
    const out = new Map<string, NodeKind>()
    for (const [name, def] of this.tags) {
      if (!this.builtins.has(name)) out.set(name, def.kind)
    }
    return out.size > 0 ? out : null
  }

  /**
   * Get a tag definition by name.
   */
  get(name: string): TagDefinition | undefined {
    return this.tags.get(name)
  }

  /**
   * Get a tag definition by semantic kind.
   */
  getByKind(kind: NodeKind): TagDefinition | undefined {
    return this.kinds.get(kind)
  }

  /**
   * Check if a tag is registered.
   */
  has(name: string): boolean {
    return this.tags.has(name)
  }

  /**
   * Get all registered tags.
   */
  getAll(): TagDefinition[] {
    return Array.from(this.tags.values())
  }

  /**
   * Get tags by category.
   */
  getByCategory(category: string): TagDefinition[] {
    return this.getAll().filter(t => t.category === category)
  }

  /**
   * Get tags by whether they are inline.
   */
  getInline(): TagDefinition[] {
    return this.getAll().filter(t => t.isInline)
  }

  /**
   * Get block-level tags.
   */
  getBlock(): TagDefinition[] {
    return this.getAll().filter(t => !t.isInline && !t.isSelfClosing)
  }

}

/**
 * The built-in BBCode tags.
 *
 * Called once per process, through `ensureBuiltins`. It used to be a private
 * method that registered each definition into `this`, which meant rebuilding
 * this whole table for every registry.
 */
function builtinTagDefinitions(): TagDefinition[] {
    const tags: TagDefinition[] = [
      // ── Formatting ──
      { name: 'b', kind: 'bold', label: 'Bold', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'formatting', label: 'Bold', icon: 'Bold', shortcut: 'Ctrl+B' } },
      { name: 'i', kind: 'italic', label: 'Italic', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'formatting', label: 'Italic', icon: 'Italic', shortcut: 'Ctrl+I' } },
      { name: 'u', kind: 'underline', label: 'Underline', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'formatting', label: 'Underline', icon: 'Underline', shortcut: 'Ctrl+U' } },
      { name: 's', kind: 'strikethrough', label: 'Strikethrough', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'strike', kind: 'strikethrough', label: 'Strikethrough (deprecated)', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, isDeprecated: true, deprecatedReplacement: 's' },
      { name: 'color', kind: 'color', label: 'Color', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'formatting', label: 'Color', icon: 'Palette' }, properties: [{ name: 'color', label: 'Color', type: 'color', defaultValue: '#FF66AB' }] },
      { name: 'size', kind: 'font_size', label: 'Font Size', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, properties: [{ name: 'size', label: 'Size (%)', type: 'slider', defaultValue: 100, min: 50, max: 200, step: 5 }] },
      { name: 'c', kind: 'inline_code', label: 'Inline Code', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'font', kind: 'font', label: 'Font', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'spoiler', kind: 'spoiler', label: 'Spoiler', category: 'formatting', isInline: true, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'formatting', label: 'Spoiler', icon: 'EyeOff' } },
      { name: 'zalgo', kind: 'zalgo', label: 'Zalgo', category: 'text', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'aesthetic', kind: 'aesthetic', label: 'Aesthetic', category: 'text', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'sparkle', kind: 'sparkle', label: 'Sparkle', category: 'text', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'bubble', kind: 'bubble', label: 'Bubble', category: 'text', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'flower', kind: 'flower', label: 'Flower', category: 'text', isInline: true, isSelfClosing: false, canHaveChildren: true },

      // ── Internal (export-only, not user-facing BBCode) ──
      {
        name: 'gradient',
        kind: 'gradient',
        label: 'Gradient',
        category: 'text',
        isInline: true,
        isSelfClosing: false,
        canHaveChildren: true,
        toBBCode: (ctx) => {
          const segments = effectSegments(ctx.node, 'gradient')
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('gradient', effectSegments(ctx.node, 'gradient')),
      },
      {
        name: 'sinewave',
        kind: 'sinewave',
        label: 'Sine Wave',
        category: 'text',
        isInline: true,
        isSelfClosing: false,
        canHaveChildren: true,
        toBBCode: (ctx) => {
          const segments = effectSegments(ctx.node, 'sinewave')
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('sinewave', effectSegments(ctx.node, 'sinewave')),
      },
      {
        name: 'grow',
        kind: 'grow',
        label: 'Grow',
        category: 'text',
        isInline: true,
        isSelfClosing: false,
        canHaveChildren: true,
        toBBCode: (ctx) => {
          const segments = effectSegments(ctx.node, 'grow')
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('grow', effectSegments(ctx.node, 'grow')),
      },
      {
        // Colour driven by a picture rather than a ramp: the tag carries a
        // small indexed grid, and each character takes the colour of the
        // cell it lands on. Nothing about the text changes — this is the
        // one effect whose whole point is that the art keeps its shape.
        name: 'paint',
        kind: 'paint',
        label: 'Paint',
        category: 'text',
        isInline: true,
        isSelfClosing: false,
        canHaveChildren: true,
        toBBCode: (ctx) => {
          const segments = effectSegments(ctx.node, 'paint')
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('paint', effectSegments(ctx.node, 'paint')),
      },
      {
        name: 'rainbow',
        kind: 'rainbow',
        label: 'Rainbow',
        category: 'text',
        isInline: true,
        isSelfClosing: false,
        canHaveChildren: true,
        toBBCode: (ctx) => {
          const segments = effectSegments(ctx.node, 'rainbow')
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('rainbow', effectSegments(ctx.node, 'rainbow')),
      },

      // ── Layout ──
      { name: 'centre', kind: 'center', label: 'Centre', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'layout', label: 'Centre', icon: 'AlignCenter' } },
      { name: 'center', kind: 'center', label: 'Center', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true, isDeprecated: true, deprecatedReplacement: 'centre' },
      { name: 'right', kind: 'right', label: 'Right', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'left', kind: 'left', label: 'Left', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'heading', kind: 'heading', label: 'Heading', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'notice', kind: 'notice', label: 'Notice', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'wnotice', kind: 'wnotice', label: 'Warning Notice', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'square', kind: 'container', label: 'Square Badge', category: 'layout', isInline: true, isSelfClosing: false, canHaveChildren: true },
      { name: 'circle', kind: 'container', label: 'Square Badge', category: 'layout', isInline: true, isSelfClosing: false, canHaveChildren: true, isDeprecated: true, deprecatedReplacement: 'square' },
      { name: 'spacing', kind: 'spacing', label: 'Spacing', category: 'layout', isInline: false, isSelfClosing: true, canHaveChildren: false },
      { name: 'empty_line', kind: 'empty_line', label: 'Empty Line', category: 'layout', isInline: false, isSelfClosing: true, canHaveChildren: false },

      // ── Media ──
      { name: 'img', kind: 'image', label: 'Image', category: 'media', isInline: false, isSelfClosing: false, canHaveChildren: false },
      { name: 'youtube', kind: 'video', label: 'YouTube', category: 'media', isInline: false, isSelfClosing: false, canHaveChildren: false },
      { name: 'audio', kind: 'audio', label: 'Audio', category: 'media', isInline: false, isSelfClosing: false, canHaveChildren: false },
      { name: 'imagemap', kind: 'imagemap', label: 'Image Map', category: 'media', isInline: false, isSelfClosing: false, canHaveChildren: true },

      // ── Special ──
      { name: 'quote', kind: 'quote', label: 'Quote', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'special', label: 'Quote', icon: 'Quote' } },
      { name: 'code', kind: 'code', label: 'Code Block', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'svg', kind: 'svg', label: 'SVG Canvas', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'spoilerbox', kind: 'spoilerbox', label: 'Spoiler Box', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'special', label: 'Spoiler Box', icon: 'ChevronDown' } },
      { name: 'box', kind: 'box', label: 'Box', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'boxw', kind: 'boxw', label: 'Box (líneas)', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'list', kind: 'list', label: 'List', category: 'special', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: '*', kind: 'list_item', label: 'List Item', category: 'special', isInline: false, isSelfClosing: true, canHaveChildren: false },
      { name: 'url', kind: 'url', label: 'URL', category: 'special', isInline: true, isSelfClosing: false, canHaveChildren: false },
      { name: 'email', kind: 'email', label: 'Email', category: 'special', isInline: true, isSelfClosing: false, canHaveChildren: false },
      { name: 'profile', kind: 'profile', label: 'Profile', category: 'special', isInline: true, isSelfClosing: false, canHaveChildren: false },
      { name: 'group', kind: 'group', label: 'Group', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
    ]

    return tags
}
