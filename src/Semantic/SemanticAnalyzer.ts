/**
 * DocumentEngine — SemanticAnalyzer
 *
 * Walks the Red Tree and produces diagnostics by applying
 * semantic rules to the syntax tree.
 *
 * This is where language-specific validation happens.
 * The analyzer is extensible via registered validators.
 *
 * Inspired by Roslyn's Semantic Model and LSP diagnostics.
 */

import { RedNode } from '../Syntax/RedNode'
import { getBBCodeTagNames, type BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import type { NodeKind } from '../Types/core'
import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticCollection,
  DiagnosticFix,
} from '../Types/diagnostics'
import {
  createDiagnosticCollection,
  createDiagnostic,
  addDiagnostic,
} from '../Types/diagnostics'

/**
 * Run one validator and file whatever it returns, both on the collection and on
 * the node itself.
 *
 * Attaching here is the point: a diagnostic is produced while its own node is
 * in hand, so pairing them later — by building an id→node Map of the whole
 * document and looking each one up — was solving a problem that only existed
 * because the two steps had been separated.
 *
 * The `try` is per validator, deliberately: one that throws must not take the
 * rest of the analysis down with it.
 */
function runValidator(
  validator: Validator,
  node: RedNode,
  context: AnalyzerContext,
  diagnostics: DiagnosticCollection,
): void {
  try {
    const result = validator.validate(node, context)
    if (result === null || result === undefined) return
    if (Array.isArray(result)) {
      for (let i = 0; i < result.length; i++) {
        addDiagnostic(diagnostics, result[i])
        node.diagnostics.push(result[i])
      }
    } else {
      addDiagnostic(diagnostics, result)
      node.diagnostics.push(result)
    }
  } catch (error) {
    // Validator error should not break the analysis
    console.warn(`[DocumentEngine] Validator ${validator.code} error:`, error)
  }
}

// ─── Validator Interface ───────────────────────────────────────

export interface Validator {
  /** Unique code for this validator (e.g. 'invalid-color') */
  code: string
  /** Severity of issues found by this validator */
  severity: DiagnosticSeverity
  /**
   * Node kinds this validator can ever fire on. Omit to run on every node.
   *
   * Three of the five built-ins open with nothing but a kind test, so on a
   * document of 1736 nodes they were called 1736 times each to answer a
   * question the dispatcher can answer once. Declaring the kinds turns the
   * call into a lookup that never happens.
   */
  kinds?: readonly string[]
  /** Validate a node. Return diagnostics or null */
  validate(node: RedNode, context: AnalyzerContext): Diagnostic | Diagnostic[] | null
}

export interface AnalyzerContext {
  /**
   * Every node in the tree, by id, for cross-reference validation.
   *
   * A getter, and deliberately: building this Map cost a second full walk of
   * the tree plus 1736 `Map.set` calls — 23% of `analyze()` — and **no
   * validator has ever read it**. It was built so that the caller could look up
   * by id the node to attach each diagnostic to, which is the node the
   * validator was looking at when it produced it. Validators that genuinely
   * need cross-references still get it; everyone else stops paying for it.
   */
  readonly allNodes: Map<string, RedNode>
  /**
   * Openers whose `[/tag]` does exist but arrived too late, keyed by the
   * opener's node id.
   *
   * A getter for the same reason `allNodes` is one, and asked for even more
   * rarely: the only way to reach it is through a node that is already known
   * to be unclosed, which on a healthy document never happens. Both validators
   * that read it test `isUnclosedTag` first, so a document with no auto-closed
   * tag never pays for the walk.
   */
  readonly crossings: ReadonlyMap<string, CrossedTags>
  /**
   * Unknown tags that were written as a PAIR, keyed by the opener's node id.
   *
   * Same lazy contract as `crossings`, and reached through an even tighter
   * gate: only a text leaf whose first and last characters are brackets can
   * be in it, which is three integer compares per text node.
   */
  readonly unknownTags: ReadonlyMap<string, UnknownTag>
  /**
   * Closing tags no opener claims, node id → tag name.
   *
   * Same walk as `unknownTags`, cached together, because the two answers are
   * two halves of one pairing: what is left over after every unknown opener
   * has taken its closer is a `[/tag]` that closes nothing.
   */
  readonly orphanClosers: ReadonlyMap<string, string>
  /** Previously collected diagnostics */
  diagnostics: DiagnosticCollection
  /** Source text for position lookups */
  source: string
}

// ─── Analyze Result ────────────────────────────────────────────

export interface AnalyzeResult {
  diagnostics: DiagnosticCollection
  /** Time taken in ms */
  duration: number
  /** Number of nodes analyzed */
  nodesAnalyzed: number
}

/**
 * What `analyze()` actually returns: an {@link AnalyzeResult} plus the node
 * index it had to build anyway for cross-reference lookups.
 *
 * Kept as a separate type, and deliberately NOT part of `AnalyzeResult`,
 * because the index holds a strong reference to every node in the tree. A
 * caller that stores an `AnalyzeResult` long-term (as `DocumentModel` does)
 * must not pin an entire stale tree; one that needs the index gets it here and
 * owns that decision explicitly.
 */
export interface IndexedAnalyzeResult extends AnalyzeResult {
  allNodes: Map<string, RedNode>
}

// ─── Validator helpers ─────────────────────────────────────────

/**
 * Tags that still work but have a preferred modern spelling.
 *
 * `kind` is not redundant. Several nodes can share a starting offset — a
 * `document`, the `paragraph` inside it and the tag itself all begin at 0 for
 * `[strike]x[/strike]` — so reading the source at that offset alone reports the
 * same tag three times. Requiring the node's kind to be the one the tag
 * produces pins the diagnostic to the node that actually is that tag.
 */
const DEPRECATED_TAGS: Record<string, { kind: NodeKind, message: string, replacement: string }> = {
  strike: { kind: 'strikethrough', message: 'Use [s] instead of [strike]', replacement: 's' },
  center: { kind: 'center', message: 'Use [centre] instead of [center]', replacement: 'centre' },
}

