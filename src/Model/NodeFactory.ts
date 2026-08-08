/**
 * DocumentEngine — NodeFactory
 *
 * Creates DocumentNode instances, RedNode instances, and GreenNode
 * instances from tag definitions. Centralizes node creation so
 * plugins can provide custom node factories.
 */

import type { NodeKind, NodeAttributes, NodeMetadata, DocumentNode } from '../Types/core'
import { createNodeId, createDocumentNode } from '../Types/core'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { TagRegistry, type TagDefinition } from './TagRegistry'

export class NodeFactory {
  private registry: TagRegistry

  constructor(registry: TagRegistry) {
    this.registry = registry
  }

  /**
   * Create a RedNode from a tag definition.
   */
  createFromTag(
    tagName: string,
    attrs: string = '',
    start: number = 0,
    end: number = 0,
    children: RedNode[] = [],
  ): RedNode {
    const def = this.registry.get(tagName)
    const kind = def?.kind ?? 'custom'
    const text = `[${tagName}${attrs ? '=' + attrs : ''}]`

    const attributes: NodeAttributes = {}

    // Parse attribute string into named attributes
    if (attrs) {
      if (def?.properties) {
        // Use property definitions to parse
        const parts = attrs.split(/,(?![^\[]*\])/g)
        for (let i = 0; i < parts.length && i < def.properties.length; i++) {
          const prop = def.properties[i]
          const value = parts[i].trim()
          if (prop.type === 'number') {
            attributes[prop.name] = parseFloat(value) || prop.defaultValue
          } else if (prop.type === 'boolean') {
            attributes[prop.name] = value === 'true' || value === '1'
          } else {
            attributes[prop.name] = value
          }
        }
      } else {
        attributes['value'] = attrs
      }
    }

    // For named attributes like color=#FF0000
    if (attrs.includes('=') && !attrs.startsWith('=')) {
      const eqIdx = attrs.indexOf('=')
      attributes[attrs.slice(0, eqIdx).trim()] = attrs.slice(eqIdx + 1).trim()
    }

    const green = greenNode(kind, text, children.map(c => c.green))

    const red = new RedNode(green, {
      kind,
      metadata: { tagName },
    })

    for (const child of children) {
      child.parent = red
      red.appendChild(child)
    }

    return red
  }

  /**
   * Create a text RedNode.
   */
  createText(text: string, start: number = 0, end: number = 0): RedNode {
    const green = greenLeaf('text', text)
    return new RedNode(green, { kind: 'text' })
  }

  /**
   * Create a self-closing tag RedNode (like [*], [img]src[/img]).
   */
  createSelfClosing(
    tagName: string,
    attrs: string = '',
    start: number = 0,
    end: number = 0,
  ): RedNode {
    const def = this.registry.get(tagName)
    const kind = def?.kind ?? 'custom'
    const text = attrs || ''

    const green = greenLeaf(kind, text)
    return new RedNode(green, { kind, metadata: { tagName, isSelfClosing: true } })
  }

  /**
   * Create a document root RedNode.
   */
  createDocument(children: RedNode[] = []): RedNode {
    const green = greenNode('document', '', children.map(c => c.green))
    const red = new RedNode(green, { kind: 'document' })
    for (const child of children) {
      child.parent = red
      red.appendChild(child)
    }
    return red
  }
}
