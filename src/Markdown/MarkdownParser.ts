import { MarkdownToken, MarkdownFenceToken } from './MarkdownLexer';
import { MarkdownNode, MarkdownDocument, MarkdownParagraph, MarkdownText, MarkdownHeading } from './MarkdownAST';

/**
 * DocumentEngine — MarkdownParser
 * 
 * Basic implementation to parse a token stream into an AST.
 */
export class MarkdownParser {
  private tokens: MarkdownToken[];
  private current: number = 0;

  constructor(tokens: MarkdownToken[]) {
    this.tokens = tokens;
  }

  public parse(): MarkdownDocument {
    const doc: MarkdownDocument = {
      type: 'document',
      children: []
    };

    while (!this.isAtEnd()) {
      let newlines = 0;
      while (this.match('newline')) newlines++;

      if (newlines > 0) {
        // Since blocks like parseParagraph consume their trailing newline, 
        // seeing 1 newline here means there were 2 newlines in the source (a blank line).
        // 1 newline here -> 1 empty_line
        // 2 newlines here -> 2 empty_lines
        for (let i = 0; i < newlines; i++) {
          doc.children.push({ type: 'empty_line' } as any);
        }
      }

      if (this.isAtEnd()) break;

      const node = this.parseBlock();
      if (node) {
        doc.children.push(node);
      }
    }

    return doc;
  }

  private parseBlock(): MarkdownNode | null {
    if (this.isAtEnd()) return null;

    const token = this.peek();

    if (token.kind === 'hash') {
      return this.parseHeading();
    }
    
    if (token.kind === 'gt') {
      const saved = this.current;
      this.advance(); // consume gt
      const next1 = this.peek();
      if (next1 && next1.kind === 'text' && ('value' in next1) && (next1.value as string).trim() === '') {
        this.advance(); // consume space
      }
      const next2 = this.peek();
      if (next2 && next2.kind === 'bracket_open') {
        const next3 = this.tokens[this.current + 1];
        if (next3 && next3.kind === 'bang') {
           this.current = saved; // restore
           return this.parseNotice();
        }
      }
      this.current = saved; // restore
      return this.parseBlockquote();
    }
    
    if (token.kind === 'fence') {
      return this.parseFence();
    }
    
    if (token.kind === 'dash' || token.kind === 'star') {
       // Must be followed by a space to be a list!
       const next = this.tokens[this.current + 1];
       if (next && next.kind === 'text' && ('value' in next) && (next.value as string).startsWith(' ')) {
         return this.parseList();
       }
    }

    // Default to paragraph
    return this.parseParagraph();
  }

  private parseHeading(): MarkdownHeading {
    const hash = this.advance();
    const level = hash.kind === 'hash' ? Math.min(hash.value.length, 6) : 1;
    
    // We don't want to blindly consume a text token if it contains actual text.
    // Let's just let parseInline handle it. The renderer can deal with leading spaces,
    // or we can trim the first child if it's text.
    const children: MarkdownNode[] = [];
    while (!this.isAtEnd() && !this.check('newline')) {
      const inlineNode = this.parseInline();
      if (inlineNode) {
        children.push(inlineNode);
      }
    }
    
    // Trim leading space from the first child if it's text
    if (children.length > 0 && children[0].type === 'text') {
      children[0].value = (children[0] as any).value.replace(/^\\s+/, '');
    }

    this.match('newline');

    return {
      type: 'heading',
      level,
      children
    };
  }

  private parseBlockquote(): MarkdownNode {
    const children: MarkdownNode[] = [];
    
    while (!this.isAtEnd()) {
      if (this.match('gt')) {
        // blockquote line prefix
      }
      
      if (this.check('newline')) {
        this.advance();
        if (this.check('newline') || this.isAtEnd()) {
          break; // Empty line ends blockquote
        }
        children.push({ type: 'text', value: '\n' });
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
      }
    }

    return {
      type: 'blockquote',
      children
    };
  }
  
  private parseNotice(): MarkdownNode {
    const children: MarkdownNode[] = [];
    this.advance(); // consume gt
    
    // consume the [!NOTE] part
    while (!this.isAtEnd() && !this.check('newline')) {
      if (this.match('bracket_close')) break;
      this.advance();
    }
    
    while (!this.isAtEnd()) {
      if (this.match('gt')) {
        // blockquote line prefix
      }
      if (this.check('newline')) {
        this.advance();
        if (this.check('newline') || this.isAtEnd()) break;
        children.push({ type: 'text', value: '\n' });
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
      }
    }
    
    return { type: 'notice', children };
  }
  
  private tokenValue(token: MarkdownToken): string {
    if ('value' in token) return (token as any).value;
    switch (token.kind) {
      case 'bracket_open': return '[';
      case 'bracket_close': return ']';
      case 'paren_open': return '(';
      case 'paren_close': return ')';
      case 'bang': return '!';
      case 'gt': return '>';
      case 'plus': return '+';
      case 'dot': return '.';
      case 'hr': return '---';
      default: return '';
    }
  }

  private parseFence(): MarkdownNode {
    const token = this.advance() as MarkdownFenceToken;
    const value = token.lang;
    let code = '';
    while (!this.isAtEnd()) {
      if (this.check('fence')) {
        this.advance(); // close fence
        break;
      }
      const p = this.advance();
      code += this.tokenValue(p);
    }
    return { type: 'code_block', lang: value, value: code.trim() };
  }
  