/**
 * The kinds any deprecated spelling can produce.
 *
 * Cheap pre-filter: the validator runs on every node of every parse, and
 * reading the source back is only meaningful for the handful of kinds a
 * deprecated tag can even yield. Testing the kind first keeps that work off the
 * keystroke path — measured at +14% on `analyze` without it.
 */
const DEPRECATED_KINDS = new Set<NodeKind>(
  Object.values(DEPRECATED_TAGS).map(entry => entry.kind),
)

/**
 * Reads the tag name at the start of a node's range: `[quote="x"]` → `quote`.
 *
 * Sticky (`y`) so it can be anchored at an arbitrary offset via `lastIndex`.
 * The obvious `source.slice(start, start + 32)` allocates a string for every
 * tag node of every parse; this matches in place.
 */
const OPENING_TAG_RE = /\[\/?([a-zA-Z0-9_*-]+)/y

/**
 * Kinds the grammar gives no content slot at all.
 *
 * Lyne's `[hr]` and `[separator=stars]` are emitted by the parser as a single
 * leaf spanning `[`..`]`. There is no inner range for content to occupy and no
 * closing form to write, now or ever. Two validators have to know that, and
 * both were getting it wrong in the same way — describing the tag's definition
 * as if it were something the author had done:
 *
 *   `empty-tag`     every `[hr]` is contentless; saying so is noise, not a hint
 *   `unclosed-tag`  worse than noise — `repairNesting` shares the
 *                   `isUnclosedTag` predicate, so the "repair" wrote a
 *                   `[/separator]` into the author's source, which osu!/Lyne
 *                   then render as literal text
 *
 * Deliberately narrower than "void". `list_item` also has no closing form, but
 * `[*]` does have a content slot, so an empty one is a real (if minor)
 * observation and stays reportable as `empty-tag`.
 */
const CONTENTLESS_BY_NATURE = new Set<NodeKind>(['separator'])

/**
 * Kinds no closing tag is ever expected for, held in one set because the check
 * below runs per node and one lookup is cheaper than two.
 *
 * Two reasons land a kind here. Most are not written tags at all: the check
 * reads the source at a node's boundaries, and several nodes can share an
 * offset — a `paragraph` wrapping `[b]x` starts at the same `[` as the `bold`
 * inside it, and would otherwise be judged as an unclosed `[b]`.
 *
 * The rest are written but have no closing form: `list_item`, because `[*]`
 * has none in BBCode at all, and whatever {@link CONTENTLESS_BY_NATURE} holds.
 */
const NO_CLOSING_TAG_EXPECTED = new Set<NodeKind>([
  'document', 'paragraph', 'group', 'text', 'spacing', 'empty_line', 'list_item', 'error',
  ...CONTENTLESS_BY_NATURE,
])

/**
 * Whether the parser had to close this tag itself because the author never did.
 *
 * Exact, not heuristic. A tag the author closed ends exactly at its own
 * `[/tag]`, because that is where the parser sets the node's end. A tag closed
 * *for* the author ends wherever the parser gave up — at the end of the
 * document, or at the mismatched `[/other]` that forced the issue — and the
 * text up to that point does not end in its closing form.
 *
 * That single rule covers both shapes: `[b]x` (never closed) and `[b][i]x[/b]`
 * (where `[i]` is auto-closed by the legacy nesting rules).
 */
export function isUnclosedTag(node: RedNode, source: string): boolean {
  if (NO_CLOSING_TAG_EXPECTED.has(node.kind)) return false

  const name = openingTagName(node, source)
  if (!name || name === '*') return false

  return !endsWithClosingTag(source, node.range.end, name)
}

/**
 * An opener the parser closed on the author's behalf, together with the
 * `[/tag]` the author *did* write — just too late for it to count.
 */
export interface CrossedTags {
  /** The tag name as written, lowercased. */
  tag: string
  /** Where its closing tag belongs: the offset the parser already closed it at. */
  at: number
  /** Where the ignored `[/tag]` sits in the source. */
  closer: { start: number; end: number }
}

/** The whole text of a `discarded_tag` leaf: `[/box]` → `box`. */
const DISCARDED_CLOSING_TAG = /^\[\/([a-zA-Z0-9_*-]+)\]$/

/**
 * Pairs every auto-closed opener with the stranded `[/tag]` that was meant for
 * it, so crossed tags stop being reported as missing ones.
 *
 * The tree already holds both halves and nothing else has to be recomputed.
 * When `[/centre]` arrives over an open `[notice][box]`, the parser closes both
 * inner frames and records their names; the `[/box]` and `[/notice]` that
 * follow find their name already spent and land as `discarded_tag` leaves,
 * which keep their range precisely so this is answerable later.
 *
 * The pairing mirrors what the parser did rather than guessing at it. Its
 * `autoClosed` is a Set keyed by name and consumed on use, so a stranded
 * `[/tag]` belongs to the most recently opened frame of that name that was
 * already closed by the time it appeared. `walk` is pre-order, so within one
 * name the innermost frame is the last one collected — which is why the search
 * runs backwards and stops at the first unclaimed match.
 */
function findCrossedTags(root: RedNode, source: string): Map<string, CrossedTags> {
  const openers = new Map<string, { id: string; at: number }[]>()
  const closers: { tag: string; start: number; end: number }[] = []

  root.walk(node => {
    if (node.kind === 'discarded_tag') {
      const match = DISCARDED_CLOSING_TAG.exec(node.text)
      if (match) {
        closers.push({
          tag: match[1].toLowerCase(),
          start: node.range.start,
          end: node.range.end,
        })
      }
      return
    }
    if (!isUnclosedTag(node, source)) return
    const tag = openingTagName(node, source)
    if (!tag) return
    const list = openers.get(tag)
    if (list) list.push({ id: node.id, at: node.range.end })
    else openers.set(tag, [{ id: node.id, at: node.range.end }])
  })

  const crossings = new Map<string, CrossedTags>()
  for (const closer of closers) {
    const candidates = openers.get(closer.tag)
    if (candidates === undefined) continue
    for (let i = candidates.length - 1; i >= 0; i--) {
      const opener = candidates[i]
      // A closer cannot belong to a frame that was still open when it arrived,
      // nor to one another closer already claimed.
      if (opener.at > closer.start) continue
      if (crossings.has(opener.id)) continue
      crossings.set(opener.id, {
        tag: closer.tag,
        at: opener.at,
        closer: { start: closer.start, end: closer.end },
      })
      break
    }
  }

  return crossings
}

/**
 * The tag name as the author actually spelled it, read back from the source.
 *
 * The tree cannot answer this. Several spellings collapse onto one `NodeKind`
 * — `[strike]` and `[s]` both become `strikethrough` — and a node's `text`
 * holds its attributes, not its name. A node's range does start at the opening
 * bracket, so the name is the identifier immediately after it.
 *
 * Returns null for nodes that do not correspond to a written tag.
 */
export function openingTagName(node: RedNode, source: string): string | null {
  const { start } = node.range
  if (start < 0 || start >= source.length || source.charCodeAt(start) !== 0x5b /* [ */) return null
  OPENING_TAG_RE.lastIndex = start
  const match = OPENING_TAG_RE.exec(source)
  return match ? match[1].toLowerCase() : null
}

/**
 * The span of the *name* inside this node's closing tag, or null if the author
 * never wrote one.
 *
 * A rename has to touch both ends: rewriting only the opening `[strike]` to
 * `[s]` leaves an orphan `[/strike]` that osu! renders as literal text — worse
 * than the deprecation it was fixing. The name sits between `[/` and `]`, so it
 * ends one character before the node and runs back its own length.
 */
export function closingTagNameRange(
  node: RedNode,
  source: string,
  name: string,
): { start: number; end: number } | null {
  const { end } = node.range
  if (!endsWithClosingTag(source, end, name)) return null
  return { start: end - name.length - 1, end: end - 1 }
}

/**
 * Does `source` end with `[/name]` at offset `end`?
 *
 * Compared in place rather than via `slice().toLowerCase()`: this runs for
 * every tag node on the keystroke path, and two throwaway strings per node adds
 * up. ASCII case folding is `| 32`, which is why the letter range is checked
 * first — folding a digit or `_` would corrupt it.
 */
function endsWithClosingTag(source: string, end: number, name: string): boolean {
  const start = end - name.length - 3
  if (start < 0) return false
  if (source.charCodeAt(start) !== 0x5b /* [ */) return false
  if (source.charCodeAt(start + 1) !== 0x2f /* / */) return false
  if (source.charCodeAt(end - 1) !== 0x5d /* ] */) return false

  for (let i = 0; i < name.length; i++) {
    let c = source.charCodeAt(start + 2 + i)
    if (c >= 0x41 && c <= 0x5a) c |= 32 // A-Z → a-z; `name` is already lowercase
    if (c !== name.charCodeAt(i)) return false
  }
  return true
}

/**
 * An unknown tag the author wrote as a pair: `[bold]x[/bold]`.
 *
 * The pairing is the whole signal. An unknown tag becomes literal text on
 * purpose — `[Gateron]` in prose has to stay visible, and a real corpus of 53
 * userpages carries `[gb]`, `[insane]`, `[rm120]` and a dozen more of those —
 * so a bare `[name]` is not evidence of anything. A `[name]` with a matching
 * `[/name]` is: nobody closes a bracketed aside. That same corpus contains
 * exactly ZERO of them, which is the false-positive budget this rule spends.
 */
export interface UnknownTag {
  /** The name as written, lowercased. */
  tag: string
  /** The `[tag]` the parser refused, kept as literal text. */
  opener: { start: number; end: number }
  /** Its `[/tag]` — what makes this a misspelling rather than prose. */
  closer: { start: number; end: number }
}

/** A text leaf that is exactly an opening tag: `[bold]` or `[bold=x]`. */
const LITERAL_OPEN = /^\[([a-zA-Z][a-zA-Z0-9_-]*)(?:=[^\]]*)?\]$/
/** A text leaf that is exactly a closing tag: `[/bold]`. */
const LITERAL_CLOSE = /^\[\/([a-zA-Z][a-zA-Z0-9_-]*)\]$/

