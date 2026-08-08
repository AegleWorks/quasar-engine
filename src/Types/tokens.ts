/**
 * DocumentEngine — Token & Trivia Types
 *
 * Tokens are the output of the Lexer and input to the Parser.
 * Trivia is whitespace, newlines, formatting that is preserved
 * but not semantically meaningful — inspired by Roslyn.
 */

// ─── Trivia ────────────────────────────────────────────────────

export type TriviaKind =
  | 'whitespace'
  | 'newline'
  | 'carriage_return'
  | 'comment'
  | 'line_continuation'

export interface Trivia {
  kind: TriviaKind
  text: string
  range: Range
}

// ─── Range ─────────────────────────────────────────────────────

export interface Range {
  start: number
  end: number
}

export function range(start: number, end: number): Range {
  return { start, end }
}

export function rangeLength(r: Range): number {
  return r.end - r.start
}

export function rangeContains(r: Range, pos: number): boolean {
  return pos >= r.start && pos < r.end
}

// ─── Token ─────────────────────────────────────────────────────

export type TokenKind =
  // Structural
  | 'open_tag'
  | 'close_tag'
  | 'self_closing_tag'
  | 'text'
  | 'newline'
  | 'whitespace'
  // Attribute values (inside tags)
  | 'attribute_name'
  | 'attribute_value'
  | 'equals'
  | 'quote'
  // Special
  | 'end_of_file'
  | 'error'

export interface Token {
  kind: TokenKind
  text: string
  range: Range

  /** Tag name or attribute name if applicable */
  name?: string

  /** Full raw tag text including brackets: [b], [/color], [*] */
  tagText?: string

  /** Raw attribute string (everything between tag name and closing ]) */
  attrs?: string

  /** Trivia attached BEFORE this token (whitespace, newlines) */
  leadingTrivia: Trivia[]

  /** Trivia attached AFTER this token */
  trailingTrivia: Trivia[]
}

// ─── Token Stream ──────────────────────────────────────────────

export interface TokenStream {
  /** Peek at the current token without consuming */
  peek(): Token
  /** Consume and return the current token, advance */
  advance(): Token
  /** Look ahead n tokens (0 = next) */
  lookAhead(n: number): Token
  /** Whether we've consumed all tokens */
  isEof(): boolean
  /** Get current position in the stream */
  position(): number
  /** Reset to a position */
  seek(pos: number): void
  /** Get all remaining tokens */
  remaining(): Token[]
  /** Get all tokens */
  getAll(): Token[]
}

// ─── Token Factory ─────────────────────────────────────────────

export function createToken(
  kind: TokenKind,
  text: string,
  start: number,
  end: number,
  options?: {
    name?: string
    tagText?: string
    attrs?: string
    leadingTrivia?: Trivia[]
    trailingTrivia?: Trivia[]
  },
): Token {
  return {
    kind,
    text,
    range: range(start, end),
    name: options?.name,
    tagText: options?.tagText,
    attrs: options?.attrs,
    leadingTrivia: options?.leadingTrivia ?? [],
    trailingTrivia: options?.trailingTrivia ?? [],
  }
}

export function createTrivia(kind: TriviaKind, text: string, start: number, end: number): Trivia {
  return { kind, text, range: range(start, end) }
}

// ─── Token Stream Implementation ───────────────────────────────

export class ArrayTokenStream implements TokenStream {
  private tokens: Token[]
  private pos: number

  constructor(tokens: Token[]) {
    this.tokens = tokens
    this.pos = 0
  }

  peek(): Token {
    if (this.pos >= this.tokens.length) {
      return createToken('end_of_file', '', 0, 0)
    }
    return this.tokens[this.pos]
  }

  advance(): Token {
    const token = this.peek()
    this.pos++
    return token
  }

  lookAhead(n: number): Token {
    const idx = this.pos + n
    if (idx >= this.tokens.length) {
      return createToken('end_of_file', '', 0, 0)
    }
    return this.tokens[idx]
  }

  isEof(): boolean {
    return this.pos >= this.tokens.length
  }

  position(): number {
    return this.pos
  }

  seek(pos: number): void {
    this.pos = Math.max(0, Math.min(pos, this.tokens.length))
  }

  remaining(): Token[] {
    return this.tokens.slice(this.pos)
  }

  getAll(): Token[] {
    return [...this.tokens]
  }
}
