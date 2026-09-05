/**
 * DocumentEngine — IncrementalParser
 *
 * Re-parses the smallest region a text change can have affected, instead of
 * the whole document.
 *
 * ─── Why this was rewritten (roadmap S5 / point 9) ──────────────────────────
 *
 * The previous implementation spliced RED nodes in place and never touched
 * ranges. Three consequences, all measured:
 *
 *  - The re-parsed subtree came from `newSource.slice(start, end)`, so its
 *    ranges were based at 0 and were grafted in without rebasing. Every offset
 *    inside the edited region was wrong by `start`.
 *  - Siblings after the splice and every ancestor kept their old ranges, so
 *    the tree silently disagreed with the text it claimed to describe.
 *  - It returned `newRootRed.green` — the OLD green root — so the model's
 *    `_greenRoot` and `_redRoot` desynchronised permanently after the first
 *    incremental edit.
 *
 * Rendering the result and comparing it against a full rebuild of the same
 * final text: 3 of 6 realistic editing scenarios produced DIFFERENT HTML, and
 * one grew 14 phantom nodes (1752 vs 1738).
 *
 * ─── How it works now ───────────────────────────────────────────────────────
 *
 * Everything happens on the GREEN tree, and the red tree is derived from it.
 * That is not a stylistic choice: green nodes carry widths and no position, so
 * a position is something only a red node has — and therefore only a red node
 * can be wrong about.
 *
 *   1. Descend to the deepest node whose inner span (the part between its
 *      delimiters) contains the change, refusing to enter the kinds whose
 *      children depend on context outside them (see `OPAQUE_KINDS`).
 *   2. Take the run of that node's children the change touches, widened by one
 *      on each side, and re-parse just those.
 *   3. Splice the result back over that run and rebuild the ancestor spine,
 *      sharing every untouched subtree by reference.
 *
 * The unit is a RUN OF SIBLINGS, not a whole node. Re-parsing a container's
 * entire contents because one character changed inside it meant typing into a
 * 13 KB `[notice]` re-lexed 66% of the document per keystroke — and an edit at
 * document level had no enclosing container at all, so it fell back to a full
 * rebuild, which is exactly where the caret sits while you write the end of a
 * post.
 *
 * Step 1 relies on the partition invariant from point 14: without it, "the
 * part between the delimiters" is not a well-defined range, which is exactly
 * why this repair was blocked on that work.
 *
 * When any precondition fails the parser returns a full rebuild rather than a
 * plausible-looking wrong tree. `path` says which happened, `reason` says why.
 */

import { RedNode } from '../Syntax/RedNode'
import { GreenNode } from '../Syntax/GreenNode'
import { spliceGreen, withChildrenSpliced, type SpineStep } from '../Syntax/greenEdit'
import { isKnownTagName } from '../BBCode/BBCodeToGreenNode'
import { BracketDepthIndex } from './BracketIndex'
import type { TextChange } from './ChangeTracker'

/**
 * A span of the source, `[start, end)`, in the coordinates of the text the
 * result describes.
 */
export interface SourceSpan {
  start: number
  end: number
}

export interface EditOperation {
  kind: 'insert' | 'delete' | 'replace'
  start: number
  end: number
  text: string
  /** The minimal range that needs re-parsing */
  affectedStart: number
  affectedEnd: number
}

/** Options a caller's parse callback must understand. */
export interface ReparseParseOptions {
  /**
   * Whether the text being parsed is document-level content. Inner spans of
   * containers are not, and must not be grouped into paragraphs.
   */
  normalizeParagraphs: boolean
}

