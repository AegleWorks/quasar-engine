/**
 * DocumentEngine — RenderTree
 *
 * An intermediate representation between DocumentModel and final output.
 * The RenderTree is what the RenderPipeline processes.
 *
 * This abstraction allows:
 * - Same DocumentModel → multiple render outputs (HTML, Canvas, SVG, PDF)
 * - Plugin renderers that intercept/modify render nodes
 * - Smooth visual transitions between document states
 * - Partial rendering for performance
 */

import type { NodeKind, NodeAttributes } from '../Types/core'
import { STYLE_PROP_WHITELIST, stripStyleValue, isDangerousStyleValue } from '../Utils/safeStyle'

/**
 * Render nodes holding HTML the engine itself produced. Only `engineHTML`
 * adds to it, and it is not on the package's public surface: a plugin cannot
 * mark a string it built from document text as safe, so nothing but engine
 * output reaches the page unescaped.
 */
const ENGINE_HTML = new WeakSet<RenderNode>()

/** A render node carrying HTML the engine rendered (a child, for a plugin handler). */
export function engineHTML(html: string): RenderNode {
  const node: RenderNode = { kind: 'engine_html', text: html, children: [], props: {} }
  ENGINE_HTML.add(node)
  return node
}

export type RenderVariant = 'html' | 'canvas' | 'svg' | 'pdf' | 'react' | 'text'

export interface RenderNode {
  /** Semantic kind */
  kind: NodeKind | string
  /** Text content */
  text: string
  /** Child render nodes */
  children: RenderNode[]
  /** Props/attributes for the renderer */
  props: Record<string, unknown>
  /** Which render variant this node targets */
  variant?: RenderVariant
  /** CSS class names */
  className?: string
  /** Inline styles */
  style?: Record<string, string | number>
  /** Events/handlers (for interactive renders) */
  events?: Record<string, string>
  /** Metadata for renderers */
  metadata?: Record<string, unknown>
}

export class RenderTree {
  /**
   * Create a render tree from a document node.
   */
  static fromNode(
    kind: NodeKind | string,
    text: string = '',
    children: RenderNode[] = [],
    props: Record<string, unknown> = {},
  ): RenderNode {
    return { kind, text, children, props }
  }

  /**
   * Create a text render node.
   */
  static text(content: string): RenderNode {
    return { kind: 'text', text: content, children: [], props: {} }
  }

  /**
   * Create a container render node.
   */
  static container(
    kind: NodeKind | string,
    children: RenderNode[],
    props: Record<string, unknown> = {},
  ): RenderNode {
    return { kind, text: '', children, props }
  }

  /**
   * Serialize a render tree to HTML.
   */
  static toHTML(node: RenderNode): string {
    if (ENGINE_HTML.has(node)) return node.text
    if (node.kind === 'text') return this.escapeHtml(node.text)

    const tag = this.kindToTag(node.kind)
    const propsStr = this.propsToHtml(node)
    const childrenStr = node.children.map(c => this.toHTML(c)).join('')

    if (tag) {
      return `<${tag}${propsStr}>${childrenStr}</${tag}>`
    }

    return childrenStr
  }

  private static kindToTag(kind: string): string | null {
    const map: Record<string, string> = {
      bold: 'strong',
      italic: 'em',
      underline: 'u',
      strikethrough: 's',
      inline_code: 'code',
      code: 'pre',
      heading: 'h2',
      paragraph: 'p',
      list: 'ul',
      list_item: 'li',
      quote: 'blockquote',
      center: 'div',
      notice: 'div',
      image: 'img',
      video: 'iframe',
      audio: 'audio',
      spoiler: 'span',
      url: 'a',
      email: 'a',
      profile: 'a',
      document: 'div',
      group: 'div',
      text: 'span',
    }
    return map[kind] ?? 'span'
  }

  /**
   * `class` and `style`, escaped. A plugin handler fills these from the
   * document (`style: { color: node.text }`), so they were an attribute
   * injection: `[neon=red" onmouseover="…]` wrote its own attribute. Style
   * keys are camelCase or kebab-case; only properties in the shared whitelist
   * get through, and no value that loads or runs anything.
   */
  private static propsToHtml(node: RenderNode): string {
    const parts: string[] = []
    if (node.className) parts.push(`class="${this.escapeAttr(node.className)}"`)
    if (node.style) {
      const styles: string[] = []
      for (const [key, raw] of Object.entries(node.style)) {
        const prop = key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).toLowerCase()
        if (!STYLE_PROP_WHITELIST.has(prop)) continue
        const value = stripStyleValue(String(raw))
        if (!value || isDangerousStyleValue(value)) continue
        styles.push(`${prop}:${value}`)
      }
      if (styles.length > 0) parts.push(`style="${this.escapeAttr(styles.join(';'))}"`)
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : ''
  }

  private static escapeAttr(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
}
