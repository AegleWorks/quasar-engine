/**
 * DocumentEngine — BBCodeToGreenNode
 *
 * Bridge between the existing BBCode Parser (BBBlock[]) and the
 * DocumentEngine's GreenNode/RedNode syntax tree.
 *
 * This is how we integrate the mature, battle-tested BBCode parser
 * with the new Language Platform architecture.
 *
 * The flow:
 *   BBCode text
 *   → parseBBCode() [existing] → BBBlock[]
 *   → convertToGreenNode() [this] → GreenNode
 *   → buildRedNode() [this] → RedNode
 *   → DocumentModel
 */

import { GreenNode, greenNode, greenLeaf } from '../Syntax/GreenNode'
import { RedNode } from '../Syntax/RedNode'
import { RedNodeStore } from '../Syntax/RedNodeStore'
import type { NodeKind } from '../Types/core'
import { scanBBCode } from '../Lexer/BBCodeLexer'
import { parseTokensToGreen } from './Parser'

// ─── Dialect & Tag → Kind mapping ─────────────────────────────

export type BBCodeDialect = 'osu' | 'miliastry' | 'lyne'

const OSU_TAG_TO_KIND_ENTRIES: Record<string, NodeKind> = {
  'b': 'bold',
  'i': 'italic',
  'u': 'underline',
  's': 'strikethrough',
  'strike': 'strikethrough',
  'color': 'color',
  'colour': 'color',
  'size': 'font_size',
  'c': 'inline_code',
  'code': 'code',
  'spoiler': 'spoiler',
  'centre': 'center',
  'center': 'center',
  'right': 'right',
  'left': 'left',
  'url': 'url',
  'email': 'email',
  'profile': 'profile',
  'img': 'image',
  'youtube': 'video',
  'audio': 'audio',
  'imagemap': 'imagemap',
  'quote': 'quote',
  'notice': 'notice',
  'spoilerbox': 'spoilerbox',
  'box': 'box',
  'list': 'list',
  '*': 'list_item',
  'heading': 'heading',
  'empty_line': 'empty_line',
}

const MILIASTRY_TAG_TO_KIND_ENTRIES: Record<string, NodeKind> = {
  ...OSU_TAG_TO_KIND_ENTRIES,
  // Extras de Miliastry: osu! real + cositas especiales propias. `font` vive
  // aquí (y en Lyne), NO en osu: osu! solo tiene [size], no familia tipográfica.
  'font': 'font',
  'zalgo': 'zalgo',
  'aesthetic': 'aesthetic',
  'sparkle': 'sparkle',
  'bubble': 'bubble',
  'flower': 'flower',
  'gradient': 'gradient',
  'grow': 'grow',
  'sinewave': 'sinewave',
  'rainbow': 'rainbow',
  'svg': 'svg',
  'group': 'group',
}

/**
 * Tags canónicos de Lyne — la superficie REAL del dialecto. Cada familia tiene
 * UNA sola forma: `effect`, `anim`, `container`, `style` (el tipo va como
 * atributo: `[effect=glow:#hex]`, `[anim=typewriter]`, `[container=glass]`).
 *
 * Los tipos de efecto que no tienen tag propio (emboss, engrave, …) se
 * alcanzan igualmente vía `[effect=emboss]`: no necesitan fila aquí.
 */
const LYNE_CANONICAL_TAG_TO_KIND: Record<string, NodeKind> = {
  // Core & standard
  'b': 'bold',
  'i': 'italic',
  'u': 'underline',
  's': 'strikethrough',
  'strike': 'strikethrough',
  'color': 'color',
  'colour': 'color',
  'size': 'font_size',
  'font': 'font',
  'c': 'inline_code',
  'code': 'code',
  'url': 'url',
  'email': 'email',
  'profile': 'profile',
  'guild': 'guild',
  'map': 'map',
  'img': 'image',
  'youtube': 'video',
  'audio': 'audio',
  'video': 'video',
  'imagemap': 'imagemap',
  'heading': 'heading',
  'notice': 'notice',
  'wnotice': 'wnotice',
  'quote': 'quote',
  'box': 'box',
  'boxw': 'boxw',
  'spoilerbox': 'spoilerbox',
  'spoiler': 'spoiler',
  'list': 'list',
  '*': 'list_item',
  'centre': 'center',
  'center': 'center',
  'right': 'right',
  'align': 'align',
  'hr': 'separator',
  'separator': 'separator',
  'scroll': 'scroll',
  'empty_line': 'empty_line',

  // Tables
  'tables': 'tables',
  'row': 'table_row',
  'col': 'table_col',
  'th': 'table_th',

  // Layout
  'gallery': 'gallery',
  'columns': 'columns',

  // Inline / Typography
  'sup': 'sup',
  'sub': 'sub',
  'abbr': 'abbr',
  'mark': 'mark',
  'kbd': 'kbd',
  'tooltip': 'tooltip',
  'flip': 'flip',
  'gradient': 'gradient',
  'raw': 'raw',
  'noparse': 'raw',
  'plain': 'plain',

  // Consolidated
  'effect': 'effect',
  'anim': 'anim',
  'container': 'container',
  'style': 'style_tag',
}

