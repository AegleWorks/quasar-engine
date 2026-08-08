/**
 * DocumentEngine — MarkdownLexer
 *
 * Tokenizes standard Markdown into a flat token stream.
 * Produces explicit newline tokens for the parser to make semantic
 * decisions about paragraph breaks.
 */

export interface MarkdownHashToken { kind: 'hash'; value: string; start: number; end: number }
export interface MarkdownGtToken { kind: 'gt'; start: number; end: number }
export interface MarkdownStarToken { kind: 'star'; value: string; start: number; end: number }
export interface MarkdownUnderscoreToken { kind: 'underscore'; value: string; start: number; end: number }
export interface MarkdownTildeToken { kind: 'tilde'; value: string; start: number; end: number }
export interface MarkdownBacktickToken { kind: 'backtick'; value: string; start: number; end: number }
export interface MarkdownBracketOpenToken { kind: 'bracket_open'; start: number; end: number }
export interface MarkdownBracketCloseToken { kind: 'bracket_close'; start: number; end: number }
export interface MarkdownParenOpenToken { kind: 'paren_open'; start: number; end: number }
export interface MarkdownParenCloseToken { kind: 'paren_close'; start: number; end: number }
export interface MarkdownBangToken { kind: 'bang'; start: number; end: number }
export interface MarkdownDashToken { kind: 'dash'; value: string; start: number; end: number }
export interface MarkdownPlusToken { kind: 'plus'; start: number; end: number }
export interface MarkdownDotToken { kind: 'dot'; start: number; end: number }
export interface MarkdownTextToken { kind: 'text'; value: string; start: number; end: number }
export interface MarkdownNewlineToken { kind: 'newline'; value: string; start: number; end: number }
export interface MarkdownFenceToken { kind: 'fence'; value: string; lang: string; start: number; end: number }
export interface MarkdownHrToken { kind: 'hr'; start: number; end: number }
export interface MarkdownEscapeToken { kind: 'escape'; value: string; start: number; end: number }
export interface MarkdownAngleToken { kind: 'angle'; value: string; start: number; end: number }

export type MarkdownToken =
  | MarkdownHashToken | MarkdownGtToken | MarkdownStarToken
  | MarkdownUnderscoreToken | MarkdownTildeToken | MarkdownBacktickToken
  | MarkdownBracketOpenToken | MarkdownBracketCloseToken
  | MarkdownParenOpenToken | MarkdownParenCloseToken
  | MarkdownBangToken | MarkdownDashToken | MarkdownPlusToken
  | MarkdownDotToken | MarkdownTextToken | MarkdownNewlineToken
  | MarkdownFenceToken | MarkdownHrToken | MarkdownEscapeToken
  | MarkdownAngleToken;

function pushToken(tokens: MarkdownToken[], kind: MarkdownToken['kind'], start: number, end: number, extra?: Record<string, string>) {
  switch (kind) {
    case 'hash': tokens.push({ kind, value: extra?.value ?? '', start, end }); break;
    case 'gt': case 'bracket_open': case 'bracket_close':
    case 'paren_open': case 'paren_close': case 'bang':
    case 'plus': case 'dot': case 'hr':
      tokens.push({ kind, start, end } as MarkdownToken); break;
    case 'star': case 'underscore': case 'tilde':
    case 'backtick': case 'dash': case 'text':
    case 'newline': case 'escape': case 'angle':
      tokens.push({ kind, value: extra?.value ?? '', start, end } as MarkdownToken); break;
    case 'fence':
      tokens.push({ kind, value: extra?.value ?? '', lang: extra?.lang ?? '', start, end }); break;
  }
}

function isMarkdownSpecial(ch: string): boolean {
  return '\\`*_{}[]()#+-.!|~\'"<>'.includes(ch) || ch === '\n' || ch === '\r';
}

/**
 * Scan Markdown source text into tokens.
 * Pure function: input → output, no state.
 */
