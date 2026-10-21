/**
 * DocumentEngine — Formatter
 *
 * Pretty-prints a document tree as canonical BBCode.
 *
 * ─── What this used to be ──────────────────────────────────────────────────
 *
 * The formatter walked the tree and joined the children. It never emitted a
 * delimiter, so `format('[b]Hello[/b]')` returned `Hello` — every tag in the
 * document was silently deleted. Its four options (`indent`, `blockNewlines`,
 * `maxLineWidth`, `normalizeInlineWhitespace`) were declared, typed, passed
 * through the public API and read by nobody. A formatter that deletes the
 * author's markup is worse than no formatter: it looks like it worked.
 *
 * ─── What it is now ────────────────────────────────────────────────────────
 *
 * Serialization is delegated to `BBCodeExporter`, which is the one component
 * that knows every tag spelling, attribute rule and escaping rule. Formatting
 * is then a set of WHITESPACE transforms over that canonical text, each one
 * opt-in, so the default result is the document with its markup intact.
 *
 * `[code]` blocks are opaque: none of the transforms touch a character inside
 * one. Code is content, and a formatter that reflows it has corrupted it.
 *
 * ─── Determinism ───────────────────────────────────────────────────────────
 *
 * No timestamps, no ids, no locale. The same tree and the same options produce
 * the same string, byte for byte, on every run and every machine.
 */

import { RedNode } from '../Syntax/RedNode'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

export interface FormatOptions {
  /**
   * Put a blank line before every block-opening tag. Makes the source read as
   * blocks instead of a wall of markup. Off by default because a blank line is
   * a real empty line in BBCode, so this changes the rendered document — it is
   * a formatting choice, not a no-op.
   */
  blockNewlines?: boolean
  /**
   * Collapse runs of spaces and tabs outside tags to a single space. Line
   * breaks and `[code]` content are untouched.
   */
  normalizeInlineWhitespace?: boolean
  /**
   * Collapse three or more line breaks to two (one blank line) outside
   * `[code]` blocks. Off by default: runs of newlines are author-visible space.
   */
  collapseEmptyLines?: boolean
}

export class Formatter {
  /**
   * Format a red tree as canonical BBCode.
   *
   * The default call preserves the document's markup and content and returns
   * the exporter's canonical spelling (`[B]` → `[b]`, an unquoted colour
   * normalised per target). Pass options to also normalise layout.
   */
  format(root: RedNode | null, options: FormatOptions = {}): string {
    if (root === null) return ''
    const exporter = new BBCodeExporter(undefined, 'miliastry')
    let out = exporter.export(root)

    if (options.collapseEmptyLines === true) out = collapseEmptyLines(out)
    if (options.normalizeInlineWhitespace === true) out = normalizeInlineWhitespace(out)
    if (options.blockNewlines === true) out = ensureBlockNewlines(out)
    return out
  }
}

// ─── Transforms ────────────────────────────────────────────────

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function collapseEmptyLines(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCode = false
  let previousBlank = false

  for (const line of lines) {
    if (inCode) {
      out.push(line)
      if (/\[\/code\]/i.test(line)) inCode = false
      continue
    }
    if (isBlank(line)) {
      // Keep the first blank line of a run, drop the rest entirely: keeping an
      // empty string for each would still join back into the same run.
      if (!previousBlank) out.push(line)
      previousBlank = true
      continue
    }
    out.push(line)
    previousBlank = false
    if (/\[code(?:=|\])/i.test(line) && !/\[\/code\]/i.test(line)) inCode = true
  }
  return out.join('\n')
}

/** `[code]` / `[code=…]` opening a raw block. Sticky: matched at an index. */
const CODE_OPEN_AT = /\[code(?:=[^\]]*)?\]/iy
/** `[/code]` closing it. Sticky. */
const CODE_CLOSE_AT = /\[\/code\]/iy
/** A block opener. Sticky, so the scanner can test without slicing the text. */
const BLOCK_TAG_AT = /\[(heading|list|quote|code|notice|wnotice|spoilerbox|box|boxw|centre|center|right|left|align|imagemap|tables|gallery|columns|separator|scroll|container|effect|anim|style|svg)(?:=|\])/iy

/** `text` from `index` if `pattern` matches there, else null. */
function matchAt(pattern: RegExp, text: string, index: number): string | null {
  pattern.lastIndex = index
  const match = pattern.exec(text)
  return match === null ? null : match[0]
}

/**
 * Put a blank line before every block-opening tag.
 *
 * One scanner over the whole text rather than a line loop: a block can begin
 * mid-line (`intro[heading]Title[/heading]`), and the decision is always the
 * same — look at what this formatter has already emitted. Inside `[code]`
 * nothing is inspected, so a literal `[heading]` in a code sample is safe.
 */