export interface ReparseResult {
  green: GreenNode
  red: RedNode
  /** Nodes that were affected by the change */
  affectedNodes: RedNode[]
  /** Time taken in ms (total) */
  duration: number
  /** Per-phase timing breakdown in ms */
  timings: {
    findAffected: number
    safeBoundary: number
    parse: number
    buildRed: number
    mutate: number
    other: number
  }
  /** Which path was used */
  path: 'incremental' | 'full_rebuild'
  /** When `full_rebuild`, why the incremental path was declined. */
  reason?: FallbackReason
  /**
   * The span of `newSource` that went through the parser, in NEW coordinates,
   * or `null` after a full rebuild (where the answer is "all of it").
   *
   * This is the contract the incremental semantic analysis is built on. The
   * red tree that comes back is derived from a green tree that shares every
   * subtree outside this span by reference with the previous one, so — with
   * red-subtree reuse — every red node outside the span is the SAME object it
   * was before the edit, and everything anyone computed about it (its
   * diagnostics, above all) is still true of it, up to a shift in position.
   * The nodes inside the span, plus the ancestors on the path down to it
   * (rebuilt because their child lists changed), are the only ones that are
   * new. `SemanticAnalyzer.analyzeWindow` re-validates exactly those.
   *
   * The span is closed on the widened window, not on the edit: the parser
   * re-parses the sibling on each side of the change too (see
   * `findReparseWindow`), and those siblings are new nodes as well.
   */
  window: SourceSpan | null
}

export type FallbackReason =
  /** No sibling window could be formed around the change. */
  | 'no-window'
  /** The change touches a container's own delimiter. */
  | 'touches-delimiter'
  /** The region cannot be lexed in isolation — see `regionIsSelfContained`. */
  | 'region-not-isolated'
  /** An unclosed `[` before the region could claim a `]` the edit creates. */
  | 'open-bracket-before'
  /** The container covers so much of the document that a rebuild is cheaper. */
  | 'region-too-large'
  /** The document is small enough that rebuilding it outright costs less. */
  | 'document-too-small'
  /** The tree's ranges disagree with the source it is supposed to describe. */
  | 'stale-ranges'

/**
 * Kinds the descent refuses to enter, so they can only ever be re-parsed whole.
 *
 * Each one is here because its children are produced by a rule that looks
 * OUTSIDE them, which a window by definition cannot see:
 *
 *  - `paragraph` — paragraph grouping happens at the ROOT and nowhere else, so
 *    a window inside a paragraph cannot discover that a newly typed blank line
 *    should have SPLIT it into two paragraphs at document level. Stopping here
 *    makes the paragraph a member of a window at root level instead, where the
 *    re-parse does see the split.
 *  - `code` / `inline_code` — raw blocks. Their contents are one literal token
 *    because the LEXER saw the opening `[code]`; re-parsing that text on its own
 *    lexes it as ordinary BBCode and shatters it into tags. This is what the
 *    differential fuzz found first: 192 divergences, and every sample was a
 *    `code` node that had grown children.
 *  - `list_item` — `[*]` self-closes the previous item, so a `[*]` typed inside
 *    one item is its SIBLING in a full parse but would land as its CHILD when
 *    the item's contents are parsed alone.
 *
 * Everything else is fair game — the unit of an edit is a run of siblings, not
 * a whole node. There used to be an allow-list of eight block containers here;
 * it meant that typing into a 13 KB `[notice]` re-parsed all 13 KB, and that an
 * edit at document level matched nothing at all and fell back to a full
 * rebuild.
 */
const OPAQUE_KINDS = new Set(['paragraph', 'code', 'inline_code', 'list_item'])

/**
 * Largest share of the document a re-parse region may cover.
 *
 * Above this the incremental path is doing nearly all of a rebuild's work plus
 * the splice, and loses. Chosen from the measured crossover, not from taste.
 */
const MAX_REGION_FRACTION = 0.7

/**
 * Below this source length, don't even try.
 *
 * A rebuild of a small document costs less than the descent, the bracket scan
 * and the splice bookkeeping needed to avoid it. Measured across documents of
 * the same shape at growing sizes: at 1.8 KB / 173 nodes the incremental path
 * was 9% SLOWER, at 3.5 KB / 341 nodes it was 50% faster. The threshold sits
 * in that gap.
 */
const MIN_SOURCE_LENGTH = 2500