/**
 * Finds unknown tags the author closed, so the checker can stop being silent
 * about them.
 *
 * Nothing here decides what a valid tag is, and that is deliberate: the parser
 * already decided, by refusing the tag and emitting its text verbatim as a
 * leaf. Reading that decision back keeps the rule correct in every dialect for
 * free, where a name list of its own would drift the moment a tag is added.
 *
 * `[code]` is excluded by walking with the flag rather than testing the node,
 * because there the brackets are content the author typed on purpose — and
 * `nested-tags-in-code` already covers that case with the right message.
 */
interface LiteralTagScan {
  /** Unknown openers the author closed, keyed by the OPENER's node id. */
  paired: Map<string, UnknownTag>
  /** Closing tags no opener claims, keyed by node id → the tag name. */
  orphans: Map<string, string>
}

function findLiteralTags(root: RedNode, source: string): LiteralTagScan {
  const opens: { id: string; tag: string; start: number; end: number }[] = []
  const closes: { id: string; tag: string; start: number; end: number; used: boolean }[] = []

  const visit = (node: RedNode, inCode: boolean): void => {
    const code = inCode || node.kind === 'code' || node.kind === 'inline_code'
    if (node.kind === 'text' && !code) {
      const text = node.text
      // Three integer compares before any regex: this runs on every text leaf
      // of the document, and almost none of them are a bracketed tag.
      if (
        text.length >= 3 &&
        text.charCodeAt(0) === 0x5b /* [ */ &&
        text.charCodeAt(text.length - 1) === 0x5d /* ] */ &&
        // A leaf whose text is not its own source span did not come from the
        // BBCode parser — an HTML import, say — and its offsets would not
        // point at the characters this reports.
        source.slice(node.range.start, node.range.end) === text
      ) {
        const open = LITERAL_OPEN.exec(text)
        if (open) {
          opens.push({ id: node.id, tag: open[1].toLowerCase(), start: node.range.start, end: node.range.end })
        } else {
          const close = LITERAL_CLOSE.exec(text)
          if (close) {
            closes.push({ id: node.id, tag: close[1].toLowerCase(), start: node.range.start, end: node.range.end, used: false })
          }
        }
      }
    }
    for (let i = 0; i < node.children.length; i++) visit(node.children[i], code)
  }
  visit(root, false)

  const paired = new Map<string, UnknownTag>()
  const orphans = new Map<string, string>()

  // `closes` is in document order, so the first unused match is the nearest.
  for (const open of opens) {
    for (const close of closes) {
      if (close.used || close.tag !== open.tag || close.start < open.end) continue
      close.used = true
      paired.set(open.id, {
        tag: open.tag,
        opener: { start: open.start, end: open.end },
        closer: { start: close.start, end: close.end },
      })
      break
    }
  }

  // Whatever no opener claimed closes nothing at all. Pairing has to run first:
  // the `[/bold]` of `[bold]x[/bold]` is not an orphan, it is the evidence that
  // made its opener a typo, and `unknown-tag` already reports the pair.
  for (const close of closes) {
    if (!close.used) orphans.set(close.id, close.tag)
  }

  return { paired, orphans }
}

