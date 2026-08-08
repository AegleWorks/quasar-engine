/**
 * DocumentEngine — Lexer
 *
 * Tokenizes source text into a stream of Tokens with Trivia.
 * Trivia includes whitespace, newlines, and formatting that is
 * preserved in the token stream but not semantically significant.
 *
 * This is a LANGUAGE-INDEPENDENT lexer framework.
 * Language-specific tokenization is provided via the LexerOptions.
 *
 * Inspired by Roslyn's lexer architecture.
 */

import type { Token, TokenStream, Trivia } from '../Types/tokens'
import { createToken, createTrivia, range, ArrayTokenStream } from '../Types/tokens'
import type { TokenKind } from '../Types/tokens'

// ─── Lexer Interface ───────────────────────────────────────────

export interface LexerRule {
  /** Pattern to match at the current position */
  pattern: RegExp
  /** Token kind to produce */
  kind: TokenKind
  /** Optional: extract a name from the match (for tags) */
  name?: (match: RegExpExecArray) => string
  /** Optional: extract attributes from the match */
  attrs?: (match: RegExpExecArray) => string
}

export interface LexerOptions {
  /** Language-specific tokenization rules */
  rules: LexerRule[]
  /** Characters that count as whitespace trivia */
  whitespaceChars?: RegExp
  /** Characters that start a newline trivia */
  newlineChars?: RegExp
  /** Whether to collect trivia */
  collectTrivia?: boolean
  /** Lexer hooks: called before each token */
  onToken?: (token: Token) => void
}

// ─── Default Lexer ─────────────────────────────────────────────

export class Lexer {
  private options: LexerOptions
  private source: string
  private pos: number
  private tokens: Token[]

  constructor(options: LexerOptions) {
    this.options = {
      collectTrivia: true,
      whitespaceChars: /[ \t]+/,
      newlineChars: /\r?\n/,
      ...options,
    }
    this.source = ''
    this.pos = 0
    this.tokens = []
  }

  /**
   * Tokenize source text into a TokenStream.
   */
  tokenize(source: string): TokenStream {
    this.source = source
    this.pos = 0
    this.tokens = []

    while (this.pos < source.length) {
      const leadingTrivia = this.options.collectTrivia ? this.scanTrivia() : []

      // Try each rule in order
      const token = this.tryRules(leadingTrivia)

      if (token) {
        this.tokens.push(token)
      } else {
        // No rule matched — produce a text token for the character
        const start = this.pos
        this.pos++
        const text = source[start]
        const tok = createToken('text', text, start, this.pos, {
          leadingTrivia,
        })
        this.tokens.push(tok)
      }
    }

    return new ArrayTokenStream(this.tokens) as TokenStream
  }

  /**
   * Re-tokenize a portion of the source (for incremental parsing).
   * Returns just the new tokens for the affected range.
   */
  retokenize(source: string, start: number, end: number): Token[] {
    const oldSource = this.source
    const oldPos = this.pos

    this.source = source
    this.pos = start
    this.tokens = []

    while (this.pos < end && this.pos < source.length) {
      const leadingTrivia = this.scanTrivia()
      const token = this.tryRules(leadingTrivia)
      if (token) {
        this.tokens.push(token)
      } else {
        const s = this.pos
        this.pos++
        this.tokens.push(createToken('text', source[s], s, this.pos, { leadingTrivia }))
      }
    }

    const result = [...this.tokens]
    this.source = oldSource
    this.pos = oldPos
    this.tokens = []

    return result
  }

  // ── Private ─────────────────────────────────────────────

  private tryRules(leadingTrivia: Trivia[]): Token | null {
    for (const rule of this.options.rules) {
      const match = rule.pattern.exec(this.source.slice(this.pos))
      if (match && match.index === 0) {
        const start = this.pos
        const text = match[0]
        this.pos += text.length

        const trailingTrivia = this.options.collectTrivia ? this.scanTrivia() : []

        const token = createToken(rule.kind, text, start, this.pos, {
          name: rule.name?.(match),
          attrs: rule.attrs?.(match),
          tagText: text,
          leadingTrivia,
          trailingTrivia,
        })

        this.options.onToken?.(token)
        return token
      }
    }
    return null
  }

  private scanTrivia(): Trivia[] {
    const trivia: Trivia[] = []

    while (this.pos < this.source.length) {
      const rest = this.source.slice(this.pos)

      const newlineMatch = this.options.newlineChars!.exec(rest)
      if (newlineMatch && newlineMatch.index === 0) {
        const start = this.pos
        this.pos += newlineMatch[0].length
        trivia.push(createTrivia('newline', newlineMatch[0], start, this.pos))
        continue
      }

      const wsMatch = this.options.whitespaceChars!.exec(rest)
      if (wsMatch && wsMatch.index === 0) {
        const start = this.pos
        this.pos += wsMatch[0].length
        trivia.push(createTrivia('whitespace', wsMatch[0], start, this.pos))
        continue
      }

      break
    }

    return trivia
  }
}