/** An orphaned closing tag, as the parser preserves it: a `text` leaf of `[/tag]`. */
const ORPHAN_CLOSE_RE = /^\[\/([a-zA-Z0-9_*-]+)\]$/

/**
 * Can this window be parsed on its own and mean the same thing it means in
 * context? Four ways it cannot:
 *
 *  - A closing tag with no opener inside the window, for a tag the parser
 *    KNOWS. In isolation it is literal text; in the whole document it may be
 *    something else, and the window cannot tell which:
 *      · if the name matches an ANCESTOR it closes that ancestor, which moves
 *        the ancestor's own boundary;
 *      · otherwise it is a `discarded_tag` — invisible, not exported — exactly
 *        when the parser auto-closed a tag of that name EARLIER in the
 *        document and no later `[/name]` has claimed it since (see
 *        `autoClosed` in `Parser.ts`). That is a fact about the prefix, which
 *        a window parse never sees: the differential found a `[/b]` typed
 *        after `[quote][b]x[/quote]` coming back as visible text where the
 *        full parse discards it.
 *    A closer for a tag the parser does NOT know is text either way and is
 *    perfectly safe — and that is the common case while editing: a half-typed
 *    `[/colo` matches nothing, and a finished `[/color]` normally closes a
 *    `[color]` that is inside the window or above it. Only a stray closer of
 *    a real tag pays with a rebuild, and only while it sits in the window.
 *    Plugin tags are the one blind spot: `isKnownTagName` sees the built-in
 *    dialects, not a document's registry, so a stray closer of a plugin tag
 *    is treated as text. The ancestor half of the rule shares that limit.
 *  - A lone `[` with no `]` after it. The lexer's bracket matching would find
 *    a `]` beyond the window.
 *  - An unclosed `[code]`. Raw blocks swallow everything up to their closing
 *    tag, so in isolation one stops at the window's end and in context it does
 *    not.
 *  - A tag left open at the end of the window. What it swallows next depends on
 *    what follows, which the window cannot see:
 *      · if the window does NOT reach the parent's last child, the open tag
 *        would swallow the FOLLOWING SIBLINGS — they are outside the window, so
 *        the re-parse cannot produce them nested;
 *      · if it does reach the end and the tag matches ANY ANCESTOR'S kind, it
 *        would steal that ancestor's closing delimiter and the ancestor would
 *        run on to the next one. Typing `[centre]` inside a `[centre]` does
 *        exactly this — and the thief need not be the immediate parent, which
 *        is what the fuzz caught with a `[centre]` inside a `[list]` inside a
 *        `[centre]`.
 *    Anything else left open at a window that reaches the end is fine: a full
 *    parse auto-closes it at the enclosing delimiter, which is where the window
 *    ends anyway.
 */
