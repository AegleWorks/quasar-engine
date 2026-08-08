import { DocumentModel } from '../Model/DocumentModel'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { Transformer, TransformResult } from './Transformer'
import { Transaction } from '../Transactions/Transaction'
import type { Operation } from '../Types/operations'
import { createOperationId } from '../Types/operations'

export interface GrowOptions {
  minSize: number
  maxSize: number
  cycles: number
  selectionRange?: { start: number, end: number }
}

export class GrowTransformer implements Transformer {
  private options: GrowOptions

  constructor(options: Partial<GrowOptions> = {}) {
    this.options = {
      minSize: options.minSize ?? 90,
      maxSize: options.maxSize ?? 160,
      cycles: options.cycles ?? 1,
      selectionRange: options.selectionRange,
    }
  }

  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }

    const { minSize, maxSize, cycles, selectionRange } = this.options
    
    let globalIndex = 0
    let totalChars = 0

    // First pass to count total target units
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
            const phase = (globalIndex / denom) * Math.PI * 2 * cycles
            const t = (Math.sin(phase) + 1) / 2
            const size = Math.round(minSize + (maxSize - minSize) * t)
            
            const synthGreen = greenLeaf('text', ch)
            const charNode = new RedNode(synthGreen, {
              kind: 'text',
              metadata: { style: { fontSize: size.toString() } }
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
