/**
 * DocumentEngine — MarkdownExporter
 *
 * Exports the Document Model to Markdown.
 * Demonstrates the format-agnostic power of the engine:
 * BBCode in → DocumentModel → Markdown out.
 *
 * A single visitor, no parser changes needed.
 */

import { RedNode } from '../Syntax/RedNode'
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
      case 'underline': return content
      case 'strikethrough': return `~~${content}~~`
      case 'inline_code': return `\`${content}\``
      case 'code': return `\`\`\`\n${content}\n\`\`\``
      case 'spoiler': return `||${content}||`
      case 'color': return content
      case 'font_size': return content
      case 'font': return content
      case 'heading': return `${'#'.repeat(Math.min(depth + 1, 6))} ${content}`
      case 'center': return content
      case 'right': return content
      case 'left': return content
      case 'url': return `[${content}](${this.extractValue(node) || content})`
      case 'email': return `[${content}](mailto:${this.extractValue(node) || content})`
      case 'profile': return `[${content}](https://osu.ppy.sh/users/${this.extractValue(node) || content})`
      case 'image': return `![Image](${node.text || ''})`
      case 'video': return `[🎥 YouTube Video](https://youtube.com/watch?v=${node.text || ''})`
      case 'audio': return `[🎵 Audio](${node.text || ''})`
      case 'quote': return `> **${this.extractValue(node) || 'Quote'}**\n> ${content.replace(/\\n/g, '\n> ')}`
      case 'notice': return `> [!NOTE]\n> ${content.replace(/\\n/g, '\n> ')}`
      case 'spoilerbox': return `**${this.renderTitleMarkdown(node) || 'Spoiler'}**\n${content}`
      case 'box':
      case 'boxw': return `**${this.renderTitleMarkdown(node) || 'Box'}**\n${content}`
      case 'list': return content
      case 'list_item': return `${'  '.repeat(Math.max(0, depth - 1))}- ${content.trim()}`
      case 'spacing': return '\n'
      case 'empty_line': return '\n'
      case 'text':
      default: return content || node.text || ''
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
   *
   * This previously read `node.properties` / `node.attributes`, neither of
   * which exists on RedNode — so it silently returned `undefined` for every
   * node and every call site fell through to its placeholder. That is why
   * Markdown export dropped link targets and quote/box titles.
   */
  private extractValue(node: RedNode): string | undefined {
    const text = node.text || ''
    const eqIdx = text.indexOf('=')
    if (eqIdx < 0) return undefined

    let value = text.slice(eqIdx + 1)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value || undefined
  }
}
