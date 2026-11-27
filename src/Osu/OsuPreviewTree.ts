/**
 * DocumentEngine — OsuPreviewTree
 *
 * The red tree the "Render what osu! actually shows" preview paints, kept
 * across successive full parses so an unchanged block keeps its identity.
 *
 * Why this exists: osu! pairing is document-global (lazy per tag family, block
 * tags closed by div count — see `osuPairing.ts`), so the osu tree cannot be
 * reparsed incrementally and is rebuilt from the whole source on every change.
 * Built as a fresh `BBCodeDocumentModel`, every node of that tree got a NEW id
 * from the global counter, so `BlockPatcher` matched no block and rewrote the
 * whole document: measured on the 547 KB fixture in Chromium, 157 ms of patch
 * plus 168 ms of forced layout per rebuild, on top of the 95 ms parse.
 *
 * What it does instead: the parse is still full (same lexer, same parser, same
 * options as a `BBCodeDocumentModel` built with `pairing: 'osu'`), but the red
 * tree is built with `greenToRedNodeReusing` in `structural` mode against the
 * previous one: every subtree whose green is EQUAL to the previous parse's is
 * the previous RedNode object — id, metadata and all — moved to its new offset
 * with the lazy shift. Only the blocks the edit really changed are new. That is
 * the shape `BlockPatcher`'s windowed reconcile expects (churn = the blocks
 * that are not reference-identical), so the attached change range
 * (`__changeRange`, the span between the blocks kept at both ends — see
 * `churnedSpan`) lets it patch O(edit) instead of O(document).
 *
 * The tree is equal to a full osu parse: the green is one, and the red is a
 * function of the green plus offsets (see `greenToRedNodeReusing`). Only ids
 * differ, which are never portable across parses anyway.
 *
 * Deliberately NOT done: interning greens across parses with a pool.
 * `'full'` interning would make unchanged blocks reference-equal, but it costs
 * more than the whole-tree equality walk it replaces (measured, see the design
 * note), and the pool would need a bound. The equality walk keeps nothing
 * beyond the previous tree, which the preview holds anyway.
 *
 * ⚠ Like the incremental parser's red reuse, `update` CONSUMES the previous
 * root: adopted subtrees are reparented into the new one. Hold only the root
 * the last `update` returned.
 */