function regionIsSelfContained(
  region: GreenNode,
  ancestorKinds: ReadonlySet<string>,
  window: { reachesEnd: boolean },
): boolean {
  // Checked on the PARSED region rather than on a second token scan. Lexing the
  // region twice — once to vet it, once to parse it — cost more than the whole
  // incremental path saved: on a document whose region is most of its length,
  // the "fast" path measured 3-4× SLOWER than a plain rebuild.
  //
  // Everything the guard needs survives into the tree, because the parser now
  // keeps what it used to drop: a bare `[` and an orphaned `[/tag]` are both
  // `text` leaves holding exactly their own source.
  //
  // Leaves inside a raw block are content, not syntax: `[code][/b][/code]`
  // holds a text leaf that IS `[/b]`, and the lexer never matched brackets
  // in there to begin with. The flag rides the stack beside the node.
  const stack: GreenNode[] = [region]
  const inCode: boolean[] = [false]
  while (stack.length > 0) {
    const node = stack.pop()!
    const code = inCode.pop()! || node.kind === 'code' || node.kind === 'inline_code'

    if (node.children.length === 0) {
      if (node.kind === 'text' && !code) {
        // The lexer emits a bare '[' as text exactly when it found no matching
        // bracket — the one case where its decision depends on what follows.
        if (node.text === '[') return false

        // A stray closer of a real tag: an ancestor's, or a discarded one —
        // see the header. `isKnownTagName` spans every dialect, so a tag the
        // active dialect happens not to know costs a rebuild rather than a
        // wrong tree.
        const orphan = ORPHAN_CLOSE_RE.exec(node.text)
        if (orphan !== null && isKnownTagName(orphan[1])) return false
      }
      continue
    }
    for (const child of node.children as readonly GreenNode[]) {
      stack.push(child)
      inCode.push(code)
    }
  }

  // Tags still open at the end of the window are exactly the rightmost chain of
  // nodes that carry no closing delimiter.
  let node: GreenNode | undefined = region
  while (node !== undefined) {
    if (node !== region && node.leadingWidth > 0 && node.trailingWidth === 0) {
      // `[code]` and `[c]` are the lexer's raw blocks — different kinds, same
      // swallow-everything behaviour.
      if (node.kind === 'code' || node.kind === 'inline_code') return false
      if (!window.reachesEnd) return false
      // Any ANCESTOR of the same kind, not just the immediate parent: every
      // ancestor's closing delimiter sits after the window, so whichever one
      // comes first would now close this newly opened tag instead. The fuzz
      // found it with a `[centre]` typed inside a `[list]` inside a `[centre]`.
      if (ancestorKinds.has(node.kind)) return false
    }
    node = node.children[node.children.length - 1] as GreenNode | undefined
  }

  return true
}

export interface IncrementalParserOptions {
  /** Override `MIN_SOURCE_LENGTH`. Set to 0 to always attempt a splice. */
  minSourceLength?: number
  /** Override `MAX_REGION_FRACTION`. */
  maxRegionFraction?: number
}

export class IncrementalParser {
  private readonly minSourceLength: number
  private readonly maxRegionFraction: number

  /**
   * Bracket-depth summary of the source, for the boundary check below.
   *
   * Keyed on the green root it was last synchronised with: a reparse whose
   * `oldGreen` is that root brings the index across the edit by re-reading a
   * few KB around it; any other root (a `rebuild`, a model handed a foreign
   * tree) rebuilds it with one scan — the same scan every keystroke used to
   * pay. See `BracketDepthIndex` for why the summary is exact.
   */
  private readonly brackets = new BracketDepthIndex()
  private bracketsRoot: GreenNode | null = null
  /**
   * Whether, within the current `reparse` call, the index has been brought to
   * describe `newSource`. Explicit rather than inferred: a length comparison
   * would confuse an unsynchronised index over an older text of the same
   * length (insert one character, delete one) with a synchronised one.
   */
  private bracketsSynced = false

  /**
   * The thresholds are constructor options because they are performance
   * tuning, not semantics: the tree that comes out is the same either way, so
   * a caller with a different document profile — or a test that wants to
   * exercise the splice on a two-line document — can move them without
   * changing what the parser means.
   */
  constructor(options: IncrementalParserOptions = {}) {
    this.minSourceLength = options.minSourceLength ?? MIN_SOURCE_LENGTH
    this.maxRegionFraction = options.maxRegionFraction ?? MAX_REGION_FRACTION
  }

  /**
   * Characters the last boundary check actually read — the tail of one index
   * piece, never the prefix. Exposed so a test can pin the bound.
   */
  get lastBoundaryScan(): number {
    return this.brackets.lastScanned
  }

