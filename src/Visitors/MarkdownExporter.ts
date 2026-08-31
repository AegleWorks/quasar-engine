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

export class MarkdownExporter extends Visitor<string> {
  visit(node: RedNode): string {
    return this.exportNode(node).replace(/(?:\r?\n){3,}/g, '\n\n')
  }

  export(node: RedNode): string {
    return this.visit(node)
  }

  private exportNode(node: RedNode, depth: number = 0): string {
    if (node.children.length === 0 && node.kind === 'text') {
      return node.text
    }

    if (node.kind === 'document') {
      return node.children.map(c => this.exportNode(c, depth)).join('')
    }

    const content = node.children.map(c => this.exportNode(c, depth)).join('')

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
        return `> ${header}${content.replace(/\n/g, '\n> ')}`
      }
      case 'notice': {
        const color = (node.metadata?.color as string) || this.extractValue(node)
        const colorAttr = color ? `=${color}` : ''
        return `[notice${colorAttr}]\n${content}\n[/notice]`
      }
      case 'wnotice': {
        const color = (node.metadata?.color as string) || this.extractValue(node)
        const colorAttr = color ? `=${color}` : ''
        return `[wnotice${colorAttr}]\n${content}\n[/wnotice]`
      }
      case 'spoilerbox':
      case 'box':
      case 'boxw': {
        const title = this.renderTitleMarkdown(node)
        const header = title ? `::: details ${title}` : '::: details'
        return `${header}\n${content}\n:::`
      }
      case 'list': {
        const lines: string[] = []
        let orderIdx = 1
        for (const child of node.children) {
          if (child.kind === 'list_item') {
            const itemContent = child.children.map(c => this.exportNode(c, depth)).join('')
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
