/**
 * Quasar Analysis Framework — Symbol Analyzer
 *
 * Detects decorative Unicode glyphs — `✧ ⚔ ☽ ━ ◈` — in document text and
 * reports them as SemanticContributions.
 *
 * The colour analyzers recognise structure that BBCode itself encodes: a
 * gradient is a *sequence of tags*, so the tree already separates it from the
 * prose around it. Symbols have no such marker. They are ordinary characters
 * inside ordinary text nodes, indistinguishable at the syntax level from the
 * words beside them. Recognising them therefore has to happen at the character
 * level, against the Unicode blocks they come from.
 *
 * ## Runs, not characters
 *
 * Symbols are reported as contiguous *runs*, because the two ways a document
 * uses them need different treatment:
 *
 *   `✧ airi ✧`      two one-glyph runs — ornaments framing a word
 *   `✧⋆⋅⋆⋅⋆✧`       one seven-glyph run — a divider line
 *
 * Swapping the first means substituting glyph for glyph. Swapping the second
 * means replacing the whole line with a different divider. A run of
 * `MIN_SEPARATOR_LENGTH` or more is labelled `Separator`; anything shorter is
 * labelled `Symbol`. Both carry per-glyph offsets in their metadata, so a
 * consumer can address either the run or its individual characters.
 *
 * ## Confidence
 *
 * Detection is exact — a code point is either in a decorative block or it is
 * not. Confidence answers the question that actually matters: is this glyph
 * *ornamental*, or does it carry meaning? A dingbat is almost always
 * decoration; `≈` in a sentence is probably arithmetic, and re-theming it
 * would corrupt the text.
 *
 * Each block carries a base confidence, a run takes the *lowest* of its
 * members — a run is only as safely ornamental as its least ornamental glyph —
 * and separator-length runs receive a bonus, because a seven-character line of
 * symbols is decoration regardless of which blocks it draws from.
 *
 * @see SemanticContribution
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'

// ── Constants ─────────────────────────────────────────────────────

/** Runs at least this long read as a divider rather than as ornaments. */
const MIN_SEPARATOR_LENGTH = 3

/** Added to a separator-length run, on top of its lowest block confidence. */
const SEPARATOR_BONUS = 0.25

/** Confidence is never reported as certainty. */
const MAX_CONFIDENCE = 0.99

/**
 * Node kinds whose text is not prose and must never be re-themed.
 *
 * `code` and `inline_code` hold code: a user who typed `✧` inside one meant
 * that exact character. (`[c]` parses tags inside it, but its glyphs are
 * still the author's code, so it stays opaque here by choice.) `image` holds a URL as its child text,
 * where a matching code point would be part of an address, not decoration.
 */
const OPAQUE_KINDS: ReadonlySet<string> = new Set(['code', 'inline_code', 'image'])

// ── Unicode blocks ────────────────────────────────────────────────

interface SymbolBlock {
  readonly name: string
  readonly first: number
  readonly last: number
  /** How reliably a glyph from this block is decoration rather than content. */
  readonly confidence: number
}

/**
 * The decorative blocks, ordered by code point.
 *
 * Deliberately narrower than "everything that is not a letter". Latin
 * punctuation, currency signs and CJK are all excluded: they appear in real
 * prose, and a re-theming pass that rewrote them would be destroying text
 * rather than restyling it.
 */
