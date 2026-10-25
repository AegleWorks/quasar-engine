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

type NodePredicate = (node: RedNode) => boolean

interface CompiledStep {
  readonly predicate: NodePredicate
  readonly combinator: QueryCombinator | 'root'
}

export class QueryEngine {
  /**
   * Execute a query against a tree.
   *
   * An empty query (or one whose every compound failed to parse) matches
   * nothing — not the root. "No selector" and "every node" are different
   * questions, and the explicit form of the second is `*`.
   *
   * The first step is answered in one pre-order walk that tests as it goes;
   * it never materialises the 38 522-node document just to filter it. A
   * one-step query — the overwhelming majority (`[color]`, `quote bold` is the
   * exception) — is therefore a single traversal with no intermediate arrays.
   */
  execute(query: Query, root: RedNode): QueryResult {
    const startTime = performance.now()
    const steps = query.steps
    if (steps.length === 0) {
      return { matches: [], total: 0, time: performance.now() - startTime }
    }

    const compiled = steps.map(compileStep)
    let current = collectMatching(root, compiled[0].predicate)

    for (let i = 1; i < compiled.length && current.length > 0; i++) {
      const step = compiled[i]
      const candidates = step.combinator === 'root'
        ? collectMatching(root, step.predicate)
        : follow(current, step.combinator, root).filter(step.predicate)
      current = candidates
    }

    const lastStep = steps[steps.length - 1]
    const matches: QueryMatch[] = current.map(node => ({
      node,
      score: 1,
      matchedSelectors: describeStep(lastStep),
    }))
    return {
      matches,
      total: matches.length,
      time: performance.now() - startTime,
    }
  }
}

/** Nodes matching one step, in document order, one traversal. */
function collectMatching(root: RedNode, predicate: NodePredicate): RedNode[] {
  const out: RedNode[] = []
  const stack: RedNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (predicate(node)) out.push(node)
    const children = node.children
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

/** Nodes reached by one combinator from `from`, in document order. */
function follow(
  from: readonly RedNode[],
  combinator: QueryCombinator,
  root: RedNode,
): readonly RedNode[] {
  // One source is the common case: its subtree/siblings are already in
  // document order, so no set and no whole-document filter are needed.
  if (from.length === 1) {
    const node = from[0]
    switch (combinator) {
      case 'descendant': {
        const out: RedNode[] = []
        const stack = node.children.slice().reverse()
        while (stack.length > 0) {
          const next = stack.pop()!
          out.push(next)
          const children = next.children
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
        }
        return out
      }
      case 'child':
        return node.children
      case 'adjacent': {
        const next = node.nextSibling
        return next ? [next] : []
      }
      case 'sibling':
        return node.parent === null ? [] : node.parent.children.slice(node.index + 1)
    }
  }

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

  // A set does not preserve document order across multiple sources; one
  // traversal restores it and drops duplicates at the same time.
  return reached.size === 0 ? [] : collectMatching(root, reached.has.bind(reached))
}

// ─── Matching ──────────────────────────────────────────────────

/** Compile a compound selector once, instead of re-dispatching per node. */
function compileStep(step: QueryStep): CompiledStep {
  const predicates = step.selector.map(compileSelector)
  return {
    combinator: step.combinator,
    predicate: predicates.length === 0
      ? () => true
      : node => {
          for (let i = 0; i < predicates.length; i++) {
            if (!predicates[i](node)) return false
          }
          return true
        },
  }
}

function compileSelector(selector: QuerySelector): NodePredicate {
  switch (selector.type) {
    case 'kind':
      return node => node.kind === selector.kind

    case 'tag': {
      if (selector.tag === '*') return ALWAYS
      const mappedKind = tagToNodeKind(selector.tag)
      const tag = selector.tag
      return node =>
        node.kind === tag ||
        node.metadata?.tagName === tag ||
        node.kind === mappedKind ||
        nodeKindToTag(node.kind) === tag
    }

    case 'attribute':
      return selector.value === undefined
        ? node => readAttribute(node, selector.name) !== undefined
        : node => readAttribute(node, selector.name) === selector.value

    case 'attribute_value':
      // The BBCode `=value` an author wrote. Read through the shared helper so
      // quoted attributes (`[quote="Ana"]`) compare without their quotes.
      return node => nodeAttrValue(node) === selector.value

    case 'has_attribute':
      return node => readAttribute(node, selector.name) !== undefined

    case 'text':
      return node => (node.text || '').includes(selector.pattern)

    case 'has_child': {
      const nested = compileSelector(selector.selector)
      return node => node.children.some(nested)
    }

    case 'has_descendant': {
      const nested = compileSelector(selector.selector)
      return node => hasDescendant(node, nested)
    }

    case 'first_child':
      return node => node.index === 0

    case 'last_child':
      return node => node.parent !== null && node.index === node.parent.children.length - 1

    case 'nth_child':
      // CSS counts children from 1.
      return node => node.index === selector.n - 1

    case 'position':
      return node => {
        if (selector.min !== undefined && node.index < selector.min) return false
        if (selector.max !== undefined && node.index > selector.max) return false
        return true
      }

    case 'depth':
      return node => {
        if (selector.min !== undefined && node.depth < selector.min) return false
        if (selector.max !== undefined && node.depth > selector.max) return false
        return true
      }

    default:
      return NEVER
  }
}

const ALWAYS: NodePredicate = () => true
const NEVER: NodePredicate = () => false

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

function hasDescendant(node: RedNode, predicate: NodePredicate): boolean {
  const stack = [...node.children]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (predicate(next)) return true
    for (const child of next.children) stack.push(child)
  }
  return false
}

// ─── Ordering and descriptions ─────────────────────────────────

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
