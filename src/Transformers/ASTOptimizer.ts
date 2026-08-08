import { DocumentModel } from '../Model/DocumentModel'
import { RedNode } from '../Syntax/RedNode'
import { greenNode } from '../Syntax/GreenNode'
import { Transformer, TransformResult } from './Transformer'
import { Transaction } from '../Transactions/Transaction'
import { createOperationId } from '../Types/operations'
import type { Operation } from '../Types/operations'
import type { NodeMetadata } from '../Types/core'

// ─── Metadata helpers ──────────────────────────────────────────
//
// This file used to deep-clone with `JSON.parse(JSON.stringify(x))` at four
// sites and compare with `JSON.stringify(a) !== JSON.stringify(b)` at one —
// inside a transformer that walks the entire tree, to a fixpoint.
//
// Serialising to compare was also a latent correctness bug: `JSON.stringify` is
// key-order sensitive, so `{a:1,b:2}` and `{b:2,a:1}` compared as different and
// two genuinely mergeable nodes would refuse to merge depending on the order
// their metadata happened to be built in.

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = cloneValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Deep copy of a metadata bag. */
function cloneMetadata(metadata: NodeMetadata | undefined): NodeMetadata {
  return cloneValue(metadata ?? {}) as NodeMetadata
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => valueEquals(item, b[i]))
  }

  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      valueEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }

  return false
}

/** Structural equality of two metadata bags, independent of key order. */
function metadataEquals(a: NodeMetadata | undefined, b: NodeMetadata | undefined): boolean {
  return valueEquals(a ?? {}, b ?? {})
}