/**
 * Grafías legacy que Lyne original aceptaba, mantenidas SOLO para que los
 * posts antiguos sigan parseando. La forma canónica es la familia:
 * `[effect=glow]`, `[anim=fade]`, `[container=glass]`, `[style=width:300px]`.
 * El exporter ya normaliza a la forma canónica al re-exportar, así que el
 * contenido legacy se auto-limpia con una edición. NO añadir más grafías
 * aquí: un efecto o contenedor nuevo se usa con su familia (`[effect=tipo]`).
 */
const LYNE_LEGACY_ALIASES: Record<string, NodeKind> = {
  // Effect legacy aliases
  'glow': 'effect',
  'neon': 'effect',
  'outline': 'effect',
  'shimmer': 'effect',
  'ghost': 'effect',
  'rainbow': 'effect',
  'fire': 'effect',
  'ice': 'effect',

  // Anim legacy aliases
  'typewriter': 'anim',
  'wave': 'anim',
  'sparkle': 'anim',
  'glitch': 'anim',
  'levitate': 'anim',

  // Container legacy aliases
  'stack': 'container',
  'flex': 'container',
  'grid': 'container',
  'middle': 'container',
  'circle': 'container',
  'card': 'container',
  'glass': 'container',
  'neon-box': 'container',
  'neonbox': 'container',
}

/**
 * Mapa completo de Lyne = canónicos + grafías legacy de compatibilidad.
 *
 * NOTA — podas realizadas (el texto queda literal, que es lo honesto):
 *  - `relief`, `gap`, `colspan`, `rowspan`: no hacían nada real (relief sin
 *    caso en el renderer, gap sin identidad, colspan/rowspan son atributos de
 *    `[col]`, no tags).
 *  - Los 18 aliases de estilo (`width`, `height`, `padding`, `margin`, …):
 *    rotos — pasaban el valor como CSS crudo (`[width=300]` → `style="300"`,
 *    inválido, el renderer lo descartaba). Solo `[style=…]` funciona.
 *  - `shadow`: el tipo de effect ignoraba el color y chocaba con el `shadow`
 *    de osu (significado distinto por dialecto). Eliminado de Lyne.
 *  - `fade`: duplicado exacto de `[anim=fade-in]`. Eliminado.
 */
const LYNE_TAG_TO_KIND_ENTRIES: Record<string, NodeKind> = {
  ...LYNE_CANONICAL_TAG_TO_KIND,
  ...LYNE_LEGACY_ALIASES,
}

const DIALECT_MAPS: Record<BBCodeDialect, Map<string, NodeKind>> = {
  osu: new Map(Object.entries(OSU_TAG_TO_KIND_ENTRIES)),
  miliastry: new Map(Object.entries(MILIASTRY_TAG_TO_KIND_ENTRIES)),
  lyne: new Map(Object.entries(LYNE_TAG_TO_KIND_ENTRIES)),
}

const TAG_TO_KIND = DIALECT_MAPS.miliastry

const KIND_TO_TAG: Partial<Record<NodeKind, string>> = {}
for (const [tag, kind] of TAG_TO_KIND) {
  KIND_TO_TAG[kind] = tag
}

export const BBCODE_TAG_NAMES: readonly string[] = Object.freeze(
  [...TAG_TO_KIND.keys()].sort(),
)