/**
 * Names people reach for that BBCode does not have.
 *
 * Edit distance cannot find these — `bold` is three edits away from `b` — and
 * they are the most common way to end up with an unknown tag at all: writing
 * the word for what you mean, when the format spells it with one letter.
 */
const COMMON_MISNOMERS: Record<string, string> = {
  bold: 'b', strong: 'b',
  italic: 'i', italics: 'i', em: 'i',
  strikethrough: 's', strikeout: 's', del: 's',
  underline: 'u',
  link: 'url',
  image: 'img', picture: 'img', pic: 'img',
  video: 'youtube', yt: 'youtube',
  header: 'heading', title: 'heading', h1: 'heading', h2: 'heading', h3: 'heading',
  hide: 'spoiler',
}

/**
 * Levenshtein distance, abandoned as soon as it cannot beat `limit`.
 *
 * Two rows rather than a matrix, and the early exit matters: this runs against
 * every known tag name, and most of them are nowhere near the misspelling.
 */
function editDistance(a: string, b: string, limit: number): number {
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowBest = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowBest) rowBest = curr[j]
    }
    if (rowBest >= limit) return limit
    const swap = prev; prev = curr; curr = swap
  }
  return prev[b.length]
}

/**
 * The tag the author probably meant, or null when guessing would be worse than
 * saying nothing.
 *
 * Misnomers first, because they are exact. Then a typo within two edits, and
 * only for names of four characters or more — under that, two edits reaches
 * most of the one-letter tags from almost anything.
 */
function suggestTag(tag: string, known: readonly string[]): string | null {
  const misnomer = COMMON_MISNOMERS[tag]
  if (misnomer !== undefined && known.includes(misnomer)) return misnomer
  if (tag.length < 4) return null

  let best: string | null = null
  let bestDistance = 3
  for (const name of known) {
    if (name.length < 3) continue
    // Never propose a spelling that `deprecated-tag` would flag on the next
    // pass. `[centr]` sits one edit from `center` AND from `centre`, and the
    // sorted list offers the outdated one first.
    if (name in DEPRECATED_TAGS) continue
    if (Math.abs(name.length - tag.length) >= bestDistance) continue
    const distance = editDistance(tag, name, bestDistance)
    if (distance < bestDistance) { bestDistance = distance; best = name }
  }
  return best
}

/**
 * Schemes a BBCode link is allowed to carry.
 *
 * osu!'s renderer emits the href verbatim, so anything the browser will
 * *execute* rather than *navigate to* is a real hazard in a shared post, not a
 * style preference. `mailto:` is here because osu! profiles legitimately use
 * it; everything else is either inert (`data:`) or dangerous (`javascript:`).
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** `https://x` → `https:`; `www.x.com` → null. Deliberately RFC-shaped. */
const URL_SCHEME_RE = /^([a-z][a-z0-9+.\-]*:)/i

/**
 * How deep quotes may nest before osu! renders them as an unreadable stack.
 *
 * Three is the legacy renderer's own comfortable limit: past it each level
 * loses another ~2em of width and the innermost quote wraps to one word a line.
 */
const MAX_QUOTE_DEPTH = 3

/**
 * Inline kinds that mean nothing when nested inside themselves.
 *
 * `[b][b]x[/b][/b]` is not an error — it renders exactly like `[b]x[/b]` — but
 * it is always an accident, usually from pasting styled text twice. Deliberately
 * limited to the kinds whose effect is idempotent: `[color]` inside `[color]`
 * is meaningful (the inner one wins) and must never be reported.
 */
const SELF_NESTING_REDUNDANT = new Set<NodeKind>([
  'bold', 'italic', 'underline', 'strikethrough',
])

/**
 * Where a link's destination actually sits in the source.
 *
 * Both BBCode link forms put the href somewhere inside the node — as an
 * attribute in `[url=https://x]`, as the content in `[url]https://x[/url]` —
 * and a diagnostic that underlines the whole tag when only the scheme is wrong
 * makes the reader hunt for it. Searching the node's own span finds either form
 * without the validator having to know which one it is looking at.
 *
 * Falls back to the node's range when the href was normalised by the parser and
 * no longer appears literally (a trailing slash added, say): a slightly wide
 * underline beats no location at all.
 */
/**
 * The span of a node's opening tag alone: `[quote="x"]` out of the whole quote.
 *
 * A structural finding — nesting too deep, a block in the wrong place — is
 * *about* the whole node but has to be *pointed at* its opening tag. Underlining
 * a four-deep quote's full range highlights most of the document to say "this is
 * too deep", which tells the reader nothing about where to cut.
 *
 * Falls back to the node's own range when there is no `]` inside it, which only
 * happens for nodes that are not written tags.
 */
