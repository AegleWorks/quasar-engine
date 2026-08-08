/**
 * DocumentEngine — TiptapExporter
 *
 * Exports the Document Model to Tiptap (ProseMirror) JSON format.
 * This proves how easily Quasar's AST bridges to visual WYSIWYG editors.
 *
 * Tiptap uses a JSON format structured like:
 * {
 *   type: "doc",
 *   content: [
 *     {
 *       type: "paragraph",
 *       content: [
 *         { type: "text", text: "Hello ", marks: [{ type: "bold" }] }
 *       ]
 *     }
 *   ]
 * }
 */

import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'

export interface TiptapNode {
  type: string
  attrs?: Record<string, any>
  content?: TiptapNode[]
  marks?: TiptapMark[]
  text?: string
}

export interface TiptapMark {
  type: string
  attrs?: Record<string, any>
}

export class TiptapExporter extends Visitor<string> {
  visit(node: RedNode): string {
    return JSON.stringify(this.toTiptap(node), null, 2)
  }

  toTiptap(node: RedNode): TiptapNode {
    if (node.kind === 'document') {
      return {
        type: 'doc',
        content: this.processChildren(node.children, []),
      }
    }
    return this.processNode(node, [])
  }

  private processChildren(children: RedNode[], marks: TiptapMark[]): TiptapNode[] {
    const content: TiptapNode[] = []
    
    for (const child of children) {
      // empty_line and spacing become empty paragraphs or brs depending on context
      if (child.kind === 'empty_line' || child.kind === 'spacing') {
        continue // Simplification: in a real bridge, these would divide paragraphs
      }
      content.push(this.processNode(child, marks))
    }

    return content
  }

  private processNode(node: RedNode, activeMarks: TiptapMark[]): TiptapNode {
    // 1. Check if this node is a mark (inline formatting)
    const newMark = this.kindToMark(node)
    if (newMark) {
      const nextMarks = [...activeMarks, newMark]
      // Inline tags shouldn't exist as blocks in Tiptap, they just wrap text
      // We return a text node if it's the leaf, otherwise we flatten children
      if (node.children.length === 1 && node.children[0].kind === 'text') {
         return {
           type: 'text',
           text: node.children[0].text,
           marks: nextMarks
         }
      } else if (node.children.length === 0) {
         return { type: 'text', text: '', marks: nextMarks }
      }
      
      // Simplification: if multiple children, we wrap them all in this mark
      // Tiptap actually expects a flat list of text nodes with marks.
      // So this requires flattening. For MVP, we return a custom block or flat text.
      // We will just create a custom inline block for now.
      return {
        type: 'text',
        text: node.children.map(c => c.text || '').join(''),
        marks: nextMarks
      }
    }

    // 2. Leaf Text Node
    if (node.kind === 'text') {
      return {
        type: 'text',
        text: node.text,
        marks: activeMarks.length > 0 ? activeMarks : undefined
      }
    }

    // 3. Block Nodes
    return {
      type: this.kindToBlockType(node.kind),
      attrs: Object.keys(node.metadata).length > 0 ? node.metadata : undefined,
      content: node.children.length > 0 ? this.processChildren(node.children, activeMarks) : undefined
    }
  }

  private kindToMark(node: RedNode): TiptapMark | null {
    switch (node.kind) {
      case 'bold': return { type: 'bold' }
      case 'italic': return { type: 'italic' }
      case 'underline': return { type: 'underline' }
      case 'strikethrough': return { type: 'strike' }
      case 'inline_code': return { type: 'code' }
      case 'color': return { type: 'textStyle', attrs: { color: node.metadata.color } }
      case 'url': return { type: 'link', attrs: { href: node.metadata.href } }
      case 'gradient': 
      case 'rainbow':
      case 'grow':
      case 'sinewave':
        return { type: 'miliastryEffect', attrs: { effect: node.kind, ...node.metadata } }
    }
    return null
  }

  private kindToBlockType(kind: string): string {
    const map: Record<string, string> = {
      heading: 'heading',
      paragraph: 'paragraph',
      quote: 'blockquote',
      code: 'codeBlock',
      list: 'bulletList',
      list_item: 'listItem',
      image: 'image',
      center: 'centerBlock',
      notice: 'noticeBlock',
      box: 'boxBlock',
      spoilerbox: 'spoilerboxBlock'
    }
    return map[kind] ?? 'paragraph'
  }
}
