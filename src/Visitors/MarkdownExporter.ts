/**
 * DocumentEngine — MarkdownExporter
 *
 * Exports the Document Model to Markdown with hybrid BBCode embedding
 * for features not natively supported in standard CommonMark (color, size,
 * underline, alignment, collapsible boxes).
 */

import { RedNode } from '../Syntax/RedNode'
import { nodeAttrValue } from '../Syntax/nodeAttr'
import { Visitor } from './Visitor'

/**
 * Kinds that occupy their own block in Markdown.
 *
 * Two block constructs must never touch a neighbouring line: a `---` directly
 * under text is a setext heading, and a list directly followed by text is a
 * lazy continuation of its last item. Both silently change what the reader
 * sees, so the exporter puts a blank line around every one of these.
 */
const BLOCK_KINDS = new Set<string>([
  'paragraph', 'heading', 'list', 'list_item', 'quote', 'code', 'separator',
  'notice', 'wnotice', 'box', 'boxw', 'spoilerbox', 'center', 'right', 'left',
  'align', 'tables', 'table_row', 'columns', 'scroll', 'gallery', 'imagemap',
  'svg', 'container',
])

export class MarkdownExporter extends Visitor<string> {
  visit(node: RedNode): string {
    return normalizeMarkdown(this.exportNode(node))
  }

  export(node: RedNode): string {
    return this.visit(node)
  }

  /**
   * Export sibling nodes, keeping block constructs separated.
   *
   * The old implementation concatenated every child, which was correct for
   * inline content and wrong for blocks: `[quote]x[/quote]` followed by a
   * paragraph became `> x` immediately followed by prose (a lazy quote line
   * in CommonMark), and a separator after text became a setext heading.
   */
  private exportSequence(children: readonly RedNode[], depth: number): string {
    // Pieces are collected and joined once. Concatenating onto one growing
    // string looked equivalent but `endsWith` flattens V8's rope, turning the
    // loop quadratic: 8.5 ms became 51 ms on the 547 KB fixture.
    const parts: string[] = []
    for (const child of children) {
      if (child.kind === 'spacing' || child.kind === 'empty_line') {
        parts.push('\n')
        continue
      }
      const piece = this.exportNode(child, depth)
      if (piece === '') continue

      if (BLOCK_KINDS.has(child.kind)) {
        // Separators are added unconditionally; `normalizeMarkdown` collapses
        // any run of blank lines to one, and trims the leading/trailing ones.
        parts.push('\n\n', piece, '\n')
      } else {
        parts.push(piece)
      }
    }
    return parts.join('')
  }