function openingTagRange(node: RedNode, source: string): { start: number; end: number } {
  const close = source.indexOf(']', node.range.start)
  if (close < 0 || close >= node.range.end) return node.range
  return { start: node.range.start, end: close + 1 }
}

function hrefRange(node: RedNode, source: string, href: string): { start: number; end: number } {
  const idx = source.indexOf(href, node.range.start)
  if (idx >= 0 && idx + href.length <= node.range.end) {
    return { start: idx, end: idx + href.length }
  }
  return node.range
}

// ─── SemanticAnalyzer ──────────────────────────────────────────

export class SemanticAnalyzer {
  private validators: Map<string, Validator> = new Map()

  /**
   * The same validators, arranged for the walk instead of for lookup.
   *
   * `_always` run on every node; `_byKind` are the ones that declared their
   * kinds. Iterating the Map itself allocated an iterator and a destructuring
   * pair per node — 9% of `analyze()` spent on bookkeeping, not on validating.
   *
   * Rebuilt on register/unregister, which happen once at construction and
   * essentially never afterwards.
   */
  private _always: Validator[] = []
  private _byKind: Map<string, Validator[]> = new Map()

  /**
   * The dialect this analyzer validates against.
   *
   * Only the suggestion for an unknown tag reads it — detection never needs a
   * name list, because the parser already refused the tag. `DocumentModel`
   * builds the analyzer before a subclass knows its dialect, so this is set
   * afterwards rather than taken by the constructor.
   */
  dialect: BBCodeDialect = 'miliastry'

  constructor() {
    this.registerBuiltinValidators()
  }

  /**
   * Register a validator.
   */
  register(validator: Validator): void {
    this.validators.set(validator.code, validator)
    this.rebuildDispatch()
  }

  /**
   * Remove a validator.
   */
  unregister(code: string): void {
    this.validators.delete(code)
    this.rebuildDispatch()
  }

  private rebuildDispatch(): void {
    this._always = []
    this._byKind = new Map()
    for (const validator of this.validators.values()) {
      if (validator.kinds === undefined) {
        this._always.push(validator)
        continue
      }
      for (const kind of validator.kinds) {
        const list = this._byKind.get(kind)
        if (list) list.push(validator)
        else this._byKind.set(kind, [validator])
      }
    }
  }

  /**
   * Analyze a Red Tree and produce diagnostics.
   */
  analyze(root: RedNode, source: string): IndexedAnalyzeResult {
    const startTime = performance.now()
    const diagnostics = createDiagnosticCollection()
    let nodesAnalyzed = 0

    // `allNodes` is a getter so the Map is only built if a validator asks for
    // it — see the note on `AnalyzerContext.allNodes`. `root` is captured, so
    // the walk that builds it happens at most once per analyze.
    let allNodesCache: Map<string, RedNode> | null = null
    let crossingsCache: Map<string, CrossedTags> | null = null
    let literalTagCache: LiteralTagScan | null = null
    const literalTags = (): LiteralTagScan => {
      if (literalTagCache === null) literalTagCache = findLiteralTags(root, source)
      return literalTagCache
    }
    const context: AnalyzerContext = {
      get allNodes(): Map<string, RedNode> {
        if (allNodesCache === null) {
          allNodesCache = new Map<string, RedNode>()
          root.walk(node => { allNodesCache!.set(node.id, node) })
        }
        return allNodesCache
      },
      get crossings(): ReadonlyMap<string, CrossedTags> {
        if (crossingsCache === null) crossingsCache = findCrossedTags(root, source)
        return crossingsCache
      },
      get unknownTags(): ReadonlyMap<string, UnknownTag> {
        return literalTags().paired
      },
      get orphanClosers(): ReadonlyMap<string, string> {
        return literalTags().orphans
      },
      diagnostics,
      source,
    }

    const always = this._always
    const byKind = this._byKind

    root.walk(node => {
      nodesAnalyzed++

      // Clear here rather than in a pass of its own, and only when there is
      // something to clear: a fresh `[]` per node meant an allocation for every
      // node in the document, and almost none of them carry diagnostics.
      if (node.diagnostics.length > 0) node.diagnostics = []

      const specific = byKind.get(node.kind)
      for (let i = 0; i < always.length; i++) {
        runValidator(always[i], node, context, diagnostics)
      }
      if (specific !== undefined) {
        for (let i = 0; i < specific.length; i++) {
          runValidator(specific[i], node, context, diagnostics)
        }
      }
    })

    const duration = performance.now() - startTime

    return {
      diagnostics,
      duration,
      nodesAnalyzed,
      get allNodes(): Map<string, RedNode> { return context.allNodes },
    }
  }

  // ─── Built-in Validators ─────────────────────────────────