import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { greenToRedNode, greenToRedNodeReusing, type BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { parseTokensToGreen } from '../BBCode/Parser'
import { scanBBCode, type BBCodeToken } from '../Lexer/BBCodeLexer'
import {
  applyOsuPairing,
  applyOsuPairingIncremental,
  type OsuListCarrier,
  type OsuPairingState,
  type OsuTitleEvent,
} from './osuPairing'
import { greenNode, type GreenNode } from '../Syntax/GreenNode'
import { spliceGreen, type SpineStep } from '../Syntax/greenEdit'
import type { RedNode } from '../Syntax/RedNode'
import type { TextChangeRange } from '../Incremental/ChangeTracker'

/**
 * Ancestor kinds whose text content participates in osu! pairing, URL/email
 * validation, or raw-block semantics — a prose edit inside one of these must
 * fall back to a full osu parse.
 */
const UNSAFE_PROSE_ANCESTORS: ReadonlySet<string> = new Set([
  'image', 'audio', 'video', 'url', 'email', 'profile', 'imagemap',
  'code', 'youtube', 'box_title', 'autolink', 'flag', 'osu_icon',
  'divider', 'composition', 'pane', 'error', 'discarded_tag',
])

/** Characters that could open/close tags, cross lines, or form emails/escapes. */
const SYNTAX_CHAR_RE = /[\[\]\r\n@\\<>]/

/**
 * Existing or resulting text that may form/border an autolink or tag — fall
 * back to full parse. Keeping `.`, `:`, `(`, `&`, `/` out of `SYNTAX_CHAR_RE`
 * means normal prose punctuation stays on the O(log N) fast-path while real
 * URLs (`://`, `www.`) and emails (`@`) still get a full osu parse.
 */
const RISKY_LEAF_RE = /:\/\/|www\.|@|\[|\]/i

/**
 * 4 KB SIMD-backed common prefix / suffix diff between two strings.
 * Returns `[start, oldEnd, newEnd]` of the minimal changed span.
 */
function findChangedSpan(oldSource: string, newSource: string): [number, number, number] {
  const oldLen = oldSource.length
  const newLen = newSource.length
  const minLen = Math.min(oldLen, newLen)
  const CHUNK = 4096

  let start = 0
  while (start + CHUNK <= minLen && oldSource.slice(start, start + CHUNK) === newSource.slice(start, start + CHUNK)) {
    start += CHUNK
  }
  while (start < minLen && oldSource.charCodeAt(start) === newSource.charCodeAt(start)) start++

  let suffix = 0
  const maxSuffix = minLen - start
  while (
    suffix + CHUNK <= maxSuffix &&
    oldSource.slice(oldLen - suffix - CHUNK, oldLen - suffix) === newSource.slice(newLen - suffix - CHUNK, newLen - suffix)
  ) {
    suffix += CHUNK
  }
  while (
    suffix < maxSuffix &&
    oldSource.charCodeAt(oldLen - 1 - suffix) === newSource.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++
  }

  return [start, oldLen - suffix, newLen - suffix]
}

/**
 * Additional ancestor kinds that are single-line (non-dotall) in osu! pairing
 * or where inserting a `\n` changes block/paragraph grouping — inserting `\n`
 * inside one of these must fall back to the structural path.
 */
const UNSAFE_NEWLINE_ANCESTORS: ReadonlySet<string> = new Set([
  'document', 'paragraph', 'heading', 'audio', 'profile', 'email', 'url', 'youtube', 'inline_code',
])

/**
 * O(log N) prose + inline-Enter fast-path for `OsuPreviewTree`:
 *
 * 1. Plain prose edit strictly inside a safe `text` leaf (no `[`, `]`,
 *    newlines, or autolink delimiters added/removed, leaf stays non-empty,
 *    and no ancestor validates its text): splice just the 1 leaf in O(depth).
 * 2. Single `\n` insertion strictly inside a safe `text` leaf inside a dotall
 *    container (e.g. `[centre]`, `[box]`, `[color]`, `[size]`, `[b]` — never
 *    at root/paragraph or inside single-line tags): split the 1 `text` leaf
 *    into `[text(before), spacing(1), text(after)]` in O(depth).
 */
function trySpliceProseGreen(
  oldRoot: RedNode,
  oldSource: string,
  newSource: string,
): { green: GreenNode; change: TextChangeRange } | null {
  const oldLen = oldSource.length
  const newLen = newSource.length
  const [start, oldEnd, newEnd] = findChangedSpan(oldSource, newSource)
  const removed = oldSource.slice(start, oldEnd)
  const inserted = newSource.slice(start, newEnd)

  const isSingleNewlineInsert = removed.length === 0 && (inserted === '\n' || inserted === '\r\n')
  if (!isSingleNewlineInsert && (SYNTAX_CHAR_RE.test(removed) || SYNTAX_CHAR_RE.test(inserted))) return null

  // Descend from oldRoot to the unique leaf containing `[start, oldEnd]`.
  // Using `findChildAt` / binary search over child ranges stays O(depth * log N).
  const spine: SpineStep[] = []
  let node: RedNode = oldRoot
  let probe = start
  if (probe > 0 && probe === oldEnd && probe >= oldRoot.range.end) probe = oldRoot.range.end - 1

  while (node.children.length > 0) {
    const kids = node.children
    // Binary search for child whose range contains `probe` (or ends at `probe` for pure insertion at leaf tail).
    let lo = 0
    let hi = kids.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const c = kids[mid]
      if (probe < c.range.start) {
        hi = mid - 1
      } else if (probe > c.range.end || (probe === c.range.end && oldEnd > c.range.end)) {
        lo = mid + 1
      } else if (probe === c.range.end && mid + 1 < kids.length && kids[mid + 1].range.start === probe && oldEnd === probe) {
        // Pure insertion right on the boundary between two siblings: prefer a plain text leaf if present.
        if (c.kind === 'text') { idx = mid; break }
        lo = mid + 1
      } else {
        idx = mid
        break
      }
    }
    if (idx === -1) return null
    const child = kids[idx]
    if (start < child.range.start || oldEnd > child.range.end) return null
    if (UNSAFE_PROSE_ANCESTORS.has(child.kind)) return null
    if (isSingleNewlineInsert && UNSAFE_NEWLINE_ANCESTORS.has(child.kind)) return null
    spine.push({ node: node.green, index: idx })
    node = child
  }

  if (spine.length === 0) return null
  if (node.kind !== 'text') return null
  if (node.green.leadingWidth !== 0 || node.green.trailingWidth !== 0) return null
  if (node.text.length !== node.green.width) return null
  if (start < node.range.start || oldEnd > node.range.end) return null
  if (RISKY_LEAF_RE.test(node.text)) return null

  // Guard adjacent siblings: if the previous or next text sibling holds an
  // unclosed `[` / `]` (e.g. `[` followed by `size=150...`), editing next to
  // it could form or break a BBCode tag.
  const parentStep = spine[spine.length - 1]
  const parentKids = parentStep.node.children
  const leafIdx = parentStep.index
  if (leafIdx > 0 && parentKids[leafIdx - 1].kind === 'text' && RISKY_LEAF_RE.test(parentKids[leafIdx - 1].text)) {
    return null
  }
  if (leafIdx + 1 < parentKids.length && parentKids[leafIdx + 1].kind === 'text' && RISKY_LEAF_RE.test(parentKids[leafIdx + 1].text)) {
    return null
  }

  const relStart = start - node.range.start
  const relEnd = oldEnd - node.range.start

  let green: GreenNode
  if (isSingleNewlineInsert) {
    // Must split strictly inside the text leaf (both halves non-empty) so the
    // new `spacing` cannot touch any adjacent `spacing`/`empty_line` sibling.
    if (relStart === 0 || relEnd === node.text.length) return null
    if (UNSAFE_NEWLINE_ANCESTORS.has(parentStep.node.kind)) return null
    const beforeText = node.text.slice(0, relStart)
    const afterText = node.text.slice(relEnd)
    const beforeNode = greenNode('text', beforeText, [], 0, 0, beforeText.length)
    const nlNode = greenNode('spacing', '', [], 0, 0, inserted.length)
    const afterNode = greenNode('text', afterText, [], 0, 0, afterText.length)
    const newParentKids = new Array<GreenNode>(parentKids.length + 2)
    for (let i = 0; i < leafIdx; i++) newParentKids[i] = parentKids[i]
    newParentKids[leafIdx] = beforeNode
    newParentKids[leafIdx + 1] = nlNode
    newParentKids[leafIdx + 2] = afterNode
    for (let i = leafIdx + 1; i < parentKids.length; i++) newParentKids[i + 2] = parentKids[i]
    const newParent = greenNode(
      parentStep.node.kind,
      parentStep.node.text,
      newParentKids,
      parentStep.node.leadingWidth,
      parentStep.node.trailingWidth,
    )
    green = spine.length === 1 ? newParent : spliceGreen(spine.slice(0, -1), newParent)
  } else {
    const newText = node.text.slice(0, relStart) + inserted + node.text.slice(relEnd)
    if (newText.length === 0) return null
    if (RISKY_LEAF_RE.test(newText)) return null
    const replacement = greenNode('text', newText, [], 0, 0, newText.length)
    green = spliceGreen(spine, replacement)
  }

  // Block-level change span (matching `churnedSpan`) in O(1) from the single
  // touched top-level child so `BlockPatcher` always takes the windowed path.
  const topIdx = spine[0].index
  const oldTop = oldRoot.children[topIdx]
  const topStart = oldTop.range.start
  const topOldEnd = oldTop.range.end
  const delta = newLen - oldLen
  return { green, change: { start: topStart, end: topOldEnd + delta, endOld: topOldEnd } }
}