export function getBBCodeTagNames(dialect: BBCodeDialect = 'miliastry'): readonly string[] {
  // Para Lyne, la superficie visible es la CANÓNICA: los legacy aliases se
  // siguen parseando (compatibilidad) pero no se listan — así un consumidor
  // (autocomplete, docs) solo ofrece las formas canónicas.
  if (dialect === 'lyne') return Object.freeze([...Object.keys(LYNE_CANONICAL_TAG_TO_KIND)].sort())
  const map = DIALECT_MAPS[dialect] || DIALECT_MAPS.miliastry
  return Object.freeze([...map.keys()].sort())
}

export function tagToNodeKind(tag: string | null, dialect: BBCodeDialect = 'miliastry'): NodeKind {
  if (tag === null) return 'text'
  const map = DIALECT_MAPS[dialect] || DIALECT_MAPS.miliastry
  return map.get(tag) ?? 'custom'
}

export function nodeKindToTag(kind: NodeKind): string | null {
  return KIND_TO_TAG[kind] ?? null
}

// ─── Rendered kind — tags that produce inline or block HTML ──

const RENDERED_AS_BLOCK = new Set<NodeKind>([
  'notice', 'wnotice', 'spoilerbox', 'box', 'boxw', 'list', 'quote', 'code', 'svg',
  'heading', 'center', 'right', 'left', 'align', 'imagemap', 'document',
  'list_item', 'spacing', 'empty_line', 'paragraph',
  'tables', 'table_row', 'gallery', 'columns', 'separator', 'scroll',
  'container',
])

export function isBlockKind(kind: NodeKind): boolean {
  return RENDERED_AS_BLOCK.has(kind)
}

// ─── BBBlock Interface (mirror of existing parser's type) ──

export interface BBBlock {
  id: string
  tag: string | null
  attrs: string
  content: string
  rawStart: number
  rawEnd: number
  children: BBBlock[]
  attrChildren?: BBBlock[]
  html?: string
}

// ─── Converters ─────────────────────────────────────────────

/**
 * Convert a single BBBlock to a GreenNode.
 * Recursively converts children.
 */
export function bbBlockToGreenNode(block: BBBlock): GreenNode {
  const kind = tagToNodeKind(block.tag)
  const children: GreenNode[] = []
  let text = ''

  // For leaf blocks with a tag (self-closing like [*], or content like [img]src[/img])
  if (block.tag === '*') {
    // List item: content is in the attrs or in children
    text = block.attrs || ''
  } else if (block.tag === 'img' || block.tag === 'youtube' || block.tag === 'audio') {
    // Media tags: content is in the text between tags
    text = block.content
  } else if (block.tag === null) {
    // Text node
    text = block.content
  } else {
    // Tag node with children
    text = block.attrs || ''
  }

  // Convert children recursively
  for (const child of block.children) {
    children.push(bbBlockToGreenNode(child))
  }

  // Handle attrChildren (nested BBCode inside attributes like [box=[color]Title[/color]])
  if (block.attrChildren && block.attrChildren.length > 0) {
    for (const attrChild of block.attrChildren) {
      children.push(bbBlockToGreenNode(attrChild))
    }
  }

  // `rawStart`/`rawEnd` are gone: a green node's width comes from its children,
  // or from its own text when it has none. This legacy bridge never fed the
  // incremental parser, so nothing depended on the old absolute spans.
  return children.length > 0
    ? greenNode(kind, text, children)
    : greenLeaf(kind, text, block.rawEnd - block.rawStart)
}

/**
 * Convert an array of BBBlock[] (the root of the existing parser's output)
 * to a GreenNode tree.
 *
 * Note: This function is kept for backward compatibility with the old parser.
 * The new DocumentEngine parser (Parser.ts + BBCodeLexer) produces GreenNode
 * directly and does NOT go through BBBlock[].
 */
export function bbBlocksToGreenTree(blocks: BBBlock[], source: string): GreenNode {
  const children: GreenNode[] = []
  for (const block of blocks) {
    children.push(bbBlockToGreenNode(block))
  }

  return greenNode('document', '', children)
}

/**
 * Extract metadata from BBCode attributes stored in a GreenNode's text.
 *
 * The GreenNode stores `block.attrs` in its `text` field for tag nodes.
 * BBCode attrs have the format `=VALUE` (e.g. `=#61afef`, `="Author"`,
 * `=https://osu.ppy.sh`). This function parses them into typed metadata.
 *
 * For media tags (image, video, audio), the content may be in children
 * rather than attrs (e.g. `[img]url[/img]` vs `[img=url]`).
 * When attrs are empty, we fall back to the first child text node.
 */