  /**
   * Does every `[` before `end` find its `]` before `end` too?
   *
   * If one does not, the lexer's bracket matching for it scans onward into
   * the region we are about to re-parse — and an edit that adds a `]` there
   * (or deletes a `[` that was keeping the nesting depth up) changes what that
   * OUTSIDE bracket means. The region would be re-parsed correctly and the
   * text before it would silently become something else.
   *
   * A clamped depth count is exact for this question: the lexer pairs
   * brackets with a stack, so a `[` is unmatched precisely when the depth
   * never returns to its level. The count used to be a scan of the whole
   * prefix on every keystroke — 22% of a keystroke with the caret at the end
   * of a post, 1.4 ms on the 547 KB fixture. The index answers it from piece
   * summaries, reading at most one piece of text.
   *
   * The index is brought across the edit here, not earlier: the paths that
   * return before this point never needed it, and on the next call the
   * root-key mismatch simply rebuilds it. The caller re-keys it on whatever
   * green root it returns.
   */
  private bracketsCloseBefore(
    oldGreen: GreenNode,
    change: TextChange,
    newSource: string,
    end: number,
  ): boolean {
    const inSync = this.bracketsRoot === oldGreen
    // Unkeyed while it is being moved: should the parse callback throw
    // halfway through this call, no later call can mistake the half-moved
    // index for a description of any tree.
    this.bracketsRoot = null
    if (inSync) {
      this.brackets.applyChange(newSource, change.start, change.end, change.text.length)
    } else {
      this.brackets.rebuild(newSource)
    }
    // Describes `newSource` from here on, whatever the outcome; the key is
    // set once the root that owns that text exists (see `keyed`).
    this.bracketsSynced = true
    return this.brackets.depthAt(newSource, end) === 0
  }

  /**
   * Reparse a tree after a text change.
   *
   * Always returns a result — either an incremental splice or a full rebuild.
   * It never returns a tree whose ranges do not describe `newSource`.
   */
  reparse(
    oldRed: RedNode,
    oldGreen: GreenNode,
    change: TextChange,
    newSource: string,
    parseCallback: (text: string, options?: ReparseParseOptions) => GreenNode,
    buildRedCallback: (green: GreenNode) => RedNode,
  ): ReparseResult {
    const startTime = performance.now()
    const delta = change.text.length - (change.end - change.start)

    // Whatever the outcome, the bracket index ends up keyed on the tree whose
    // text it describes — or on nothing, so the next call rebuilds it. A call
    // that returns before the boundary check never moved the index, and the
    // tree it returns describes a text the index does not; the key it had
    // (the previous root) is useless from here on, since the next call comes
    // in with this call's root.
    this.bracketsSynced = false
    const keyed = (result: ReparseResult): ReparseResult => {
      this.bracketsRoot = this.bracketsSynced ? result.green : null
      return result
    }

    const fullRebuild = (reason: FallbackReason, tFind: number): ReparseResult => {
      const t0 = performance.now()
      const green = parseCallback(newSource)
      const tParse = performance.now() - t0
      const t1 = performance.now()
      const red = buildRedCallback(green)
      const tBuild = performance.now() - t1
      const total = performance.now() - startTime
      return keyed({
        green,
        red,
        affectedNodes: [red],
        duration: total,
        timings: {
          findAffected: tFind,
          safeBoundary: 0,
          parse: tParse,
          buildRed: tBuild,
          mutate: 0,
          other: Math.max(0, total - tFind - tParse - tBuild),
        },
        path: 'full_rebuild',
        reason,
        window: null,
      })
    }

    if (newSource.length < this.minSourceLength) {
      return fullRebuild('document-too-small', 0)
    }

    // The tree must currently describe the text BEFORE the change; otherwise
    // the offsets we are about to descend by mean nothing. This used to be
    // discovered halfway through, as "tree ranges are stale".
    const oldLength = newSource.length - delta
    if (oldGreen.width !== oldLength) {
      return fullRebuild('stale-ranges', 0)
    }

    // ─── 1. Find the sibling window around the change ───────────
    //
    // The descent runs over the RED tree, because that is where positions live
    // now. It yields the green spine the splice needs, the parent whose
    // children are being replaced, and the absolute offsets of the window.
    const tFind0 = performance.now()
    const found = this.findReparseWindow(oldRed, change)
    const tFind = performance.now() - tFind0
    if (found === null) return fullRebuild('no-window', tFind)
    const { spine, parent, from, to, windowStart, windowEnd, ancestorKinds } = found

    // ─── 2. Re-parse just that window ───────────────────────────
    const region = newSource.slice(windowStart, windowEnd + delta)

    const tBoundary0 = performance.now()
    // Re-parsing a region that is nearly the whole document cannot beat simply
    // rebuilding it, and the splice bookkeeping makes it lose. Measured on a
    // 32 KB document whose container spanned 95% of the text: 0.86 ms spliced
    // against 0.20 ms rebuilt.
    if (region.length > (newSource.length + 1) * this.maxRegionFraction) {
      return fullRebuild('region-too-large', tFind)
    }
    if (!this.bracketsCloseBefore(oldGreen, change, newSource, windowStart)) {
      return fullRebuild('open-bracket-before', tFind)
    }
    const tBoundary = performance.now() - tBoundary0

    const tParse0 = performance.now()
    // Paragraph grouping happens at the root and only there, so the window's
    // content is root content exactly when its parent is the document.
    const isRoot = parent.kind === 'document'
    const parsedRegion = parseCallback(region, { normalizeParagraphs: isRoot })
    const tParse = performance.now() - tParse0

    const reachesEnd = to === parent.children.length
    if (!regionIsSelfContained(parsedRegion, ancestorKinds, { reachesEnd })) {
      return fullRebuild('region-not-isolated', tFind)
    }

    // No rebasing step: the parsed region has widths, not offsets, so it is
    // already correct wherever it ends up.
    const newChildren = parsedRegion.children as readonly GreenNode[]

    // ─── 3. Rebuild the spine ───────────────────────────────────
    const tMutate0 = performance.now()
    const newParent = withChildrenSpliced(parent, from, to, newChildren)
    const newGreenRoot = spliceGreen(spine, newParent)
    const tMutate = performance.now() - tMutate0

    const tBuild0 = performance.now()
    const newRed = buildRedCallback(newGreenRoot)
    const tBuild = performance.now() - tBuild0

    const total = performance.now() - startTime
    return keyed({
      green: newGreenRoot,
      red: newRed,
      affectedNodes: [newRed],
      duration: total,
      timings: {
        findAffected: tFind,
        safeBoundary: tBoundary,
        parse: tParse,
        buildRed: tBuild,
        mutate: tMutate,
        other: Math.max(0, total - tFind - tBoundary - tParse - tBuild - tMutate),
      },
      path: 'incremental',
      // The region, in the coordinates of the text it now describes.
      window: { start: windowStart, end: windowEnd + delta },
    })
  }

