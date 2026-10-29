import { DocumentModel, type DocumentModelOptions } from '../Model/DocumentModel';
import { GreenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import type { TextChange } from '../Incremental/ChangeTracker';
import { scanMarkdown } from '../Markdown/MarkdownLexer';
import { parseMarkdown } from '../Markdown/MarkdownParser';
import { markdownAstToGreenTree, greenToRedNode as markdownGreenToRedNode } from '../Markdown/MarkdownToGreenNode';
import { createBBCodeScanner } from '../Lexer/BBCodeLexer';
import { parseTokensToGreen } from '../BBCode/Parser';
import { greenToRedNode as bbcodeGreenToRedNode, greenToRedNodeReusing } from '../BBCode/BBCodeToGreenNode';
import { applyMarkdownInlineToGreen } from './MilHibriInline';
import { rewriteMarkdownBlocks } from './MarkdownBlocks';

export interface MilHibriDocumentModelOptions extends DocumentModelOptions {
  source?: string;
}

// ── Source mode ────────────────────────────────────────────────────

/**
 * The tags osu! itself knows, exactly as `osuPairing` spells them. A document
 * made only of these is BBCode, and must go through the BBCode engine so it
 * inherits every measured osu! rule (lazy pairing, div-count closing, the
 * `[box=]` empty title, newline budgets, …) instead of the Markdown rules
 * that were written for prose.
 */
const OSU_BBCODE_TAGS = new Set([
  'b', 'i', 'u', 's', 'strike', 'spoiler', 'notice', 'centre', 'left', 'right',
  'color', 'size', 'heading', 'audio', 'profile', 'email', 'url', 'youtube',
  'imagemap', 'c', 'code', 'img', 'box', 'spoilerbox', 'quote', 'list',
])

/**
 * Tags that only exist in Miliastry/Lyne. Their presence means the source is
 * not pure osu! BBCode: the Markdown importer has to run to understand them.
 */
const MILIASTRY_ONLY_TAGS = new Set([
  'neon', 'glow', 'outline', 'shimmer', 'ghost', 'rainbow', 'fire', 'ice',
  'emboss', 'engrave', 'typewriter', 'wave', 'sparkle', 'glitch', 'levitate',
  'pulse', 'bounce', 'shake', 'fade-in', 'fade-out', 'card', 'glass',
  'neon-box', 'neonbox', 'square', 'circle', 'stack', 'flex', 'grid', 'middle',
  'columns', 'tables', 'row', 'th', 'col', 'scroll', 'effect', 'anim',
  'container', 'raw', 'noparse', 'plain', 'boxw', 'align', 'font', 'gradient',
  'group', 'svg', 'image', 'video', 'separator', 'hr', 'br',
])

const OPENING_TAG = /\[([a-z][a-z0-9_-]*)(?:[= \t][^\]]*)?\]/gi

/**
 * Characters a text-leaf splice may contain or remove.
 *
 * This is the whole safety argument of the fast path: a leaf splice keeps the
 * block stack and the inline translation exactly as they were, so the edit
 * must not be able to create or destroy a tag, a Markdown block/inline marker,
 * an entity, a link or a line break. Anything outside this set falls back to
 * the full import, where the parser can decide again.
 *
 * This is deliberately the Markdown lexer's own special set, plus the BBCode
 * brackets: even a character that cannot open a construct (an apostrophe, a
 * period) splits the inline lexer's text run, so a full import would produce
 * a different leaf segmentation than a one-leaf splice. Letters, digits,
 * spaces and the punctuation that stays inside one text token are enough for
 * ordinary typing; everything else pays for a rebuild.
 */
const UNSAFE_TEXT_CHAR = new Set([
  '[', ']', '*', '_', '~', '+', '`', '!', '#', '>', '-', '=', ':', '{', '}',
  '^', '\\', '<', '|', '.', '\'', '"', '(', ')', '&',
])

function canSpliceAsPlainText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // Controls (including tab and both newlines) always fall back.
    if (c < 0x20 || c === 0x7f) return false
    if (UNSAFE_TEXT_CHAR.has(text[i])) return false
  }
  return true
}