/**
 * Get the URL from the first child text node (fallback for `[img]url[/img]`).
 *
 * Module-level on purpose: as a closure inside `extractGreenNodeMetadata` this
 * was allocated for every node in the document, including the vast majority
 * whose `switch` branch never calls it.
 */
function firstChildText(green: GreenNode): string {
  if (green.children.length > 0) {
    const first = green.children[0] as GreenNode
    if (first.kind === 'text' && first.text) return first.text
  }
  return ''
}

const BBCODE_TAG_RE = /\[\/?[a-zA-Z0-9_*-]+=?[^\]]*\]/g

/** Strip BBCode tags from text for clean display (e.g. `[b]title[/b]` → `title`) */
function stripBBCode(raw: string): string {
  return raw.replace(BBCODE_TAG_RE, '').trim()
}

export function extractGreenNodeMetadata(green: GreenNode): Record<string, unknown> {
  const kind = green.kind as NodeKind
  if (kind === 'text') return {}

  const rawText = green.text || ''

  // Strip `=` prefix and surrounding quotes
  let value = rawText
  const eqIdx = value.indexOf('=')
  if (eqIdx >= 0) {
    value = value.slice(eqIdx + 1)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
  }

  switch (kind) {
    case 'color':    return { color: value }
    case 'font_size':return { size: value }
    case 'font':     return { font: value }
    case 'url':      return { href: value || firstChildText(green) }
    case 'email':    return { href: `mailto:${value}` }
    case 'profile':  return { username: value }
    case 'quote':    return { source: value }
    case 'spoilerbox':
    case 'box':
    case 'boxw':
      // boxw es el box con líneas y fondo (estilo Lyne): se marca `styled`
      // para que el renderer emita la clase que dispara ese look. El box
      // normal ([box]) queda limpio por defecto.
      //
      // Sufijo de color `:#hex` (como `[container=neon-box:#FF0055]`):
      // `[box=Mi Caja:#FF0055]` separa el color del título; el color se guarda
      // aparte para que el renderer lo aplique como `--box-accent` y el
      // exporter lo vuelva a emitir en el round-trip.
      const colorMatch = /:#[0-9a-fA-F]{3,8}$/.exec(value)
      const color = colorMatch ? colorMatch[0].slice(1) : undefined
      const titleValue = colorMatch ? value.slice(0, colorMatch.index) : value
      return {
        title: stripBBCode(titleValue) || (kind === 'box' || kind === 'boxw' ? 'Box' : 'Spoiler'),
        rawTitle: titleValue,
        ...(color ? { color } : {}),
        ...(kind === 'boxw' ? { styled: true } : {}),
      }
    case 'list':     return { ordered: value === '1' || value === 'a' }
    case 'image': {
      // En el dialecto Lyne el atributo del tag es el TAMAÑO o modificador
      // (`[img=400x300]url[/img]`, `[img round]url[/img]`) y la URL va como
      // contenido — igual que en el renderer original (parseImgAttr(node.attr)
      // + textOf(node.children)). Guardar `value` como src rompía la imagen:
      // con `[img=400x300]url[/img]` el src quedaba "400x300" y la URL se perdía.
      // Si el atributo parece una URL, es la forma `[img=url]` (sin contenido)
      // y entonces sí es el src.
      const looksLikeUrl = /^https?:\/\//i.test(value)
      const src = looksLikeUrl ? value : (firstChildText(green) || undefined)
      // imgAttr conserva el tamaño/modificador original (`400x300`, `round`, …)
      // para que el exporter pueda reproducir `[img=400x300]` en el round-trip.
      const imgAttr = looksLikeUrl ? undefined : (value || undefined)
      return { src, imgAttr }
    }
    case 'video':    return { videoId: value || firstChildText(green) }
    case 'audio':    return { src: value || firstChildText(green) }
    case 'gradient':
      // Parse "=#ff0000,#00ff00" → { colors: ['#FF0000', '#00FF00'] }
      const gradientColors = value.split(',').map(c => c.trim()).filter(c => c.startsWith('#'))
      return gradientColors.length > 0 ? { colors: gradientColors } : {}
    case 'notice':
    case 'wnotice':  return value ? { color: value } : {}
    case 'tables':
    case 'columns': {
      // Sufijo de color `:#hex` (como en box): `[tables=striped:#FF0055]` y
      // `[columns=2:#FF0055]`. De ese color se deriva toda la paleta (bordes,
      // filas, encabezado) vía `--table-accent` / `--columns-accent`.
      if (!value) return {}
      const colorMatch = /:#[0-9a-fA-F]{3,8}$/.exec(value)
      const clean = colorMatch ? value.slice(0, colorMatch.index) : value
      const color = colorMatch ? colorMatch[0].slice(1) : undefined
      const base = kind === 'tables' ? { variant: clean } : { columns: clean }
      return color ? { ...base, color } : base
    }
    case 'separator':return value ? { variant: value } : {}
    case 'scroll':   return value ? { height: value } : {}
    case 'abbr':     return value ? { title: value } : {}
    case 'tooltip':  return value ? { tip: value } : {}
    case 'guild':    return value ? { tag: value } : {}
    case 'map':      return value ? { id: value } : {}
    case 'align':    return value ? { align: value } : {}
    case 'effect': {
      if (!value) return {}
      if (value.includes(':')) {
        const [effectType, ...rest] = value.split(':')
        return { effectType, color: rest.join(':') }
      }
      if (value.startsWith('#')) return { effectType: 'glow', color: value }
      return { effectType: value }
    }
    case 'anim': {
      if (!value) return {}
      if (value.includes(':')) {
        const [animType, ...rest] = value.split(':')
        return { animType, param: rest.join(':') }
      }
      return { animType: value }
    }
    case 'container':return value ? { containerType: value } : {}
    case 'style_tag':return value ? { style: value } : {}
    case 'list_item':return {}  // No metadata for list items
    default:         return {}
  }
}