  private registerBuiltinValidators(): void {
    // Unknown tag validator
    //
    // This rule could not fire. It waited on `custom`, the kind
    // `tagToNodeKind` returns for a tag it does not know — but `Parser` never
    // lets one through: it intercepts `custom` and emits the tag's text as a
    // literal leaf, on purpose, so `[Gateron]` in prose stays visible. No
    // `custom` node has ever reached the analyzer from a BBCode parse, so
    // `[bold]x[/bold]` rendered as visible garbage and the checker said
    // nothing. The translation and the panel's rule label had shipped for it
    // all along.
    //
    // It now reads the parser's decision back off the literal leaf, and fires
    // only on a tag that was CLOSED. See {@link UnknownTag} for why the
    // pairing is the entire rule.
    this.register({
      code: 'unknown-tag',
      severity: 'warning',
      kinds: ['text'],
      validate: (node, ctx) => {
        const text = node.text
        // Cheap enough to sit in front of the map: reaching `ctx.unknownTags`
        // walks the document, and a text leaf that is not bracketed end to end
        // can never be in it.
        if (
          text.length < 3 ||
          text.charCodeAt(0) !== 0x5b /* [ */ ||
          text.charCodeAt(text.length - 1) !== 0x5d /* ] */
        ) return null

        const unknown = ctx.unknownTags.get(node.id)
        if (unknown === undefined) return null

        const suggestion = suggestTag(unknown.tag, getBBCodeTagNames(this.dialect))

        // Not automatic, and for the opposite reason to every other fix here:
        // those are safe because they do not change the render, and this one
        // exists precisely to change it. `[bold]x[/bold]` is literal text
        // today and bold afterwards — which is what the author wanted, but it
        // is a guess at their intent, so it is theirs to accept.
        const fixes: DiagnosticFix[] | undefined = suggestion === null ? undefined : [{
          description: `Replace [${unknown.tag}] with [${suggestion}]`,
          isAutomatic: false,
          operations: [
            // Both ends, or the rename leaves an orphan `[/bold]` that osu!
            // paints as literal text — the same half-repair `deprecated-tag`
            // had to learn to avoid.
            {
              kind: 'replace_text',
              range: { start: unknown.opener.start + 1, end: unknown.opener.start + 1 + unknown.tag.length },
              newText: suggestion,
            },
            {
              kind: 'replace_text',
              range: { start: unknown.closer.start + 2, end: unknown.closer.start + 2 + unknown.tag.length },
              newText: suggestion,
            },
          ],
        }]

        return createDiagnostic(
          'unknown-tag',
          `Unknown BBCode tag: [${unknown.tag}] — it renders as literal text`,
          'warning',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            fixes,
            related: [{
              message: `Its closing [/${unknown.tag}]`,
              range: { start: unknown.closer.start, end: unknown.closer.end },
              nodeId: null,
            }],
          },
        )
      },
    })

