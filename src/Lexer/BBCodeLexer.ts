/**
 * DocumentEngine — BBCodeLexer
 *
 * A purpose-built lexer for BBCode that produces explicit newline tokens.
 * This replaces the old BBCode parser's Tokenizer by producing a cleaner
 * token stream that allows the parser to make semantic decisions about
 * spacing (single vs double newlines → empty_line nodes).
 *
 * Unlike the generic Lexer base class, this is tuned specifically for BBCode
 * syntax: [tag], [/tag], [tag=value], text content, and newlines.
 *
 * Token types:
 * - open:     [tag] or [tag=attrs]
 * - close:    [/tag]
 * - text:     Any content between tags (never includes newlines or brackets)
 * - newline:  \n or \r\n (explicit — not mixed into text tokens)
 *
 * Architecture: Pure function, no state, no class. Input → Output.
 * Can be used in workers, SSR, or client-side without initialization.
 */

// ─── Token Types ───────────────────────────────────────────────

export interface BBCodeOpenToken {
  kind: 'open'
  tag: string
  attrs: string
  start: number
  end: number
}

export interface BBCodeCloseToken {
  kind: 'close'
  tag: string
  start: number
  end: number
}

export interface BBCodeTextToken {
  kind: 'text'
  value: string
  start: number
  end: number
}

export interface BBCodeNewlineToken {
  kind: 'newline'
  value: string
  start: number
  end: number
}

export type BBCodeToken =
  | BBCodeOpenToken
  | BBCodeCloseToken
  | BBCodeTextToken
  | BBCodeNewlineToken

// ─── Tag name validation ───────────────────────────────────────
//
// Tag names used to be handled with two regexes: one tested CHARACTER BY
// CHARACTER to find where the name ends, and one validated the result. Between
// them they cost 30% of the lexer on the reference document — the per-character
// one alone was 20%, because every step allocated a one-character string and
// entered the regex engine to ask a question four integer comparisons answer.
//
// The scan below does the finding, the validating and the case detection in a
// single pass over char codes.

const CHAR_UPPER_A = 65
const CHAR_UPPER_Z = 90
const CHAR_LOWER_A = 97
const CHAR_LOWER_Z = 122
const CHAR_ZERO = 48
const CHAR_NINE = 57
const CHAR_UNDERSCORE = 95
const CHAR_HYPHEN = 45
const CHAR_STAR = 42
const CHAR_BRACKET_OPEN = 91
const CHAR_BRACKET_CLOSE = 93
const CHAR_SLASH = 47
const CHAR_LF = 10
const CHAR_CR = 13

/** Valid in a tag name: `a-z A-Z 0-9 _ * -` — the old `/[a-zA-Z0-9_*-]/`. */
function isNameChar(c: number): boolean {
  return (
    (c >= CHAR_LOWER_A && c <= CHAR_LOWER_Z) ||
    (c >= CHAR_UPPER_A && c <= CHAR_UPPER_Z) ||
    (c >= CHAR_ZERO && c <= CHAR_NINE) ||
    c === CHAR_UNDERSCORE ||
    c === CHAR_HYPHEN ||
    c === CHAR_STAR
  )
}

/**
 * How many valid name characters run from `from`, and whether any is uppercase.
 *
 * The uppercase flag is what lets the caller skip `toLowerCase()` — a second
 * 18% of the lexer, spent overwhelmingly on strings that were already lower
 * case and came back as identical copies.
 *
 * Returns the length in the low bits and the uppercase flag in bit 31, so the
 * hot path allocates nothing. `limit` is exclusive.
 */
function scanNameChars(source: string, from: number, limit: number): number {
  let i = from
  let hasUpper = false
  while (i < limit) {
    const c = source.charCodeAt(i)
    if (!isNameChar(c)) break
    if (c >= CHAR_UPPER_A && c <= CHAR_UPPER_Z) hasUpper = true
    i++
  }
  const length = i - from
  return hasUpper ? length | 0x4000_0000 : length
}

const NAME_LENGTH_MASK = 0x3fff_ffff
const NAME_HAS_UPPER = 0x4000_0000

// ─── Scan ──────────────────────────────────────────────────────

/**
 * Scan BBCode source text into a flat array of tokens.
 *
 * The lexer distinguishes between:
 * - Valid BBCode tags: [b], [color=red], [/b], [*]
 * - Invalid syntax:    [bogus stuff, [unclosed, lone [
 *
 * Invalid syntax is treated as plain text — the parser will never
 * see malformed tokens.
 *
 * Newlines are always emitted as distinct tokens so the parser
 * can precisely determine spacing semantics.
 */