const SYMBOL_BLOCKS: readonly SymbolBlock[] = [
  // Arrows and maths are the least certain: `→` and `≈` are ordinary in prose.
  { name: 'arrows',           first: 0x2190,  last: 0x21ff,  confidence: 0.65 },
  { name: 'math-operators',   first: 0x2200,  last: 0x22ff,  confidence: 0.60 },
  { name: 'technical',        first: 0x2300,  last: 0x23ff,  confidence: 0.80 },
  // Box drawing exists only to draw boxes and rules.
  { name: 'box-drawing',      first: 0x2500,  last: 0x257f,  confidence: 0.95 },
  { name: 'block-elements',   first: 0x2580,  last: 0x259f,  confidence: 0.90 },
  { name: 'geometric',        first: 0x25a0,  last: 0x25ff,  confidence: 0.90 },
  { name: 'misc-symbols',     first: 0x2600,  last: 0x26ff,  confidence: 0.90 },
  { name: 'dingbats',         first: 0x2700,  last: 0x27bf,  confidence: 0.95 },
  // Misc Math Symbols-A (`⟡` U+27E1, `⟪`, `⟫`) & Supplemental (`⫘` U+2AD8).
  { name: 'math-symbols-a',   first: 0x27c0,  last: 0x27ef,  confidence: 0.85 },
  { name: 'math-symbols-b',   first: 0x2980,  last: 0x29ff,  confidence: 0.80 },
  { name: 'math-supp',        first: 0x2a00,  last: 0x2aff,  confidence: 0.75 },
  { name: 'symbols-arrows',   first: 0x2b00,  last: 0x2bff,  confidence: 0.90 },
  // Javanese ornamental brackets (`꧁`, `꧂`) widely used in osu! profiles.
  { name: 'ornaments',        first: 0xa9c1,  last: 0xa9c2,  confidence: 0.90 },
  // Astral emoji — always two UTF-16 units, see `scanSymbolText`.
  { name: 'pictographs',      first: 0x1f300, last: 0x1f5ff, confidence: 0.85 },
  { name: 'emoticons',        first: 0x1f600, last: 0x1f64f, confidence: 0.85 },
  { name: 'transport',        first: 0x1f680, last: 0x1f6ff, confidence: 0.85 },
  { name: 'supplemental',     first: 0x1f900, last: 0x1f9ff, confidence: 0.85 },
  { name: 'emoji-ext-a',      first: 0x1fa70, last: 0x1faff, confidence: 0.85 },
]

const EMOJI_FLAG_BLOCK: SymbolBlock = {
  name: 'emoji-flag',
  first: 0x1f1e6,
  last: 0x1f1ff,
  // Flags carry geographic/identity meaning, so keep below 0.7 (opt-in review).
  confidence: 0.55,
}

const ASCII_DIVIDER_BLOCK: SymbolBlock = {
  name: 'ascii-divider',
  first: 0x2a,
  last: 0x7e,
  confidence: 0.65, // + SEPARATOR_BONUS (0.25) = 0.90
}

const UNICODE_DASH_BLOCK: SymbolBlock = {
  name: 'unicode-dash',
  first: 0x2013,
  last: 0xfe4f,
  confidence: 0.65, // + SEPARATOR_BONUS (0.25) = 0.90
}

const BULLET_BLOCK: SymbolBlock = {
  name: 'bullet',
  first: 0x2022,
  last: 0x2023,
  confidence: 0.65,
}

function blockOf(codePoint: number): SymbolBlock | null {
  for (let i = 0; i < SYMBOL_BLOCKS.length; i++) {
    const block = SYMBOL_BLOCKS[i]
    if (codePoint >= block.first && codePoint <= block.last) return block
  }
  if (codePoint === 0x2022 || codePoint === 0x2023) return BULLET_BLOCK
  return null
}

/** True for Regional Indicator letters `🇦`–`🇿` (paired into country flags). */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff
}

/** True for Emoji skin-tone modifiers `🏻`–`🏿`. */
function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff
}

/** True for Variation Selectors (VS15 text / VS16 emoji). */
function isVariationSelector(cp: number): boolean {
  return cp === 0xfe0f || cp === 0xfe0e
}

/** True for horizontal rule / wave dashes that only count as dividers when repeated. */
function isUnicodeDash(cp: number): boolean {
  return (
    cp === 0x2014 || // — EM DASH
    cp === 0x2015 || // ― HORIZONTAL BAR
    cp === 0x2017 || // ‗ DOUBLE LOW LINE
    cp === 0x2e3b || // ⸻ THREE-EM DASH
    cp === 0x3030 || // 〰 WAVY DASH
    cp === 0xfe4f    // ﹏ WAVY LOW LINE
  )
}

/** True for ASCII characters that form divider rules when repeated (>= 4 chars). */
function isAsciiDividerChar(cp: number): boolean {
  return (
    cp === 0x2d || // -
    cp === 0x3d || // =
    cp === 0x5f || // _
    cp === 0x7e || // ~
    cp === 0x2a    // *
  )
}

