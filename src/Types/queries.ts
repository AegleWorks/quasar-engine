/**
 * DocumentEngine — Query Types
 *
 * CSS-inspired structural queries over the document tree. The syntax is CSS's
 * with one deliberate difference: a bare bracketed name is a BBCode TAG, not
 * an HTML attribute. `[color]` finds colour nodes because that is what an
 * author of a BBCode document means by it.
 *
 *   bold                       every bold node
 *   quote bold                 bold inside a quote (descendant)
 *   quote > paragraph          paragraphs directly inside a quote
 *   bold + italic              the italic immediately after a bold
 *   bold ~ italic              every italic after a bold sibling
 *   *                          every node, root included
 *   [color]                    every colour node
 *   [color=red]                colour nodes written with the attribute `red`
 *   [heading]:first-child      the first heading in each parent
 *   url[href=…]                CSS attribute syntax, read from metadata
 *   paragraph:last-child
 *   list > *:nth-child(2)
 *
 * A selector is a chain of STEPS. Each step has a compound selector (all of
 * its parts must match) and a combinator describing how it connects to the
 * previous step. The first step searches the whole document; that is the same
 * rule CSS uses for the leftmost selector, and it is what makes
 * `query('bold')` mean "every bold node" rather than "the root, if it is bold".
 */

import type { NodeKind } from './core'
import type { RedNode } from '../Syntax/RedNode'

// ─── Query Selector ───────────────────────────────────────────

export type QuerySelector =
  /** Match the semantic kind. */
  | { type: 'kind'; kind: NodeKind }
  /**
   * Match the semantic kind or the registered tag name. `'*'` matches any
   * node, which is what the universal selector compiles to.
   */
  | { type: 'tag'; tag: string }
  /** CSS-style attribute: read `metadata[name]`, then the tag's attribute. */
  | { type: 'attribute'; name: string; value?: string }
  /** The BBCode `=value` attribute of a bracketed selector, e.g. `[color=red]`. */
  | { type: 'attribute_value'; value: string }
  /** Presence of an attribute, without caring about its value. */
  | { type: 'has_attribute'; name: string }
  /** Substring match on this node's own text. */
  | { type: 'text'; pattern: string }
  | { type: 'has_child'; selector: QuerySelector }
  | { type: 'has_descendant'; selector: QuerySelector }
  | { type: 'nth_child'; n: number }
  | { type: 'first_child' }
  | { type: 'last_child' }
  | { type: 'position'; min?: number; max?: number }
  | { type: 'depth'; min?: number; max?: number }

/**
 * How a step connects to the step before it.
 *
 * `root` is the first step's combinator: it searches the entire tree, which is
 * why a one-step query works at all.
 */
export type QueryCombinator =
  | 'child'       // >  direct child
  | 'descendant'  //    any descendant
  | 'adjacent'    // +  the immediately following sibling
  | 'sibling'     // ~  any following sibling

export interface QueryStep {
  selector: QuerySelector[]
  combinator: QueryCombinator | 'root'
}

export interface Query {
  steps: QueryStep[]
}

export interface QueryMatch {
  node: RedNode
  /** How well this node matches (reserved for ranking; 1 today). */
  score: number
  /** Human-readable descriptions of the compound parts that matched. */
  matchedSelectors: string[]
}

// ─── Query Builder ─────────────────────────────────────────────

/**
 * Parse a selector string into a query.
 *
 * The parser is forgiving by design: an unbalanced bracket, a trailing
 * combinator or an empty compound is skipped rather than thrown, because a
 * query often comes from user input. A selector that produced no steps yields
 * an empty query and therefore no matches.
 */
export function query(selector: string): Query {
  const tokens = tokenize(selector)
  const steps: QueryStep[] = []
  let pending: QueryCombinator | null = null
  let first = true

  for (const token of tokens) {
    if (token.kind === 'combinator') {
      pending = token.combinator
      continue
    }
    const selectors = parseCompound(token.text)
    if (selectors.length === 0) continue
    steps.push({
      selector: selectors,
      combinator: first ? 'root' : (pending ?? 'descendant'),
    })
    first = false
    pending = null
  }
  return { steps }
}

// ─── Tokenizer ────────────────────────────────────────────────

type Token =
  | { kind: 'compound'; text: string }
  | { kind: 'combinator'; combinator: QueryCombinator }