/**
 * Parse rich BBCode inside a container attribute (e.g. `[box=[b]Title[/b]]`).
 * Produces a list of RedNode children for the title slot.
 */
function buildTitleNodes(
  rawTitle: string,
  parent: RedNode,
  store?: RedNodeStore,
  start: number = 0,
): RedNode[] {
  if (!rawTitle || !rawTitle.includes('[')) return []
  try {
    const tokens = scanBBCode(rawTitle)
    const greenTitle = parseTokensToGreen(tokens, rawTitle, { normalizeParagraphs: false })
    const redTitle = greenToRedNode(greenTitle, null, store, start)
    for (const child of redTitle.children) {
      child.parent = parent
    }
    return redTitle.children
  } catch {
    return []
  }
}

/**
 * Build a RedNode tree from a GreenNode.
 * Similar to TreeBuilder.buildRed but uses actual kind from the green node
 * and extracts BBCode metadata from attributes.
 *
 * When a RedNodeStore is provided, instance RedNodes are created with
 * correct parent references copied from the canonical's metadata.
 * The canonicalId (from green._hash) enables:
 * - React.memo in BBCodeCanvas by canonicalId
 * - HTMLRenderer cache by canonicalId
 * - Diff optimization (same canonicalId = unchanged subtree)
 * - Future PositionRef-based sharing
 */
