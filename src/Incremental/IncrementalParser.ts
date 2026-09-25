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
import { tagToNodeKind } from '../BBCode/BBCodeToGreenNode'
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
  /** For `region-not-isolated`, which check it was — for tuning, not semantics. */
  isolation?: IsolationFailure
  /**
   * How many narrower windows were turned down before this result (see the
   * candidate ladder in `reparse`). For tuning, not semantics.
   */
  escalations?: number
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
  /**
   * The window changed what the parser's `autoClosed` set holds when the text
   * after it is read — see `pendingAutoClosePreserved`.
   */
  | 'pending-auto-close'
  /** The container covers so much of the document that a rebuild is cheaper. */
  | 'region-too-large'
  /** The document is small enough that rebuilding it outright costs less. */
  | 'document-too-small'
  /** The tree's ranges disagree with the source it is supposed to describe. */
  | 'stale-ranges'

/** Which of `regionIsSelfContained`'s checks turned a window down. */
export type IsolationFailure =
  | 'bare-bracket'
  | 'closes-ancestor'
  | 'closes-pending'
  | 'open-raw-block'
  | 'open-before-siblings'
  | 'open-steals-ancestor-close'
  | 'paragraph-seam'

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

/** See the ladder's budget in `reparse`. */
const LADDER_BUDGET_FLOOR = 16384

const LIST_ITEM_ONLY: ReadonlySet<string> = new Set(['list_item'])
const NOTHING: ReadonlySet<string> = new Set()

/** An orphaned closing tag, as the parser preserves it: a `text` leaf of `[/tag]`. */
const ORPHAN_CLOSE_RE = /^\[\/([a-zA-Z0-9_*-]+)\]$/

/**
 * What a stretch of tree does to the parser's `autoClosed` set.
 *
 * `autoClosed` is the one piece of parser state that flows RIGHTWARDS past a
 * window without being visible in the tree at the window's edge (see
 * `pendingAutoClosePreserved`). A stretch of text does three things to it:
 *
 *   - ADDS a name, when a `[/x]` overtakes an inner `[y]` and closes it
 *     without its delimiter — the element ends up with `trailingWidth === 0`;
 *   - CONSUMES one, when a `[/y]` arrives while `y` is pending: the parser
 *     keeps it as a `discarded_tag` and drops the name;
 *   - DELETES one, on every opening tag, because reopening `[y]` retires the
 *     `y` that was still pending.
 */
interface AutoCloseProfile {
  /**
   * For each kind, the LAST thing the stretch did to it: `add` (a crossing
   * left it pending) or `del` (an opening tag or a `discarded_tag` retired
   * it). Only the last one matters — the operations are per-name and
   * idempotent, so whatever happened before it has already been overwritten.
   */
  last: Map<string, 'add' | 'del'>
  /**
   * The kinds still open when the stretch ENDS — the rightmost chain. Those
   * are not adds yet: whatever closes them sits past the window and adds them
   * all at once there, so they override everything in `last`.
   */
  chain: Set<string>
}

function emptyProfile(): AutoCloseProfile {
  return { last: new Map(), chain: new Set() }
}

/**
 * A node the parser had on its tag stack, as opposed to a leaf or a grouping
 * wrapper: exactly the nodes that own an opening delimiter. Leaves always
 * carry a leading width of 0 (see `greenLeaf`), and so do `paragraph`,
 * `group` and the document root, which the parser synthesises.
 */
function wasStackFrame(node: GreenNode): boolean {
  return node.leadingWidth > 0
}

/**
 * Fill `out` from one node, in document order.
 *
 * `onChain` marks the rightmost chain of nodes still open when the stretch
 * ends: they carry no closing delimiter because there was nothing left to
 * close them, not because a crossing did.
 */
