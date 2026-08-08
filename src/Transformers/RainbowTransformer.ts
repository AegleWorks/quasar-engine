import { DocumentModel } from '../Model/DocumentModel'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { Transformer, TransformResult } from './Transformer'
import { Transaction } from '../Transactions/Transaction'
import type { Operation } from '../Types/operations'
import { createOperationId } from '../Types/operations'
import { hslToHex } from '../Utils/color'

export interface RainbowOptions {
  saturation: number // 0-100
  lightness: number  // 0-100
  spread: number     // degrees
  offset: number     // degrees
  selectionRange?: { start: number, end: number }
}

export class RainbowTransformer implements Transformer {
  private options: RainbowOptions

  constructor(options: Partial<RainbowOptions> = {}) {
    this.options = {
      saturation: options.saturation ?? 80,
      lightness: options.lightness ?? 60,
      spread: options.spread ?? 300,
      offset: options.offset ?? 0,
      selectionRange: options.selectionRange,
    }
  }

  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }

    const { saturation, lightness, spread, offset, selectionRange } = this.options
    
    // Convert to 0-1 range for the color util
    const s = saturation / 100
    const l = lightness / 100

    let globalIndex = 0
    let totalChars = 0

    // First pass to count total characters (for proper spread calculation)
    const countWalk = (node: RedNode) => {
      if (selectionRange) {
        if (node.range.end <= selectionRange.start || node.range.start >= selectionRange.end) return
      }
      if (node.kind === 'text' && node.text) {
        totalChars += node.text.replace(/\s+/g, '').length
        return
      }
      for (const child of node.children) countWalk(child)
    }
    countWalk(document.redRoot)

    const denom = Math.max(totalChars - 1, 1)
    const operations: Operation[] = []

    // Second pass to apply the transformation
    const walk = (node: RedNode) => {
      if (selectionRange) {
        if (node.range.end <= selectionRange.start || node.range.start >= selectionRange.end) return
      }

      if (node.kind === 'text' && node.text) {
        const newChildren: RedNode[] = []
        const chars = [...node.text]
        
        for (const ch of chars) {
          if (ch.trim() === '') {
            const synthGreen = greenLeaf('text', ch)
            const spaceNode = new RedNode(synthGreen, { kind: 'text', metadata: {} })
            newChildren.push(spaceNode)
          } else {
            const hue = offset + (globalIndex / denom) * spread
            const colorHex = hslToHex(hue, s, l)
            
            const synthGreen = greenLeaf('text', ch)
            const charNode = new RedNode(synthGreen, {
              kind: 'text',
              metadata: { style: { color: colorHex } }
            })
            newChildren.push(charNode)
            globalIndex++
          }
        }

        const emptyGreen = greenNode('group', '')
        const groupNode = new RedNode(emptyGreen, { kind: 'group' })
        
        RedNode.allowMutation(() => {
          for (const child of newChildren) {
            groupNode.appendChild(child)
          }
        })

        operations.push({
          kind: 'replace_node',
          id: createOperationId(),
          nodeId: node.id,
          newNode: groupNode,
          oldNode: node,
          undoable: true,
          timestamp: Date.now()
        })
        return
      }

      for (const child of [...node.children]) {
        walk(child)
      }
    }

    walk(document.redRoot)

    const transaction = new Transaction(operations)
    transaction.apply(document.redRoot)

    return { document, transaction }
  }
}