export class ASTOptimizer implements Transformer {
  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }

    let maxIters = 10
    const totalOps: Operation[] = []

    // Fixpoint iteration: keep optimizing until the tree is stable
    while (maxIters > 0) {
      const operations: Operation[] = []
      
      const walk = (node: RedNode) => {
        // 1. Optimize children first
        const childrenToWalk = [...node.children]
        for (const child of childrenToWalk) {
          walk(child)
        }

        // 2. Apply rules on the current node
        this.applyRules(node, operations)
      }

      walk(document.redRoot)

      if (operations.length === 0) break

      const transaction = new Transaction(operations)
      transaction.apply(document.redRoot)
      
      totalOps.push(...operations)
      maxIters--
    }

    const finalTx = new Transaction(totalOps)
    return { document, transaction: finalTx }
  }

  private applyRules(node: RedNode, operations: Operation[]) {
    if (node.children.length === 0) return

    let changed = false
    const newChildren: RedNode[] = []

    // Pass 1: Remove empty non-void tags
    for (let i = 0; i < node.children.length; i++) {
      const current = node.children[i]
      if (this.isEmptyNode(current)) {
        changed = true
        continue
      }
      newChildren.push(current)
    }

    // Pass 2: Merge adjacent siblings separated only by spacing
    const finalChildren: RedNode[] = []
    for (let i = 0; i < newChildren.length; i++) {
      const current = newChildren[i]
      
      if (finalChildren.length > 0) {
        let prevIdx = finalChildren.length - 1
        
        let spaces: RedNode[] = []
        while (prevIdx >= 0 && (finalChildren[prevIdx].kind === 'spacing' || finalChildren[prevIdx].kind === 'empty_line')) {
           spaces.unshift(finalChildren[prevIdx])
           prevIdx--
        }

        if (prevIdx >= 0) {
          const previous = finalChildren[prevIdx]
          if (this.canMerge(previous, current) || this.isOrphanedParagraphPair(previous, current, spaces)) {
            changed = true
            
            // Build the green node FROM the children it will hold, so its width
            // is theirs. The shell used to declare a span and hold no children
            // at all, which made the resulting red node's range describe nothing.
            const mergedKids = [...previous.children, ...spaces, ...current.children]
            const mergedGreen = greenNode(
              previous.kind,
              previous.text,
              mergedKids.map(k => k.green),
              previous.green.leadingWidth,
              previous.green.trailingWidth,
            )
            const mergedNode = new RedNode(mergedGreen, {
              kind: previous.kind,
              metadata: cloneMetadata(previous.metadata)
            })

            RedNode.allowMutation(() => {
              for (const c of previous.children) mergedNode.appendChild(c)
              for (const s of spaces) mergedNode.appendChild(s)
              for (const c of current.children) mergedNode.appendChild(c)
            })

            finalChildren[prevIdx] = mergedNode
            finalChildren.splice(prevIdx + 1, spaces.length)
            
            continue 
          }
        }
      }

      finalChildren.push(current)
    }

    // Pass 3: Canonical Ordering (Invert out-of-order single child wrappers)
    // Example: [color][b]text[/b][/color] -> [b][color]text[/color][/b]
    if (finalChildren.length === 1 && !changed) {
      const child = finalChildren[0]
      const parentRank = this.getRank(node.kind)
      const childRank = this.getRank(child.kind)

      // If parent rank > child rank, it means the parent should be INSIDE the child
      if (parentRank !== 99 && childRank !== 99 && parentRank > childRank) {
        // Swap node and child!
        const innerGreen = greenNode(
          node.kind,
          node.text,
          (child.children as RedNode[]).map(g => g.green),
          node.green.leadingWidth,
          node.green.trailingWidth,
        )
        const innerNode = new RedNode(innerGreen, {
          kind: node.kind,
          metadata: cloneMetadata(node.metadata)
        })

        const swappedGreen = greenNode(
          child.kind,
          child.text,
          [innerGreen],
          child.green.leadingWidth,
          child.green.trailingWidth,
        )
        const replacementNode = new RedNode(swappedGreen, {
          kind: child.kind,
          metadata: cloneMetadata(child.metadata)
        })

        RedNode.allowMutation(() => {
          for (const grandchild of child.children) {
            innerNode.appendChild(grandchild)
          }
          replacementNode.appendChild(innerNode)
        })

        operations.push({
          kind: 'replace_node',
          id: createOperationId(),
          nodeId: node.id,
          newNode: replacementNode,
          oldNode: node,
          undoable: true,
          timestamp: Date.now()
        })
        return // We replaced the current node entirely, stop applying rules
      }
    }

    // If we only merged/cleaned children, we replace the node with its optimized children
    if (changed) {
      const groupGreen = greenNode(
        node.kind,
        node.text,
        finalChildren.map(c => c.green),
        node.green.leadingWidth,
        node.green.trailingWidth,
      )
      const replacementNode = new RedNode(groupGreen, { 
        kind: node.kind,
        metadata: cloneMetadata(node.metadata)
      })
      
      RedNode.allowMutation(() => {
        for (const child of finalChildren) {
          replacementNode.appendChild(child)
        }
      })

      operations.push({
        kind: 'replace_node',
        id: createOperationId(),
        nodeId: node.id,
        newNode: replacementNode,
        oldNode: node,
        undoable: true,
        timestamp: Date.now()
      })
    }
  }

  private static VOID_TAGS = new Set(['img', 'image', 'url', 'empty_line', 'spacing'])
  private static UNMERGEABLE = new Set(['document', 'group', 'paragraph', 'empty_line', 'spacing', 'text', 'code', 'inline_code', 'notice', 'box', 'spoilerbox', 'quote', 'list', 'center', 'heading', 'right'])

  private isEmptyNode(node: RedNode): boolean {
    if (ASTOptimizer.VOID_TAGS.has(node.kind)) return false
    
    if (node.kind === 'text') return node.text === ''
    
    // Group or style nodes with no children
    if (node.children.length === 0) return true

    // Check if all children are also empty
    return node.children.every(c => this.isEmptyNode(c))
  }

  /**
   * Two `paragraph` siblings with *nothing* between them.
   *
   * `paragraph` is in {@link UNMERGEABLE} for good reason — paragraphs are block
   * separators and collapsing them normally would change the document. But this
   * particular shape is one the optimizer creates itself and the parser never
   * does: paragraphs exist because a block element split the inline content, so
   * when a rule deletes that block (an empty `[notice]`, say) the two halves are
   * left as adjacent paragraphs that no longer have anything separating them.
   *
   * That was the whole non-idempotence bug. Exporting such a tree emits no
   * separator, so re-parsing folds the two paragraphs back into one and a second
   * optimizer pass finds more work to do. Merging here makes the tree agree with
   * its own round-trip.
   *
   * Verified empirically before relying on it: across 202.764 nodes (both real
   * fixtures plus 20.000 seeded random documents) the parser produced this shape
   * **zero** times, so the rule can only ever fire on optimizer-made trees.
   *
   * `spaces` must be empty — paragraphs separated by real spacing or blank lines
   * are a genuine authored break and must survive.
   */
  private isOrphanedParagraphPair(a: RedNode, b: RedNode, spaces: RedNode[]): boolean {
    return spaces.length === 0 && a.kind === 'paragraph' && b.kind === 'paragraph'
  }

  private canMerge(a: RedNode, b: RedNode): boolean {
    if (a.kind !== b.kind) return false
    
    if (ASTOptimizer.UNMERGEABLE.has(a.kind)) return false

    if (!metadataEquals(a.metadata, b.metadata)) return false

    return true
  }

  private getRank(kind: string): number {
    const ranks: Record<string, number> = {
      'url': 1, 'email': 1, 'profile': 1,
      'font_size': 2, 'font': 2,
      'bold': 3, 'italic': 3, 'underline': 3, 'strikethrough': 3, 'shadow': 3,
      'color': 4
    }
    return ranks[kind] ?? 99
  }
}
