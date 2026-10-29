/**
 * MilHibri — Markdown inline inside a BBCode tree.
 *
 * The hybrid has three layers:
 *
 *   0. Markdown blocks are rewritten as their BBCode equivalents BEFORE this
 *      pass (`MarkdownBlocks`), so a heading or fence nests in the existing
 *      block stack instead of switching the whole document to the Markdown
 *      importer;
 *   1. the BBCode engine owns block structure and tag pairing (the measured
 *      osu! rules: nested boxes, notices, imagemaps, lazy closers, …);
 *   2. Markdown inline syntax is translated inside each run of ordinary text.
 *
 * That is deliberately not "run the Markdown importer on the whole page". A
 * page with 48 block tags is not a Markdown document because one line contains
 * `**b**`; it is a BBCode document whose text happens to use a Markdown marker.
 *
 * The translation is an import: the resulting tree describes the translation,
 * so its widths no longer add up to the source. `MilHibriDocumentModel` sets
 * `treeMirrorsSource` accordingly.
 */
import { GreenNode, greenNode } from '../Syntax/GreenNode'
import { parseInlineMarkdown } from '../Markdown/MarkdownParser'
import { markdownAstToGreenTree } from '../Markdown/MarkdownToGreenNode'
import type { MarkdownNode } from '../Markdown/MarkdownAST'

export interface HybridInlineResult {
  green: GreenNode
  /** Whether any text run was translated; false keeps the original green. */
  changed: boolean
}

/**
 * Subtrees whose text is a value, not prose. Markdown must not run there:
 * `[code]**not bold**[/code]`, `[c]_not italic_[/c]`, an image URL with `_`,
 * or a profile name with `*` are literals.
 */
const LITERAL_SUBTREES = new Set([
  'code',
  'inline_code',
  'raw',
  'noparse',
  'plain',
  'image',
  'video',
  'audio',
  'imagemap',
  'url',
  'email',
  'profile',
  'style_tag',
])

/**
 * Cheap gate before paying for a Markdown lexer on every text leaf.
 *
 * Each alternative requires a real opener AND closer with content between,
 * exactly like the document-level detector. A bare run (`~~~~~~~~`,
 * `C++`, `-+++++++#…`) is prose, not an empty emphasis span; matching it made
 * 10 osu! pages change rendering even though nothing had been marked up.
 */
function hasInlineMarkdownSyntax(text: string): boolean {
  return /\*\*[^*\n]+\*\*/.test(text)
    || /~~[^~\n]+~~/.test(text)
    || /\+\+[^+\n]+\+\+/.test(text)
    || /`[^`\n]+`/.test(text)
    || /!\[[^\]\n]*\]\([^)\n]+\)/.test(text)
    || /\[[^\]\n]+\]\([^)\n]+\)/.test(text)
}

/**
 * Translate one text run.
 *
 * Returns `null` when the translation is byte-for-byte the same text, so the
 * caller can keep the original green node and its identity.
 */
function inlineGreen(text: string): GreenNode[] | null {
  const nodes = parseInlineMarkdown(text)
  if (nodes.length === 0) return null
  const root = markdownAstToGreenTree({ type: 'document', children: nodes } as MarkdownNode)
  const converted = root.children as GreenNode[]
  if (converted.length === 1 && converted[0].kind === 'text' && converted[0].text === text) {
    return null
  }
  return converted
}

function convertChildren(children: readonly GreenNode[]): { nodes: GreenNode[]; changed: boolean } {
  const out: GreenNode[] = []
  let bufferText = ''
  let bufferNodes: GreenNode[] = []
  let changed = false

  const flush = (): void => {
    if (bufferNodes.length === 0) return
    const source = bufferText
    const originals = bufferNodes
    bufferText = ''
    bufferNodes = []

    if (!hasInlineMarkdownSyntax(source)) {
      out.push(...originals)
      return
    }

    const converted = inlineGreen(source)
    if (converted === null) {
      out.push(...originals)
      return
    }

    out.push(...converted)
    changed = true
  }

  for (const child of children) {
    // Adjacent text leaves are one prose run. The BBCode lexer splits an
    // unknown opener from the text after it (`[Beatmap]` + `(url)`), and a
    // Markdown link only exists once the two are back together.
    if (child.kind === 'text') {
      bufferText += child.text
      bufferNodes.push(child)
      continue
    }

    flush()

    if (LITERAL_SUBTREES.has(child.kind) || child.children.length === 0) {
      out.push(child)
      continue
    }

    const inner = convertChildren(child.children)
    if (!inner.changed) {
      out.push(child)
      continue
    }

    out.push(greenNode(child.kind, child.text, inner.nodes, child.leadingWidth, child.trailingWidth))
    changed = true
  }

  flush()
  return { nodes: out, changed }
}

/**
 * Apply Markdown inline translation to a BBCode green tree.
 *
 * Block structure is untouched; only text leaves change. If nothing in the
 * document uses inline Markdown, the original green tree is returned by
 * reference.
 */
export function applyMarkdownInlineToGreen(root: GreenNode): HybridInlineResult {
  if (root.kind === 'text') {
    if (!hasInlineMarkdownSyntax(root.text)) return { green: root, changed: false }
    const converted = inlineGreen(root.text)
    if (converted === null) return { green: root, changed: false }
    // A bare text root has no parent to hold the translated siblings; give it
    // the smallest container the renderer understands.
    return { green: greenNode('paragraph', '', converted), changed: true }
  }

  if (LITERAL_SUBTREES.has(root.kind) || root.children.length === 0) {
    return { green: root, changed: false }
  }

  const converted = convertChildren(root.children)
  if (!converted.changed) return { green: root, changed: false }

  return {
    green: greenNode(root.kind, root.text, converted.nodes, root.leadingWidth, root.trailingWidth),
    changed: true,
  }
}