export function scanMarkdown(source: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const start = i;

    // Newline
    if (ch === '\n') {
      i++;
      pushToken(tokens, 'newline', start, i, { value: '\n' });
      continue;
    }
    if (ch === '\r') {
      if (i + 1 < source.length && source[i + 1] === '\n') i++;
      i++;
      pushToken(tokens, 'newline', start, i, { value: '\r\n' });
      continue;
    }

    // Escape character
    if (ch === '\\' && i + 1 < source.length) {
      i += 2;
      pushToken(tokens, 'escape', start, i, { value: source.slice(start, i) });
      continue;
    }

    // Hash (heading)
    if (ch === '#') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '#' && count < 6) { count++; i++; }
      pushToken(tokens, 'hash', start, i, { value: source.slice(start, i) });
      continue;
    }

    // GT (blockquote)
    if (ch === '>') {
      i++;
      pushToken(tokens, 'gt', start, i);
      continue;
    }

    // Bang (image)
    if (ch === '!' && i + 1 < source.length && source[i + 1] === '[') {
      i++;
      pushToken(tokens, 'bang', start, i);
      continue;
    }

    // Brackets and parens
    if (ch === '[') { i++; pushToken(tokens, 'bracket_open', start, i); continue; }
    if (ch === ']') { i++; pushToken(tokens, 'bracket_close', start, i); continue; }
    if (ch === '(') { i++; pushToken(tokens, 'paren_open', start, i); continue; }
    if (ch === ')') { i++; pushToken(tokens, 'paren_close', start, i); continue; }

    // Star (*, **, ***)
    if (ch === '*') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '*' && count < 3) { count++; i++; }
      pushToken(tokens, 'star', start, i, { value: source.slice(start, i) });
      continue;
    }

    // Underscore (_, __, ___)
    if (ch === '_') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '_' && count < 3) { count++; i++; }
      pushToken(tokens, 'underscore', start, i, { value: source.slice(start, i) });
      continue;
    }

    // Tilde (~, ~~)
    if (ch === '~') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '~' && count < 2) { count++; i++; }
      pushToken(tokens, 'tilde', start, i, { value: source.slice(start, i) });
      continue;
    }

    // Backtick (inline or fence)
    if (ch === '`') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '`' && count < 3) { count++; i++; }
      if (count === 3) {
        const langStart = i;
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
        pushToken(tokens, 'fence', start, i, { value: '```', lang: source.slice(langStart, i).trim() });
      } else {
        pushToken(tokens, 'backtick', start, i, { value: source.slice(start, i) });
      }
      continue;
    }

    // Dash (-, --, ---)
    if (ch === '-') {
      let count = 1;
      i++;
      while (i < source.length && source[i] === '-' && count < 3) { count++; i++; }
      // Hr if --- and alone on line (simplified, normally requires parser validation)
      if (count === 3) {
        pushToken(tokens, 'dash', start, i, { value: source.slice(start, i) });
      } else {
        pushToken(tokens, 'dash', start, i, { value: source.slice(start, i) });
      }
      continue;
    }

    // Plus
    if (ch === '+') { i++; pushToken(tokens, 'plus', start, i); continue; }

    // Dot
    if (ch === '.') { i++; pushToken(tokens, 'dot', start, i); continue; }
    
    // Angle
    if (ch === '<' || ch === '>') {
      i++;
      pushToken(tokens, 'angle', start, i, { value: ch });
      continue;
    }

    // Default: accumulate text
    const textStart = i;
    while (i < source.length && !isMarkdownSpecial(source[i])) i++;
    if (i > textStart) {
      pushToken(tokens, 'text', textStart, i, { value: source.slice(textStart, i) });
    } else {
      // If it's a special char not handled above, treat as text to avoid infinite loop
      pushToken(tokens, 'text', textStart, i + 1, { value: source[i] });
      i++; 
    }
  }

  return tokens;
}