export function greenToRedNode(
  green: GreenNode,
  parent?: RedNode | null,
  store?: RedNodeStore,
  start: number = 0,
): RedNode {
  // Absolute offsets are woven in here, on the way down: a child begins where
  // its parent's opening delimiter ends, and each sibling after the previous
  // one. Green nodes carry only widths (see `GreenNode.ts`), so this walk is
  // the single place a position comes into existence — and it costs one
  // addition per node.
  if (store) {
    // Get/create canonical node (stores metadata extracted from green.text)
    const canonical = store.getOrCreate(green)

    // Create a NEW instance RedNode that:
    // - Has correct parent reference (position-specific)
    // - Has its OWN children array (position-specific)
    // - Has the SAME canonicalId (enables identity-based optimizations)
    // - Has the SAME metadata as canonical (copied)
    const instance = new RedNode(green, {
      parent: parent ?? null,
      kind: green.kind as NodeKind,
      metadata: { ...canonical.metadata },
      start,
    })

    if ((green.kind === 'box' || green.kind === 'boxw' || green.kind === 'spoilerbox') && instance.metadata.rawTitle) {
      const rawTitle = String(instance.metadata.rawTitle)
      const tagName = green.kind
      const rawText = green.text || ''
      const isQuoted = (rawText.startsWith('="') && rawText.endsWith('"')) || (rawText.startsWith("='") && rawText.endsWith("'"))
      const offsetToTitle = start + 1 + tagName.length + 1 + (isQuoted ? 1 : 0)
      const titleNodes = buildTitleNodes(rawTitle, instance, store, offsetToTitle)
      if (titleNodes.length > 0) {
        instance.metadata.titleNodes = titleNodes
      }
    }

    const greenChildren = green.children as GreenNode[]
    if (greenChildren.length > 0) {
      const kids: RedNode[] = new Array(greenChildren.length)
      let offset = start + green.leadingWidth
      for (let i = 0; i < greenChildren.length; i++) {
        kids[i] = greenToRedNode(greenChildren[i], instance, store, offset)
        offset += greenChildren[i].width
      }
      instance.initChildren(kids)
    }

    return instance
  }

  // Legacy path without store (backward compat)
  const red = new RedNode(green, {
    parent: parent ?? null,
    kind: green.kind as NodeKind,
    metadata: extractGreenNodeMetadata(green),
    start,
  })

  if ((green.kind === 'box' || green.kind === 'boxw' || green.kind === 'spoilerbox') && red.metadata.rawTitle) {
    const rawTitle = String(red.metadata.rawTitle)
    const tagName = green.kind
    const rawText = green.text || ''
    const isQuoted = (rawText.startsWith('="') && rawText.endsWith('"')) || (rawText.startsWith("='") && rawText.endsWith("'"))
    const offsetToTitle = start + 1 + tagName.length + 1 + (isQuoted ? 1 : 0)
    const titleNodes = buildTitleNodes(rawTitle, red, store, offsetToTitle)
    if (titleNodes.length > 0) {
      red.metadata.titleNodes = titleNodes
    }
  }

  const greenChildren = green.children as GreenNode[]
  if (greenChildren.length > 0) {
    const kids: RedNode[] = new Array(greenChildren.length)
    let offset = start + green.leadingWidth
    for (let i = 0; i < greenChildren.length; i++) {
      kids[i] = greenToRedNode(greenChildren[i], red, store, offset)
      offset += greenChildren[i].width
    }
    red.initChildren(kids)
  }

  return red
}

// ─── Red-tree reuse across incremental reparses ─────────────

/**
 * Build the red tree for `green`, adopting subtrees of the PREVIOUS red tree
 * wherever the new green shares a green node by reference with the old one.
 *
 * The incremental splice (`spliceGreen`) rebuilds only the spine of ancestors
 * around an edit; every untouched sibling keeps its exact green object. Yet
 * `greenToRedNode` reconstructed all ~1700 red nodes on every keystroke —
 * measured as the single largest phase of a keystroke (0.30 of 0.94 ms).
 * Reference equality of greens is proof the subtree did not change, so its old
 * red subtree — ids, metadata, diagnostics and all — can be adopted wholesale.
 * Adoption is one `parent` reassignment (done by `initChildren`) plus, only
 * when the subtree moved, a `setStart` walk that adds a delta to two ints per
 * node. Both are far cheaper than re-extracting metadata and reallocating.
 *
 * ⚠ Contract: the OLD red tree is consumed. Adopted subtrees are reparented
 * into the new tree, so the previous `redRoot` must not be used again after
 * this returns. Nothing in the engine or the app reads a superseded red tree
 * (verified), and `DocumentModelOptions.reuseRed` is the kill-switch if a
 * future consumer ever needs the old tree to stay intact.
 *
 * The child walk mirrors `NodeMatcher` Phase 0 / `preserveNodeIds`: trim the
 * common prefix and suffix by green reference, descend into the changed window
 * only when it is the single-child shape a keystroke produces, and build the
 * rest fresh. Positional lockstep also makes double-adoption impossible: each
 * old red child is adopted at most once, even when interning makes distinct
 * positions share one green object.
 */