export interface OsuPreviewTreeOptions {
  dialect?: BBCodeDialect
}

export interface OsuPreviewUpdateStats {
  /** Lexing + parsing to green, ms. */
  parseMs: number
  /** Building (or adopting) the red tree, ms. */
  buildMs: number
  /** Red subtrees carried over from the previous tree. */
  adopted: number
  /** The churned span handed to the patcher, or null for a from-scratch build. */
  change: TextChangeRange | null
}

/**
 * The parse a `BBCodeDocumentModel` does in `rebuild`, without the red build
 * and the id walk around it. A subclass so the lexer/parser options stay the
 * model's own, not a copy that could drift from it.
 */
class OsuGreenParser extends BBCodeDocumentModel {
  constructor(dialect: BBCodeDialect | undefined) {
    super({ dialect, pairing: 'osu', incremental: false, autoAnalyze: false, maxUndo: 0 })
  }

  parse(source: string): GreenNode {
    return this.parseToGreen(source)
  }
}

const CODE_WORD_RE = /code/i

/** Check whether a raw token array contains `[code]`/`[/code]` or unmatched `[` text tokens. */
function analyzeRawTokens(tokens: readonly BBCodeToken[]): { hasCode: boolean; hasUnmatchedBracket: boolean } {
  let hasCode = false
  let hasUnmatchedBracket = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if ((t.kind === 'open' || t.kind === 'close') && t.tag === 'code') {
      hasCode = true
    } else if (t.kind === 'text' && t.value.includes('[')) {
      hasUnmatchedBracket = true
    }
    if (hasCode && hasUnmatchedBracket) break
  }
  return { hasCode, hasUnmatchedBracket }
}

/**
 * Binary-search the first token whose `end > byteOffset` (or `tokens.length`).
 */
