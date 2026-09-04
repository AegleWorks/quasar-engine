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

/** Distingue exportadores creados dentro del mismo milisegundo. */
let exporterSeq = 0

export class BBBlocksExporter extends Visitor<UIBBBlock[]> {
  private idCounter = 0

  /**
   * Un identificador único dentro de ESTA exportación.
   *
   * Llevaba un `Date.now().toString(36)` por nodo. El reloj no aportaba nada
   * —los identificadores solo tienen que distinguirse entre sí dentro del
   * lote— y se leía, y se convertía a base 36, una vez por nodo del árbol.
   * El prefijo se calcula una sola vez por exportador para que dos lotes
   * consecutivos sigan sin colisionar.
   */
  private readonly idPrefix = `block-${(exporterSeq++).toString(36)}-${Date.now().toString(36)}`

  private generateId(): string {
    this.idCounter++
    return `${this.idPrefix}-${this.idCounter}`
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
