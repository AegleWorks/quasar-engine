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

// ─── Tag → Kind mapping (mirrors the existing BBCode parser) ──

const TAG_TO_KIND_ENTRIES: Record<string, NodeKind> = {
  'b': 'bold',
  'i': 'italic',
  'u': 'underline',
  's': 'strikethrough',
  'strike': 'strikethrough',
  'color': 'color',
  'size': 'font_size',
  'font': 'font',
  'shadow': 'shadow',
  'c': 'inline_code',
  'code': 'code',
  'spoiler': 'spoiler',
  'centre': 'center',
  'center': 'center',
  'right': 'right',
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
  'zalgo': 'zalgo',
  'aesthetic': 'aesthetic',
  'sparkle': 'sparkle',
  'bubble': 'bubble',
  'flower': 'flower',
  'gradient': 'gradient',
  'grow': 'grow',
  'svg': 'svg',
  'empty_line': 'empty_line',
}

/**
 * A `Map`, not the object literal above.
 *
 * The literal is written as an object because that is how it reads, but it is
 * QUERIED with tag names that come from the source, so V8 sees a megamorphic
 * key and falls back to a dictionary lookup. Measured over 1608 lookups — one
 * per element in the reference document — a Map is twice as fast.
 */
const TAG_TO_KIND = new Map<string, NodeKind>(
  Object.entries(TAG_TO_KIND_ENTRIES) as [string, NodeKind][],
)

const KIND_TO_TAG: Partial<Record<NodeKind, string>> = {}
for (const [tag, kind] of TAG_TO_KIND) {
  KIND_TO_TAG[kind] = tag
}

/**
 * Todas las etiquetas BBCode que el parser reconoce.
 *
 * Cualquiera que necesite saber «qué es una etiqueta» —el resaltado del
 * editor, el plegado, la ayuda contextual— debe leer esto en vez de mantener
 * su propia lista. Cuando existían dos, divergieron: el resaltador de Monaco
 * ignoraba 12 etiquetas que el motor sí parseaba, entre ellas `[gradient]` y
 * `[grow]`, y resaltaba `[centre]` pero no `[center]`.
 */
export const BBCODE_TAG_NAMES: readonly string[] = Object.freeze(
  [...TAG_TO_KIND.keys()].sort(),
)

export function tagToNodeKind(tag: string | null): NodeKind {
  if (tag === null) return 'text'
  return TAG_TO_KIND.get(tag) ?? 'custom'
}

export function nodeKindToTag(kind: NodeKind): string | null {
  return KIND_TO_TAG[kind] ?? null
}

// ─── Rendered kind — tags that produce inline or block HTML ──

const RENDERED_AS_BLOCK = new Set<NodeKind>([
  'notice', 'spoilerbox', 'box', 'list', 'quote', 'code', 'svg',
  'heading', 'center', 'right', 'imagemap', 'document',
  'list_item', 'spacing', 'empty_line', 'paragraph'
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

const BBCODE_TAG_RE = /\[\/?[a-zA-Z0-9_*]+=?[^\]]*\]/g

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
    case 'shadow':   return { color: value }
    case 'url':      return { href: value || firstChildText(green) }
    case 'email':    return { href: `mailto:${value}` }
    case 'profile':  return { username: value }
    case 'quote':    return { source: value }
    case 'spoilerbox':
    case 'box':      return { title: stripBBCode(value) || 'Spoiler' }
    case 'list':     return { ordered: value === '1' || value === 'a' }
    case 'image':    return { src: value || firstChildText(green) }
    case 'video':    return { videoId: value || firstChildText(green) }
    case 'audio':    return { src: value || firstChildText(green) }
    case 'gradient':
      // Parse "=#ff0000,#00ff00" → { colors: ['#FF0000', '#00FF00'] }
      const gradientColors = value.split(',').map(c => c.trim()).filter(c => c.startsWith('#'))
      return gradientColors.length > 0 ? { colors: gradientColors } : {}
    case 'list_item':return {}  // No metadata for list items
    default:         return {}
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
    if (oldRed.range.start !== start) oldRed.setStart(start)
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
  if (oldRed.range.start !== start) oldRed.setStart(start)
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
