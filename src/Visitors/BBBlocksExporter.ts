import { Visitor } from './Visitor'
import type { VisitorContext } from './Visitor'
import { RedNode } from '../Syntax/RedNode'

export interface UIBBBlock {
  id: string
  type: string
  attributes?: Record<string, string>
  children: UIBBBlock[]
  content?: string
}

export class BBBlocksExporter extends Visitor<UIBBBlock[]> {
  private idCounter = 0

  private generateId(): string {
    this.idCounter++
    return `block-${Date.now().toString(36)}-${this.idCounter}`
  }

  visit(node: RedNode, context?: VisitorContext): UIBBBlock[] {
    if (context) this.context = context
    
    // If it's a document node, we just return the exported children
    if (node.kind === 'document') {
      return node.children.flatMap(child => this.exportNode(child))
    }
    
    return [this.exportNode(node)]
  }

  export(root: RedNode): UIBBBlock[] {
    return this.visit(root)
  }

  private exportNode(node: RedNode): UIBBBlock {
    const block: UIBBBlock = {
      id: this.generateId(),
      type: node.kind,
      children: []
    }

    // Process attributes
    if (node.metadata) {
      const attrs: Record<string, string> = {}
      for (const [key, value] of Object.entries(node.metadata)) {
        if (value !== undefined && value !== null) {
          attrs[key] = String(value)
        }
      }
      if (Object.keys(attrs).length > 0) {
        block.attributes = attrs
      }
    }

    // Process content (leaf nodes or text nodes)
    if (node.kind === 'text') {
      block.content = node.text || ''
    } else {
      // Process children
      block.children = node.children.map(child => this.exportNode(child))
      
      // Some tags might store text content directly without children in RedNode representation depending on the parser,
      // but RedNode generally structures text as child nodes of type 'text'.
    }

    return block
  }
}
