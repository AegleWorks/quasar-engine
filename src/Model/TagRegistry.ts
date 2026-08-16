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
import { mixMultiple, ease, clamp, hslToHex, type Easing } from '../Utils/color'

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

/** Recursively extract plain text from a RedNode tree */
function extractTextContent(node: RedNode): string {
  if (node.kind === 'text') return node.text
  return node.children.map(extractTextContent).join('')
}

/** Split text by unit: 'character', 'word', or 'line' */
function splitByUnit(text: string, unit: string): string[] {
  if (!text) return []
  switch (unit) {
    case 'word':
      return text.split(/(\s+)/).filter(s => s.length > 0)
    case 'line':
      return text.split('\n')
    default: // 'character'
      return [...text]
  }
}

/** Escape [ and ] inside BBCode content so they're not parsed as tags */
function escapeBracket(ch: string): string {
  // BBCode has no standard escape. For internal tags produced by TextStudio,
  // text never contains brackets. If it does, we use the backslash escape
  // that some BBCode parsers support.
  return ch.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

// ─── Effect segment math — one source of truth per effect ─────
//
// Each effect (gradient, sinewave, grow, rainbow) serializes two ways: to
// osu!-compatible BBCode (`toBBCode`) and to a RenderNode tree
// (`toRenderNode`). Both used to carry their own copy of the per-segment
// math — t-progression, easing, color mixing, wave sizing — differing only in
// presentation, which is exactly how the two drift apart. The math now lives
// in ONE `*Segments` function per effect; the handlers are thin presenters.
//
// Note this is deliberately NOT the same algorithm as `HTMLRenderer`'s own
// `renderGradient`: the preview paints a smooth CSS `linear-gradient` with
// `background-clip: text`, while these segments reproduce the DISCRETE
// per-chunk colors that the exported `[color=…]` BBCode will actually have.

/**
 * A run of text with the style its effect computed. `color` and `size` are
 * mutually exclusive; neither set means the run passes through unstyled
 * (whitespace between sized words).
 */
interface StyledSegment {
  text: string
  color?: string
  size?: number
}

/**
 * Effect progression t ∈ [0,1] for segment `i` of `count`, honoring the
 * document-wide fields (`globalOffset`/`documentLength`) that let one logical
 * effect span several nodes. `single` is the t for a one-segment run — the
 * effects legitimately disagree on it (gradient/rainbow use 0, grow 0.5).
 */
function progressAt(i: number, count: number, node: RedNode, single: number): number {
  const globalOffset = (node.metadata?.globalOffset as number) || 0
  const documentLength = (node.metadata?.documentLength as number) || count
  if (documentLength > 1) return (globalOffset + i) / (documentLength - 1)
  return count > 1 ? i / (count - 1) : single
}

function gradientSegments(node: RedNode): StyledSegment[] {
  const colors = (node.metadata?.colors as string[]) || ['#FF0000', '#00FF00']
  const unit = (node.metadata?.unit as string) || 'character'
  const easing = (node.metadata?.easing as Easing) || 'linear'
  const text = extractTextContent(node)
  if (!text) return []
  const parts = splitByUnit(text, unit)
  return parts.map((seg, i) => ({
    text: seg,
    color: mixMultiple(colors, ease(clamp(progressAt(i, parts.length, node, 0)), easing)),
  }))
}

function sinewaveSegments(node: RedNode): StyledSegment[] {
  const min = (node.metadata?.min as number) ?? 20
  const max = (node.metadata?.max as number) ?? 80
  const freq = (node.metadata?.freq as number) ?? 0.4
  const step = (node.metadata?.step as string) ?? 'char'
  const text = extractTextContent(node)
  if (!text) return []
  const amplitude = (max - min) / 2
  const center = min + amplitude

  if (step === 'word') {
    let wordIndex = 0
    return text.split(/(\s+)/).map(chunk => {
      if (chunk.trim() === '') return { text: chunk }
      const size = Math.round(center + Math.sin(wordIndex * freq) * amplitude)
      wordIndex++
      return { text: chunk, size }
    })
  }

  return [...text].map((ch, i) => ({
    text: ch,
    size: Math.round(center + Math.sin(i * freq) * amplitude),
  }))
}

function growSegments(node: RedNode): StyledSegment[] {
  const min = (node.metadata?.min as number) ?? 50
  const max = (node.metadata?.max as number) ?? 200
  const cycles = (node.metadata?.cycles as number) ?? 1
  const text = extractTextContent(node)
  if (!text) return []
  const chars = [...text]
  return chars.map((ch, i) => {
    const sine = Math.sin(progressAt(i, chars.length, node, 0.5) * cycles * Math.PI * 2)
    const normalized = (sine + 1) / 2
    return { text: ch, size: Math.round(min + (max - min) * normalized) }
  })
}

function rainbowSegments(node: RedNode): StyledSegment[] {
  const saturation = ((node.metadata?.saturation as number) ?? 80) / 100
  const lightness = ((node.metadata?.lightness as number) ?? 60) / 100
  const spread = (node.metadata?.spread as number) ?? 300
  const offset = (node.metadata?.offset as number) ?? 0
  const text = extractTextContent(node)
  if (!text) return []
  const chars = [...text]
  return chars.map((ch, i) => ({
    text: ch,
    color: hslToHex(offset + progressAt(i, chars.length, node, 0) * spread, saturation, lightness),
  }))
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

export class TagRegistry {
  private tags: Map<string, TagDefinition> = new Map()
  private kinds: Map<NodeKind, TagDefinition> = new Map()
  /** Names registered by the constructor — the language's own tags. */
  private builtins: Set<string> = new Set()

  /**
   * Bumped on every register/unregister, so consumers that derive something
   * from the registry (the parser's `extraTags` map) can memoize against it
   * instead of rebuilding per parse.
   */
  version: number = 0

  constructor() {
    this.registerBuiltins()
    for (const name of this.tags.keys()) this.builtins.add(name)
  }

  /**
   * Register a tag definition.
   */
  register(tag: TagDefinition): void {
    this.tags.set(tag.name, tag)
    this.kinds.set(tag.kind, tag)
    this.version++
  }

  /**
   * Unregister a tag definition.
   */
  unregister(name: string): void {
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

  /**
   * Register the built-in BBCode tags.
   */
  private registerBuiltins(): void {
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
          const segments = gradientSegments(ctx.node)
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('gradient', gradientSegments(ctx.node)),
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
          const segments = sinewaveSegments(ctx.node)
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('sinewave', sinewaveSegments(ctx.node)),
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
          const segments = growSegments(ctx.node)
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('grow', growSegments(ctx.node)),
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
          const segments = rainbowSegments(ctx.node)
          return segments.length === 0 ? ctx.visitChildren(ctx.node) : segmentsToBBCode(segments)
        },
        toRenderNode: (ctx) => segmentsToRenderNode('rainbow', rainbowSegments(ctx.node)),
      },

      // ── Layout ──
      { name: 'centre', kind: 'center', label: 'Centre', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true, toolbar: { group: 'layout', label: 'Centre', icon: 'AlignCenter' } },
      { name: 'center', kind: 'center', label: 'Center', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true, isDeprecated: true, deprecatedReplacement: 'centre' },
      { name: 'right', kind: 'right', label: 'Right', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'left', kind: 'left', label: 'Left', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'heading', kind: 'heading', label: 'Heading', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
      { name: 'notice', kind: 'notice', label: 'Notice', category: 'layout', isInline: false, isSelfClosing: false, canHaveChildren: true },
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

    for (const tag of tags) {
      this.register(tag)
    }
  }
}