/** True for whitespace characters that can bridge ornaments inside a single divider line. */
function isLineSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x2800 || cp === 0x3000
}

/**
 * Fast pre-check before per-code-point scanning: matches either any non-ASCII
 * decorative range (`>= U+2014`) OR an ASCII divider run (`>= 4` rule chars
 * or spaced rule chars like `- - - -`). Rejects ordinary prose in one native
 * vectorised scan.
 */
const MAYBE_SYMBOL = /[\u2014-\uFFFF]|[-=_~*]{4}|(?:[-=_~*][ \t]){3}[-=_~*]/

/** Minimum length of a pure ASCII divider (`----`, `====`, `~~~~`, `____`, `****`). */
const MIN_ASCII_DIVIDER_LENGTH = 4

// ── Types ─────────────────────────────────────────────────────────

export interface SymbolGlyph {
  readonly char: string
  readonly codePoint: number
  /** Unicode block name this glyph was matched in. */
  readonly block: string
  /** Absolute source offsets, UTF-16 code units — `source.slice(start, end)`. */
  readonly start: number
  readonly end: number
}

export interface SymbolRunModel {
  /** The run exactly as it appears in the source. */
  readonly text: string
  readonly glyphs: readonly SymbolGlyph[]
  /** Distinct block names present, in first-seen order. */
  readonly blocks: readonly string[]
  /** Length in glyphs — not in UTF-16 units, which astral symbols inflate. */
  readonly length: number
  /** Whether the run was long enough to read as a divider. */
  readonly isSeparator: boolean
}

function blockConfidence(blockName: string): number {
  for (let i = 0; i < SYMBOL_BLOCKS.length; i++) {
    if (SYMBOL_BLOCKS[i].name === blockName) return SYMBOL_BLOCKS[i].confidence
  }
  if (blockName === EMOJI_FLAG_BLOCK.name) return EMOJI_FLAG_BLOCK.confidence
  if (blockName === ASCII_DIVIDER_BLOCK.name) return ASCII_DIVIDER_BLOCK.confidence
  if (blockName === UNICODE_DASH_BLOCK.name) return UNICODE_DASH_BLOCK.confidence
  if (blockName === BULLET_BLOCK.name) return BULLET_BLOCK.confidence
  return 0.7
}

/**
 * Consume trailing emoji modifiers (VS16/VS15, skin-tone, and ZWJ sequences)
 * attached to a matched emoji/symbol base so `⚙️`, `❤️`, `🖥️`, `👨‍💻`, and
 * `🏳️‍⚧️` stay a single atomic glyph with no dangling `\uFE0F` or `\u200D`.
 */
function consumeEmojiClusterEnd(text: string, afterBase: number): number {
  let end = afterBase
  while (end < text.length) {
    const next = text.codePointAt(end)!
    const w = next > 0xffff ? 2 : 1
    if (isVariationSelector(next) || isSkinTone(next)) {
      end += w
      continue
    }
    if (next === 0x200d /* ZWJ */ && end + 1 < text.length) {
      const joined = text.codePointAt(end + 1)!
      const jw = joined > 0xffff ? 2 : 1
      if (blockOf(joined) !== null || isRegionalIndicator(joined)) {
        end += 1 + jw
        continue
      }
    }
    break
  }
  return end
}

/**
 * Scan one line slice (no `\n`) for decorative glyphs, emoji clusters,
 * Unicode dash dividers, ASCII dividers, and space-bridged pure divider lines.
 */
function scanLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  textStart: number,
  sink: Contribution[],
): void {
  const emitRun = (glyphs: SymbolGlyph[], forceSeparator: boolean): void => {
    if (glyphs.length === 0) return
    const start = glyphs[0].start
    const end = glyphs[glyphs.length - 1].end
    const isSeparator = forceSeparator || glyphs.length >= MIN_SEPARATOR_LENGTH

    const blocks: string[] = []
    let minConf = 1
    for (let i = 0; i < glyphs.length; i++) {
      const b = glyphs[i].block
      if (!blocks.includes(b)) blocks.push(b)
      const c = blockConfidence(b)
      if (c < minConf) minConf = c
    }

    let confidence = minConf
    if (isSeparator) confidence = Math.min(MAX_CONFIDENCE, confidence + SEPARATOR_BONUS)

    const model: SymbolRunModel = {
      text: text.slice(start - textStart, end - textStart),
      glyphs,
      blocks,
      length: glyphs.length,
      isSeparator,
    }

    sink.push({
      kind: ContributionKind.Semantic,
      label: isSeparator ? 'Separator' : 'Symbol',
      confidence,
      range: { start, end },
      metadata: { model },
      description: isSeparator
        ? `Separator of ${glyphs.length} glyphs (${blocks.join(', ')})`
        : `Decorative symbol ${model.text} (${blocks.join(', ')})`,
    })
  }

  // Track whether the entire line contains ONLY decorative glyphs + line
  // spaces (no prose letters/digits/punctuation). If so, space-bridged
  // dividers like `━━━━━━━━ ⟡ ━━━━━━━━` or `✦ ◇ ✦` merge into ONE Separator.
  let lineIsPureDivider = true
  const lineRuns: Array<{ glyphs: SymbolGlyph[]; forceSeparator: boolean }> = []
  let run: SymbolGlyph[] = []
  let runForceSep = false

  const flushRun = (): void => {
    if (run.length === 0) return
    lineRuns.push({ glyphs: run, forceSeparator: runForceSep })
    run = []
    runForceSep = false
  }

  let i = lineStart
  while (i < lineEnd) {
    const codePoint = text.codePointAt(i)!
    const width = codePoint > 0xffff ? 2 : 1

    // 1. Regional Indicator Flag pair (`🇨🇴`, `🇯🇵`, `🇺🇸`)
    if (isRegionalIndicator(codePoint) && i + width < lineEnd) {
      const next = text.codePointAt(i + width)!
      if (isRegionalIndicator(next)) {
        const end = i + width + (next > 0xffff ? 2 : 1)
        run.push({
          char: text.slice(i, end),
          codePoint,
          block: EMOJI_FLAG_BLOCK.name,
          start: textStart + i,
          end: textStart + end,
        })
        i = end
        continue
      }
    }

    // 2. Standard decorative / emoji Unicode blocks (with full VS16/skin/ZWJ cluster)
    const block = blockOf(codePoint)
    if (block) {
      const clusterEnd = consumeEmojiClusterEnd(text, i + width)
      run.push({
        char: text.slice(i, clusterEnd),
        codePoint,
        block: block.name,
        start: textStart + i,
        end: textStart + clusterEnd,
      })
      i = clusterEnd
      continue
    }

    // 3. Unicode horizontal rule / wave dashes (`———`, `―――`, `⸻`, `〰〰〰`)
    // Only treated as decoration when repeated (>= MIN_SEPARATOR_LENGTH) or `⸻`
    // (three-em dash) or already adjacent to a decorative run.
    if (isUnicodeDash(codePoint)) {
      let j = i + width
      let count = 1
      while (j < lineEnd) {
        const next = text.codePointAt(j)!
        if (!isUnicodeDash(next)) break
        j += next > 0xffff ? 2 : 1
        count++
      }
      if (count >= MIN_SEPARATOR_LENGTH || codePoint === 0x2e3b || run.length > 0) {
        let k = i
        while (k < j) {
          const cp = text.codePointAt(k)!
          const w = cp > 0xffff ? 2 : 1
          run.push({
            char: text.slice(k, k + w),
            codePoint: cp,
            block: UNICODE_DASH_BLOCK.name,
            start: textStart + k,
            end: textStart + k + w,
          })
          k += w
        }
        if (codePoint === 0x2e3b) runForceSep = true
        i = j
        continue
      }
      // Single em-dash in prose (`boredom — just trying`): not decoration.
      lineIsPureDivider = false
      flushRun()
      i = j
      continue
    }

    // 4. ASCII divider runs (`----`, `====`, `~~~~`, `____`, `****`)
    // Must be >= 4 chars and not glued to word characters (`foo----bar`).
    if (isAsciiDividerChar(codePoint)) {
      let j = i + 1
      while (j < lineEnd && isAsciiDividerChar(text.charCodeAt(j))) j++
      const len = j - i
      const prevOk = i === lineStart || isLineSpace(text.codePointAt(i - 1)!) || run.length > 0
      const nextOk = j === lineEnd || isLineSpace(text.codePointAt(j)!)
      if (len >= MIN_ASCII_DIVIDER_LENGTH && prevOk && nextOk) {
        for (let k = i; k < j; k++) {
          const cp = text.charCodeAt(k)
          run.push({
            char: text[k],
            codePoint: cp,
            block: ASCII_DIVIDER_BLOCK.name,
            start: textStart + k,
            end: textStart + k + 1,
          })
        }
        runForceSep = true
        i = j
        continue
      }
      lineIsPureDivider = false
      flushRun()
      i = j
      continue
    }

    if (isLineSpace(codePoint)) {
      flushRun()
      i += width
      continue
    }

    // Any other character (letters, digits, prose punctuation) breaks pure-divider mode.
    lineIsPureDivider = false
    flushRun()
    i += width
  }

  flushRun()

  if (lineRuns.length === 0) return

  // Space-bridged pure divider line (`━━━━━━━━ ⟡ ━━━━━━━━`, `✦ ◇ ✦`, `━ ━ ━ ━`):
  // require >= 3 runs that are either symmetric (`first === last`) or all
  // identical, so a catalogue of distinct symbols (`✧ ⚔ ☽ ◈ ⌬ ☄`) or a pair
  // (`✧ ━━━━━━`) stays separate.
  if (lineIsPureDivider && lineRuns.length >= 3) {
    const sliceOf = (r: { glyphs: SymbolGlyph[] }) =>
      text.slice(r.glyphs[0].start - textStart, r.glyphs[r.glyphs.length - 1].end - textStart)
    const firstText = sliceOf(lineRuns[0])
    const lastText = sliceOf(lineRuns[lineRuns.length - 1])
    const symmetric = firstText === lastText
    let allSame = true
    for (let r = 1; r < lineRuns.length; r++) {
      if (sliceOf(lineRuns[r]) !== firstText) {
        allSame = false
        break
      }
    }
    if (symmetric || allSame) {
      const merged: SymbolGlyph[] = []
      for (let r = 0; r < lineRuns.length; r++) {
        const g = lineRuns[r].glyphs
        for (let k = 0; k < g.length; k++) merged.push(g[k])
      }
      emitRun(merged, true)
      return
    }
  }

  for (let r = 0; r < lineRuns.length; r++) {
    emitRun(lineRuns[r].glyphs, lineRuns[r].forceSeparator)
  }
}

