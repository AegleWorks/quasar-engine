import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'

export interface LexicalNode {
  type: string
  version: number
  [key: string]: any
}

export interface LexicalElementNode extends LexicalNode {
  children: LexicalNode[]
  direction: 'ltr' | 'rtl' | null
  format: string | number
  indent: number
}

export interface LexicalTextNode extends LexicalNode {
  type: 'text'
  detail: number
  format: number
  mode: 'normal' | 'token' | 'segmented'
  style: string
  text: string
}

export class LexicalExporter extends Visitor<string> {
  visit(node: RedNode): string {
    const rootState = {
      root: this.toLexicalRoot(node)
    }
    return JSON.stringify(rootState, null, 2)
  }

  toLexicalRoot(node: RedNode): LexicalElementNode {
    if (node.kind !== 'document') {
      throw new Error('LexicalExporter requires a document root node')
    }
    
    // Top-level children in Lexical RootNode MUST be ElementNodes (like paragraph).
    // If we have raw text nodes or inline format nodes at the top level, we must wrap them in a paragraph.
    const rootChildren: LexicalNode[] = []
    let currentParagraphChildren: LexicalNode[] = []

    const flushParagraph = () => {
      if (currentParagraphChildren.length > 0) {
        rootChildren.push({
          type: 'paragraph',
          version: 1,
          children: currentParagraphChildren,
          direction: 'ltr',
          format: '',
          indent: 0
        })
        currentParagraphChildren = []
      }
    }

    const processedNodes = this.processChildren(node.children, 0, '')
    
    for (const child of processedNodes) {
      if (this.isInlineNode(child)) {
        currentParagraphChildren.push(child)
      } else {
        flushParagraph()
        rootChildren.push(child)
      }
    }
    flushParagraph()

    if (rootChildren.length === 0) {
      rootChildren.push({
        type: 'paragraph',
        version: 1,
        children: [],
        direction: 'ltr',
        format: '',
        indent: 0
      })
    }

    return {
      type: 'root',
      version: 1,
      children: rootChildren,
      direction: 'ltr',
      format: '',
      indent: 0
    }
  }

  private isInlineNode(node: LexicalNode): boolean {
    return node.type === 'text' || node.type === 'link'
  }

  private processChildren(children: RedNode[], textFormat: number, textStyle: string): LexicalNode[] {
    const content: LexicalNode[] = []
    
    for (const child of children) {
      if (child.kind === 'empty_line' || child.kind === 'spacing') {
        content.push({
          type: 'paragraph',
          version: 1,
          children: [],
          direction: null,
          format: '',
          indent: 0
        })
        continue
      }
      
      const result = this.processNode(child, textFormat, textStyle)
      if (Array.isArray(result)) {
        content.push(...result)
      } else {
        content.push(result)
      }
    }

    return content
  }

  private processNode(node: RedNode, activeFormat: number, activeStyle: string): LexicalNode | LexicalNode[] {
    const formatMask = this.kindToFormatMask(node.kind)
    
    if (formatMask !== 0) {
      const nextFormat = activeFormat | formatMask
      return this.processChildren(node.children, nextFormat, activeStyle)
    }

    if (node.kind === 'color') {
      const nextStyle = activeStyle ? `${activeStyle} color: ${node.metadata.color};` : `color: ${node.metadata.color};`
      return this.processChildren(node.children, activeFormat, nextStyle)
    }

    if (node.kind === 'text') {
      return this.createText(node.text, activeFormat, activeStyle)
    }

    // Block Nodes & Link
    const isLink = node.kind === 'url'
    const children = node.children.length > 0 ? this.processChildren(node.children, activeFormat, activeStyle) : []
    
    return {
      type: this.kindToBlockType(node.kind),
      version: 1,
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      ...this.extractBlockAttrs(node)
    } as LexicalElementNode
  }

  private createText(text: string, format: number, style: string): LexicalTextNode {
    return {
      type: 'text',
      version: 1,
      detail: 0,
      format,
      mode: 'normal',
      style,
      text
    }
  }

  private extractBlockAttrs(node: RedNode): Record<string, any> {
    const attrs: Record<string, any> = {}
    if (node.kind === 'url') attrs.url = node.metadata.href || ''
    if (node.kind === 'image') attrs.src = node.metadata.src || ''
    if (node.kind === 'heading') {
      attrs.tag = node.metadata.level ? `h${node.metadata.level}` : 'h1'
    }
    if (node.kind === 'list') {
      attrs.listType = node.metadata.type === 'number' ? 'number' : 'bullet'
      attrs.start = 1
      attrs.tag = attrs.listType === 'number' ? 'ol' : 'ul'
    }
    if (node.kind === 'list_item') {
      attrs.value = 1
    }
    if (node.kind === 'code') {
      attrs.language = node.metadata.language || 'javascript'
    }
    return attrs
  }

  private kindToFormatMask(kind: string): number {
    switch (kind) {
      case 'bold': return 1
      case 'italic': return 2
      case 'strikethrough': return 4
      case 'underline': return 8
      case 'inline_code': return 16
    }
    return 0
  }

  private kindToBlockType(kind: string): string {
    const map: Record<string, string> = {
      heading: 'heading',
      paragraph: 'paragraph',
      quote: 'quote',
      code: 'code',
      list: 'list',
      list_item: 'listitem',
      url: 'link'
    }
    return map[kind] ?? 'paragraph'
  }
}