/**
 * Whether the caret sits inside something that is syntax, not prose.
 *
 * The leaf text around `[profile=14106450]` is still text in the green tree,
 * so matching it by context would splice a letter into the TAG NAME and keep
 * the old structure — the source would say `[profjile=…]` while the tree still
 * rendered a profile. Bracket depth, link destinations, entities and HTML
 * tags are all checked here; any hit falls back to a full import. The checks
 * are conservative about unmatched prose brackets too, which costs speed for
 * a malformed line but never correctness.
 */
function isInsideSyntax(source: string, at: number): boolean {
  const openBracket = source.lastIndexOf('[', at - 1)
  const closeBracket = source.lastIndexOf(']', at - 1)
  if (openBracket > closeBracket) return true

  const linkOpen = source.lastIndexOf('](', at - 1)
  const linkClose = source.lastIndexOf(')', at - 1)
  if (linkOpen > linkClose) return true

  // An ampersand is only syntax when a real entity closes it; `R&B` is prose.
  const entityOpen = source.lastIndexOf('&', at - 1)
  const entityClose = source.lastIndexOf(';', at - 1)
  if (entityOpen > entityClose) {
    const semi = source.indexOf(';', at)
    if (semi !== -1 && semi - entityOpen <= 32) {
      const body = source.slice(entityOpen + 1, semi)
      if (/^(?:[A-Za-z][A-Za-z0-9]+|#\d+|#x[0-9A-Fa-f]+)$/.test(body)) return true
    }
  }

  // Likewise `<3` and `a < b` are prose. A tag is a name followed by space,
  // `/` or `>`, which is also what a half-typed tag looks like.
  const angleOpen = source.lastIndexOf('<', at - 1)
  const angleClose = source.lastIndexOf('>', at - 1)
  if (angleOpen > angleClose && /^(?:\/?[A-Za-z][A-Za-z0-9-]*|!--)(?:\s|\/?>|$)/.test(source.slice(angleOpen + 1))) {
    return true
  }

  return false
}

/** A text leaf that contains the edited run, and where inside it the run is. */
interface LeafHit {
  leaf: RedNode
  /** Offset of the changed run inside `leaf.text`. */
  at: number
}

/**
 * Find the ONE text leaf that owns the edited run.
 *
 * Context is measured inside the source line and tried longest-first, so a
 * sentence that spans several leaves still matches on the leaf that holds the
 * caret. `[b]world[/b]` splits `world` away from its markers: a 24-character
 * context includes `[b]`, matches nothing, and the 2-character fallback
 * (`wo` + `ld`) matches the leaf. Ambiguous matches are refused, never guessed:
 * a wrong leaf would silently edit the wrong occurrence.
 */
function findTextLeaf(
  root: RedNode,
  oldSource: string,
  change: TextChange,
  removedText: string,
): LeafHit | null {
  const lineStart = oldSource.lastIndexOf('\n', change.start - 1) + 1
  const lineEndRaw = oldSource.indexOf('\n', change.end)
  const lineEnd = lineEndRaw === -1 ? oldSource.length : lineEndRaw
  const before = oldSource.slice(Math.max(lineStart, change.start - 64), change.start)
  const after = oldSource.slice(change.end, Math.min(lineEnd, change.end + 64))

  // When the tree partitions the source (pure BBCode), green widths give the
  // exact source offset of every leaf. That turns "this leaf contains the
  // context" into "this leaf owns the caret", which is the stronger check and
  // the one that cannot silently edit a repeated phrase elsewhere.
  const exactOffsets = root.green.width === oldSource.length

  for (const width of [24, 12, 6, 4, 2]) {
    const left = before.slice(-width)
    // A bare insertion at the very start/end of a line has only one side;
    // require enough real context that the match can be unique.
    const right = after.slice(0, width)
    if (left.length + right.length < 4) continue
    const needle = left + removedText + right

    let hit: LeafHit | null = null
    let count = 0
    const visit = (node: RedNode, start: number): void => {
      if (count > 1) return
      if (node.children.length === 0) {
        if (node.kind !== 'text' || node.text.length === 0) return
        const first = node.text.indexOf(needle)
        if (first === -1) return
        const at = first + left.length
        if (exactOffsets && start + at !== change.start) return
        // Two occurrences in one leaf is as ambiguous as two leaves.
        if (node.text.indexOf(needle, first + 1) !== -1) {
          count = 2
          return
        }
        count++
        if (count === 1) hit = { leaf: node, at }
        return
      }
      let offset = start + node.green.leadingWidth
      for (const child of node.children) {
        visit(child, offset)
        offset += child.green.width
      }
    }
    visit(root, 0)

    if (count === 1 && hit !== null) {
      const found: LeafHit = hit
      const leafText = found.leaf.text
      if (leafText.slice(found.at, found.at + removedText.length) !== removedText) continue
      if (found.at < 0 || found.at > leafText.length) continue
      return found
    }
  }
  return null
}

/**
 * Rebuild only the green spine from a leaf to the root.
 *
 * Every sibling keeps its identity, which is what makes the subsequent red
 * build cheap and what keeps structural sharing across the edit. The parent's
 * own `text`/delimiters are copied verbatim; its width is recomputed by the
 * `GreenNode` constructor from the new child.
 */
function spliceLeaf(leaf: RedNode, newLeaf: GreenNode): GreenNode {
  const spine: { green: GreenNode; index: number }[] = []
  let node: RedNode = leaf
  for (;;) {
    const parent: RedNode | null = node.parent
    if (parent === null) break
    spine.push({ green: parent.green, index: node.index })
    node = parent
  }

  let green = newLeaf
  for (const step of spine) {
    const children = step.green.children.slice() as GreenNode[]
    children[step.index] = green
    green = new GreenNode(
      step.green.kind,
      step.green.text,
      children,
      step.green.leadingWidth,
      step.green.trailingWidth,
    )
  }
  return green
}

function tagNames(source: string): string[] {
  const out: string[] = []
  OPENING_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OPENING_TAG.exec(source)) !== null) out.push(match[1].toLowerCase())
  return out
}