/**
 * Find the decorative runs in one text leaf and append their contributions.
 *
 * Module-level because the restyle analyzer scans the same text in the same
 * single pass as the colour and gradient work; a second implementation would
 * be a second opinion about what a symbol is.
 */
export function scanSymbolText(
  text: string,
  textStart: number,
  sink: Contribution[],
): void {
  if (!MAYBE_SYMBOL.test(text)) return

  let lineStart = 0
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    if (lineEnd > lineStart) {
      scanLine(text, lineStart, lineEnd, textStart, sink)
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
}

// ── Analyzer ──────────────────────────────────────────────────────

export class SymbolAnalyzer implements AnalyzerPass {
  readonly id = 'symbol'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.walk(tree, contributions, 0)
    return contributions
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Descend the tree, accumulating absolute offsets.
   *
   * Green nodes carry widths rather than positions (see `GreenNode.ts`), so
   * the offsets a Contribution reports are built on the way down. Only `text`
   * leaves are scanned: an element node's own `text` holds its attributes
   * (`=#D194B3`), which are syntax, not content.
   */
  private walk(node: GreenNode, sink: Contribution[], start: number): void {
    if (OPAQUE_KINDS.has(node.kind)) return

    if (node.kind === 'text') {
      scanSymbolText(node.text, start, sink)
      return
    }

    const children = node.children as readonly GreenNode[]
    if (children.length === 0) return

    // Accumulate, don't allocate: see the note in `ColorUsageAnalyzer`.
    let offset = start + node.leadingWidth
    for (let i = 0; i < children.length; i++) {
      this.walk(children[i], sink, offset)
      offset += children[i].width
    }
  }
}