function findFirstTokenAfter(tokens: readonly BBCodeToken[], byteOffset: number): number {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (tokens[mid].end <= byteOffset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Binary-search the first token whose `start >= byteOffset` (or `tokens.length`).
 */
function findTokenAtStart(tokens: readonly BBCodeToken[], byteOffset: number): number {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (tokens[mid].start < byteOffset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** True when `[` and `]` are strictly balanced inside `s` (depth never < 0 and ends at 0). */
function hasBalancedBrackets(s: string): boolean {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 91 /* [ */) depth++
    else if (c === 93 /* ] */) {
      if (--depth < 0) return false
    }
  }
  return depth === 0
}

const BODY_SENSITIVE_LINE_TAGS: ReadonlySet<string> = new Set([
  'url', 'email', 'profile', 'youtube', 'heading', 'audio', 'img', 'imagemap',
])

interface RawTokenSpliceResult {
  tokens: BBCodeToken[]
  hasCode: boolean
  tokStart: number
  tokEnd: number
  midLen: number
  deltaByte: number
  dirtyTags: Set<string>
  newlineChanged: boolean
}

/**
 * Incremental line-window lexer splice for `OsuPreviewTree`.
 *
 * BBCode lexing is strictly local across top-level newline boundaries whenever
 * neither the document nor the edited window has raw `[code]` blocks and both
 * old and new edited windows have balanced `[`/`]` brackets (so no earlier
 * unmatched `[` can change its match and no `[` in the window can escape it).
 */
function trySpliceRawTokens(
  oldTokens: BBCodeToken[],
  oldSource: string,
  newSource: string,
  hasCode: boolean,
): RawTokenSpliceResult | null {
  if (hasCode || oldTokens.length === 0) return null

  const [start, oldEnd] = findChangedSpan(oldSource, newSource)
  const delta = newSource.length - oldSource.length

  // Locate token span covering [start, oldEnd] and expand to top-level newline boundaries.
  let tokStart = findFirstTokenAfter(oldTokens, start)
  if (tokStart > 0 && oldTokens[tokStart - 1].end === start) {
    // Pure insertion right at a token boundary: include the preceding token if not a newline.
    if (oldTokens[tokStart - 1].kind !== 'newline') tokStart--
  }
  while (tokStart > 0 && oldTokens[tokStart - 1].kind !== 'newline') tokStart--
  // Guard against `\r` + inserted `\n` merging into a single `\r\n` token across boundary.
  const prevTok = tokStart > 0 ? oldTokens[tokStart - 1] : null
  if (prevTok !== null && prevTok.kind === 'newline' && prevTok.value === '\r') {
    tokStart--
    while (tokStart > 0 && oldTokens[tokStart - 1].kind !== 'newline') tokStart--
  }

  let tokEnd = findTokenAtStart(oldTokens, oldEnd)
  while (tokEnd < oldTokens.length && oldTokens[tokEnd].kind !== 'newline') tokEnd++

  const winStart = tokStart < oldTokens.length ? oldTokens[tokStart].start : oldSource.length
  const winOldEnd = tokEnd < oldTokens.length ? oldTokens[tokEnd].start : oldSource.length
  const winNewEnd = winOldEnd + delta
  if (winNewEnd < winStart) return null

  // If the edited window covers more than half the document, a full lex is cleaner.
  if (winNewEnd - winStart > (newSource.length >>> 1) && newSource.length > 4096) return null

  const oldWin = oldSource.slice(winStart, winOldEnd)
  const newWin = newSource.slice(winStart, winNewEnd)
  if (CODE_WORD_RE.test(newWin)) return null
  if (!hasBalancedBrackets(oldWin) || !hasBalancedBrackets(newWin)) return null

  const midTokens = scanBBCode(newWin, { pairing: 'osu' })
  let midHasCode = false
  for (let i = 0; i < midTokens.length; i++) {
    const t = midTokens[i]
    t.start += winStart
    t.end += winStart
    if ((t.kind === 'open' || t.kind === 'close') && t.tag === 'code') midHasCode = true
  }

  // Narrow the diff within the line window so untouched wrapper tags on the
  // same line (e.g. `[color=#...]` around a newly typed `[b]`) are NOT marked
  // dirty and don't force re-scanning 20k `[color]` tokens.
  const oldSliceLen = tokEnd - tokStart
  const midLen = midTokens.length
  const minSlice = Math.min(oldSliceLen, midLen)
  let lineHead = 0
  while (lineHead < minSlice && sameTokenRelative(oldTokens[tokStart + lineHead], midTokens[lineHead])) {
    lineHead++
  }
  let lineTail = 0
  const maxLineTail = minSlice - lineHead
  while (
    lineTail < maxLineTail &&
    sameTokenRelative(oldTokens[tokEnd - 1 - lineTail], midTokens[midLen - 1 - lineTail])
  ) {
    lineTail++
  }

  const dirtyTags = new Set<string>()
  let newlineChanged = false
  for (let i = tokStart + lineHead; i < tokEnd - lineTail; i++) {
    const t = oldTokens[i]
    if (t.kind === 'open' || t.kind === 'close') dirtyTags.add(t.tag)
    else if (t.kind === 'newline') newlineChanged = true
  }
  for (let i = lineHead; i < midLen - lineTail; i++) {
    const t = midTokens[i]
    if (t.kind === 'open' || t.kind === 'close') dirtyTags.add(t.tag)
    else if (t.kind === 'newline') newlineChanged = true
  }
  // If any body-sensitive single-line tag (url/email/profile/youtube/img) wraps
  // the edited text on the same line, mark it dirty so its content check re-runs.
  for (let i = tokStart; i < tokStart + lineHead; i++) {
    const t = oldTokens[i]
    if ((t.kind === 'open' || t.kind === 'close') && BODY_SENSITIVE_LINE_TAGS.has(t.tag)) dirtyTags.add(t.tag)
  }
  for (let i = tokEnd - lineTail; i < tokEnd; i++) {
    const t = oldTokens[i]
    if ((t.kind === 'open' || t.kind === 'close') && BODY_SENSITIVE_LINE_TAGS.has(t.tag)) dirtyTags.add(t.tag)
  }

  // Narrow the splice range by the unchanged prefix/suffix tokens on the edited
  // line so untouched wrapper tags (e.g. `[color=#...]` around a newly typed
  // `[b]`) keep their existing `forced` bits AND aren't marked dirty.
  const effTokStart = tokStart + lineHead
  const effTokEnd = tokEnd - lineTail
  const effMidStart = lineHead
  const effMidLen = midLen - lineHead - lineTail

  const suffixCount = oldTokens.length - effTokEnd
  const next = new Array<BBCodeToken>(effTokStart + effMidLen + suffixCount)
  for (let i = 0; i < effTokStart; i++) next[i] = oldTokens[i]
  for (let i = 0; i < effMidLen; i++) next[effTokStart + i] = midTokens[effMidStart + i]
  const outBase = effTokStart + effMidLen
  if (delta === 0) {
    for (let i = 0; i < suffixCount; i++) next[outBase + i] = oldTokens[effTokEnd + i]
  } else {
    for (let i = 0; i < suffixCount; i++) {
      const t = oldTokens[effTokEnd + i]
      t.start += delta
      t.end += delta
      next[outBase + i] = t
    }
  }

  return {
    tokens: next,
    hasCode: midHasCode,
    tokStart: effTokStart,
    tokEnd: effTokEnd,
    midLen: effMidLen,
    deltaByte: delta,
    dirtyTags,
    newlineChanged,
  }
}

/** True when two tokens have identical kind, length, and payload (ignoring absolute offset). */
function sameTokenRelative(a: BBCodeToken, b: BBCodeToken): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || (a.end - a.start) !== (b.end - b.start)) return false
  switch (a.kind) {
    case 'open':
      return a.tag === (b as typeof a).tag && a.attrs === (b as typeof a).attrs
    case 'close':
      return a.tag === (b as typeof a).tag
    case 'text':
    case 'newline':
      return a.value === (b as typeof a).value
  }
}