/**
 * A Markdown link, not a BBCode tag followed by prose in parentheses.
 *
 * `[color=#fff](note)` is BBCode; `[Beatmap](https://osu.ppy.sh/b/1)` is a
 * Markdown link. The label of a BBCode opener starts with a tag name, so that
 * is what decides. Quasar's tag vocabulary is shared with the sets above.
 */
function hasMarkdownLink(source: string): boolean {
  const link = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
  let match: RegExpExecArray | null
  while ((match = link.exec(source)) !== null) {
    const label = match[1]
    const head = /^\/?([a-z][a-z0-9_-]*)/i.exec(label)?.[1]?.toLowerCase()
    // A known BBCode tag followed by parentheses is BBCode prose, not a
    // Markdown link: userpages are full of `[b](note)` and `[size](x)`.
    if (head && (OSU_BBCODE_TAGS.has(head) || MILIASTRY_ONLY_TAGS.has(head))) continue
    if (label.includes('[/')) continue
    return true
  }
  return false
}

/**
 * Markdown constructs that own a BLOCK, not just a span of prose.
 *
 * These make `prefersOsuBBCode` false, but they no longer force the Markdown
 * importer when an osu! tag is present: `usesBBCodeStructure` keeps the BBCode
 * engine and `rewriteMarkdownBlocks` translates them into its own tags.
 * Inline emphasis, links and inline code were already handled inside text runs.
 */