  /**
   * Find the run of sibling children a change can have affected.
   *
   * Two steps. First descend to the deepest node whose INNER span contains the
   * change — inner rather than full, so a container's own delimiters never go
   * back through the parser: an edit that touches `[colo|r=red]` changes what
   * that element IS, and is handled by re-parsing it as part of its parent's
   * window instead.
   *
   * Then pick the children that the change touches, widened by one on each
   * side. The widening is what lets a deletion MERGE two nodes: removing the
   * blank line between two paragraphs changes only the node in between, and
   * without a neighbour on each side the re-parse could not see that the two
   * survivors have to become one.
   */
  private findReparseWindow(
    root: RedNode,
    change: TextChange,
  ): {
    spine: SpineStep[]
    parent: GreenNode
    from: number
    to: number
    windowStart: number
    windowEnd: number
    ancestorKinds: Set<string>
  } | null {
    const spine: SpineStep[] = []
    const ancestorKinds = new Set<string>([root.kind])
    let node = root
    // Absolute start of `node` in the source. Accumulated from GREEN widths, not
    // from red `range` reads: the red tree's offsets may carry a pending lazy
    // shift from the previous reparse (see `RedNode.setStart`), and reading
    // `range`/`innerStart`/`innerEnd` would force a materialization walk over
    // every displaced subtree — moving the cost the lazy shift was meant to
    // remove back into this phase. Green widths are position-free and always
    // current, and the partition invariant guarantees they accumulate to exactly
    // the materialized red ranges.
    let nodeOffset = root.range.start

    // ── Descend ──
    // `nodeOffset` tracks the current node's absolute start. Each child begins
    // after the parent's leading delimiter plus the previous siblings' widths,
    // and its inner span is the same accumulation past its own delimiters.
    for (;;) {
      const kids = node.children
      let next = -1
      let offset = nodeOffset + node.green.leadingWidth
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]
        const innerStart = offset + c.green.leadingWidth
        const innerEnd = offset + c.green.width - c.green.trailingWidth
        if (
          !OPAQUE_KINDS.has(c.kind) &&
          c.children.length > 0 &&
          innerStart <= change.start &&
          change.end <= innerEnd
        ) {
          next = i
          break
        }
        offset += c.green.width
      }
      if (next === -1) break

