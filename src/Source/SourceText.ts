/**
 * Quasar — SourceText (source locations)
 *
 * Every diagnostic, anchor and edit in Quasar speaks in absolute offsets. That
 * is the right currency for the tree — offsets are what a parser and a splice
 * actually move — but it is the wrong currency for a human or for an LSP
 * client, which speak in line and column. Until this module existed every
 * consumer translated offsets itself: the app carried a `buildLineStarts` plus
 * a linear scan, and the engine had no answer at all. Two implementations of
 * the same rule drift, and line/column is exactly the kind of rule that drifts
 * on CRLF.
 *
 * This is Roslyn's `SourceText` in miniature: the text plus a lazily built
 * index of line starts, with O(log lines) offset→position and O(1) position→
 * offset. It is immutable and cheap to share, so a document can hold one for
 * the lifetime of a source snapshot.
 *
 * ─── Coordinates ───────────────────────────────────────────────────────────
 *
 * Lines and characters are 0-based, like LSP and Roslyn. Diagnostics are
 * rendered 1-based by {@link formatDiagnostic}, because every compiler a reader
 * has ever used prints `file(3,7)`.
 *
 * ─── Line breaks ───────────────────────────────────────────────────────────
 *
 * `\n`, `\r\n` and a lone `\r` all end a line, and each counts as ONE break.
 * A document written on Windows therefore reports the same line numbers it
 * would have on Unix — the CRLF bug that makes an error land one line above
 * where the reader is looking does not exist here.
 */

import type { Diagnostic, DiagnosticSeverity } from '../Types/diagnostics'

export interface LineAndCharacter {
  /** 0-based line number. */
  readonly line: number
  /** 0-based character offset within the line. */
  readonly character: number
}

export interface SourceLine {
  /** 0-based line number. */
  readonly line: number
  /** Offset of the first character. */
  readonly start: number
  /** Offset just past the last character, before the line break. */
  readonly end: number
  /** Offset just past the line break (equal to `end` on the last line). */
  readonly endIncludingBreak: number
  /** The line's characters, without the break. */
  readonly text: string
}

const CR = 13
const LF = 10

export class SourceText {
  /** The source this index describes. */
  readonly text: string

  /**
   * Offset of every line start, ascending, beginning with 0.
   * Built on first use: a document that never asks for a line number never
   * pays for the scan.
   */
  private _lineStarts: number[] | null = null

  constructor(text: string) {
    this.text = text
  }

  get length(): number {
    return this.text.length
  }

  get lineCount(): number {
    return this.lineStarts.length
  }

  /** Offsets of every line start. Do not mutate. */
  get lineStarts(): readonly number[] {
    return this._lineStarts ?? (this._lineStarts = computeLineStarts(this.text))
  }

  getLineStart(line: number): number {
    const starts = this.lineStarts
    if (line <= 0) return 0
    if (line >= starts.length) return this.text.length
    return starts[line]
  }

  /** Offset just past the line's characters, before its break. */
  getLineEnd(line: number): number {
    const starts = this.lineStarts
    if (line < 0) return 0
    if (line >= starts.length) return this.text.length
    if (line + 1 >= starts.length) return this.text.length
    let end = starts[line + 1]
    // starts[line + 1] is past the break. Walk back over `\r\n` or one `\n`/`\r`.
    if (end > starts[line] && this.text.charCodeAt(end - 1) === LF) {
      end--
      if (end > starts[line] && this.text.charCodeAt(end - 1) === CR) end--
    } else if (end > starts[line] && this.text.charCodeAt(end - 1) === CR) {
      end--
    }
    return end
  }

  /** Offset just past the line's break (equal to {@link getLineEnd} at EOF). */
  getLineEndIncludingBreak(line: number): number {
    const starts = this.lineStarts
    if (line < 0) return 0
    if (line + 1 >= starts.length) return this.text.length
    return starts[line + 1]
  }

  getLineText(line: number): string {
    return this.text.slice(this.getLineStart(line), this.getLineEnd(line))
  }

  /** The line containing `offset`, clamped into the document. */
  lineAt(offset: number): SourceLine {
    const position = this.positionAt(offset)
    const line = position.line
    return {
      line,
      start: this.getLineStart(line),
      end: this.getLineEnd(line),
      endIncludingBreak: this.getLineEndIncludingBreak(line),
      text: this.getLineText(line),
    }
  }