function hasMarkdownBlockExtension(source: string): boolean {
  return /^ {0,3}#{1,6} /m.test(source)
    || /^ {0,3}```/m.test(source)
    || /^ {0,3}:::/m.test(source)
    || /^ {0,3}>/m.test(source)
    || /^ {0,3}->.*<-[ \t]*$/m.test(source)
}

/** Markdown syntax the MilHibri importer renders as Markdown, not as prose. */
function hasMarkdownExtension(source: string): boolean {
  return hasMarkdownBlockExtension(source)
    || /\*\*[^*\n]+\*\*/.test(source)
    || /\+\+[^+\n]+\+\+/.test(source)
    || /~~[^~\n]+~~/.test(source)
    || /`[^`\n]+`/.test(source)
    || hasMarkdownLink(source)
}

/**
 * Markdown-only prose that the importer would render as structure. Counted
 * only when there is no osu! tag in the document: a userpage with `[centre]`
 * and a `- item` line is BBCode prose, and osu! publishes the dash literally.
 * A Markdown document with no BBCode at all keeps its lists and emphasis.
 */
function hasPlainMarkdown(source: string): boolean {
  return /^ {0,3}[-*+]\s+\S/m.test(source)
    || /^ {0,3}\d+\.\s+\S/m.test(source)
    || /^ {0,3}<[a-z][^>]*>/im.test(source)
    || /(?<!\*)\*[^*\n]+\*(?!\*)/.test(source)
    || /(?<!\w)_[^_\n]+_(?!\w)/.test(source)
}

/**
 * Whether the BBCode engine should parse this source instead of the Markdown
 * importer.
 *
 * The default assumption is Markdown-with-BBCode (the hybrid language). The
 * BBCode engine takes over only when ALL of these hold:
 *
 *  - it contains no Miliastry/Lyne-only tag (`[neon]`, `[card]`, …);
 *  - it contains no unambiguous Markdown extension (heading, fence, `:::`, a
 *    Markdown link, emphasis, inline code);
 *  - if it contains no osu! tag at all (plain prose), it also has no list or
 *    single-emphasis Markdown, which only the Markdown importer renders.
 *
 * Ambiguous prose (`- list-looking line`, `*emphasis*`, `#1`) is deliberately
 * NOT counted when the document already has an osu! tag. osu! userpages are
 * full of it, and treating it as Markdown is exactly what makes a pasted page
 * diverge. Plain prose without BBCode stays Markdown-first, so a Markdown-only
 * document keeps its lists and italics.
 */
export function prefersOsuBBCode(source: string): boolean {
  if (source === '') return false
  const tags = tagNames(source)
  if (tags.some((tag) => MILIASTRY_ONLY_TAGS.has(tag))) return false
  if (hasMarkdownExtension(source)) return false
  const hasOsuTag = tags.some((tag) => OSU_BBCODE_TAGS.has(tag))
  if (!hasOsuTag) return !hasPlainMarkdown(source)
  return true
}

/**
 * Whether the source takes the BBCode-structure + Markdown hybrid path.
 *
 * This is not `prefersOsuBBCode`: a document with `[box]` and `**bold**` is not
 * pure BBCode (the old predicate says false), but it is still a BBCode document
 * whose prose uses Markdown. The distinction is the whole point of the hybrid.
 *
 * A Markdown BLOCK no longer disqualifies the source. `rewriteMarkdownBlocks`
 * turns headings, fences, quotes, `:::` containers, callouts, arrows and
 * (Markdown-declared) lists into the BBCode tag with the same meaning before
 * the BBCode engine runs, so the block stack is still the measured osu! one and
 * Markdown blocks can nest inside `[box]`/`[notice]` instead of replacing them.
 */
export function usesBBCodeStructure(source: string): boolean {
  if (source === '') return false
  const tags = tagNames(source)
  if (tags.some((tag) => MILIASTRY_ONLY_TAGS.has(tag))) return false
  return tags.some((tag) => OSU_BBCODE_TAGS.has(tag))
}

/**
 * DocumentEngine — MilHibriDocumentModel
 * 
 * First-class DocumentModel for the MilHibri language:
 * Unifies 100% of osu! BBCode and 100% of Markdown + Modern Industry Extensions
 * into a single unified, collision-free AST.
 */
export class MilHibriDocumentModel extends DocumentModel {
  /** Which parser built the current tree; the red builder follows it. */
  private _lastParseWasBBCode = false
  /** Whether the green tree still partitions the source byte-for-byte. */
  private _lastParseMirrorsSource = false

  constructor(options: MilHibriDocumentModelOptions = {}) {
    // Keep the caller's switches (`autoAnalyze`, `incremental`, `reuseRed`,
    // `maxUndo`): the old constructor dropped them, so a caller asking for no
    // analysis or no undo got both anyway.
    super({ ...options, source: '', language: 'milhibri' });
    if (options.source) {
      this.rebuild(options.source);
    }
  }

  static fromSource(source: string): MilHibriDocumentModel {
    return new MilHibriDocumentModel({ source });
  }

  protected parseToGreen(source: string): GreenNode {
    // A BBCode document keeps its block structure even when its prose uses
    // inline Markdown. A Markdown BLOCK (heading, fence, :::, quote, -> <-) is
    // translated into the BBCode tag with the same meaning first, so it nests
    // inside the existing block stack instead of handing the whole page to the
    // Markdown importer. The measured failure was hxovc's page: +124 KB of
    // visible markup and 262 changed lines because one token flipped parsers.
    const useBBCodeStructure = usesBBCodeStructure(source)

    if (useBBCodeStructure || prefersOsuBBCode(source)) {
      this._lastParseWasBBCode = true
      const blocks = useBBCodeStructure
        ? rewriteMarkdownBlocks(source)
        : { source, changed: false }
      this._lastParseMirrorsSource = !blocks.changed
      try {
        // The BBCode engine, not a Markdown-shaped approximation of it: this
        // is where osu!'s measured pairing, div-count closing and title rules
        // live. `pairing: 'osu'` is the same one the osu! preview uses.
        const tokens = createBBCodeScanner(blocks.source, { pairing: 'osu' })
        const green = parseTokensToGreen(tokens, blocks.source, {
          dialect: 'osu',
          pairing: 'osu',
          strictMode: false,
          normalizeParagraphs: true,
          extraTags: this.tagRegistry.customTags() ?? undefined,
        })

        if (!useBBCodeStructure) return green

        // Block structure is now fixed. Translate Markdown inline syntax only
        // inside text leaves, so `**bold**` and `[label](url)` work without
        // asking the Markdown importer to rebuild the BBCode blocks.
        const hybrid = applyMarkdownInlineToGreen(green)
        this._lastParseMirrorsSource = this._lastParseMirrorsSource && !hybrid.changed
        return hybrid.green
      } catch (error) {
        console.warn('[MilHibriDocumentModel] BBCode parse error:', error);
        this._lastParseMirrorsSource = !blocks.changed;
        return greenLeaf('text', source);
      }
    }

    this._lastParseWasBBCode = false
    this._lastParseMirrorsSource = false
    try {
      const tokens = scanMarkdown(source);
      // BBCode's line rule, not Markdown's: a newline ends the line. Without
      // this a pasted userpage collapses every line into one soft paragraph.
      const ast = parseMarkdown(tokens, { lineBreaks: 'hard' });
      return markdownAstToGreenTree(ast);
    } catch (error) {
      console.warn('[MilHibriDocumentModel] Parse error:', error);
      return greenLeaf('text', source);
    }
  }

  /**
   * A BBCode tree partitions its source; a Markdown translation does not.
   * The flag is set by `parseToGreen` immediately before the red build, so
   * validation follows whichever parser actually ran. A BBCode tree with
   * inline Markdown translated stops mirroring the source too: the markers
   * are syntax, and the imported tree describes the translation. The same is
   * true when Markdown blocks were rewritten into BBCode tags first.
   */
  protected get treeMirrorsSource(): boolean {
    return this._lastParseMirrorsSource
  }

  protected buildRedFromGreen(green: GreenNode): RedNode {
    return this._lastParseWasBBCode
      ? bbcodeGreenToRedNode(green)
      : markdownGreenToRedNode(green)
  }

  /**
   * The edit path: a text-leaf splice when the change is plain prose inside
   * one leaf, the full import otherwise.
   *
   * The hybrid parser cannot be windowed like pure BBCode: `rewriteMarkdownBlocks`
   * and the inline pass change the shape of a whole document based on syntax
   * outside any one block, so re-parsing a window would have to know the mode
   * of the document it belongs to. A leaf splice sidesteps that: it keeps the
   * structure the last full import decided and only edits the characters the
   * user typed. Typing a letter into a 40 KB userpage becomes a path rebuild
   * instead of a whole page re-import, and anything that touches syntax falls
   * back to the measured full path.
   */
  applyChange(change: TextChange, origin: string = 'local', resultingSource?: string): void {
    const oldSource = this.source
    const removedText = oldSource.slice(change.start, change.end)
    const expectedLength = change.start + change.text.length + (oldSource.length - change.end)
    const newSource = resultingSource !== undefined && resultingSource.length === expectedLength
      ? resultingSource
      : oldSource.slice(0, change.start) + change.text + oldSource.slice(change.end)
    if (newSource === oldSource) return

    this.changeTracker.track(change)

    if (this.tryTextLeafSplice(change, oldSource, newSource, removedText, origin)) return
    // A rebuild is not a window: say so, rather than leaving the previous
    // edit's path on the public API for the next reader.
    this.lastReparsePath = 'full_rebuild'
    this.lastReparseFallbackReason = null
    this.lastReparseIsolation = null
    this.lastReparseTimings = null
    this.lastReparseWindow = null
    this.rebuild(newSource)
  }

  /**
   * Try the leaf-only route, and return whether it adopted the edit.
   *
   * Every guard here is a reason a leaf splice could be WRONG, not a reason it
   * could be slow; the speed comes from not running the import, so the guards
   * must be conservative. A false negative costs one full rebuild; a false
   * positive would show the wrong document, so ambiguity is always a no.
   */
  private tryTextLeafSplice(
    change: TextChange,
    oldSource: string,
    newSource: string,
    removedText: string,
    origin: string,
  ): boolean {
    // Below the incremental parser's own crossover a rebuild is cheaper than
    // the traversal + red build, and small documents are exactly where the
    // full import is already sub-millisecond.
    if (newSource.length < 4000) return false
    // Only a tree that PARTITIONS the source has leaf widths usable as source
    // offsets (and text leaves that are one lexical run). A translated tree —
    // Markdown blocks rewritten, inline Markdown converted — has no source map
    // for its zero-width leaves, so a one-leaf splice is not provably
    // equivalent there; it keeps the measured full rebuild.
    if (!this.treeMirrorsSource) return false
    if (!canSpliceAsPlainText(change.text) || !canSpliceAsPlainText(removedText)) return false
    if (isInsideSyntax(oldSource, change.start)) return false

    // A leading space can turn a line into an indented code block or move a
    // list item a level; the old tree must not keep its old block role.
    const lineStart = oldSource.lastIndexOf('\n', change.start - 1) + 1
    if (change.start === lineStart && (change.text.includes(' ') || removedText.includes(' '))) return false

    // Table rows are the one Markdown block the hybrid does NOT rewrite into
    // BBCode. Their cell boundaries are decided while parsing the line, so a
    // one-leaf splice inside one can disagree with a full import even when the
    // typed character is a letter. Headings/lists/quotes/fences are rewritten
    // and safe, but they still cost only a rebuild, so reject every block-
    // looking line: this stays a speed switch, never a correctness one.
    const lineEnd = oldSource.indexOf('\n', change.end)
    const line = oldSource.slice(lineStart, lineEnd === -1 ? oldSource.length : lineEnd).trimStart()
    if (/^(?:\||>{1,}|#{1,6}\s|```|:::|-{1,3}\s|\*\s|\+\s|\d+\.\s)/.test(line)) return false
    const root = this.redRoot
    if (root === null) return false

    const hit = findTextLeaf(root, oldSource, change, removedText)
    if (hit === null) return false
    const oldText = hit.leaf.text
    const newText = oldText.slice(0, hit.at) + change.text + oldText.slice(hit.at + removedText.length)
    if (newText === oldText) return false

    // A BBCode text leaf's width IS its text; an importer's translated leaf
    // may deliberately be zero-width (the Markdown importer gives every text
    // node width 0, because its widths describe the translation, not the
    // source). Preserve that convention instead of suddenly charging the new
    // text to the root and inflating every range above it.
    const oldGreen = hit.leaf.green
    const newWidth = oldGreen.width === oldText.length ? newText.length : oldGreen.width
    const newLeaf = new GreenNode('text', newText, [], 0, 0, newWidth)
    const green = spliceLeaf(hit.leaf, newLeaf)
    // The splice rebuilds only the spine; every sibling is the same green
    // object as before. The reuse builder turns that into the same red object
    // too, so a keystroke allocates the edited leaf and its ancestors instead
    // of all ~3.2k nodes.
    const red = greenToRedNodeReusing(green, root)
    this.adoptTextLeafSplice(newSource, green, change, origin, 'text_leaf', red)
    return true
  }
}
