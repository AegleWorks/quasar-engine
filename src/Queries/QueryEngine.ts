/**
 * DocumentEngine — QueryEngine
 *
 * CSS-inspired query engine for the document tree.
 * Enables queries like:
 *   query('paragraph > bold')
 *   query('quote text')
 *   query('[color]')
 *   query('list > *')
 *
 * Useful for:
 * - Finding nodes by structure
 * - AI context gathering
 * - Plugin discovery
 * - Lint rule targeting
 */

import { RedNode } from '../Syntax/RedNode'
import type { Query, QueryStep, QuerySelector, QueryMatch, QueryResult } from '../Types/queries'

export class QueryEngine {
  /**
   * Execute a query against a RedNode tree.
   */
  execute(query: Query, root: RedNode): QueryResult {
    const startTime = performance.now()
    const matches: QueryMatch[] = []

    // Start from root, apply each step
    let candidates: RedNode[] = [root]

    for (const step of query.steps) {
      if (candidates.length === 0) break

      if (step.combinator === 'root') {
        // First step: match against root
        candidates = this.matchStep(step, candidates)
      } else if (step.combinator === 'descendant') {
        // Space: any descendant
        const allDescendants: RedNode[] = []
        for (const c of candidates) {
          c.walk(node => {
            if (node !== c) allDescendants.push(node)
          })
        }
        candidates = this.matchStep(step, allDescendants)
      } else if (step.combinator === 'child') {
        // > direct child
        const children: RedNode[] = []
        for (const c of candidates) {
          children.push(...c.children)
        }
        candidates = this.matchStep(step, children)
      } else if (step.combinator === 'adjacent') {
        // + next sibling
        const nextSiblings: RedNode[] = []
        for (const c of candidates) {
          const next = c.nextSibling
          if (next) nextSiblings.push(next)
        }
        candidates = this.matchStep(step, nextSiblings)
      } else if (step.combinator === 'sibling') {
        // ~ any sibling
        const siblings: RedNode[] = []
        for (const c of candidates) {
          if (c.parent) {
            siblings.push(...c.parent.children.filter(s => s.id !== c.id))
          }
        }
        candidates = this.matchStep(step, siblings)
      }
    }

    for (const node of candidates) {
      matches.push({
        node,
        score: 1,
        matchedSelectors: [],
      })
    }

    return {
      matches,
      total: matches.length,
      time: performance.now() - startTime,
    }
  }

  /**
   * Filter candidates by applying a query step's selectors.
   */
  private matchStep(step: QueryStep, candidates: RedNode[]): RedNode[] {
    return candidates.filter(node =>
      step.selector.every(sel => this.matchesSelector(node, sel))
    )
  }

  /**
   * Check if a single node matches a single selector.
   */
  private matchesSelector(node: RedNode, selector: QuerySelector): boolean {
    switch (selector.type) {
      case 'kind':
        return node.kind === selector.kind
      case 'tag': {
        const tagName = node.metadata?.tagName as string | undefined
        return tagName === selector.tag || node.kind === selector.tag
      }
      case 'attribute': {
        const val = node.metadata?.[selector.name]
        if (selector.value !== undefined) {
          return String(val) === selector.value
        }
        return val !== undefined && val !== null
      }
      case 'has_attribute':
        return node.metadata?.[selector.name] !== undefined
      case 'text': {
        const text = node.text || ''
        return text.includes(selector.pattern)
      }
      case 'has_child':
        return node.children.some(c => this.matchesSelector(c, selector.selector))
      case 'has_descendant': {
        let found = false
        node.walk(c => {
          if (c !== node && this.matchesSelector(c, selector.selector)) {
            found = true
            return 'skip'
          }
        })
        return found
      }
      case 'first_child':
        return node.index === 0
      case 'last_child':
        return node.parent ? node.index === node.parent.children.length - 1 : false
      case 'nth_child':
        return node.index === selector.n - 1
      case 'position':
        if (selector.min !== undefined && node.index < selector.min) return false
        if (selector.max !== undefined && node.index > selector.max) return false
        return true
      case 'depth':
        if (selector.min !== undefined && node.depth < selector.min) return false
        if (selector.max !== undefined && node.depth > selector.max) return false
        return true
      default:
        return false
    }
  }
}
