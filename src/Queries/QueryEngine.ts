/**
 * DocumentEngine — QueryEngine
 *
 * Structural queries over the red tree: the engine an editor, a lint rule or
 * an AI context builder uses to ask "where are the quotes", "which links are
 * not https", "what is the third item of each list".
 *
 * ─── Semantics ─────────────────────────────────────────────────────────────
 *
 * The first step searches the WHOLE document (CSS's leftmost-selector rule),
 * and every later step is resolved from the previous step's matches:
 *
 *   `bold`            every bold node
 *   `quote bold`      bold nodes that have a quote ancestor
 *   `quote > bold`    bold nodes whose parent is a quote
 *   `bold + italic`   italics immediately after a bold sibling
 *   `bold ~ italic`   italics after a bold sibling (any distance)
 *
 * Results are returned in document order, deduplicated by identity. That
 * matters: a descendant step can reach one node from two parents, and an
 * editor that draws a match list should not draw it twice. Identity, not
 * `node.id` — reading ids mints them for the whole tree and would make a
 * read-only query allocate identity state as a side effect.
 *
 * Every traversal is iterative. Documents nest up to `MAX_NESTING_DEPTH`
 * (256), but a query can run on a tree a plugin built, and a stack is neither
 * slower nor harder to read than recursion here.
 *
 * ─── What it does not do (deliberately) ─────────────────────────────────────
 *
 * No `:not()`, no sibling text pseudo-classes, no CSS specificity. This is a
 * structural index over one document, not a stylesheet engine; every feature
 * added here is a grammar the editor has to explain to an author.
 */

import { RedNode } from '../Syntax/RedNode'
import { nodeAttrValue } from '../Syntax/nodeAttr'
import { nodeKindToTag, tagToNodeKind } from '../BBCode/BBCodeToGreenNode'
import type {
  Query,
  QueryCombinator,
  QueryMatch,
  QueryResult,
  QuerySelector,
  QueryStep,
} from '../Types/queries'

export class QueryEngine {
  /**
   * Execute a query against a tree.
   *
   * An empty query (or one whose every compound failed to parse) matches
   * nothing — not the root. "No selector" and "every node" are different
   * questions, and the explicit form of the second is `*`.
   */
  execute(query: Query, root: RedNode): QueryResult {
    const startTime = performance.now()
    const steps = query.steps
    if (steps.length === 0) {
      return { matches: [], total: 0, time: performance.now() - startTime }
    }

    const all = flatten(root)
    let current: readonly RedNode[] = []

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const candidates = i === 0 || step.combinator === 'root'
        ? all
        : this.follow(current, step.combinator, all)

      if (candidates.length === 0) {
        current = []
        break
      }
      current = candidates.filter(node => matchesStep(node, step))
    }

    const matches: QueryMatch[] = current.map(node => ({
      node,
      score: 1,
      matchedSelectors: describeStep(steps[steps.length - 1]),
    }))
    return {
      matches,
      total: matches.length,
      time: performance.now() - startTime,
    }
  }

  /** Nodes reached by one combinator from `from`, in document order. */
  private follow(
    from: readonly RedNode[],
    combinator: QueryCombinator,
    all: readonly RedNode[],
  ): readonly RedNode[] {
    const reached = new Set<RedNode>()

    for (const node of from) {
      switch (combinator) {
        case 'descendant': {
          const stack = [...node.children]
          while (stack.length > 0) {
            const next = stack.pop()!
            reached.add(next)
            for (const child of next.children) stack.push(child)
          }
          break
        }
        case 'child':
          for (const child of node.children) reached.add(child)
          break
        case 'adjacent': {
          const next = node.nextSibling
          if (next) reached.add(next)
          break
        }
        case 'sibling': {
          const parent = node.parent
          if (!parent) break
          const siblings = parent.children
          for (let i = node.index + 1; i < siblings.length; i++) reached.add(siblings[i])
          break
        }
      }
    }

    // Filtering the pre-order list both restores document order (a set does
    // not preserve it across multiple sources) and removes duplicates.
    return reached.size === 0 ? [] : all.filter(node => reached.has(node))
  }
}