  /**
   * Translate an absolute offset to a line and character.
   *
   * Out-of-range offsets are clamped to `[0, length]`: a caret parked one past
   * the last character (the normal end-of-document state) resolves to the last
   * line, which is what an editor draws. On a document that ends with a line
   * break, `length` is the start of the empty final line, as it is in Roslyn.
   */
  positionAt(offset: number): LineAndCharacter {
    const starts = this.lineStarts
    let at = offset
    if (at <= 0) return { line: 0, character: 0 }
    if (at > this.text.length) at = this.text.length

    // Binary search: last line start <= at. `lo` stays a valid candidate.
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return { line: lo, character: at - starts[lo] }
  }

  /**
   * Translate a line and character to an absolute offset, clamped.
   *
   * A character past the end of the line lands at the line's end — before its
   * break, never on the next line. position→offset→position is then stable for
   * every requested position, which is the property an LSP range round-trip
   * needs; mapping a too-large column into the next line would silently move a
   * caret instead of clamping it.
   */
  offsetAt(position: LineAndCharacter): number
  offsetAt(line: number, character: number): number
  offsetAt(lineOrPosition: LineAndCharacter | number, character?: number): number {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const char = typeof lineOrPosition === 'number' ? (character ?? 0) : lineOrPosition.character
    const starts = this.lineStarts
    const clampedLine = line < 0 ? 0 : line >= starts.length ? starts.length - 1 : line
    const start = starts[clampedLine]
    const end = this.getLineEnd(clampedLine)
    const target = start + (char < 0 ? 0 : char)
    return target > end ? end : target
  }

  slice(start: number, end: number = this.length): string {
    return this.text.slice(Math.max(0, start), Math.max(0, end))
  }
}

/** One pass, no regex. `\r\n` is one start, `\n` and lone `\r` are one each. */
function computeLineStarts(text: string): number[] {
  const starts: number[] = [0]
  const length = text.length
  for (let i = 0; i < length; i++) {
    const c = text.charCodeAt(i)
    if (c === CR) {
      if (i + 1 < length && text.charCodeAt(i + 1) === LF) i++
      starts.push(i + 1)
    } else if (c === LF) {
      starts.push(i + 1)
    }
  }
  return starts
}

// ─── Diagnostic rendering ──────────────────────────────────────────────────

export interface FormatDiagnosticOptions {
  /**
   * Name shown before the coordinates. A file path, a document title, or
   * nothing at all. Defaults to `<source>`.
   */
  filePath?: string
  /**
   * Print the diagnostic's `source` (the rule engine that produced it) after
   * the code, as `[source]`. Off by default: the code already identifies the
   * finding, and most editors show the source separately.
   */
  includeSource?: boolean
}

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  hint: 'hint',
}

/**
 * Render one diagnostic the way a compiler does:
 *
 *   post.bbcode(12,4): error unclosed-tag: Missing [/b] — the tag was closed automatically
 *
 * Coordinates are 1-based and only present when the diagnostic has a range.
 * The output is deterministic: the same diagnostic and source always produce
 * the same line, so it can be compared, snapshotted and written to a log.
 */
export function formatDiagnostic(
  diagnostic: Diagnostic,
  source: SourceText | string,
  options: FormatDiagnosticOptions = {},
): string {
  const text = typeof source === 'string' ? new SourceText(source) : source
  const file = options.filePath ?? '<source>'
  const where = diagnostic.range
    ? (() => {
        const { line, character } = text.positionAt(diagnostic.range.start)
        return `${file}(${line + 1},${character + 1})`
      })()
    : file
  const origin = options.includeSource && diagnostic.source ? ` [${diagnostic.source}]` : ''
  return `${where}: ${SEVERITY_LABEL[diagnostic.severity]} ${diagnostic.code}${origin}: ${diagnostic.message}`
}

/**
 * Render a whole collection, one per line, in the order given.
 *
 * Deliberately not sorted: the analyzer already emits diagnostics in document
 * order, and a formatter that reorders them makes a snapshot test disagree
 * with the editor's gutter for no gain. Sort the array first if you want a
 * different order.
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  source: SourceText | string,
  options: FormatDiagnosticOptions = {},
): string {
  const text = typeof source === 'string' ? new SourceText(source) : source
  return diagnostics.map(d => formatDiagnostic(d, text, options)).join('\n')
}
