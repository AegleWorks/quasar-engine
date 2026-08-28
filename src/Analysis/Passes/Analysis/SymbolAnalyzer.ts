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
import { childOffsets } from '../../../Syntax/GreenNode'

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
 * `code` and `inline_code` are the lexer's raw tags (`BBCODE_RAW_TAGS`): their
 * content is literal by definition, and a user who typed `✧` inside a code
 * block meant that exact character. `image` holds a URL as its child text,
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
  { name: 'symbols-arrows',   first: 0x2b00,  last: 0x2bff,  confidence: 0.90 },
  // Astral emoji — always two UTF-16 units, see `scanText`.
  { name: 'pictographs',      first: 0x1f300, last: 0x1f5ff, confidence: 0.85 },
  { name: 'emoticons',        first: 0x1f600, last: 0x1f64f, confidence: 0.85 },
  { name: 'supplemental',     first: 0x1f900, last: 0x1f9ff, confidence: 0.85 },
]

function blockOf(codePoint: number): SymbolBlock | null {
  for (const block of SYMBOL_BLOCKS) {
    if (codePoint >= block.first && codePoint <= block.last) return block
  }
  return null
}

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
      this.scanText(node.text, start, sink)
      return
    }

    const children = node.children as readonly GreenNode[]
    if (children.length === 0) return

    const offsets = childOffsets(node, start)
    for (let i = 0; i < children.length; i++) {
      this.walk(children[i], sink, offsets[i])
    }
  }

  /**
   * Find runs of decorative glyphs in one text leaf.
   *
   * Iterates by code point, not by index: an astral symbol such as `🌸`
   * occupies two UTF-16 units, and stepping one unit at a time would split it
   * into unpaired surrogates that match no block. The offsets recorded stay in
   * UTF-16 units so they address the source directly.
   */
  private scanText(text: string, textStart: number, sink: Contribution[]): void {
    let run: SymbolGlyph[] = []

    const flush = () => {
      if (run.length > 0) {
        sink.push(this.toContribution(text, textStart, run))
        run = []
      }
    }

    let i = 0
    while (i < text.length) {
      const codePoint = text.codePointAt(i)!
      const width = codePoint > 0xffff ? 2 : 1
      const block = blockOf(codePoint)

      if (block) {
        run.push({
          char: String.fromCodePoint(codePoint),
          codePoint,
          block: block.name,
          start: textStart + i,
          end: textStart + i + width,
        })
      } else {
        flush()
      }

      i += width
    }

    flush()
  }

  private toContribution(
    text: string,
    textStart: number,
    glyphs: readonly SymbolGlyph[],
  ): Contribution {
    const start = glyphs[0].start
    const end = glyphs[glyphs.length - 1].end
    const isSeparator = glyphs.length >= MIN_SEPARATOR_LENGTH

    const blocks: string[] = []
    for (const glyph of glyphs) {
      if (!blocks.includes(glyph.block)) blocks.push(glyph.block)
    }

    // The lowest base wins: a run is only as safely ornamental as its least
    // ornamental glyph, so `≈≈≈` stays more doubtful than `✧✧✧`.
    let confidence = Math.min(...glyphs.map(g => blockOf(g.codePoint)!.confidence))
    if (isSeparator) confidence = Math.min(MAX_CONFIDENCE, confidence + SEPARATOR_BONUS)

    const model: SymbolRunModel = {
      text: text.slice(start - textStart, end - textStart),
      glyphs,
      blocks,
      length: glyphs.length,
      isSeparator,
    }

    return {
      kind: ContributionKind.Semantic,
      label: isSeparator ? 'Separator' : 'Symbol',
      confidence,
      range: { start, end },
      metadata: { model },
      description: isSeparator
        ? `Separator of ${glyphs.length} glyphs (${blocks.join(', ')})`
        : `Decorative symbol ${model.text} (${blocks.join(', ')})`,
    }
  }
}