function profileNode(node: GreenNode, onChain: boolean, out: AutoCloseProfile): void {
  if (node.kind === 'discarded_tag') {
    const match = ORPHAN_CLOSE_RE.exec(node.text)
    // Named by kind like every other event, so both sides compare on the same
    // alphabet.
    out.last.set(match === null ? node.text : tagToNodeKind(match[1]), 'del')
    return
  }
  if (wasStackFrame(node)) out.last.set(node.kind, 'del')

  const children = node.children as readonly GreenNode[]
  // A node that owns a closing delimiter was closed where it stands, so
  // nothing below it is still open at the end of the stretch.
  const stillOpen = onChain && node.trailingWidth === 0
  for (let i = 0; i < children.length; i++) {
    profileNode(children[i], stillOpen && i === children.length - 1, out)
  }

  if (node.trailingWidth > 0) {
    // This delimiter closed the author's tag and, on the way, every frame
    // still open inside it — the rightmost chain, which is what the parser's
    // `autoClosedHere` collects.
    for (
      let c = children[children.length - 1] as GreenNode | undefined;
      c !== undefined && wasStackFrame(c) && c.trailingWidth === 0;
      c = c.children[c.children.length - 1] as GreenNode | undefined
    ) {
      out.last.set(c.kind, 'add')
    }
  } else if (onChain && wasStackFrame(node)) {
    out.chain.add(node.kind)
  }
}

function profileSiblings(children: readonly GreenNode[], out: AutoCloseProfile): AutoCloseProfile {
  for (let i = 0; i < children.length; i++) profileNode(children[i], i === children.length - 1, out)
  return out
}

/**
 * Does the re-parsed window hand the text AFTER it the same `autoClosed` set
 * the old one did?
 *
 * This is the leak the differential fuzz found, and it is invisible in the
 * window itself. `[notice]
[b] [/notice]` auto-closes the `[b]`, leaving `b`
 * pending; a `[/b]` further down the document is then a `discarded_tag` —
 * invisible, not exported. Delete a `]` somewhere earlier so that the whole
 * run gets swallowed into one literal-text token, and the `[b]` never opens,
 * so the `[/b]` outside the window becomes visible text. The window parses
 * correctly; the tree keeps the stale `discarded_tag` it adopted.
 *
 * ─── Why one entry per kind is the whole answer ─────────────────────────────
 *
 * `autoClosed` is a set of NAMES, and every operation on it names exactly one:
 * a crossing adds one, an opening tag or a spent `[/tag]` deletes one. Names
 * never interact, so the window's effect factorises into one function per
 * kind, and each of those has only three possible shapes — leave the name as
 * it arrived (the window did nothing to it), force it pending (the last thing
 * the window did was add it), or force it absent (the last thing was a
 * delete). That is why only the LAST operation per kind is recorded, and why a
 * crossing the window resolves on the spot — `[b]` auto-closed by `[/notice]`
 * and then reopened, which the fixture does 24 times — cancels out and costs
 * nothing.
 *
 * The frames left open at the window's end are the exception in placement
 * only: whatever closes them does so past the window, after every other
 * operation, so `chain` overrides `last`.
 *
 * Two shapes still disagree without it mattering: "did nothing" and "deleted"
 * are the same function whenever the name was not pending on the way in, which
 * is a fact about the prefix that {@link PendingSpans} answers from a few
 * dozen measured stretches. Without that relaxation an ordinary
 * `[heading]TOP[/heading]` typed above the fixture's first block loses its
 * window, because the block opens 190 tags and the new one is a 191st.
 *
 * The one approximation is naming an operation by its element KIND rather than
 * by the tag as written, so two spellings of the same element — `[centre]` and
 * `[center]` — look alike to it. Getting that wrong needs a pending cross of
 * one of the two spellings over the window AND the edit to swap the window
 * between them; it is the same order of blind spot as the plugin-tag note
 * above, and it is recorded here rather than paid for on every keystroke.
 */
function pendingAutoClosePreserved(
  oldChildren: readonly GreenNode[],
  from: number,
  to: number,
  region: GreenNode,
  pending: PendingSpans,
  windowStart: number,
): boolean {
  const after = profileSiblings(region.children as readonly GreenNode[], emptyProfile())
  const before = profileSiblings(oldChildren.slice(from, to), emptyProfile())

  const kinds = new Set<string>(before.last.keys())
  for (const kind of after.last.keys()) kinds.add(kind)
  for (const kind of before.chain) kinds.add(kind)
  for (const kind of after.chain) kinds.add(kind)

  for (const kind of kinds) {
    const b = before.chain.has(kind) ? 'add' : before.last.get(kind) ?? 'none'
    const a = after.chain.has(kind) ? 'add' : after.last.get(kind) ?? 'none'
    if (b === a) continue
    // `del` and `none` are the same function on a name that was not pending.
    if (b !== 'add' && a !== 'add' && !pending.covers(kind, windowStart)) continue
    return false
  }
  return true
}

/** A stretch of the document over which `kind` sits in the parser's `autoClosed`. */
interface PendingSpan {
  kind: string
  start: number
  /** `Infinity` for a name nothing ever retired. */
  end: number
}

