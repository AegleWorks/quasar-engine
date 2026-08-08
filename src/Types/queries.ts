/**
 * DocumentEngine — Query Types
 *
 * CSS-inspired query selectors for the document tree.
 * Enables queries like: `paragraph > bold`, `quote text`, `[color]`
 */

import type { NodeKind, NodeAttributes } from './core'
import type { RedNode } from '../Syntax/RedNode'

// ─── Query ─────────────────────────────────────────────────────

export type QuerySelector =
  | { type: 'kind'; kind: NodeKind }
  | { type: 'tag'; tag: string }
  | { type: 'attribute'; name: string; value?: string }
  | { type: 'has_attribute'; name: string }
  | { type: 'text'; pattern: string }
  | { type: 'has_child'; selector: QuerySelector }
  | { type: 'has_descendant'; selector: QuerySelector }
  | { type: 'nth_child'; n: number }
  | { type: 'first_child' }
  | { type: 'last_child' }
  | { type: 'position'; min?: number; max?: number }
  | { type: 'depth'; min?: number; max?: number }

export type QueryCombinator =
  | 'child'       // >  direct child
  | 'descendant'  // (space) any descendant
  | 'adjacent'    // +  next sibling
  | 'sibling'     // ~  any sibling

export interface QueryStep {
  selector: QuerySelector[]
  combinator: QueryCombinator | 'root'
}

export interface Query {
  steps: QueryStep[]
}

export interface QueryMatch {
  node: RedNode
  /** How well this node matches (for sorting results) */
  score: number
  /** The specific selectors that matched */
  matchedSelectors: string[]
}

// ─── Query Builder ─────────────────────────────────────────────

export function query(selector: string): Query {
  // Parse simple CSS-like selector syntax
  const parts = selector.split(/\s+(?![^\[]*\])\s*/g).filter(Boolean)
  const steps: QueryStep[] = []
  let combinator: QueryCombinator | 'root' = 'root'

  for (const part of parts) {
    if (part === '>') {
      combinator = 'child'
      continue
    }
    if (part === '+') {
      combinator = 'adjacent'
      continue
    }
    if (part === '~') {
      combinator = 'sibling'
      continue
    }

    const selectors: QuerySelector[] = parseSimpleSelector(part)
    steps.push({ selector: selectors, combinator })
    combinator = 'descendant'
  }

  return { steps }
}

function parseSimpleSelector(part: string): QuerySelector[] {
  const selectors: QuerySelector[] = []

  // Tag/kind selector
  const tagMatch = part.match(/^([a-zA-Z_*][a-zA-Z0-9_-]*)/)
  if (tagMatch) {
    selectors.push({ type: 'tag', tag: tagMatch[1] })
  }

  // Attribute selectors: [name], [name=value]
  const attrRegex = /\[([^\]=]+)(?:=([^\]]*))?\]/g
  let attrMatch
  while ((attrMatch = attrRegex.exec(part)) !== null) {
    if (attrMatch[2] !== undefined) {
      selectors.push({ type: 'attribute', name: attrMatch[1], value: attrMatch[2] })
    } else {
      selectors.push({ type: 'has_attribute', name: attrMatch[1] })
    }
  }

  // Pseudo-classes
  if (part.includes(':first-child')) {
    selectors.push({ type: 'first_child' })
  }
  if (part.includes(':last-child')) {
    selectors.push({ type: 'last_child' })
  }
  const nthMatch = part.match(/:nth-child\((\d+)\)/)
  if (nthMatch) {
    selectors.push({ type: 'nth_child', n: parseInt(nthMatch[1], 10) })
  }

  return selectors
}

// ─── Query Result ─────────────────────────────────────────────

export interface QueryResult {
  matches: QueryMatch[]
  total: number
  time: number
}