      spine.push({ node: node.green, index: next })
      // The child's absolute start: the accumulated offset at its index.
      nodeOffset += node.green.leadingWidth
      for (let i = 0; i < next; i++) nodeOffset += node.children[i].green.width
      node = node.children[next]
      ancestorKinds.add(node.kind)
    }

    const children = node.children
    if (children.length === 0) return null

    // ── Window ──
    // A child is touched when it overlaps the change at all, boundaries
    // included: an insertion sits between two children and both are candidates.
    let first = -1
    let last = -1
    let offset = nodeOffset + node.green.leadingWidth
    for (let i = 0; i < children.length; i++) {
      const c = children[i]
      const start = offset
      const end = offset + c.green.width
      if (start <= change.end && change.start <= end) {
        if (first === -1) first = i
        last = i
      }
      offset = end
    }
    // A change past the last child (typing at the very end) touches nothing;
    // anchor it to the final child so there is something to re-parse.
    if (first === -1) {
      first = children.length - 1
      last = first
    }

    let from = Math.max(0, first - 1)
    const to = Math.min(children.length, last + 2)

    // A run of newlines is `spacing` followed by `empty_line`s: which one a
    // newline becomes depends on how many came BEFORE it. Starting the window
    // mid-run would make its first newline believe it is the first of all, and
    // it would come back as `spacing`. Walk left to the run's real start.
    while (from > 0 && children[from].kind === 'empty_line') from--

    // Window offsets, again from green widths (identical to the red ranges the
    // tree would report once materialized).
    let windowStart = nodeOffset + node.green.leadingWidth
    for (let i = 0; i < from; i++) windowStart += children[i].green.width
    let windowEnd = windowStart
    for (let i = from; i < to; i++) windowEnd += children[i].green.width

    return {
      spine,
      parent: node.green,
      from,
      to,
      windowStart,
      windowEnd,
      ancestorKinds,
    }
  }

  /**
   * Nodes on the path from the root down to the change.
   *
   * Kept because it is part of the public surface and is genuinely useful for
   * callers that want to know what an edit touched; the reparse itself no
   * longer needs it.
   */
  findAffectedNodes(root: RedNode, change: TextChange): RedNode[] {
    const affected: RedNode[] = []
    let current: RedNode | undefined = root
    // Absolute offset of `current`, accumulated from GREEN widths — reading red
    // ranges here would materialize every pending lazy shift (see
    // `RedNode.setStart`), walking the displaced tail for a call that only
    // needs the containment chain. Same invariant as `findReparseWindow`.
    let offset = root.range.start

    while (current) {
      if (offset <= change.start && offset + current.green.width >= change.end) {
        affected.push(current)
        // Children partition their parent, so at most one can contain the
        // change — the first match is the only match.
        let next: RedNode | undefined
        let childOffset = offset + current.green.leadingWidth
        for (const child of current.children) {
          const cEnd = childOffset + child.green.width
          if (childOffset <= change.start && cEnd >= change.end) {
            next = child
            offset = childOffset
            break
          }
          childOffset = cEnd
        }
        current = next
      } else {
        break
      }
    }

    return affected
  }
}