/**
 * Where in the document a name is pending in the parser's `autoClosed`.
 *
 * The parser's own rules, replayed over the tree in one walk: a closing
 * delimiter makes every frame it overtook pending from that point; an opening
 * tag of the same name retires it (reopening `[b]` retires the pending `b`);
 * so does a `discarded_tag`, which is the pending name being spent. What comes
 * out is a handful of short spans — on the 547 KB fixture, a couple of dozen,
 * none longer than a few KB — and outside them the incoming set is empty,
 * which is what lets the window guard ignore the deletes almost always.
 *
 * The walk is O(nodes) and runs once per green root. An incremental splice
 * carries it forward instead (`shifted`): the guard that consults it only
 * passes edits that leave the crossings OUTSIDE the window where they were,
 * and the crossings inside it are re-measured from the re-parsed window.
 */
class PendingSpans {
  constructor(private readonly spans: readonly PendingSpan[]) {}

  /**
   * Whether `kind` is pending when the parser reaches `offset`. The end is
   * INCLUSIVE: a span ends at the start of the tag that retires the name, and
   * at that offset the name is still pending — that tag is what spends it.
   * Found by the differential fuzz: an italic auto-closing a `[size]` exactly
   * where a `[/size]` began gave an empty span, so a window starting at that
   * `[/size]` saw nothing pending and kept it as visible text where the full
   * parse discards it. Inclusive is also the safe side: `covers` only ever
   * turns a window down.
   */
  covers(kind: string, offset: number): boolean {
    for (const span of this.spans) {
      if (span.kind === kind && span.start <= offset && offset <= span.end) return true
    }
    return false
  }

  /**
   * The same spans over the text an edit produced.
   *
   * Anything wholly before the window is untouched and anything wholly after
   * it moves by `delta`. An endpoint that falls INSIDE the window is clamped
   * outwards, to the window's own edges: the guard has already established
   * that the crossing and the tag that retires it are both still there, but
   * not exactly where, and a span that claims to be pending for slightly
   * longer than it is can only cost a rebuild, never correctness.
   */
  shifted(windowStart: number, windowEndOld: number, delta: number, born: readonly PendingSpan[] = []): PendingSpans {
    const windowEndNew = windowEndOld + delta
    const move = (at: number): number => {
      if (at === Number.POSITIVE_INFINITY || at >= windowEndOld) return at + delta
      return at
    }
    const spans: PendingSpan[] = []
    for (const span of this.spans) {
      const start = span.start < windowStart ? span.start : Math.max(windowStart, move(span.start))
      const end = span.end <= windowStart ? span.end : Math.max(windowEndNew, move(span.end))
      spans.push({ kind: span.kind, start, end })
    }
    // Crossings the new window both opens and retires are invisible to the
    // guard (their net effect on the text after it is nil) but not to a later
    // window that starts BETWEEN the two: without them it believed the name
    // was not pending and kept a stray `[/list]` visible where the full parse
    // discards it. Found by the differential fuzz once wider windows (the
    // candidate ladder) made such windows common.
    for (const span of born) spans.push(span)
    return new PendingSpans(spans)
  }
}

function collectPendingSpans(root: GreenNode): PendingSpans {
  return new PendingSpans(pendingSpansOf(root, 0, Number.POSITIVE_INFINITY))
}

/**
 * The spans a (sub)tree produces on its own, placed at `base`. A name still
 * pending when it ends is recorded up to `openEnd`: over a whole document that
 * is "forever"; over a re-parsed window it is the window's end, since the
 * guard has already matched whatever leaves the window pending with a span
 * the old tree had.
 */