/**
 * Split a selector into compounds and combinators.
 *
 * Spaces inside `[...]` belong to the compound (`[box=My Title]`), and spaces
 * inside `:has(...)` parentheses belong to the pseudo-class, so the scanner
 * tracks both depths. `>`/`+`/`~` are combinators only at depth zero, which is
 * what lets an attribute value contain them (`[url=https://x]`).
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let buffer = ''
  let bracket = 0
  let paren = 0
  let quote: '"' | "'" | null = null
  let sawSpace = false

  const flushSpace = (): void => {
    if (sawSpace && buffer.length > 0) {
      tokens.push({ kind: 'compound', text: buffer })
      buffer = ''
    }
    sawSpace = false
  }
  const flushCompound = (): void => {
    if (buffer.length > 0) {
      tokens.push({ kind: 'compound', text: buffer })
      buffer = ''
    }
    sawSpace = false
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quote !== null) {
      buffer += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === '[') bracket++
    else if (ch === ']' && bracket > 0) bracket--
    else if (ch === '(') paren++
    else if (ch === ')' && paren > 0) paren--

    const atTop = bracket === 0 && paren === 0
    if (atTop && (ch === '>' || ch === '+' || ch === '~')) {
      flushCompound()
      tokens.push({
        kind: 'combinator',
        combinator: ch === '>' ? 'child' : ch === '+' ? 'adjacent' : 'sibling',
      })
      continue
    }
    if (atTop && /\s/.test(ch)) {
      sawSpace = true
      flushSpace()
      continue
    }
    if (sawSpace) {
      // Whitespace ended a compound, so this character starts a new one.
      if (buffer.length > 0) tokens.push({ kind: 'compound', text: buffer })
      buffer = ''
      sawSpace = false
    }
    buffer += ch
  }
  flushCompound()
  return tokens
}

// ─── Compound Parser ──────────────────────────────────────────

/**
 * Parse one compound (`tag[attr=value]:pseudo`).
 *
 * Bracket rules, in order:
 *  - the first bracket with no tag in front is the TAG (`[color]`);
 *  - a later bracket is a CSS attribute (`url[href=…]`);
 *  - `=` inside a tag bracket becomes an `attribute_value` selector, which
 *    compares the node's raw BBCode attribute — the form authors actually
 *    write.
 */
function parseCompound(part: string): QuerySelector[] {
  const selectors: QuerySelector[] = []
  let i = 0

  // Leading tag or `*`.
  if (part[i] === '*') {
    selectors.push({ type: 'tag', tag: '*' })
    i++
  } else {
    const match = /^[a-zA-Z_][a-zA-Z0-9_-]*/.exec(part)
    if (match) {
      selectors.push({ type: 'tag', tag: match[0] })
      i = match[0].length
    }
  }

  let sawTagBracket = false
  while (i < part.length) {
    const ch = part[i]

    if (ch === '[') {
      const close = findClosing(part, i, '[', ']')
      const inner = close === -1 ? part.slice(i + 1) : part.slice(i + 1, close)
      i = close === -1 ? part.length : close + 1

      const eq = inner.indexOf('=')
      const name = (eq === -1 ? inner : inner.slice(0, eq)).trim()
      const rawValue = eq === -1 ? undefined : unquote(inner.slice(eq + 1).trim())

      if (name === '') continue

      if (!sawTagBracket && !selectors.some(s => s.type === 'tag')) {
        // `[color]` / `[color=red]` — a BBCode tag selector.
        selectors.push({ type: 'tag', tag: name })
        if (rawValue !== undefined) selectors.push({ type: 'attribute_value', value: rawValue })
        sawTagBracket = true
      } else if (rawValue === undefined) {
        selectors.push({ type: 'has_attribute', name })
      } else {
        selectors.push({ type: 'attribute', name, value: rawValue })
      }
      continue
    }

    if (ch === ':') {
      const rest = part.slice(i + 1)
      const nth = /^nth-child\(\s*(\d+)\s*\)/.exec(rest)
      if (nth) {
        selectors.push({ type: 'nth_child', n: parseInt(nth[1], 10) })
        i += 1 + nth[0].length
        continue
      }
      if (rest.startsWith('first-child')) {
        selectors.push({ type: 'first_child' })
        i += 1 + 'first-child'.length
        continue
      }
      if (rest.startsWith('last-child')) {
        selectors.push({ type: 'last_child' })
        i += 1 + 'last-child'.length
        continue
      }
      // Unknown pseudo-class: skip its name (and arguments, if any).
      const nameMatch = /^[a-zA-Z-]+(?:\([^)]*\))?/.exec(rest)
      i += 1 + (nameMatch ? nameMatch[0].length : 0)
      continue
    }

    i++
  }

  return selectors
}

/** Index of the matching closer, or -1. Handles nested pairs and quotes. */
function findClosing(input: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = openIndex; i < input.length; i++) {
    const ch = input[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

// ─── Query Result ─────────────────────────────────────────────

export interface QueryResult {
  matches: QueryMatch[]
  total: number
  time: number
}