    // Orphan closing tag validator
    //
    // A `[/tag]` with no opener anywhere. The parser keeps it as literal text
    // so no character of the source belongs to nothing — which means it is
    // PRINTED, and until now nothing said so: the checker reported a clean
    // document while the preview showed `[/notice][/centre]` as body text.
    // Found by opening the editor, not by any test or corpus sweep.
    //
    // osu! and Quasar genuinely disagree here — osu! discards the tag, Quasar
    // shows it — and `Tests/OsuNestingFidelity.test.ts` pins that: deleting
    // the orphans is what makes the visible text match the hand-verified
    // oracle. So the message has to name both behaviours, or the author cannot
    // tell whether the preview or their post is the one lying.
    //
    // In 53 real userpages these appear only in the deliberately broken ones:
    // 12 across the three NyuPenyu files, 0 everywhere else.
    this.register({
      code: 'orphan-closing-tag',
      severity: 'warning',
      kinds: ['text'],
      validate: (node, ctx) => {
        const text = node.text
        // Same cheap gate as `unknown-tag`, plus the slash: a closing tag is
        // the only thing this can be.
        if (
          text.length < 4 ||
          text.charCodeAt(0) !== 0x5b /* [ */ ||
          text.charCodeAt(1) !== 0x2f /* / */ ||
          text.charCodeAt(text.length - 1) !== 0x5d /* ] */
        ) return null

        const tag = ctx.orphanClosers.get(node.id)
        if (tag === undefined) return null

        return createDiagnostic(
          'orphan-closing-tag',
          `[/${tag}] closes nothing — osu! drops it, the preview shows it as text`,
          'warning',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            // Manual, like the other two repairs that alter what is displayed.
            // Deleting it is what osu! already does, so the published post does
            // not move — but this preview does, and a `[/notice]` alone on its
            // line leaves its newline behind exactly as `crossed-tags` does.
            fixes: [{
              description: `Delete [/${tag}]`,
              isAutomatic: false,
              operations: [{ kind: 'delete_range', range: { start: node.range.start, end: node.range.end } }],
            }],
          },
        )
      },
    })

    // Deprecated tag validator
    this.register({
      code: 'deprecated-tag',
      severity: 'info',
      // Same set the validator's own first line tests, hoisted into dispatch.
      kinds: [...DEPRECATED_KINDS],
      validate: (node, ctx) => {
        // Looked up `deprecated[node.text]` before, which could never match:
        // `node.text` holds the tag's *attributes*, not its name. And the name
        // is not on the node either — `[strike]` and `[s]` both parse to kind
        // `strikethrough`, so the spelling the author used only survives in the
        // source. The node's range points at the opening bracket, so read it
        // back from there.
        if (!DEPRECATED_KINDS.has(node.kind)) return null

        const spelling = openingTagName(node, ctx.source)
        if (!spelling) return null

        const found = DEPRECATED_TAGS[spelling]
        if (!found || found.kind !== node.kind) return null

        // Renombrar es dos ediciones, no una: apertura y cierre. Se emiten
        // ambas en el MISMO fix para que se apliquen como una sola operación —
        // aplicar media deja un `[/strike]` huérfano en el documento.
        const operations: DiagnosticFix['operations'] = [
          {
            kind: 'replace_text',
            range: { start: node.range.start + 1, end: node.range.start + 1 + spelling.length },
            newText: found.replacement,
          },
        ]
        const closing = closingTagNameRange(node, ctx.source, spelling)
        if (closing) {
          operations.push({ kind: 'replace_text', range: closing, newText: found.replacement })
        }

        return createDiagnostic(
          'deprecated-tag',
          found.message,
          'info',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            tags: ['deprecated'],
            fixes: [{
              description: `Replace [${spelling}] with [${found.replacement}]`,
              isAutomatic: true,
              operations,
            }],
          },
        )
      },
    })

    // Empty tag validator
    //
    // Excludes structural kinds that are intentionally contentless
    // (empty_line, spacing), and the kinds that cannot hold content at all —
    // see CONTENTLESS_BY_NATURE. Note that only the bare `[hr]` / `[separator]`
    // reached here anyway: with an attribute, `[separator=stars]` carries
    // `=stars` as its text and failed the `text === ''` test by accident.
    this.register({
      code: 'empty-tag',
      severity: 'hint',
      validate: (node) => {
        if (
          node.children.length === 0 &&
          node.text === '' &&
          node.kind !== 'text' &&
          node.kind !== 'empty_line' &&
          node.kind !== 'spacing' &&
          !CONTENTLESS_BY_NATURE.has(node.kind)
        ) {
          return createDiagnostic(
            'empty-tag',
            `Empty tag: ${node.kind}`,
            'hint',
            {
              nodeId: node.id,
              nodeKind: node.kind,
              range: node.range,
              tags: ['unnecessary'],
              // Una etiqueta sin contenido no renderiza nada, así que borrarla
              // no puede cambiar la salida: es la corrección más segura de las
              // tres.
              fixes: [{
                description: 'Remove the empty tag',
                isAutomatic: true,
                operations: [{ kind: 'delete_range', range: node.range }],
              }],
            },
          )
        }
        return null
      },
    })

    // Unclosed tag validator
    //
    // The one BBCode mistake people actually make. The legacy parser closes
    // these silently by design — the preview still looks plausible — so without
    // a diagnostic there is nothing anywhere telling the author a tag is
    // missing.
    this.register({
      code: 'unclosed-tag',
      severity: 'warning',
      validate: (node, ctx) => {
        if (!isUnclosedTag(node, ctx.source)) return null
        // Its closing tag is not missing, it is misplaced. Reported — with a
        // different repair — by `crossed-tags` below.
        if (ctx.crossings.has(node.id)) return null

        const name = openingTagName(node, ctx.source)

        // El parser YA cerró la etiqueta en `range.end`; la corrección solo
        // escribe en el fuente la decisión que el árbol ya tomó. Por eso es
        // segura: no cambia cómo se renderiza nada, elimina la divergencia
        // entre lo que el autor escribió y lo que se está mostrando.
        const fixes: DiagnosticFix[] | undefined = name
          ? [{
              description: `Insert [/${name}]`,
              isAutomatic: true,
              operations: [{ kind: 'insert_text', position: node.range.end, text: `[/${name}]` }],
            }]
          : undefined

        return createDiagnostic(
          'unclosed-tag',
          `Missing [/${name}] — the tag was closed automatically`,
          'warning',
          { nodeId: node.id, nodeKind: node.kind, range: node.range, fixes },
        )
      },
    })

    // Crossed tags validator
    //
    // `[centre][notice]x[/centre][/notice]` — the closers are all there, just
    // in the wrong order. The parser resolves it the way osu! does and moves
    // on, so without this the author is told two tags are *missing* while
    // their `[/tag]`s sit in plain sight further down the document.
    this.register({
      code: 'crossed-tags',
      severity: 'warning',
      validate: (node, ctx) => {
        // Cheap gate first: reaching `ctx.crossings` at all builds the pairing
        // for the whole document, and only an auto-closed tag can be in it.
        if (!isUnclosedTag(node, ctx.source)) return null

        const crossing = ctx.crossings.get(node.id)
        if (crossing === undefined) return null

        // Deliberately NOT automatic, and this is the whole reason the repair
        // is not just `repairNesting`'s edits handed over as a fix.
        //
        // Moving the closer is correct BBCode but it is not render-neutral:
        // the whitespace that surrounded the stranded `[/tag]` stays where it
        // was, and a newline that used to sit outside the container now sits
        // inside it — or two newlines that were separated by the discarded tag
        // become adjacent and turn into a blank line. Measured on
        // `[centre][notice]hola\n[/centre]\n[/notice]`: one extra
        // `bb-empty-line` in the output. Every other automatic fix in here is
        // safe precisely because it only writes down a decision the parser had
        // already taken; this one changes what the reader sees, so it is the
        // author's call and it stays out of "fix all".
        const fixes: DiagnosticFix[] = [{
          description: `Move [/${crossing.tag}] to where the tag actually closes`,
          isAutomatic: false,
          operations: [
            { kind: 'insert_text', position: crossing.at, text: `[/${crossing.tag}]` },
            { kind: 'delete_range', range: { start: crossing.closer.start, end: crossing.closer.end } },
          ],
        }]

        return createDiagnostic(
          'crossed-tags',
          `[/${crossing.tag}] is out of order — the tag was closed earlier and this closing tag is ignored`,
          'warning',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            fixes,
            related: [{
              message: `The ignored [/${crossing.tag}]`,
              range: { start: crossing.closer.start, end: crossing.closer.end },
              nodeId: null,
            }],
          },
        )
      },
    })

    // Potentially nested structure validator
    this.register({
      code: 'nested-structure',
      kinds: ['code', 'inline_code'],
      severity: 'warning',
      validate: (node) => {
        if (node.kind !== 'code' && node.kind !== 'inline_code') return null

        // Instead of underlining the entire [code] block, we find the exact
        // positions of the tags inside the text and yield a diagnostic for each.
        const diagnostics: Diagnostic[] = []
        const regex = /\[\/?[a-zA-Z0-9_*-]+(?:=[^\]]*)?\]/g

        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i]
          if (child.kind !== 'text') continue

          let match: RegExpExecArray | null
          while ((match = regex.exec(child.text)) !== null) {
            const start = child.range.start + match.index
            const end = start + match[0].length

            diagnostics.push(createDiagnostic(
              'nested-tags-in-code',
              'BBCode tags inside [code] blocks are not rendered by osu!',
              'warning',
              { nodeId: node.id, nodeKind: node.kind, range: { start, end } },
            ))
          }
        }

        return diagnostics.length > 0 ? diagnostics : null
      },
    })

    // ── Link destination validators ──────────────────────────
    //
    // Split into two codes on purpose. A missing scheme (`www.osu.ppy.sh`) is a
    // typo with one obvious repair, so it is a warning that fixes itself. A
    // *disallowed* scheme (`javascript:`) is either a mistake of a completely
    // different kind or an attack on whoever reads the post, and there is no
    // safe automatic rewrite for it — the author has to decide what they meant.
    this.register({
      code: 'invalid-url-protocol',
      severity: 'error',
      kinds: ['url'],
      validate: (node, ctx) => {
        const href = String(node.metadata?.href ?? '').trim()
        if (!href) return null

        const scheme = href.match(URL_SCHEME_RE)?.[1]?.toLowerCase()
        const range = hrefRange(node, ctx.source, href)

        if (scheme === undefined) {
          // No scheme at all. osu! resolves these against its own domain, so
          // `www.google.com` silently becomes an osu!web 404 — the link looks
          // right in the editor and is broken everywhere else.
          return createDiagnostic(
            'missing-url-protocol',
            `Link "${href}" has no protocol — it will resolve against osu!'s own domain`,
            'warning',
            {
              nodeId: node.id,
              nodeKind: node.kind,
              range,
              fixes: [{
                description: 'Prefix the link with https://',
                // Safe to batch: it only ever adds a scheme in front of a
                // destination that has none, so it cannot collide with another
                // finding's range and cannot change how the link text renders.
                isAutomatic: true,
                operations: [{ kind: 'insert_text', position: range.start, text: 'https://' }],
              }],
            },
          )
        }

        if (ALLOWED_URL_SCHEMES.has(scheme)) return null

        return createDiagnostic(
          'invalid-url-protocol',
          `Link protocol "${scheme}" is not allowed — use http://, https:// or mailto:`,
          'error',
          { nodeId: node.id, nodeKind: node.kind, range },
        )
      },
    })

    // Empty link validator
    //
    // Not reachable by `empty-tag`: `[url=https://x][/url]` carries `=https://x`
    // as its text, so it fails that rule's `text === ''` test and slips through.
    // The result renders as an anchor with nothing between its tags — invisible
    // and unclickable — which is exactly the kind of breakage a checker exists
    // to catch.
    this.register({
      code: 'empty-link',
      severity: 'warning',
      kinds: ['url'],
      validate: (node, ctx) => {
        if (node.children.length > 0) return null
        const href = String(node.metadata?.href ?? '').trim()
        if (!href) return null

        // `[url]https://x[/url]` parses its destination into a text child, so
        // the `children.length` test above has already isolated the attribute
        // form. What is left to find is where the label would go: immediately
        // before the closing tag.
        const name = openingTagName(node, ctx.source)
        const closingName = name ? closingTagNameRange(node, ctx.source, name) : null
        if (!closingName) return null
        const closing = closingName.start - 2

        return createDiagnostic(
          'empty-link',
          'Link has no visible text — it renders as an empty anchor',
          'warning',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            fixes: [{
              description: `Use "${href}" as the link text`,
              // Manual: it puts text on screen that was not there before. The
              // author may well want a different label, and "Fix all" must not
              // write copy on their behalf.
              isAutomatic: false,
              operations: [{ kind: 'insert_text', position: closing, text: href }],
            }],
          },
        )
      },
    })

    // Quote depth validator
    //
    // Ranged, unlike the Linter rule it replaces: a finding with `range: null`
    // cannot be jumped to, and a nesting problem you cannot navigate to is
    // barely a finding at all.
    this.register({
      code: 'max-quote-depth',
      severity: 'warning',
      kinds: ['quote'],
      validate: (node, ctx) => {
        let depth = 0
        for (let current = node.parent; current; current = current.parent) {
          if (current.kind === 'quote') depth++
        }
        if (depth < MAX_QUOTE_DEPTH) return null

        return createDiagnostic(
          'max-quote-depth',
          `Quotes are nested ${depth + 1} levels deep — osu! renders past ${MAX_QUOTE_DEPTH} as an unreadable stack`,
          'warning',
          { nodeId: node.id, nodeKind: node.kind, range: openingTagRange(node, ctx.source) },
        )
      },
    })

    // Redundant self-nesting validator
    //
    // Replaces the Linter's `no-nested-bold`, generalised to every inline kind
    // whose effect is idempotent. `[color]` inside `[color]` is deliberately
    // NOT reported: there the inner one wins, so the nesting means something.
    this.register({
      code: 'redundant-nesting',
      severity: 'hint',
      kinds: [...SELF_NESTING_REDUNDANT],
      validate: (node, ctx) => {
        if (node.parent?.kind !== node.kind) return null

        const name = openingTagName(node, ctx.source)
        const operations: DiagnosticFix['operations'] = []
        if (name) {
          const openEnd = ctx.source.indexOf(']', node.range.start)
          if (openEnd > 0 && openEnd < node.range.end) {
            operations.push({
              kind: 'delete_range',
              range: { start: node.range.start, end: openEnd + 1 },
            })
          }
          const closing = closingTagNameRange(node, ctx.source, name)
          if (closing) {
            operations.push({
              kind: 'delete_range',
              range: { start: closing.start - 2, end: node.range.end },
            })
          }
        }

        return createDiagnostic(
          'redundant-nesting',
          `[${name ?? node.kind}] inside another [${name ?? node.kind}] has no additional effect`,
          'hint',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            tags: ['redundant'],
            // Manual even though the visual result is identical: unwrapping
            // changes the emitted HTML, and the one promise "Fix all" makes is
            // that it never changes the document's output. Offered per-finding
            // so the author can still take it.
            fixes: operations.length === 2
              ? [{ description: `Unwrap the inner [${name}]`, isAutomatic: false, operations }]
              : undefined,
          },
        )
      },
    })
  }

  /**
   * Create a validator for a specific tag/kind.
   * Convenience method for plugin authors.
   */
  createValidator(
    code: string,
    severity: DiagnosticSeverity,
    predicate: (node: RedNode, ctx: AnalyzerContext) => string | null,
  ): Validator {
    return {
      code,
      severity,
      validate: (node, ctx) => {
        const message = predicate(node, ctx)
        if (message) {
          return createDiagnostic(code, message, severity, {
            nodeId: node.id,
            nodeKind: node.kind,
          })
        }
        return null
      },
    }
  }
}