function pendingSpansOf(root: GreenNode, base: number, openEnd: number): PendingSpan[] {
  const spans: PendingSpan[] = []
  const open = new Map<string, number>()
  const retire = (kind: string, at: number): void => {
    const start = open.get(kind)
    if (start === undefined) return
    open.delete(kind)
    spans.push({ kind, start, end: at })
  }

  const visit = (node: GreenNode, start: number): void => {
    if (node.kind === 'discarded_tag') {
      const match = ORPHAN_CLOSE_RE.exec(node.text)
      if (match !== null) retire(tagToNodeKind(match[1]), start)
      return
    }
    if (wasStackFrame(node)) retire(node.kind, start)

    const children = node.children as readonly GreenNode[]
    let offset = start + node.leadingWidth
    for (let i = 0; i < children.length; i++) {
      visit(children[i], offset)
      offset += children[i].width
    }

    if (node.trailingWidth > 0) {
      const at = start + node.width
      for (
        let c = children[children.length - 1] as GreenNode | undefined;
        c !== undefined && wasStackFrame(c) && c.trailingWidth === 0;
        c = c.children[c.children.length - 1] as GreenNode | undefined
      ) {
        if (!open.has(c.kind)) open.set(c.kind, at)
      }
    }
  }
  visit(root, base)

  // Whatever the document never retired stays pending to its end and beyond:
  // an edit appending text reads it with the name still set.
  for (const [kind, start] of open) spans.push({ kind, start, end: openEnd })
  return spans
}

/**
 * Can this window be parsed on its own and mean the same thing it means in
 * context? Four ways it cannot:
 *
 *  - A closing tag with no opener inside the window, in one of two situations.
 *    In isolation it is literal text; in the whole document it may be
 *    something else, and the window cannot tell which:
 *      · if the name matches an ANCESTOR it closes that ancestor, which moves
 *        the ancestor's own boundary;
 *      · otherwise it is a `discarded_tag` — invisible, not exported — exactly
 *        when the parser auto-closed a tag of that name EARLIER in the
 *        document and no later `[/name]` has claimed it since (see
 *        `autoClosed` in `Parser.ts`). That is a fact about the prefix, which
 *        a window parse never sees: the differential found a `[/b]` typed
 *        after `[quote][b]x[/quote]` coming back as visible text where the
 *        full parse discards it. {@link PendingSpans} is what makes that fact
 *        answerable here without reading the prefix — and answerable
 *        precisely, which matters: refusing every stray closer of a KNOWN tag
 *        instead cost the 20 KB mid-document delete its window on the 500 KB
 *        fixture, and a large delete strands a closer almost by definition.
 *    Anything else is text either way and is perfectly safe — the common case
 *    while editing, since a half-typed `[/colo` matches nothing and a finished
 *    `[/color]` normally closes a `[color]` inside the window or above it.
 *    Plugin tags are the one blind spot: `tagToNodeKind` sees the built-in
 *    dialects, not a document's registry, so a stray closer of a plugin tag is
 *    compared as `custom`.
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
/**
 * Does the `[` at `at` find its `]` inside `text`, by the lexer's own rule
 * (bracket depth, `findMatchingBracket`)?
 */
function bracketClosesWithin(text: string, at: number): boolean {
  let depth = 0
  for (let j = at + 1; j < text.length; j++) {
    const c = text.charCodeAt(j)
    if (c === 91 /* [ */) depth++
    else if (c === 93 /* ] */) {
      if (depth === 0) return true
      depth--
    }
  }
  return false
}

/** Bare `[` leaves a window may vet by scanning, before it just gives up. */
const MAX_BARE_BRACKET_SCANS = 16