  private parseList(): MarkdownNode {
    const items: any[] = [];
    while (!this.isAtEnd() && (this.check('dash') || this.check('star'))) {
      this.advance(); // consume dash/star
      const children: MarkdownNode[] = [];
      while (!this.isAtEnd() && !this.check('newline')) {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
      }
      // Trim leading space from the first child if it's text
      if (children.length > 0 && children[0].type === 'text') {
        children[0].value = (children[0] as any).value.replace(/^\\s+/, '');
      }
      items.push({ type: 'list_item', children });
      if (this.match('newline')) {
        if (this.check('newline')) break; // End of list on double newline
      }
    }
    return { type: 'list', ordered: false, children: items };
  }

  private parseParagraph(): MarkdownParagraph {
    const children: MarkdownNode[] = [];
    
    while (!this.isAtEnd()) {
      if (this.check('newline')) {
        this.advance();
        // Two newlines mean end of paragraph
        if (this.check('newline') || this.isAtEnd()) {
          break;
        } else {
          // A single newline could mean lazy continuation, BUT we must check if a new block starts!
          if (this.check('hash') || this.check('gt') || this.check('fence') || this.check('hr') || this.check('dash')) {
            break; // Paragraph interrupted by block
          }
          // Single newline treated as space in paragraph
          children.push({ type: 'text', value: '\n' });
        }
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) {
          children.push(inlineNode);
        }
      }
    }

    return {
      type: 'paragraph',
      children
    };
  }

  private parseInline(terminator?: { kind: string, value?: string }): MarkdownNode | null {
    if (this.isAtEnd()) return null;

    if (terminator) {
      const peekToken = this.peek();
      if (peekToken.kind === terminator.kind && (!terminator.value || ('value' in peekToken && peekToken.value === terminator.value))) {
        return null;
      }
    }

    const token = this.advance();
    
    // Bold and Italic
    if (token.kind === 'star' || token.kind === 'underscore') {
      const val = ('value' in token) ? token.value as string : '';
      if (val === '**' || val === '__' || val === '*' || val === '_') {
        const type = (val.length === 2) ? 'strong' : 'emphasis';
        
        const savedCurrent = this.current;
        const children: MarkdownNode[] = [];
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break; // Don't span across lines in this basic parser

          if (next.kind === token.kind && ('value' in next && next.value === val)) {
            this.advance(); // consume closing token
            closed = true;
            break;
          }

          const child = this.parseInline({ kind: token.kind, value: val });
          if (child) {
            children.push(child);
          } else {
            break;
          }
        }

        if (closed) {
          return { type, children };
        } else {
          // Backtrack and treat as text
          this.current = savedCurrent;
          return { type: 'text', value: val };
        }
      }
    }

    // Strikethrough
    if (token.kind === 'tilde') {
      const val = ('value' in token) ? token.value as string : '';
      if (val === '~~') {
        const savedCurrent = this.current;
        const children: MarkdownNode[] = [];
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break;

          if (next.kind === 'tilde' && ('value' in next && next.value === val)) {
            this.advance();
            closed = true;
            break;
          }

          const child = this.parseInline({ kind: 'tilde', value: val });
          if (child) children.push(child);
          else break;
        }

        if (closed) {
          return { type: 'strikethrough', children } as any; 
        } else {
          this.current = savedCurrent;
          return { type: 'text', value: val };
        }
      }
    }
    
    // Spoiler (||)
    if (token.kind === 'text' && token.value === '||') {
      const savedCurrent = this.current;
      const children: MarkdownNode[] = [];
      let closed = false;
      while (!this.isAtEnd()) {
        const next = this.peek();
        if (next.kind === 'newline') break;
        if (next.kind === 'text' && next.value === '||') {
          this.advance();
          closed = true;
          break;
        }
        const child = this.parseInline({ kind: 'text', value: '||' });
        if (child) children.push(child);
        else break;
      }
      if (closed) {
        return { type: 'spoiler', children };
      } else {
        this.current = savedCurrent;
        return { type: 'text', value: '||' };
      }
    }

    // Link or Image
    if (token.kind === 'bracket_open' || token.kind === 'bang') {
      const isImage = token.kind === 'bang';
      if (isImage) {
        if (!this.match('bracket_open')) {
          return { type: 'text', value: '!' };
        }
      }
      
      const savedCurrent = this.current;
      let text = '';
      let closedBracket = false;
      
      while (!this.isAtEnd() && !this.check('newline')) {
        if (this.match('bracket_close')) {
          closedBracket = true;
          break;
        }
        const p = this.advance();
        text += ('value' in p) ? (p as any).value : '';
      }

      if (closedBracket && this.match('paren_open')) {
        let url = '';
        let closedParen = false;
        while (!this.isAtEnd() && !this.check('newline')) {
          if (this.match('paren_close')) {
            closedParen = true;
            break;
          }
          const p = this.advance();
          url += ('value' in p) ? (p as any).value : '';
        }

        if (closedParen) {
          if (isImage) {
            return { type: 'image', url, alt: text };
          } else {
            return { type: 'link', url, children: [{ type: 'text', value: text }] };
          }
        }
      }
      
      // Fallback
      this.current = savedCurrent;
      return { type: 'text', value: isImage ? '![' : '[' };
    }

    return {
      type: 'text',
      value: this.tokenValue(token)
    };
  }

  // --- Helpers ---

  private peek(): MarkdownToken {
    return this.tokens[this.current];
  }

  private previous(): MarkdownToken {
    return this.tokens[this.current - 1];
  }

  private isAtEnd(): boolean {
    return this.current >= this.tokens.length;
  }

  private advance(): MarkdownToken {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private check(kind: MarkdownToken['kind']): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().kind === kind;
  }

  private match(kind: MarkdownToken['kind']): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;

  }
}

export function parseMarkdown(tokens: MarkdownToken[]): MarkdownDocument {
  const parser = new MarkdownParser(tokens);
  return parser.parse();
}
