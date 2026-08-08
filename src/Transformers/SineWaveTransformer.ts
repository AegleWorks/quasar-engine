import { DocumentModel } from '../Model/DocumentModel'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { Transformer, TransformResult } from './Transformer'
import { Transaction } from '../Transactions/Transaction'
import type { Operation } from '../Types/operations'
import { createOperationId } from '../Types/operations'

export interface SineWaveOptions {
  minSize: number
  maxSize: number
  frequency: number
  step: 'char' | 'word'
  selectionRange?: { start: number, end: number }
}

export class SineWaveTransformer implements Transformer {
  private options: SineWaveOptions

  constructor(options: Partial<SineWaveOptions> = {}) {
    this.options = {
      minSize: options.minSize ?? 50,
      maxSize: options.maxSize ?? 150,
      frequency: options.frequency ?? 0.5,
      step: options.step ?? 'char',
      selectionRange: options.selectionRange,
    }
  }

  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }

    const { minSize, maxSize, frequency, step, selectionRange } = this.options
    const amplitude = (maxSize - minSize) / 2
    const center = minSize + amplitude

    let globalIndex = 0
    const operations: Operation[] = []

    const walk = (node: RedNode) => {
      // AST Intersection check
      if (selectionRange) {
        if (node.range.end <= selectionRange.start || node.range.start >= selectionRange.end) {
          return // Node is completely outside the selection, skip it
        }
      }

      if (node.kind === 'text' && node.text) {
        const newChildren: RedNode[] = []
        
        if (step === 'char') {
          const chars = [...node.text]
          for (const ch of chars) {
            const wave = Math.sin(globalIndex * frequency)
            const size = Math.round(center + wave * amplitude)
            
            const synthGreen = greenLeaf('text', ch)
            const charNode = new RedNode(synthGreen, {
              kind: 'text',
              metadata: { style: { fontSize: size.toString() } }
            })
            newChildren.push(charNode)
            
            if (ch.trim() !== '') globalIndex++
          }
        } else if (step === 'word') {
          const words = node.text.split(/(\s+)/)
          for (const chunk of words) {
            if (chunk.trim() === '') {
              const synthGreen = greenLeaf('text', chunk)
              const spaceNode = new RedNode(synthGreen, { kind: 'text', metadata: {} })
              newChildren.push(spaceNode)
            } else {
              const wave = Math.sin(globalIndex * frequency)
              const size = Math.round(center + wave * amplitude)
              
              const synthGreen = greenLeaf('text', chunk)
              const wordNode = new RedNode(synthGreen, {
                kind: 'text',
                metadata: { style: { fontSize: size.toString() } }
              })
              newChildren.push(wordNode)
              globalIndex++
            }
          }
        }

        // We create a new Group RedNode to replace the text node
        const emptyGreen = greenNode('group', '')
        const groupNode = new RedNode(emptyGreen, { kind: 'group' })
        
        RedNode.allowMutation(() => {
          for (const child of newChildren) {
            groupNode.appendChild(child)
          }
        })

        // Emit an operation
        operations.push({
          kind: 'replace_node',
          id: createOperationId(),
          nodeId: node.id,
          newNode: groupNode,
          oldNode: node, // reference to old node
          undoable: true,
          timestamp: Date.now()
        })

        return // Prevent walking into the newly generated text fragments
      }

      const childrenToWalk = [...node.children]
      for (const child of childrenToWalk) {
        walk(child)
      }
    }

    walk(document.redRoot)

    // Build the transaction
    const transaction = new Transaction(operations)
    
    // For now, we apply it directly to the model as we still mutate the Red Tree,
    // but going forward, a true immutable system would return a cloned model.
    transaction.apply(document.redRoot)

    return { document, transaction }
  }
}