function regionIsSelfContained(
  region: GreenNode,
  regionText: string,
  ancestorKinds: ReadonlySet<string>,
  window: { reachesEnd: boolean; closedByNextSibling: ReadonlySet<string> },
  pendingKind: (kind: string) => boolean,
): IsolationFailure | null {
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
  const offsets: number[] = [0]
  let bareScans = 0
  while (stack.length > 0) {
    const node = stack.pop()!
    const code = inCode.pop()! || node.kind === 'code' || node.kind === 'inline_code'
    const at = offsets.pop()!

    if (node.children.length === 0) {
      if (node.kind === 'text' && !code) {
        // The lexer emits a bare `[` in three places. Only one depends on what
        // follows: no `]` matched it. The other two — a closer whose name is
        // invalid (`[/col or]`, typed mid-tag), a `[` with no tag name — are
        // decided by a `]` the lexer DID find; when that `]` is inside the
        // window, the text between is the same in the full parse and so is the
        // decision. Refusing every bare `[` cost a whole-document rebuild for
        // each space typed inside a closing tag: the largest share of the
        // rebuilds left on the 547 KB fixture.
        if (node.text === '[') {
          if (++bareScans > MAX_BARE_BRACKET_SCANS || !bracketClosesWithin(regionText, at)) return 'bare-bracket'
        }

        // A stray closer that is not text after all: an ancestor's, or one
        // the prefix left pending — see the header. Compared by node kind,
        // not tag name: `[centre]` and `[center]` are the same element and
        // either spelling closes it.
        const orphan = ORPHAN_CLOSE_RE.exec(node.text)
        if (orphan !== null) {
          const kind = tagToNodeKind(orphan[1])
          if (ancestorKinds.has(kind)) return 'closes-ancestor'
          if (pendingKind(kind)) return 'closes-pending'
        }
      }
      continue
    }
    let childAt = at + node.leadingWidth
    for (const child of node.children as readonly GreenNode[]) {
      stack.push(child)
      inCode.push(code)
      offsets.push(childAt)
      childAt += child.width
    }
  }

  // Tags still open at the end of the window are exactly the rightmost chain of
  // nodes that carry no closing delimiter.
  let node: GreenNode | undefined = region
  while (node !== undefined) {
    if (node !== region && node.leadingWidth > 0 && node.trailingWidth === 0) {
      // `[code]` and `[c]` are the lexer's raw blocks — different kinds, same
      // swallow-everything behaviour.
      if (node.kind === 'code' || node.kind === 'inline_code') return 'open-raw-block'
      if (!window.reachesEnd) {
        // An item left open is the one open tag whose end the window CAN
        // see: `[*]` has no closing delimiter, and the full parse ends the
        // item exactly where the next sibling's `[*]` begins — which is where
        // the window ends. Only as the region's own top-level node, and only
        // when that next sibling really is an item; anything still open
        // INSIDE the item is refused as before, by the next turn of this loop.
        if (node === region.children[region.children.length - 1] && window.closedByNextSibling.has(node.kind)) {
          node = node.children[node.children.length - 1] as GreenNode | undefined
          continue
        }
        return 'open-before-siblings'
      }
      // Any ANCESTOR of the same kind, not just the immediate parent: every
      // ancestor's closing delimiter sits after the window, so whichever one
      // comes first would now close this newly opened tag instead. The fuzz
      // found it with a `[centre]` typed inside a `[list]` inside a `[centre]`.
      if (ancestorKinds.has(node.kind)) return 'open-steals-ancestor-close'
    }
    node = node.children[node.children.length - 1] as GreenNode | undefined
  }

  return null
}

/**
 * At the root, paragraphs are grouped by looking at their NEIGHBOURS, so a
 * window whose edge paragraph now touches a paragraph outside it would have
 * been merged with it by a full parse — two paragraphs are never adjacent in
 * a grouped tree. The first window's one-sibling widening keeps that seam
 * inside it; a window one level up, around a block the edit turned into loose
 * text, may not (found by the differential fuzz once the candidate ladder
 * produced such windows: a `[/notice]` typed so that a notice's tail became
 * text next to a paragraph after the window).
 */
function paragraphSeam(parent: GreenNode, from: number, to: number, region: GreenNode): IsolationFailure | null {
  const kids = region.children as readonly GreenNode[]
  if (kids.length === 0) return null
  const before = from > 0 ? (parent.children[from - 1] as GreenNode) : null
  const after = to < parent.children.length ? (parent.children[to] as GreenNode) : null
  if (before?.kind === 'paragraph' && kids[0].kind === 'paragraph') return 'paragraph-seam'
  if (after?.kind === 'paragraph' && kids[kids.length - 1].kind === 'paragraph') return 'paragraph-seam'
  return null
}

/** One candidate window: a run of `parent`'s children, reached through `spine`. */
interface CandidateWindow {
  spine: SpineStep[]
  parent: GreenNode
  from: number
  to: number
  windowStart: number
  windowEnd: number
  ancestorKinds: Set<string>
}

interface DescentPath extends CandidateWindow {
  /** Absolute start of the node at each depth of the descent. */
  levelOffsets: number[]
  /** Kind of the node at each depth, the root's first. */
  levelKinds: string[]
}

/**
 * The same run, widened to the right: one more sibling, then three, seven…
 * doubling until it reaches the parent's last child. What a narrow window
 * cannot see is almost always just past its right edge — the `]` a bare `[`
 * now pairs with, the siblings a broken closer lets a tag swallow — and at
 * the root "the parent's end" is the end of the document, far too large to
 * be worth trying. Doubling finds the near case in a few attempts and costs
 * at most twice the region it settles on.
 */