export function scanBBCode(source: string): BBCodeToken[] {
  const tokens: BBCodeToken[] = []
  const length = source.length
  let pos = 0

  // Lower-cased copy of the WHOLE source, allocated lazily. It exists only to
  // find the end of a raw `[code]` block, and most documents contain none —
  // the reference document does not, and paid for a 19.6 KB copy anyway.
  let lowerSource: string | null = null
  const lowerOf = (): string => (lowerSource ??= source.toLowerCase())

  // ── Bracket matching memo ──────────────────────────────────
  //
  // Naively rescanning for the closing bracket at every `[` is O(n^2): a
  // document of unmatched brackets (`[[[[[...`, common in code snippets and
  // ASCII art) made a 16 KB paste cost ~550 ms and froze the editor.
  //
  // A single scan already discovers the answer for EVERY `[` it walks past —
  // the bracket stack tells us exactly which `]` closes each one. Recording
  // those results makes the total work linear in the source length.

  /** `[` offset → offset of its matching `]` at depth 0, or -1 if unmatched. */
  const bracketMatch = new Map<number, number>()
  /** Sticky: once `indexOf(']')` fails, no `]` exists in the rest of the source. */
  let noCloseBracketRemains = false

  function findMatchingBracket(from: number): number {
    // The map is empty on any document without unmatched brackets, and a size
    // check is cheaper than a lookup that is going to miss. Instrumented on the
    // reference document: 804 lookups, 0 hits.
    if (bracketMatch.size !== 0) {
      const memo = bracketMatch.get(from)
      if (memo !== undefined) return memo
    }

    const open: number[] = []
    let result = -1

    for (let j = from + 1; j < source.length; j++) {
      const cj = source.charCodeAt(j)
      if (cj === CHAR_BRACKET_OPEN) {
        open.push(j)
      } else if (cj === CHAR_BRACKET_CLOSE) {
        if (open.length === 0) {
          // First `]` at depth 0 relative to `from` — this is the answer.
          result = j
          break
        }
        // Closes a nested `[` (e.g. `[box=[b]title[/b]]`). Stack discipline
        // guarantees this is that bracket's first depth-0 `]` too.
        bracketMatch.set(open.pop()!, j)
      }
    }

    // Deliberately NOT recording the answer for `from` itself. The main loop
    // never asks twice: on success it jumps past `result`, and on failure it
    // emits `[` as text and moves to `from + 1`. Either way it never comes back,
    // so that entry could only ever be written, never read — 804 wasted `set`s
    // on the reference document, which is what kept the map from being empty
    // and made every lookup above pay for a miss.
    //
    // The entries for brackets found *inside* the scan are a different matter:
    // when this scan fails, the main loop walks into them one by one, and those
    // hits are the whole reason the memo exists. On `[`×16000 it turns 15.999
    // rescans into 15.999 lookups.
    //
    // We only exit the loop with a non-empty stack when we reached the end of
    // the source, so everything still open is genuinely unmatched.
    for (const unmatched of open) bracketMatch.set(unmatched, -1)
    return result
  }

  while (pos < length) {
    const ch = source.charCodeAt(pos)

    // ── Newlines ───────────────────────────────────────────────
    if (ch === CHAR_LF || ch === CHAR_CR) {
      const start = pos
      // Consume \r\n as a single token
      if (ch === CHAR_CR && pos + 1 < length && source.charCodeAt(pos + 1) === CHAR_LF) {
        pos += 2
      } else {
        pos++
      }
      tokens.push({
        kind: 'newline',
        value: source.slice(start, pos),
        start,
        end: pos,
      })
      continue
    }

    // ── Potential tag: [...] ───────────────────────────────────
    if (ch === CHAR_BRACKET_OPEN) {
      // ── Closing tags: [/tag] ──────────────────────────────
      // Simple ] find is sufficient since close tags never nest.
      if (pos + 1 < length && source.charCodeAt(pos + 1) === CHAR_SLASH) {
        const closeBracket = noCloseBracketRemains ? -1 : source.indexOf(']', pos)
        if (closeBracket === -1) noCloseBracketRemains = true
        if (closeBracket !== -1) {
          // Validate in place. The name must fill the whole span — `[/has space]`
          // is not a close tag — which is exactly what the old
          // `isValidTagName(slice)` checked, without the slice or the regex.
          const nameStart = pos + 2
          const scanned = scanNameChars(source, nameStart, closeBracket)
          const nameLength = scanned & NAME_LENGTH_MASK
          if (nameLength > 0 && nameStart + nameLength === closeBracket) {
            const raw = source.slice(nameStart, closeBracket)
            const tagName = (scanned & NAME_HAS_UPPER) !== 0 ? raw.toLowerCase() : raw
            tokens.push({
              kind: 'close',
              tag: tagName,
              start: pos,
              end: closeBracket + 1,
            })
            pos = closeBracket + 1
            continue
          }
        }
        // Invalid close tag → treat '[' as text
        tokens.push({ kind: 'text', value: '[', start: pos, end: pos + 1 })
        pos++
        continue
      }

      // ── Opening tags: [tag] or [tag=nested[bb]code[/bb]] ─
      // Bracket depth is tracked so nested BBCode in attributes
      // (e.g. [box=[b]title[/b]]) resolves to the right `]`.
      const closeBracket = findMatchingBracket(pos)

      // No matching closing bracket → lone '[' = plain text
      if (closeBracket === -1) {
        tokens.push({ kind: 'text', value: '[', start: pos, end: pos + 1 })
        pos++
        continue
      }

      // The name runs from just after the `[`. Scanned over char codes, so no
      // `inner` slice is needed to find it and no second regex to validate it:
      // every character the scan accepted is by definition a valid name
      // character, so the old `isValidTagName(tagName)` could only ever be true.
      const nameStart = pos + 1
      const scanned = scanNameChars(source, nameStart, closeBracket)
      const nameEnd = scanned & NAME_LENGTH_MASK

      if (nameEnd > 0) {
        {
          const raw = source.slice(nameStart, nameStart + nameEnd)
          const tagName = (scanned & NAME_HAS_UPPER) !== 0 ? raw.toLowerCase() : raw
          const attrs = source.slice(nameStart + nameEnd, closeBracket).trim()
          tokens.push({
            kind: 'open',
            tag: tagName,
            attrs,
            start: pos,
            end: closeBracket + 1,
          })
          pos = closeBracket + 1

          // ── RAW BLOCK HANDLING (code, c) ──
          // Contents of code blocks are strictly literal. No inner tags or newline tokens.
          if (tagName === 'code' || tagName === 'c') {
            const endTag = `[/${tagName}]`
            const closeIdx = lowerOf().indexOf(endTag, pos)
            
            if (closeIdx !== -1) {
              if (closeIdx > pos) {
                tokens.push({
                  kind: 'text',
                  value: source.slice(pos, closeIdx),
                  start: pos,
                  end: closeIdx,
                })
              }
              tokens.push({
                kind: 'close',
                tag: tagName,
                start: closeIdx,
                end: closeIdx + endTag.length,
              })
              pos = closeIdx + endTag.length
            } else {
              // Unclosed raw block consumes the rest of the document
              if (pos < length) {
                tokens.push({
                  kind: 'text',
                  value: source.slice(pos),
                  start: pos,
                  end: length,
                })
                pos = length
              }
            }
          }
          
          continue
        }
      }

      // Invalid tag syntax → treat '[' as text
      tokens.push({ kind: 'text', value: '[', start: pos, end: pos + 1 })
      pos++
      continue
    }

    // ── Plain text (anything that isn't a tag start or newline) ─
    const start = pos
    while (pos < length) {
      const c = source.charCodeAt(pos)
      if (c === CHAR_BRACKET_OPEN || c === CHAR_LF || c === CHAR_CR) break
      pos++
    }
    tokens.push({
      kind: 'text',
      value: source.slice(start, pos),
      start,
      end: pos,
    })
  }

  return tokens
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Debug: format tokens for inspection.
 */
export function formatTokens(tokens: BBCodeToken[]): string {
  return tokens
    .map(t => {
      switch (t.kind) {
        case 'open':
          return `OPEN  [${t.tag}] attrs="${t.attrs}" [${t.start}..${t.end}]`
        case 'close':
          return `CLOSE [/${t.tag}] [${t.start}..${t.end}]`
        case 'text':
          return `TEXT  "${t.value.slice(0, 40)}" [${t.start}..${t.end}]`
        case 'newline':
          return `NL    [${t.start}..${t.end}]`
      }
    })
    .join('\n')
}