  private exportNode(node: RedNode, depth: number = 0): string {
    if (node.children.length === 0 && node.kind === 'text') {
      return node.text
    }

    if (node.kind === 'document') {
      return this.exportSequence(node.children, depth)
    }

    const content = BLOCK_KINDS.has(node.kind)
      ? this.exportSequence(node.children, depth)
      : node.children.map(c => this.exportNode(c, depth)).join('')

    switch (node.kind) {
      case 'bold': return `**${content}**`
      case 'italic': return `*${content}*`
      case 'underline': return `++${content}++`
      case 'strikethrough': return `~~${content}~~`
      case 'inline_code': return `\`${content}\``
      case 'code': return `\`\`\`\n${content}\n\`\`\``
      case 'spoiler': return `||${content}||`
      case 'color': {
        const c = (node.metadata?.color as string) || this.extractValue(node) || '#ffffff'
        return `[${content}]{${c}}`
      }
      case 'font_size': {
        const s = (node.metadata?.size as string) || this.extractValue(node) || '100'
        return `[${content}]{size="${s}"}`
      }
      case 'font': {
        const f = (node.metadata?.font as string) || this.extractValue(node) || 'sans-serif'
        return `[${content}]{font="${f}"}`
      }
      case 'heading': {
        const level = (node.metadata?.level as number) || depth + 1
        return `${'#'.repeat(Math.min(level, 6))} ${content}`
      }
      case 'center': return `-> ${content.trim()} <-`
      case 'right': return `-> ${content.trim()} ->`
      case 'left': return `[left]${content}[/left]`
      case 'align': {
        const a = (node.metadata?.align as string) || this.extractValue(node) || 'center'
        if (a === 'center') return `-> ${content.trim()} <-`
        if (a === 'right') return `-> ${content.trim()} ->`
        return `[align=${a}]${content}[/align]`
      }
      case 'url': return `[${content}](${node.metadata?.href || this.extractValue(node) || content})`
      case 'email': {
        const addr = (node.metadata?.href as string)?.replace('mailto:', '') || this.extractValue(node) || content
        return `[${content}](mailto:${addr})`
      }
      case 'profile': return `[${content}](https://osu.ppy.sh/users/${node.metadata?.username || this.extractValue(node) || content})`
      case 'image': {
        const src = (node.metadata?.src as string) || (node.text && !node.text.startsWith('=') ? node.text : '') || content
        const alt = (node.metadata?.alt as string) || (content && content !== src ? content : 'Image')
        return `![${alt}](${src})`
      }
      case 'video': return `[🎥 YouTube Video](https://youtube.com/watch?v=${node.text || ''})`
      case 'audio': return `[🎵 Audio](${node.text || ''})`
      case 'quote': {
        const source = (node.metadata?.source as string) || this.extractValue(node)
        const header = source ? `**${source}**\n> ` : ''
        const body = trimNewlines(content)
        return `> ${header}${body.replace(/\n/g, '\n> ')}`
      }
      case 'notice': {
        const color = (node.metadata?.color as string) || this.extractValue(node)
        const colorAttr = color ? `=${color}` : ''
        return `[notice${colorAttr}]\n${trimNewlines(content)}\n[/notice]`
      }
      case 'wnotice': {
        const color = (node.metadata?.color as string) || this.extractValue(node)
        const colorAttr = color ? `=${color}` : ''
        return `[wnotice${colorAttr}]\n${trimNewlines(content)}\n[/wnotice]`
      }
      case 'spoilerbox':
      case 'box':
      case 'boxw': {
        const title = this.renderTitleMarkdown(node)
        const header = title ? `::: details ${title}` : '::: details'
        return `${header}\n${trimNewlines(content)}\n:::`
      }
      case 'list': {
        const lines: string[] = []
        let orderIdx = 1
        for (const child of node.children) {
          if (child.kind === 'list_item') {
            const itemContent = this.exportSequence(child.children, depth)
            const isOrdered = node.metadata?.ordered
            const prefix = isOrdered ? `${orderIdx++}. ` : '- '
            lines.push(`${'  '.repeat(Math.max(0, depth))}${prefix}${itemContent.trim()}`)
          }
        }
        return lines.length > 0 ? lines.join('\n') + '\n' : content
      }
      case 'list_item': {
        const isOrdered = node.parent?.metadata?.ordered
        const prefix = isOrdered ? '1. ' : '- '
        return `${'  '.repeat(Math.max(0, depth - 1))}${prefix}${content.trim()}`
      }
      case 'separator': return '---'
      case 'spacing': return '\n'
      case 'empty_line': return '\n'
      case 'paragraph': return content
      case 'text': return content || node.text || ''
      default: {
        const val = this.extractValue(node) || (node.metadata?.value as string) || (node.metadata?.raw as string)
        const attr = val !== undefined && val !== null && String(val) !== '' ? `=${val}` : ''
        return `[${node.kind}${attr}]${content}[/${node.kind}]`
      }
    }
  }

  private renderTitleMarkdown(node: RedNode): string {
    const titleNodes = node.metadata?.titleNodes as RedNode[] | undefined
    if (titleNodes && titleNodes.length > 0) {
      return titleNodes.map(c => this.exportNode(c, 0)).join('')
    }
    return (node.metadata?.title as string) || this.extractValue(node) || ''
  }

  /**
   * Read a BBCode tag's `=VALUE` attribute.
   */
  /**
   * El atributo del nodo, o `undefined` si no lleva.
   *
   * El recorte lo hace `nodeAttrValue`, el mismo lector del `HTMLRenderer`;
   * aquí sólo se cambia el contrato del caso vacío. Este exportador encadena
   * `metadata ?? atributo ?? contenido`, así que necesita un `undefined`
   * explícito donde `nodeAttrValue` devuelve el texto crudo — es la única
   * diferencia, y por eso no se llama directamente.
   */
  private extractValue(node: RedNode): string | undefined {
    if (!(node.text || '').includes('=')) return undefined
    return nodeAttrValue(node) || undefined
  }
}

/** Strip leading and trailing line breaks, keeping the ones in between. */
function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * Collapse blank-line runs to one, and trim the document's edges.
 *
 * Fenced code is copied verbatim: blank lines inside a sample are content, and
 * the previous implementation ran the collapse over the whole output, so a
 * code block with two blank lines was silently compacted. Fences are tracked
 * line by line, which is also what keeps a literal ``` inside an inline code
 * span from being mistaken for one.
 */
function normalizeMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let blankRun = 0

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      blankRun = 0
      continue
    }
    if (!inFence && line.trim() === '') {
      blankRun++
      if (blankRun > 1) continue
      out.push('')
      continue
    }
    blankRun = 0
    out.push(line)
  }

  let start = 0
  let end = out.length
  while (start < end && out[start] === '') start++
  while (end > start && out[end - 1] === '') end--
  return out.slice(start, end).join('\n')
}