export function greenToRedNodeReusing(
  green: GreenNode,
  oldRed: RedNode,
  start: number = 0,
  stats?: { adopted: number },
): RedNode {
  if (green === oldRed.green) {
    // `setStart` records the shift lazily (no subtree walk) and no-ops when the
    // offset did not move, so the former `oldRed.range.start !== start` guard —
    // which READ the range, forcing a lazy materialization — is unnecessary.
    oldRed.setStart(start)
    oldRed.parent = null
    if (stats) stats.adopted++
    return oldRed
  }

  const red = new RedNode(green, {
    parent: null,
    kind: green.kind as NodeKind,
    metadata: extractGreenNodeMetadata(green),
    start,
  })

  if ((green.kind === 'box' || green.kind === 'boxw' || green.kind === 'spoilerbox') && red.metadata.rawTitle) {
    const rawTitle = String(red.metadata.rawTitle)
    const tagName = green.kind
    const rawText = green.text || ''
    const isQuoted = (rawText.startsWith('="') && rawText.endsWith('"')) || (rawText.startsWith("='") && rawText.endsWith("'"))
    const offsetToTitle = start + 1 + tagName.length + 1 + (isQuoted ? 1 : 0)
    const titleNodes = buildTitleNodes(rawTitle, red, undefined, offsetToTitle)
    if (titleNodes.length > 0) {
      red.metadata.titleNodes = titleNodes
    }
  }

  const greenKids = green.children as GreenNode[]
  const oldKids = oldRed.children
  if (greenKids.length === 0) return red

  // Absolute start of every green child, needed by the suffix walk, which
  // cannot accumulate forward.
  const offsets: number[] = new Array(greenKids.length)
  let offset = start + green.leadingWidth
  for (let i = 0; i < greenKids.length; i++) {
    offsets[i] = offset
    offset += greenKids[i].width
  }

  const kids: RedNode[] = new Array(greenKids.length)
  const limit = Math.min(greenKids.length, oldKids.length)

  // Common prefix: same green object, adopt.
  let lo = 0
  while (lo < limit && greenKids[lo] === oldKids[lo].green) {
    kids[lo] = adoptShifted(oldKids[lo], offsets[lo], stats)
    lo++
  }

  // Common suffix, stopping before the prefix already consumed.
  let gHi = greenKids.length - 1
  let oHi = oldKids.length - 1
  while (gHi >= lo && oHi >= lo && greenKids[gHi] === oldKids[oHi].green) {
    kids[gHi] = adoptShifted(oldKids[oHi], offsets[gHi], stats)
    gHi--
    oHi--
  }

  if (gHi === lo && oHi === lo) {
    // The single changed child both sides — the keystroke shape. Descend so
    // its own untouched children are still adopted.
    kids[lo] = greenToRedNodeReusing(greenKids[lo], oldKids[lo], offsets[lo], stats)
  } else {
    // A wider window (multi-node paste, fallback rebuild): build it fresh.
    for (let i = lo; i <= gHi; i++) {
      kids[i] = greenToRedNode(greenKids[i], null, undefined, offsets[i])
    }
  }

  // Sets parent and index cache on every child, adopted or fresh.
  red.initChildren(kids)
  return red
}

/** Adopt an old red subtree at (possibly) a new absolute offset. */
function adoptShifted(oldRed: RedNode, start: number, stats?: { adopted: number }): RedNode {
  // Lazy shift: records the delta without walking the subtree (see
  // `RedNode.setStart`). The former range read here would force a
  // materialization, defeating the whole point.
  oldRed.setStart(start)
  if (stats) stats.adopted++
  return oldRed
}

/**
 * A `RedNodeStore` wired with BBCode metadata semantics.
 *
 * `RedNodeStore` used to carry its own verbatim copy of
 * `extractGreenNodeMetadata` — its comment even said *"Mirrors
 * extractGreenNodeMetadata"* — which meant two sources of truth for the
 * attrs→metadata mapping, and they had already drifted apart. The store now
 * takes the extractor as a dependency; this is the BBCode wiring.
 */
export function createBBCodeRedNodeStore(): RedNodeStore {
  return new RedNodeStore(extractGreenNodeMetadata)
}

/**
 * Convert a BBBlock array directly to a RedNode root.
 * This is the main entry point for the bridge.
 */
export function bbBlocksToRedTree(blocks: BBBlock[], source: string): RedNode {
  const greenTree = bbBlocksToGreenTree(blocks, source)
  return greenToRedNode(greenTree)
}