/**
 * A top-level child is a safe incremental boundary ONLY if it is a self-closed
 * block (explicit closing delimiter `trailingWidth > 0`, so nothing after it
 * could have caused it to close or merge) or a standalone `discarded_tag`.
 * Paragraphs, spacing/empty_line runs, `list_item`, and auto-closed blocks all
 * have `trailingWidth === 0` and are excluded from boundaries.
 */
function isSafeBlockBoundary(node: RedNode): boolean {
  return node.green.trailingWidth > 0 || node.kind === 'discarded_tag'
}

function sameAutoClosed(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const aLen = a?.length ?? 0
  const bLen = b?.length ?? 0
  if (aLen !== bLen) return false
  if (aLen === 0) return true
  if (a === b) return true
  for (let i = 0; i < aLen; i++) {
    if (!b!.includes(a![i])) return false
  }
  return true
}

/**
 * Block-level GreenNode reuse after `applyOsuPairing`.
 *
 * Even when a structural edit forces a global `applyOsuPairing` pass, usually
 * only 1–2 top-level blocks have changed paired tokens. Reusing the exact old
 * `GreenNode` references for every untouched prefix & suffix top-level block
 * lets `parseTokensToGreen` parse only the changed slice AND lets
 * `greenToRedNodeReusing` adopt 99% of the RedNode tree by reference (`===`)
 * with zero `greenSubtreeEquals` traversal.
 */