function ensureBlockNewlines(text: string): string {
  const parts: string[] = []
  let inCode = false
  /** Consecutive line breaks at the end of the output, capped at 2. */
  let trailingBreaks = 0

  const append = (chunk: string): void => {
    if (chunk === '') return
    parts.push(chunk)
    // Tracking this as an integer avoids `endsWith` on the whole output, which
    // flattens the rope and makes a document full of blocks quadratic.
    if (chunk.endsWith('\n\n')) trailingBreaks = 2
    else if (chunk.endsWith('\n')) trailingBreaks = Math.min(2, trailingBreaks + 1)
    else trailingBreaks = 0
  }

  let i = 0
  while (i < text.length) {
    if (inCode) {
      CODE_CLOSE_INLINE.lastIndex = i
      const close = CODE_CLOSE_INLINE.exec(text)
      if (close === null) {
        append(text.slice(i))
        break
      }
      const end = close.index + close[0].length
      append(text.slice(i, end))
      i = end
      inCode = false
      continue
    }

    // Copy plain text in whole chunks instead of one character at a time.
    const next = text.indexOf('[', i)
    if (next === -1) {
      append(text.slice(i))
      break
    }
    append(text.slice(i, next))

    const open = matchAt(CODE_OPEN_AT, text, next)
    if (open !== null) {
      append(open)
      i = next + open.length
      inCode = true
      continue
    }
    if (matchAt(BLOCK_TAG_AT, text, next) !== null && parts.length > 0 && trailingBreaks < 2) {
      // One newline already present needs one more to become a blank line.
      append(trailingBreaks === 0 ? '\n\n' : '\n')
    }

    // Copy the whole bracket span, so a `[heading]` inside an attribute value
    // is never mistaken for a block opener. Unbalanced `[` runs to EOF, the
    // same region the char scanner used to treat as "inside a tag".
    let depth = 0
    let j = next
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) { j++; break }
      }
    }
    append(text.slice(next, j))
    i = j
  }
  return parts.join('')
}

/**
 * Collapse spaces/tabs outside tags and outside code.
 *
 * Newlines are kept. Bracket spans are copied verbatim, including spaces in an
 * attribute (`[box=My Title]`) and in a quoted URL.
 */
function normalizeInlineWhitespace(text: string): string {
  const lines = text.split('\n')
  let inCode = false
  const out: string[] = []

  for (const line of lines) {
    if (inCode) {
      out.push(line)
      if (/\[\/code\]/i.test(line)) inCode = false
      continue
    }
    const parts: string[] = []
    let at = 0
    // A `[code]…[/code]` span can start and end inside one line. Search from
    // the current index instead of slicing the rest of the line per span.
    while (at < line.length) {
      CODE_OPEN_INLINE.lastIndex = at
      const openMatch = CODE_OPEN_INLINE.exec(line)
      if (openMatch === null) {
        parts.push(collapseSpacesOutsideTags(line.slice(at)))
        break
      }
      const openStart = openMatch.index
      parts.push(collapseSpacesOutsideTags(line.slice(at, openStart)))
      const afterOpen = openStart + openMatch[0].length
      CODE_CLOSE_INLINE.lastIndex = afterOpen
      const closeMatch = CODE_CLOSE_INLINE.exec(line)
      if (closeMatch === null) {
        // The opener belongs to the protected span too, not just its content.
        parts.push(line.slice(openStart))
        inCode = true
        break
      }
      const end = closeMatch.index + closeMatch[0].length
      parts.push(line.slice(openStart, end))
      at = end
    }
    out.push(parts.join(''))
  }
  return out.join('\n')
}

const CODE_OPEN_INLINE = /\[code(?:=[^\]]*)?\]/gi
const CODE_CLOSE_INLINE = /\[\/code\]/gi

function collapseSpacesOutsideTags(line: string): string {
  // Fast path: nothing to collapse. Most prose lines take this branch, and it
  // avoids a per-character scan of the whole document.
  if (line.indexOf('\t') === -1 && line.indexOf('  ') === -1) return line

  const out: string[] = []
  let bracket = 0
  let previousSpace = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '[') bracket++
    else if (ch === ']' && bracket > 0) bracket--

    if (bracket === 0 && (ch === ' ' || ch === '\t')) {
      if (previousSpace) continue
      previousSpace = true
      out.push(' ')
      continue
    }
    previousSpace = false
    out.push(ch)
  }
  return out.join('')
}