function* widenedRight(w: CandidateWindow): Generator<CandidateWindow> {
  const len = w.parent.children.length
  let to = w.to
  let windowEnd = w.windowEnd
  for (let step = 1; to < len; step *= 2) {
    const next = Math.min(len, to + step)
    for (let i = to; i < next; i++) windowEnd += (w.parent.children[i] as GreenNode).width
    to = next
    yield { ...w, to, windowEnd }
  }
}

/**
 * Every window worth trying for one change, narrowest first: the one
 * `findReparseWindow` found, then that run widened rightwards, then — one
 * level up at a time — the ancestor's child that holds the change with a
 * sibling on each side, widened the same way. Each candidate at a level
 * contains the previous one, and every one contains the change.
 */
function* candidateWindows(path: DescentPath): Generator<CandidateWindow> {
  yield path
  yield* widenedRight(path)
  for (let depth = path.spine.length - 1; depth >= 0; depth--) {
    const { node: parent, index } = path.spine[depth]
    const children = parent.children as readonly GreenNode[]
    let from = Math.max(0, index - 1)
    const to = Math.min(children.length, index + 2)
    // Same rule as the first window: never start mid-run of newlines.
    while (from > 0 && children[from].kind === 'empty_line') from--
    let windowStart = path.levelOffsets[depth] + parent.leadingWidth
    for (let i = 0; i < from; i++) windowStart += children[i].width
    let windowEnd = windowStart
    for (let i = from; i < to; i++) windowEnd += children[i].width
    const window: CandidateWindow = {
      spine: path.spine.slice(0, depth),
      parent,
      from,
      to,
      windowStart,
      windowEnd,
      ancestorKinds: new Set(path.levelKinds.slice(0, depth + 1)),
    }
    yield window
    yield* widenedRight(window)
  }
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
   * Where the document carries a pending `autoClosed` name, memoised on the
   * green root it was measured over — see {@link PendingSpans}.
   *
   * It survives an incremental splice by construction: the window guard that
   * consults it only lets through edits that leave the crossings on both
   * sides of the window as they were, so the spans need only be moved. Any
   * other outcome drops the key and the next edit pays one walk.
   */
  private pendingRoot: GreenNode | null = null
  private pendingSpans = new PendingSpans([])

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
    if (!this.bracketsSynced) this.syncBrackets(oldGreen, change, newSource)
    return this.brackets.depthAt(newSource, end) === 0
  }

  /** Brings the bracket index across `change`, once per `reparse` call. */
  private syncBrackets(oldGreen: GreenNode, change: TextChange, newSource: string): void {
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
    // The pending spans carry over only on the incremental path (see the
    // field); anything else re-keys them to nothing so the next call remeasures.
    let carriedSpans: PendingSpans | null = null
    const keyed = (result: ReparseResult): ReparseResult => {
      this.bracketsRoot = this.bracketsSynced ? result.green : null
      this.pendingRoot = carriedSpans === null ? null : result.green
      if (carriedSpans !== null) this.pendingSpans = carriedSpans
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
    // ─── 2. Re-parse the narrowest window that stands on its own ───
    //
    // The window found above is the narrowest candidate, not the only one. A
    // window that cannot be parsed in isolation — a tag left open that would
    // swallow the siblings after it, a bracket that pairs beyond its edge — is
    // not a reason to re-parse the WHOLE document: the same window widened to
    // the end of its parent, or one level up, usually can. So the candidates
    // are tried narrowest first, climbing the descent path, and only when the
    // root itself fails (or a candidate grows past `maxRegionFraction`) does
    // the parser rebuild. Each candidate goes through every guard below;
    // widening never relaxes one. Typing inside tag syntax — breaking a
    // `[/color]` while editing it — used to cost a whole-document rebuild per
    // keystroke; it now costs the enclosing block.
    let failure: { reason: FallbackReason; isolation?: IsolationFailure } | null = null
    let escalations = 0
    // Characters parsed by candidates that were then turned down. Capped at
    // one document's worth, so the ladder can never make the worst keystroke
    // on a large document cost more than twice a plain rebuild; plus a floor
    // (`LADDER_BUDGET_FLOOR`), because on a small one a few KB of parsing costs
    // nothing and the window is still worth finding.
    let wasted = 0
    let tBoundary = 0
    let tParse = 0
    for (const attempt of candidateWindows(found)) {
      const { spine, parent, from, to, windowStart, windowEnd, ancestorKinds } = attempt
      // Sized before it is sliced: skipping a candidate that is too large must
      // not cost a copy of it.
      const regionLength = windowEnd + delta - windowStart

      const tBoundary0 = performance.now()
      // Re-parsing a region that is nearly the whole document cannot beat simply
      // rebuilding it, and the splice bookkeeping makes it lose. Measured on a
      // 32 KB document whose container spanned 95% of the text: 0.86 ms spliced
      // against 0.20 ms rebuilt. Wider candidates only grow, so this ends the climb.
      if (regionLength > (newSource.length + 1) * this.maxRegionFraction) {
        failure ??= { reason: 'region-too-large' }
        // Wider candidates at THIS level only grow; one level up may still
        // start narrower (±1 sibling), so the climb is not over — only the
        // budget below ends it.
        continue
      }
      if (wasted + regionLength > newSource.length + LADDER_BUDGET_FLOOR) {
        failure ??= { reason: 'region-too-large' }
        break
      }
      const bracketsClose = this.bracketsCloseBefore(oldGreen, change, newSource, windowStart)
      tBoundary += performance.now() - tBoundary0
      if (!bracketsClose) {
        failure ??= { reason: 'open-bracket-before' }
        escalations++
        continue
      }

      const region = newSource.slice(windowStart, windowEnd + delta)
      const tParse0 = performance.now()
      // Paragraph grouping happens at the root and only there, so the window's
      // content is root content exactly when its parent is the document.
      const isRoot = parent.kind === 'document'
      const parsedRegion = parseCallback(region, { normalizeParagraphs: isRoot })
      tParse += performance.now() - tParse0

      // Measured on the OLD tree, which is the one the incoming set is a fact
      // about; the guard below is what keeps the answer true of the new one.
      // Both guards want it, so it is settled before either runs.
      if (this.pendingRoot !== oldGreen) {
        this.pendingSpans = collectPendingSpans(oldGreen)
        this.pendingRoot = oldGreen
      }
      const spans = this.pendingSpans
      const pendingKind = (kind: string): boolean => spans.covers(kind, windowStart)

      const reachesEnd = to === parent.children.length
      // The sibling right after the window, when it self-closes a same-kind
      // node left open at the window's end (see `regionIsSelfContained`).
      const next = reachesEnd ? null : (parent.children[to] as GreenNode)
      const closedByNextSibling = next !== null && next.kind === 'list_item' && next.leadingWidth > 0
        ? LIST_ITEM_ONLY
        : NOTHING
      const isolation = regionIsSelfContained(parsedRegion, region, ancestorKinds, { reachesEnd, closedByNextSibling }, pendingKind)
        ?? (isRoot ? paragraphSeam(parent, from, to, parsedRegion) : null)
      if (isolation !== null) {
        failure ??= { reason: 'region-not-isolated', isolation }
        escalations++
        wasted += region.length
        continue
      }
      // The guard protects the text AFTER the window from parser state leaking
      // out of it. A window that runs to the end of the document has no such
      // text — a tag its edit left open simply stays open to the end, which is
      // what the full parse does too.
      const nothingAfter = reachesEnd && spine.length === 0
      if (!nothingAfter && !pendingAutoClosePreserved(
        parent.children as readonly GreenNode[], from, to, parsedRegion, spans, windowStart,
      )) {
        failure ??= { reason: 'pending-auto-close' }
        escalations++
        wasted += region.length
        continue
      }
      carriedSpans = this.pendingSpans.shifted(
        windowStart, windowEnd, delta, pendingSpansOf(parsedRegion, windowStart, windowEnd + delta),
      )

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
        escalations,
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

    const result = fullRebuild(failure?.reason ?? 'no-window', tFind)
    result.isolation = failure?.isolation
    result.escalations = escalations
    return result
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
    parentOffset: number
    levelOffsets: number[]
    levelKinds: string[]
  } | null {
    const spine: SpineStep[] = []
    const ancestorKinds = new Set<string>([root.kind])
    // Per level of the descent: the node's absolute start and its kind, so a
    // window can later be formed around any ancestor (see `windowAround`).
    const levelOffsets: number[] = []
    const levelKinds: string[] = [root.kind]
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
      levelOffsets.push(nodeOffset)
      // The child's absolute start: the accumulated offset at its index.
      nodeOffset += node.green.leadingWidth
      for (let i = 0; i < next; i++) nodeOffset += node.children[i].green.width
      node = node.children[next]
      ancestorKinds.add(node.kind)
      levelKinds.push(node.kind)
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
      parentOffset: nodeOffset,
      levelOffsets,
      levelKinds,
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