function tryIncrementalGreenFromPaired(
  oldRoot: RedNode,
  oldPaired: readonly BBCodeToken[],
  newPaired: readonly BBCodeToken[],
  oldSourceLen: number,
  newSource: string,
  dialect: BBCodeDialect | undefined,
  prevAutoClosedByEnd: ReadonlyMap<number, readonly string[]> | null,
  knownChangedTokSpan?: readonly [number, number] | null,
): { green: GreenNode; autoClosedByEnd: Map<number, readonly string[]> } | null {
  const oldLen = oldPaired.length
  const newLen = newPaired.length

  // 1. Exact byte spans of unchanged prefix & suffix: O(1) when incremental
  //    pairing already tracked `[minChangedTok, maxChangedTok)`, else linear scan.
  let diffStart: number
  let suffixByteWidth: number
  if (knownChangedTokSpan != null) {
    const [minTok, maxTok] = knownChangedTokSpan
    diffStart = minTok < newLen ? newPaired[minTok].start : newSource.length
    suffixByteWidth = maxTok < newLen ? newSource.length - newPaired[maxTok].start : 0
  } else {
    const minTok = Math.min(oldLen, newLen)
    let tokHead = 0
    while (tokHead < minTok && sameTokenRelative(oldPaired[tokHead], newPaired[tokHead])) tokHead++

    let tokTail = 0
    const maxTail = minTok - tokHead
    while (
      tokTail < maxTail &&
      sameTokenRelative(oldPaired[oldLen - 1 - tokTail], newPaired[newLen - 1 - tokTail])
    ) {
      tokTail++
    }
    diffStart = tokHead < newLen ? newPaired[tokHead].start : newSource.length
    suffixByteWidth = tokTail > 0 ? newSource.length - newPaired[newLen - tokTail].start : 0
  }

  // 2. Select untouched top-level blocks from `oldRoot.children`.
  const oldKids = oldRoot.children
  const kidCount = oldKids.length
  if (kidCount < 3) return null

  let keepHead = 0
  let prefixByteEnd = 0
  while (keepHead < kidCount && prefixByteEnd + oldKids[keepHead].green.width <= diffStart) {
    prefixByteEnd += oldKids[keepHead].green.width
    keepHead++
  }
  // Never end the kept prefix on a non-self-closed node (paragraph, spacing,
  // empty_line, list_item, or auto-closed block).
  while (keepHead > 0 && !isSafeBlockBoundary(oldKids[keepHead - 1])) {
    keepHead--
    prefixByteEnd -= oldKids[keepHead].green.width
  }

  let keepTail = 0
  let suffixKeepWidth = 0
  while (
    keepHead + keepTail < kidCount &&
    suffixKeepWidth + oldKids[kidCount - 1 - keepTail].green.width <= suffixByteWidth
  ) {
    suffixKeepWidth += oldKids[kidCount - 1 - keepTail].green.width
    keepTail++
  }
  // For suffix boundaries, also exclude `discarded_tag` (which depends on
  // `autoClosed` populated by the immediately preceding block).
  while (keepTail > 0 && oldKids[kidCount - keepTail].green.trailingWidth === 0) {
    suffixKeepWidth -= oldKids[kidCount - keepTail].green.width
    keepTail--
  }

  if (keepHead === 0 && keepTail === 0) return null

  // 3. Map kept byte boundaries to exact token slice `[midTokStart, midTokEnd)`.
  const midByteStart = prefixByteEnd
  const midByteEnd = newSource.length - suffixKeepWidth
  if (midByteEnd < midByteStart) return null

  const midTokStart = midByteStart === 0 ? 0 : findTokenAtStart(newPaired, midByteStart)
  const midTokEnd = midByteEnd === newSource.length ? newLen : findTokenAtStart(newPaired, midByteEnd)

  // Verify exact byte alignment (no token straddles the kept block boundary).
  const actualStart = midTokStart < newLen ? newPaired[midTokStart].start : newSource.length
  const actualEnd = midTokEnd > 0 ? newPaired[midTokEnd - 1].end : 0
  if (midTokStart < midTokEnd && (actualStart !== midByteStart || actualEnd !== midByteEnd)) return null
  if (midTokStart === midTokEnd && midByteStart !== midByteEnd) return null

  // Exact `autoClosed` state entering the middle slice (at `midByteStart`) and
  // expected leaving the middle slice (at old `midByteEnd - delta`, before suffix).
  const delta = newSource.length - oldSourceLen
  const initialAutoClosed = keepHead > 0 ? prevAutoClosedByEnd?.get(midByteStart) : undefined
  const expectedExitAutoClosed = keepTail > 0 ? prevAutoClosedByEnd?.get(midByteEnd - delta) : undefined

  // 4. Parse ONLY the changed middle slice with full `'osu'` tree semantics.
  let midChildren: readonly GreenNode[] = []
  const midAutoClosedMap = new Map<number, readonly string[]>()
  let actualExitAutoClosed: readonly string[] | null = initialAutoClosed ?? null

  if (midTokStart < midTokEnd) {
    const parseStateOut: {
      stackDepthAtEnd: number
      endAutoClosed: readonly string[] | null
      autoClosedAtRootEnd: Map<number, readonly string[]>
    } = {
      stackDepthAtEnd: 0,
      endAutoClosed: null,
      autoClosedAtRootEnd: midAutoClosedMap,
    }
    const midGreen = parseTokensToGreen(newPaired.slice(midTokStart, midTokEnd), newSource, {
      dialect,
      pairing: 'osu',
      osuPrePaired: {},
      initialAutoClosed,
      parseStateOut,
    })
    // An unclosed tag at the end of the middle slice would swallow suffix blocks;
    // bail out to a full parse in that case.
    if (parseStateOut.stackDepthAtEnd > 0) return null
    if (midGreen.width !== midByteEnd - midByteStart) return null
    midChildren = midGreen.children
    actualExitAutoClosed = parseStateOut.endAutoClosed
  }

  // If suffix blocks are kept, the `autoClosed` state leaving the middle slice
  // MUST match what the suffix blocks originally saw.
  if (keepTail > 0 && !sameAutoClosed(actualExitAutoClosed, expectedExitAutoClosed)) return null

  // 5. Merge `autoClosedByEnd` map for the next edit (usually 0–5 entries).
  const nextAutoClosedByEnd = new Map<number, readonly string[]>()
  if (prevAutoClosedByEnd && prevAutoClosedByEnd.size > 0) {
    const oldSuffixStart = midByteEnd - delta
    for (const [endByte, snap] of prevAutoClosedByEnd) {
      if (endByte <= midByteStart) {
        nextAutoClosedByEnd.set(endByte, snap)
      } else if (endByte > oldSuffixStart) {
        nextAutoClosedByEnd.set(endByte + delta, snap)
      }
    }
  }
  for (const [endByte, snap] of midAutoClosedMap) {
    nextAutoClosedByEnd.set(endByte, snap)
  }

  // 6. Stitch untouched prefix/suffix GreenNode references around the reparsed middle.
  const outChildren = new Array<GreenNode>(keepHead + midChildren.length + keepTail)
  for (let i = 0; i < keepHead; i++) outChildren[i] = oldKids[i].green
  for (let i = 0; i < midChildren.length; i++) outChildren[keepHead + i] = midChildren[i]
  const tailOutBase = keepHead + midChildren.length
  const tailOldBase = kidCount - keepTail
  for (let i = 0; i < keepTail; i++) outChildren[tailOutBase + i] = oldKids[tailOldBase + i].green

  return { green: greenNode('document', '', outChildren), autoClosedByEnd: nextAutoClosedByEnd }
}

export class OsuPreviewTree {
  private readonly parser: OsuGreenParser
  private readonly _dialect: BBCodeDialect | undefined
  private _source: string | null = null
  private _root: RedNode | null = null
  /** Cached raw (pre-pairing) tokens and the exact source they came from. */
  private _rawTokens: BBCodeToken[] | null = null
  private _rawTokensSource: string | null = null
  private _hasCodeToken = false
  /** Cached paired tokens and parse invariants for block-level green reuse. */
  private _pairedTokens: BBCodeToken[] | null = null
  private _pairedTokensSource: string | null = null
  private _pairingState: OsuPairingState | null = null
  private _hadSpecialOsuEvents = false
  private _autoClosedByEnd: Map<number, readonly string[]> | null = null
  /** Staged fast-path splice from `canFastUpdate(source)` so `update(source)` reuses it with zero duplicate work. */
  private _stagedFast: {
    source: string
    fast: { green: GreenNode; change: TextChangeRange }
    parseMs: number
  } | null = null
  /** What the last `update` that did work cost; for benches and diagnostics. */
  lastStats: OsuPreviewUpdateStats | null = null

