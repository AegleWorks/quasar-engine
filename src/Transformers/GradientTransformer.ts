import { DocumentModel } from '../Model/DocumentModel'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { Transformer, TransformResult } from './Transformer'
import { Transaction } from '../Transactions/Transaction'
import type { Operation } from '../Types/operations'
import { createOperationId } from '../Types/operations'
import { ease, mixHex, type Easing } from '../Utils/color'

export interface GradientOptions {
  from: string       // hex color
  to: string         // hex color
  unit: 'char' | 'word'
  easing: Easing
  selectionRange?: { start: number, end: number }
}

export class GradientTransformer implements Transformer {
  private options: GradientOptions

  constructor(options: Partial<GradientOptions> = {}) {
    this.options = {
      from: options.from ?? '#e8b04b',
      to: options.to ?? '#d94f4f',
      unit: options.unit ?? 'char',
      easing: options.easing ?? 'linear',
      selectionRange: options.selectionRange,
    }
  }

  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }

    const { from, to, unit, easing, selectionRange } = this.options
    
    let globalIndex = 0
    let totalUnits = 0

    // First pass to count total target units
    const countWalk = (node: RedNode) => {
      if (selectionRange) {
        if (node.range.end <= selectionRange.start || node.range.start >= selectionRange.end) return
      }
      if (node.kind === 'text' && node.text) {
        if (unit === 'char') {
          totalUnits += node.text.replace(/\s+/g, '').length
        } else {
          totalUnits += node.text.split(/(\s+)/).filter(w => w.trim() !== '').length
        }
        return
      }
      for (const child of node.children) countWalk(child)
    }
    countWalk(document.redRoot)

    const denom = Math.max(totalUnits - 1, 1)
    const operations: Operation[] = []

    // Second pass to apply the transformation
    const walk = (node: RedNode) => {
      if (selectionRange) {
        if (node.range.end <= selectionRange.start || node.range.start >= selectionRange.end) return
      }

      if (node.kind === 'text' && node.text) {
        const newChildren: RedNode[] = []
        
        if (unit === 'char') {
          const chars = [...node.text]
          for (const ch of chars) {
            if (ch.trim() === '') {
              const synthGreen = greenLeaf('text', ch)
              const spaceNode = new RedNode(synthGreen, { kind: 'text', metadata: {} })
              newChildren.push(spaceNode)
            } else {
              const t = ease(totalUnits <= 1 ? 0 : globalIndex / denom, easing)
              const colorHex = mixHex(from, to, t)
              
              const synthGreen = greenLeaf('text', ch)
              const charNode = new RedNode(synthGreen, {
                kind: 'text',
                metadata: { style: { color: colorHex } }
              })
              newChildren.push(charNode)
              globalIndex++
            }
          }
        } else if (unit === 'word') {
          const words = node.text.split(/(\s+)/)
          for (const chunk of words) {
            if (chunk.trim() === '') {
              const synthGreen = greenLeaf('text', chunk)
              const spaceNode = new RedNode(synthGreen, { kind: 'text', metadata: {} })
              newChildren.push(spaceNode)
            } else {
              const t = ease(totalUnits <= 1 ? 0 : globalIndex / denom, easing)
              const colorHex = mixHex(from, to, t)
              
              const synthGreen = greenLeaf('text', chunk)
              const wordNode = new RedNode(synthGreen, {
                kind: 'text',
                metadata: { style: { color: colorHex } }
              })
              newChildren.push(wordNode)
              globalIndex++
            }
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