// ─── Matching ──────────────────────────────────────────────────

function matchesStep(node: RedNode, step: QueryStep): boolean {
  for (let i = 0; i < step.selector.length; i++) {
    if (!matchesSelector(node, step.selector[i])) return false
  }
  return true
}

function matchesSelector(node: RedNode, selector: QuerySelector): boolean {
  switch (selector.type) {
    case 'kind':
      return node.kind === selector.kind

    case 'tag': {
      if (selector.tag === '*') return true
      if (node.kind === selector.tag || node.metadata?.tagName === selector.tag) return true
      // A selector names the BBCode TAG (`[b]`), the tree carries the semantic
      // KIND (`bold`). Both directions are accepted so `b`, `color` and
      // `centre`/`center` all find what an author expects.
      return tagToNodeKind(selector.tag) === node.kind || nodeKindToTag(node.kind) === selector.tag
    }

    case 'attribute': {
      const value = readAttribute(node, selector.name)
      if (selector.value === undefined) return value !== undefined
      return value !== undefined && value === selector.value
    }

    case 'attribute_value': {
      // The BBCode `=value` an author wrote. Read through the shared helper so
      // quoted attributes (`[quote="Ana"]`) compare without their quotes.
      return nodeAttrValue(node) === selector.value
    }

    case 'has_attribute':
      return readAttribute(node, selector.name) !== undefined

    case 'text':
      return (node.text || '').includes(selector.pattern)

    case 'has_child':
      return node.children.some(child => matchesSelector(child, selector.selector))

    case 'has_descendant':
      return hasDescendant(node, selector.selector)

    case 'first_child':
      return node.index === 0

    case 'last_child':
      return node.parent !== null && node.index === node.parent.children.length - 1

    case 'nth_child':
      // CSS counts children from 1.
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

/**
 * The value of an attribute, from metadata first and the source attribute
 * second. `undefined` means "this node has no such attribute".
 *
 * The second fallback is deliberately narrow. `nodeAttrValue(node)` returns a
 * childless node's own text when there is no `=`, which is right for
 * `[img]url[/img]` but would make every text leaf "have" every attribute. So
 * the raw attribute is only read when the node actually contains `=`.
 */
function readAttribute(node: RedNode, name: string): string | undefined {
  const meta = node.metadata?.[name]
  if (meta !== undefined && meta !== null) {
    return typeof meta === 'string' ? meta : String(meta)
  }
  const text = node.text || ''
  if (text.indexOf('=') < 0) return undefined
  const value = nodeAttrValue(node, name)
  return value === '' ? undefined : value
}

function hasDescendant(node: RedNode, selector: QuerySelector): boolean {
  const stack = [...node.children]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (matchesSelector(next, selector)) return true
    for (const child of next.children) stack.push(child)
  }
  return false
}

// ─── Ordering and descriptions ─────────────────────────────────

/** Pre-order, root first, iterative. Document order by construction. */
function flatten(root: RedNode): readonly RedNode[] {
  const out: RedNode[] = []
  const stack: RedNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    out.push(node)
    const children = node.children
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

/** Human-readable parts of a compound, for `QueryMatch.matchedSelectors`. */
function describeStep(step: QueryStep): string[] {
  return step.selector.map(selector => {
    switch (selector.type) {
      case 'kind': return `kind:${selector.kind}`
      case 'tag': return `tag:${selector.tag}`
      case 'attribute': return selector.value === undefined
        ? `attr:${selector.name}`
        : `attr:${selector.name}=${selector.value}`
      case 'attribute_value': return `value:${selector.value}`
      case 'has_attribute': return `has:${selector.name}`
      case 'text': return `text:${selector.pattern}`
      case 'has_child': return 'has-child'
      case 'has_descendant': return 'has-descendant'
      case 'nth_child': return `nth-child(${selector.n})`
      case 'first_child': return 'first-child'
      case 'last_child': return 'last-child'
      case 'position': return `position(${selector.min ?? ''}..${selector.max ?? ''})`
      case 'depth': return `depth(${selector.min ?? ''}..${selector.max ?? ''})`
      default: return 'unknown'
    }
  })
}