  constructor(options: OsuPreviewTreeOptions = {}) {
    this._dialect = options.dialect
    this.parser = new OsuGreenParser(options.dialect)
  }

  get root(): RedNode | null {
    return this._root
  }

  get source(): string | null {
    return this._source
  }

  /**
   * Cheaply tests whether updating to `source` can take the O(log N) prose
   * fast-path, staging the spliced green tree so an immediate `update(source)`
   * consumes it without repeating the diff. Lets callers break out of a
   * post-structural-edit debounce on the very first prose keystroke.
   */
  canFastUpdate(source: string): boolean {
    if (this._root === null || this._source === null) return false
    if (source === this._source) return true
    if (this._stagedFast && this._stagedFast.source === source) return true
    const t0 = performance.now()
    const fast = trySpliceProseGreen(this._root, this._source, source)
    if (fast === null) {
      this._stagedFast = null
      return false
    }
    this._stagedFast = { source, fast, parseMs: performance.now() - t0 }
    return true
  }

  /**
   * The osu tree of `source`. Same source as last time → the same root, so a
   * caller may ask twice (React's double render) without consuming anything.
   */
  update(source: string): RedNode {
    if (this._root !== null && source === this._source) return this._root

    const old = this._root
    const oldSource = this._source
    const staged = this._stagedFast && this._stagedFast.source === source ? this._stagedFast : null
    this._stagedFast = null

    const t0 = performance.now()

    // Fast path: pure prose edit strictly inside a safe text leaf.
    // O(depth * log N) instead of a full document lex + osuPairing + parse.
    if (old !== null && oldSource !== null) {
      const fast = staged ? staged.fast : trySpliceProseGreen(old, oldSource, source)
      if (fast !== null) {
        const parseMs = staged ? staged.parseMs : performance.now() - t0
        const t1 = performance.now()
        const reuse = { adopted: 0 }
        try {
          const root = greenToRedNodeReusing(fast.green, old, 0, reuse, false)
          ;(root as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange = fast.change
          const t2 = performance.now()
          this._root = root
          this._source = source
          this.lastStats = { parseMs, buildMs: t2 - t1, adopted: reuse.adopted, change: fast.change }
          return root
        } catch {
          // If anything unexpected happens during adoption, drop the old tree
          // and fall through to a clean full parse below.
          this.dispose()
        }
      }
    }

    // Structural path:
    // 1. Lex incrementally via line-window token splicing when safe, else full scan.
    let rawTokens: BBCodeToken[]
    let hasCode: boolean
    const spliced =
      this._rawTokens !== null && this._rawTokensSource !== null
        ? trySpliceRawTokens(
            this._rawTokens,
            this._rawTokensSource,
            source,
            this._hasCodeToken,
          )
        : null

    if (spliced !== null) {
      rawTokens = spliced.tokens
      hasCode = spliced.hasCode
    } else {
      rawTokens = scanBBCode(source, { pairing: 'osu' })
      hasCode = analyzeRawTokens(rawTokens).hasCode
    }

    // 2. Run osu! pairing — tag-family-incremental when `spliced` succeeded and
    //    no cross-family/imagemap/global tag was touched, else full global pass.
    let pairedTokens: BBCodeToken[]
    let pairingState: OsuPairingState
    let hasSpecialEvents = false
    let titleEvents: Map<number, OsuTitleEvent[]> | undefined
    let listCarriers: Map<number, OsuListCarrier> | undefined
    let listHeadItems: Map<number, OsuListCarrier> | undefined

    const incPaired =
      spliced !== null &&
      this._pairedTokens !== null &&
      this._pairingState !== null &&
      this._pairedTokensSource === this._rawTokensSource &&
      !this._hadSpecialOsuEvents
        ? applyOsuPairingIncremental(
            rawTokens,
            source,
            this._pairedTokens,
            this._pairingState,
            spliced.tokStart,
            spliced.tokEnd,
            spliced.midLen,
            spliced.deltaByte,
            spliced.dirtyTags,
            spliced.newlineChanged,
          )
        : null

    let knownChangedTokSpan: [number, number] | null = null
    if (incPaired !== null) {
      pairedTokens = incPaired.paired
      pairingState = incPaired.state
      knownChangedTokSpan = [incPaired.minChangedTok, incPaired.maxChangedTok]
    } else {
      titleEvents = new Map<number, OsuTitleEvent[]>()
      listCarriers = new Map<number, OsuListCarrier>()
      listHeadItems = new Map<number, OsuListCarrier>()
      pairingState = {
        forced: new Uint8Array(0),
        collapsed: new Uint8Array(0),
        caseOk: new Uint8Array(0),
        tagCodes: new Uint8Array(0),
        consumedCloseScratch: new Uint8Array(0),
        imagemapRanges: [],
        imgRanges: [],
        hasTitleTags: false,
      }
      pairedTokens = applyOsuPairing(rawTokens, source, {
        titleEvents,
        listCarriers,
        listHeadItems,
        stateOut: pairingState,
      })
      hasSpecialEvents = titleEvents.size > 0 || listCarriers.size > 0 || listHeadItems.size > 0
    }

    // 3. Build green tree — reusing untouched top-level block GreenNodes by
    //    reference when paired tokens only changed in a local span.
    const prev = this._root
    let green: GreenNode
    let usedRefReuse = false
    let autoClosedByEnd: Map<number, readonly string[]> | null = null

    const inc =
      prev !== null &&
      oldSource !== null &&
      this._pairedTokens !== null &&
      this._pairedTokensSource === oldSource &&
      !this._hadSpecialOsuEvents &&
      !hasSpecialEvents
        ? tryIncrementalGreenFromPaired(
            prev,
            this._pairedTokens,
            pairedTokens,
            oldSource.length,
            source,
            this._dialect,
            this._autoClosedByEnd,
            knownChangedTokSpan,
          )
        : null

    if (inc !== null) {
      green = inc.green
      autoClosedByEnd = inc.autoClosedByEnd
      usedRefReuse = true
    } else {
      const autoClosedAtRootEnd = new Map<number, readonly string[]>()
      const parseStateOut: {
        stackDepthAtEnd: number
        endAutoClosed: readonly string[] | null
        autoClosedAtRootEnd: Map<number, readonly string[]>
      } = {
        stackDepthAtEnd: 0,
        endAutoClosed: null,
        autoClosedAtRootEnd,
      }
      green = parseTokensToGreen(pairedTokens, source, {
        dialect: this._dialect,
        pairing: 'osu',
        osuPrePaired: { titleEvents, listCarriers, listHeadItems },
        parseStateOut,
      })
      autoClosedByEnd = autoClosedAtRootEnd
    }
    const t1 = performance.now()

    const reuse = { adopted: 0 }
    let root: RedNode
    let change: TextChangeRange | null = null
    try {
      if (prev !== null) {
        // When `tryIncrementalGreenFromPaired` stitched unchanged GreenNode
        // references, reference-mode adoption (`structural = false`) adopts
        // every untouched top-level block in O(blocks), while
        // `structuralOnMismatch = true` reuses unchanged children INSIDE the
        // single reparsed block (e.g. 79 untouched lines of a 5 KB `[box]`).
        root = greenToRedNodeReusing(green, prev, 0, reuse, !usedRefReuse, usedRefReuse)
        // With nothing adopted every block is new: no window to point at.
        if (reuse.adopted > 0) change = churnedSpan(prev, root)
      } else {
        root = greenToRedNode(green)
      }
    } catch (err) {
      // Adoption reparents as it goes: a throw leaves the old tree half
      // consumed. Start the next update from scratch rather than from it.
      this.dispose()
      throw err
    }
    // The patcher reads the edited span from the root (see
    // `DocumentModel._attachChangeRange`); null sends it to the keyed walk.
    ;(root as RedNode & { __changeRange?: TextChangeRange | null }).__changeRange = change
    const t2 = performance.now()

    this._root = root
    this._source = source
    this._rawTokens = rawTokens
    this._rawTokensSource = source
    this._hasCodeToken = hasCode
    this._pairedTokens = pairedTokens
    this._pairedTokensSource = source
    this._pairingState = pairingState
    this._hadSpecialOsuEvents = hasSpecialEvents
    this._autoClosedByEnd = autoClosedByEnd
    this.lastStats = { parseMs: t1 - t0, buildMs: t2 - t1, adopted: reuse.adopted, change }
    return root
  }

  /** Drop the tree (toggle off, dialect change, document closed). */
  dispose(): void {
    this._root = null
    this._source = null
    this._rawTokens = null
    this._rawTokensSource = null
    this._hasCodeToken = false
    this._pairedTokens = null
    this._pairedTokensSource = null
    this._pairingState = null
    this._hadSpecialOsuEvents = false
    this._autoClosedByEnd = null
    this._stagedFast = null
    this.lastStats = null
  }
}

/**
 * The span the patcher must reconcile: everything between the blocks kept at
 * the head and the blocks kept at the tail, end given in both coordinate
 * systems.
 *
 * Taken from the TREE, not from a diff of the two texts, and that is the whole
 * point. osu! pairing is document-global: an orphan `[/box]` typed at the end
 * re-pairs a box opened at the top, so the blocks that changed can lie far
 * outside the edited text. The windowed reconcile locates the OLD runs by this
 * span, and a text-diff span there left the re-paired blocks' old elements in
 * the DOM next to their new ones (caught by the random-edit test). The kept
 * blocks at both ends are equal greens, hence equal text, so this span always
 * contains the text edit too: a common prefix of blocks is a common prefix of
 * text.
 */
function churnedSpan(oldRoot: RedNode, newRoot: RedNode): TextChangeRange | null {
  const oldKids = oldRoot.children
  const newKids = newRoot.children
  const limit = Math.min(oldKids.length, newKids.length)
  let head = 0
  let start = newRoot.green.leadingWidth
  while (head < limit && newKids[head] === oldKids[head]) {
    start += newKids[head].green.width
    head++
  }
  // Same trailing delimiter width in both trees: the root kind never changes.
  let tailWidth = newRoot.green.trailingWidth
  let tail = 0
  while (
    tail < limit - head &&
    newKids[newKids.length - 1 - tail] === oldKids[oldKids.length - 1 - tail]
  ) {
    tailWidth += newKids[newKids.length - 1 - tail].green.width
    tail++
  }
  if (head === newKids.length && head === oldKids.length) return null
  return { start, end: newRoot.green.width - tailWidth, endOld: oldRoot.green.width - tailWidth }
}
