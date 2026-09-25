/**
 * Anchors, layer 3: the persisted form, and finding it again in a text that
 * may have changed since it was saved.
 *
 * A selector is the W3C Web Annotation pair of a `TextPositionSelector`
 * (`start`, `end`) and a `TextQuoteSelector` (`exact`, with `prefix` and
 * `suffix` context). The position finds the anchor when nothing changed; the
 * quote and its context find it after the text moved, and tell two identical
 * snippets apart. When neither is convincing the anchor is reported as an
 * orphan — never guessed. See docs/11-Anchors-Plan.md.
 */

import type { Anchor, AnchorSet, Stickiness } from './AnchorSet'

export interface AnchorSelector {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
  readonly stickiness: Stickiness
}

/** Characters of context kept on each side. */
export const SELECTOR_CONTEXT = 32

export function toSelector(anchor: Anchor, text: string, context = SELECTOR_CONTEXT): AnchorSelector {
  return {
    id: anchor.id,
    start: anchor.start,
    end: anchor.end,
    exact: text.slice(anchor.start, anchor.end),
    prefix: text.slice(Math.max(0, anchor.start - context), anchor.start),
    suffix: text.slice(anchor.end, anchor.end + context),
    stickiness: anchor.stickiness,
  }
}

export type Reanchored =
  /** The saved position still holds the quote with its context: nothing moved. */
  | { kind: 'exact'; start: number; end: number }
  /**
   * Found elsewhere by the quote and its context. `ambiguous`: another
   * occurrence was plausible too (a twin — osu! userpages repeat sections),
   * and the best-ranked one was taken. Twins cannot always be told apart
   * without the edit history: when an edit damaged the true one's context, a
   * far twin can look MORE like what was saved. A caller that must not guess
   * (a comment) can say so; an unflagged `moved` had no rival.
   */
  | { kind: 'moved'; start: number; end: number; score: number; ambiguous: boolean }
  /** Not found convincingly. */
  | { kind: 'orphan' }

/** How much context must still surround a candidate, from 0 to 1. */
export const MIN_CONTEXT_SCORE = 0.5
/** Occurrences of the quote examined at most (a very common snippet). */
const MAX_CANDIDATES = 2000

/** Length of the common suffix of `a` and `b`. */
function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++
  return n
}

/** Length of the common prefix of `a` and `b`. */
function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a.charCodeAt(n) === b.charCodeAt(n)) n++
  return n
}

/**
 * How much of the saved context surrounds `exact` at `at`, from 0 to 1: each
 * side on its own, then averaged, so an intact suffix still counts when an
 * edit destroyed the prefix. A side saved empty (the anchor was at an end of
 * the text) does not count.
 */
function contextScore(selector: AnchorSelector, text: string, at: number): number {
  const { prefix, suffix } = selector
  if (prefix.length === 0 && suffix.length === 0) return 1
  const before = text.slice(Math.max(0, at - prefix.length), at)
  const end = at + selector.exact.length
  const after = text.slice(end, end + suffix.length)
  let sum = 0
  let sides = 0
  if (prefix.length > 0) { sum += commonSuffix(before, prefix) / prefix.length; sides++ }
  if (suffix.length > 0) { sum += commonPrefix(after, suffix) / suffix.length; sides++ }
  return sum / sides
}

/**
 * The distance from the saved position at which a candidate has lost half of
 * the most it can lose ({@link DISTANCE_WEIGHT}). The penalty `d / (d + scale)`
 * never flattens out, so between two equally good candidates the nearer one
 * always wins, however far both moved.
 */
export const DISTANCE_SCALE = 4096
/** The most a candidate can lose for being far from the saved position. */
export const DISTANCE_WEIGHT = 0.5

/**
 * Where `selector` is in `text` now.
 *
 * 1. The saved position still holds the quote, with its context → `exact`.
 * 2. Otherwise every occurrence of the quote that keeps at least
 *    {@link MIN_CONTEXT_SCORE} of its context is a candidate, ranked by that
 *    score minus a penalty for its distance from the saved position → `moved`.
 * 3. No candidate → `orphan`.
 *
 * The distance penalty is not a detail. osu! userpages repeat sections, so a
 * quote often has twins with the very same context; when an edit damaged the
 * true one's context, a twin far away scored higher on context alone
 * (measured on the 547 KB fixture). The saved position is evidence too.
 */
export function fromSelector(selector: AnchorSelector, text: string): Reanchored {
  const { exact } = selector
  if (exact.length === 0) return { kind: 'orphan' }
  if (text.startsWith(exact, selector.start) && contextScore(selector, text, selector.start) >= MIN_CONTEXT_SCORE) {
    return { kind: 'exact', start: selector.start, end: selector.start + exact.length }
  }
  let best = -1
  let bestScore = 0
  let bestRank = -Infinity
  let plausible = 0
  let seen = 0
  for (let at = text.indexOf(exact); at !== -1 && seen < MAX_CANDIDATES; at = text.indexOf(exact, at + 1)) {
    seen++
    const score = contextScore(selector, text, at)
    if (score < MIN_CONTEXT_SCORE) continue
    plausible++
    const distance = Math.abs(at - selector.start)
    const rank = score - DISTANCE_WEIGHT * (distance / (distance + DISTANCE_SCALE))
    if (rank > bestRank) {
      best = at
      bestScore = score
      bestRank = rank
    }
  }
  if (best === -1) return { kind: 'orphan' }
  return { kind: 'moved', start: best, end: best + exact.length, score: bestScore, ambiguous: plausible > 1 }
}

/**
 * Re-anchors saved selectors into `set` (whose text is the current one),
 * keeping their ids. Returns the ones that could not be placed.
 */
export function restoreAnchors(set: AnchorSet, selectors: readonly AnchorSelector[]): AnchorSelector[] {
  const orphans: AnchorSelector[] = []
  for (const selector of selectors) {
    const found = fromSelector(selector, set.text)
    if (found.kind === 'orphan' || set.get(selector.id)) {
      orphans.push(selector)
      continue
    }
    set.add(found.start, found.end, { id: selector.id, stickiness: selector.stickiness })
  }
  return orphans
}
