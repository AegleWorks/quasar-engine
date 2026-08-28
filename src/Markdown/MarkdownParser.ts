import { MarkdownToken, MarkdownFenceToken, MarkdownContainerToken, scanMarkdown } from './MarkdownLexer';
import {
  MarkdownNode,
  MarkdownDocument,
  MarkdownParagraph,
  MarkdownText,
  MarkdownHeading,
  MarkdownStrikethrough,
  MarkdownUnderline,
  MarkdownColor,
  MarkdownFontSize,
  MarkdownFont,
  MarkdownAlign,
  MarkdownBox,
  MarkdownSeparator,
} from './MarkdownAST';

interface BBCodeTagInfo {
  tagName: string;
  attrValue?: string;
  tokenEndIndex: number;
}

const BLOCK_BBCODE_TAGS = new Set([
  'box', 'boxw', 'spoilerbox', 'centre', 'center', 'right', 'left', 'align', 'quote', 'notice', 'wnotice', 'code',
  'columns', 'tables', 'row', 'th', 'col', 'glass', 'card', 'neon-box', 'scroll', 'separator', 'list', 'group', 'svg', 'imagemap', 'image',
]);

/**
 * DocumentEngine — MarkdownParser
 * 
 * Parses Markdown tokens with hybrid BBCode embedding support into a typed AST.
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
        for (let i = 0; i < newlines; i++) {
          doc.children.push({ type: 'empty_line' });
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

    // Horizontal Rule (---)
    if (token.kind === 'hr' || (token.kind === 'dash' && ('value' in token && token.value === '---'))) {
      this.advance();
      this.match('newline');
      return { type: 'separator' };
    }

    if (token.kind === 'hash') {
      return this.parseHeading();
    }
    
    if (token.kind === 'gt') {
      const saved = this.current;
      this.advance(); // consume gt
      while (!this.isAtEnd() && this.peek()?.kind === 'text' && ('value' in this.peek()) && (this.peek() as any).value.trim() === '') {
        this.advance(); // consume space
      }
      if (this.check('bracket_open')) {
        const nextToken = this.tokens[this.current + 1];
        if (nextToken && (nextToken.kind === 'bang' || ('value' in nextToken && nextToken.value === '!'))) {
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

    // Fenced Container Divs (::: details Title, ::: center, ::: warning)
    if (token.kind === 'container') {
      return this.parseContainer();
    }
    
    // Lists (unordered or ordered)
    if (this.isListStart()) {
      return this.parseList();
    }

    // Embedded Block BBCode tags (e.g. [box=Title]...[/box], [centre]...[/centre])
    if (token.kind === 'bracket_open') {
      const bbTag = this.peekBBCodeOpenTag(this.current);
      if (bbTag && BLOCK_BBCODE_TAGS.has(bbTag.tagName)) {
        return this.parseBBCodeBlock(bbTag);
      }
    }

    // Default to paragraph
    return this.parseParagraph();
  }

  private parseHeading(): MarkdownHeading {
    const hash = this.advance();
    const level = hash.kind === 'hash' ? Math.min(hash.value.length, 6) : 1;
    
    const children: MarkdownNode[] = [];
    while (!this.isAtEnd() && !this.check('newline')) {
      const inlineNode = this.parseInline();
      if (inlineNode) {
        children.push(inlineNode);
      } else {
        break;
      }
    }
    
    if (children.length > 0 && children[0].type === 'text') {
      children[0].value = (children[0] as MarkdownText).value.replace(/^\s+/, '');
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
    this.advance(); // consume initial gt
    while (!this.isAtEnd() && this.peek()?.kind === 'text' && ('value' in this.peek()) && (this.peek() as any).value.trim() === '') {
      this.advance();
    }

    // Parse the first line's inline nodes to check for author attribution (e.g. **Author wrote:**, **Author:**, **Author**)
    const firstLineNodes: MarkdownNode[] = [];
    while (!this.isAtEnd() && !this.check('newline')) {
      const inlineNode = this.parseInline();
      if (inlineNode) firstLineNodes.push(inlineNode);
      else break;
    }

    let source: string | undefined;

    const getPlainText = (n: MarkdownNode): string => {
      if ('value' in n && typeof (n as any).value === 'string') return (n as any).value;
      if ('children' in n && Array.isArray((n as any).children)) {
        return (n as any).children.map(getPlainText).join('');
      }
      return '';
    };

    // Trim trailing whitespace nodes from the first line
    const trimmed = [...firstLineNodes];
    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1].type === 'text' &&
      (trimmed[trimmed.length - 1] as any).value.trim() === ''
    ) {
      trimmed.pop();
    }

    if (trimmed.length > 0) {
      // 1. Single bold node: **Author**, **Author wrote:**, **Author:**
      if (trimmed.length === 1 && trimmed[0].type === 'strong') {
        const raw = getPlainText(trimmed[0]).trim();
        const cleaned = raw.replace(/\s*wrote:\s*$/i, '').replace(/:\s*$/, '').trim();
        if (cleaned) {
          source = cleaned;
        }
      }
      // 2. Bold node followed by "wrote:", "wrote", ":", etc.
      else if (
        trimmed.length === 2 &&
        trimmed[0].type === 'strong' &&
        trimmed[1].type === 'text' &&
        /^\s*(wrote:|wrote|:)\s*$/i.test((trimmed[1] as any).value)
      ) {
        const cleaned = getPlainText(trimmed[0]).trim();
        if (cleaned) {
          source = cleaned;
        }
      }
      // 3. Plain text patterns: [quote=Author] or Author wrote:
      else {
        const fullLine = trimmed.map(getPlainText).join('').trim();
        const quoteMatch = fullLine.match(/^\[quote=["']?([^\]"']+)["']?\]$/i);
        if (quoteMatch) {
          source = quoteMatch[1].trim();
        } else {
          const wroteMatch = fullLine.match(/^(\*\*)?([^*\n]+?)\1\s*wrote:\s*$/i);
          if (wroteMatch) {
            source = wroteMatch[2].trim();
          }
        }
      }
    }

    if (!source) {
      children.push(...firstLineNodes);
    }

    while (!this.isAtEnd()) {
      if (this.check('newline')) {
        this.advance();
        if (this.check('newline') || this.isAtEnd()) {
          break; // Empty line ends blockquote
        }
        if (children.length > 0) {
          children.push({ type: 'text', value: '\n' });
        }
      }

      if (this.match('gt')) {
        // blockquote line prefix
        while (!this.isAtEnd() && this.peek()?.kind === 'text' && ('value' in this.peek()) && (this.peek() as any).value.trim() === '') {
          this.advance();
        }
      }

      if (this.check('newline')) {
        // will be handled on next loop iteration
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
        else break;
      }
    }

    if (children.length > 0 && children[0].type === 'text') {
      (children[0] as MarkdownText).value = (children[0] as MarkdownText).value.replace(/^\s+/, '');
    }

    return {
      type: 'blockquote',
      source,
      children
    };
  }
  
  private parseNotice(): MarkdownNode {
    const children: MarkdownNode[] = [];
    this.advance(); // consume gt
    while (!this.isAtEnd() && this.peek()?.kind === 'text' && ('value' in this.peek()) && (this.peek() as any).value.trim() === '') {
      this.advance();
    }
    
    // consume the [!NOTE] or [!NOTE]- Title part
    let headerText = '';
    let isCollapsible = false;
    let title = '';

    while (!this.isAtEnd() && !this.check('newline')) {
      if (this.match('bracket_close')) {
        // Check if immediately followed by - or + (Obsidian collapsible syntax)
        if (this.match('dash')) isCollapsible = true;
        else if (this.match('plus')) isCollapsible = true;
        
        // Read rest of title line
        while (!this.isAtEnd() && !this.check('newline')) {
          const t = this.advance();
          title += this.tokenValue(t);
        }
        break;
      }
      const t = this.advance();
      headerText += this.tokenValue(t);
    }
    
    this.match('newline');

    while (!this.isAtEnd()) {
      if (this.match('gt')) {
        // blockquote line prefix
        while (!this.isAtEnd() && this.peek()?.kind === 'text' && ('value' in this.peek()) && (this.peek() as any).value.trim() === '') {
          this.advance();
        }
      }
      if (this.check('newline')) {
        this.advance();
        if (this.check('newline') || this.isAtEnd()) break;
        children.push({ type: 'text', value: '\n' });
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
        else break;
      }
    }
    
    if (isCollapsible) {
      const cleanTitle = title.trim() || 'Details';
      return { type: 'box', title: cleanTitle, rawTitle: cleanTitle, children };
    }

    return { type: 'notice', children };
  }

  private parseContainer(): MarkdownNode {
    const token = this.advance() as MarkdownContainerToken;
    const info = token.info ? token.info.trim() : '';
    const firstSpace = info.indexOf(' ');
    const tag = (firstSpace === -1 ? info : info.slice(0, firstSpace)).toLowerCase();
    const rest = firstSpace === -1 ? '' : info.slice(firstSpace + 1).trim();

    this.match('newline');
    const children: MarkdownNode[] = [];

    while (!this.isAtEnd()) {
      if (this.check('container')) {
        this.advance(); // closing :::
        this.match('newline');
        break;
      }
      if (this.check('newline')) {
        this.advance();
        while (this.match('newline')) {
          children.push({ type: 'empty_line' });
        }
      } else {
        const block = this.parseBlock();
        if (block) children.push(block);
        else break;
      }
    }

    switch (tag) {
      case 'details':
      case 'box':
      case 'boxw':
        return { type: 'box', title: rest || 'Details', rawTitle: rest, children };
      case 'spoilerbox':
        return { type: 'spoilerbox', title: rest || 'Spoiler', rawTitle: rest, children };
      case 'center':
      case 'centre':
        return { type: 'center', children };
      case 'right':
        return { type: 'right', children };
      case 'left':
        return { type: 'left', children };
      case 'info':
      case 'note':
      case 'warning':
      case 'tip':
      case 'caution':
      case 'notice':
      case 'wnotice':
        return { type: 'notice', color: rest ? rest : undefined, children };
      case 'quote':
        return { type: 'blockquote', source: rest || undefined, children };
      default:
        return { type: 'box', title: info || 'Box', rawTitle: info, children };
    }
  }
  
  private tokenValue(token: MarkdownToken): string {
    if (!token) return '';
    if ('value' in token) return (token as any).value;
    switch (token.kind) {
      case 'bracket_open': return '[';
      case 'bracket_close': return ']';
      case 'brace_open': return '{';
      case 'brace_close': return '}';
      case 'paren_open': return '(';
      case 'paren_close': return ')';
      case 'bang': return '!';
      case 'gt': return '>';
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
        this.match('newline');
        break;
      }
      const p = this.advance();
      code += this.tokenValue(p);
    }
    if (code.startsWith('\r\n')) code = code.slice(2);
    else if (code.startsWith('\n')) code = code.slice(1);
    if (code.endsWith('\r\n')) code = code.slice(0, -2);
    else if (code.endsWith('\n')) code = code.slice(0, -1);

    return { type: 'code_block', lang: value, value: code };
  }

  private isListStart(): boolean {
    if (this.isAtEnd()) return false;
    const token = this.peek();
    if (token.kind === 'dash' || token.kind === 'star') {
      const next = this.tokens[this.current + 1];
      if (next && next.kind === 'text' && ('value' in next) && (next.value as string).startsWith(' ')) {
        return true;
      }
    }
    return this.isOrderedListStart();
  }

  private isOrderedListStart(): boolean {
    if (this.isAtEnd()) return false;
    const token = this.peek();
    if (token.kind === 'text' && /^\d+$/.test(('value' in token ? (token as any).value : '').trim())) {
      const next1 = this.tokens[this.current + 1];
      if (next1 && next1.kind === 'dot') {
        const next2 = this.tokens[this.current + 2];
        if (next2 && next2.kind === 'text' && ('value' in next2) && (next2.value as string).startsWith(' ')) {
          return true;
        }
      }
    }
    return false;
  }
  
  private parseList(): MarkdownNode {
    const items: any[] = [];
    const ordered = this.isOrderedListStart();

    while (!this.isAtEnd()) {
      if (ordered) {
        if (!this.isOrderedListStart()) break;
        this.advance(); // number
        this.advance(); // dot
      } else {
        if (!this.check('dash') && !this.check('star')) break;
        this.advance(); // dash or star
      }

      const children: MarkdownNode[] = [];
      while (!this.isAtEnd() && !this.check('newline')) {
        const inlineNode = this.parseInline();
        if (inlineNode) children.push(inlineNode);
        else break;
      }
      if (children.length > 0 && children[0].type === 'text') {
        children[0].value = (children[0] as MarkdownText).value.replace(/^\s+/, '');
      }
      items.push({ type: 'list_item', children });
      if (this.match('newline')) {
        if (this.check('newline')) break; // End of list on double newline
      }
    }
    return { type: 'list', ordered, children: items };
  }

  private parseParagraph(): MarkdownParagraph {
    const children: MarkdownNode[] = [];
    
    while (!this.isAtEnd()) {
      if (this.check('newline')) {
        this.advance();
        if (this.check('newline') || this.isAtEnd()) {
          break;
        } else {
          if (this.check('hash') || this.check('gt') || this.check('fence') || this.check('hr') || this.check('container')) {
            break;
          }
          if (this.isListStart()) {
            break;
          }
          // Also break if block BBCode starts
          if (this.check('bracket_open')) {
            const bbTag = this.peekBBCodeOpenTag(this.current);
            if (bbTag && BLOCK_BBCODE_TAGS.has(bbTag.tagName)) {
              break;
            }
          }
          children.push({ type: 'text', value: '\n' });
        }
      } else {
        const inlineNode = this.parseInline();
        if (inlineNode) {
          children.push(inlineNode);
        } else {
          break;
        }
      }
    }

    return {
      type: 'paragraph',
      children
    };
  }

  public parseInline(terminator?: { kind: string, value?: string }): MarkdownNode | null {
    if (this.isAtEnd()) return null;

    if (terminator) {
      const peekToken = this.peek();
      if (peekToken.kind === terminator.kind && (!terminator.value || ('value' in peekToken && peekToken.value === terminator.value))) {
        return null;
      }
    }

    // Check for BBCode close tag matching an active parent
    if (this.check('bracket_open')) {
      const peekClose = this.peekBBCodeCloseTag(this.current);
      if (peekClose) {
        return null;
      }

      // Check for BBCode open tag
      const openTag = this.peekBBCodeOpenTag(this.current);
      if (openTag) {
        return this.parseBBCodeInline(openTag);
      }
    }

    const token = this.advance();

    // Inline Code (`code`)
    if (token.kind === 'backtick') {
      const val = ('value' in token) ? token.value as string : '`';
      if (val === '`') {
        const savedCurrent = this.current;
        let code = '';
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break;

          if (next.kind === 'backtick' && ('value' in next && next.value === '`')) {
            this.advance();
            closed = true;
            break;
          }

          const p = this.advance();
          code += this.tokenValue(p);
        }

        if (closed) {
          return { type: 'code_inline', value: code };
        } else {
          this.current = savedCurrent;
          return { type: 'text', value: '`' };
        }
      }
    }
    
    // Bold and Italic (*, **, _, __)
    if (token.kind === 'star' || token.kind === 'underscore') {
      const val = ('value' in token) ? token.value as string : '';
      if (val === '**' || val === '__' || val === '*' || val === '_') {
        const type = (val.length === 2) ? 'strong' : 'emphasis';
        
        const savedCurrent = this.current;
        const children: MarkdownNode[] = [];
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break;

          if (next.kind === token.kind && ('value' in next && next.value === val)) {
            this.advance();
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
          this.current = savedCurrent;
          return { type: 'text', value: val };
        }
      }
    }

    // Strikethrough (~~)
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
          return { type: 'strikethrough', children }; 
        } else {
          this.current = savedCurrent;
          return { type: 'text', value: val };
        }
      }
    }
    
    // Underline (++) (CriticMarkup / markdown-it-ins)
    if (token.kind === 'plus' && ('value' in token && token.value === '++')) {
      const savedCurrent = this.current;
      const children: MarkdownNode[] = [];
      let closed = false;
      while (!this.isAtEnd()) {
        const next = this.peek();
        if (next.kind === 'newline') break;
        if (next.kind === 'plus' && ('value' in next && next.value === '++')) {
          this.advance();
          closed = true;
          break;
        }
        const child = this.parseInline({ kind: 'plus', value: '++' });
        if (child) children.push(child);
        else break;
      }
      if (closed) {
        return { type: 'underline', children };
      } else {
        this.current = savedCurrent;
        return { type: 'text', value: '++' };
      }
    }

    // Alignment arrow (-> text <- or -> text ->)
    if (token.kind === 'arrow_right') {
      const savedCurrent = this.current;
      const children: MarkdownNode[] = [];
      let alignType: 'center' | 'right' | null = null;
      while (!this.isAtEnd()) {
        const next = this.peek();
        if (next.kind === 'newline') break;
        if (next.kind === 'arrow_left') {
          this.advance();
          alignType = 'center';
          break;
        }
        if (next.kind === 'arrow_right') {
          this.advance();
          alignType = 'right';
          break;
        }
        const child = this.parseInline();
        if (child) children.push(child);
        else break;
      }
      if (alignType) {
        if (children.length > 0 && children[0].type === 'text') {
          children[0].value = (children[0] as MarkdownText).value.replace(/^\s+/, '');
        }
        if (children.length > 0 && children[children.length - 1].type === 'text') {
          const last = children[children.length - 1] as MarkdownText;
          last.value = last.value.replace(/\s+$/, '');
        }
        return { type: alignType, children };
      } else {
        this.current = savedCurrent;
        return { type: 'text', value: '->' };
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

    // Link, Image, or Generic Attribute Span [text]{attributes}
    if (token.kind === 'bracket_open' || token.kind === 'bang') {
      const savedCurrent = this.current;
      const isImage = token.kind === 'bang';
      if (isImage) {
        if (!this.match('bracket_open')) {
          return { type: 'text', value: '!' };
        }
      }
      
      let text = '';
      let closedBracket = false;
      
      while (!this.isAtEnd() && !this.check('newline')) {
        if (this.match('bracket_close')) {
          closedBracket = true;
          break;
        }
        const p = this.advance();
        text += this.tokenValue(p);
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
          url += this.tokenValue(p);
        }

        if (closedParen) {
          if (isImage) {
            return { type: 'image', url, alt: text };
          } else {
            return { type: 'link', url, children: [{ type: 'text', value: text }] };
          }
        }
      }

      // Generic Attribute Span [text]{.underline} or [text]{color="#ff0055"} or [text]{#ff0055}
      if (closedBracket && this.match('brace_open')) {
        let attrString = '';
        let closedBrace = false;
        while (!this.isAtEnd() && !this.check('newline')) {
          if (this.match('brace_close')) {
            closedBrace = true;
            break;
          }
          const p = this.advance();
          attrString += this.tokenValue(p);
        }

        if (closedBrace) {
          return this.createAttributeSpanNode(text, attrString.trim());
        }
      }
      
      // Fallback: restore cursor to before bracket was consumed
      this.current = savedCurrent;
      return { type: 'text', value: isImage ? '!' : '[' };
    }

    return {
      type: 'text',
      value: this.tokenValue(token)
    };
  }

  private createAttributeSpanNode(rawText: string, attrString: string): MarkdownNode {
    const innerTokens = scanMarkdown(rawText);
    const innerDoc = new MarkdownParser(innerTokens).parseInline();
    const children: MarkdownNode[] = innerDoc ? [innerDoc] : [{ type: 'text', value: rawText }];

    // 1. Shorthand class: .underline
    if (attrString === '.underline' || attrString.includes('.underline')) {
      return { type: 'underline', children };
    }

    // 2. Shorthand hex color: #ff0055 or #f00
    if (/^#[0-9a-fA-F]{3,8}$/.test(attrString)) {
      return { type: 'color', color: attrString, children };
    }

    // 3. Key-value attributes: color="...", size="...", font="..."
    let resultNode: MarkdownNode = { type: 'paragraph', children };
    let wrapped = false;

    // Match color=... or style="color:..."
    const colorMatch = attrString.match(/color=["']?([^"'\s}]+)["']?/) || attrString.match(/style=["'][^"']*color:\s*([^;"'\s]+)/);
    if (colorMatch) {
      resultNode = { type: 'color', color: colorMatch[1], children };
      wrapped = true;
    }

    // Match size=... or style="font-size:..."
    const sizeMatch = attrString.match(/size=["']?([^"'\s}]+)["']?/) || attrString.match(/style=["'][^"']*font-size:\s*([^;"'\s]+)/);
    if (sizeMatch) {
      const currentChildren = wrapped ? [resultNode] : children;
      resultNode = { type: 'font_size', size: sizeMatch[1], children: currentChildren };
      wrapped = true;
    }

    // Match font=... or style="font-family:..."
    const fontMatch = attrString.match(/font(?:-family)?=["']?([^"'}]+)["']?/);
    if (fontMatch) {
      const currentChildren = wrapped ? [resultNode] : children;
      resultNode = { type: 'font', font: fontMatch[1].trim(), children: currentChildren };
      wrapped = true;
    }

    if (wrapped) {
      return resultNode;
    }

    return { type: 'text', value: `[${rawText}]{${attrString}}` };
  }

  // --- BBCode Embedding Support ---

  private peekBBCodeOpenTag(startIndex: number): BBCodeTagInfo | null {
    if (this.tokens[startIndex]?.kind !== 'bracket_open') return null;
    let idx = startIndex + 1;
    let tagContent = '';

    while (idx < this.tokens.length) {
      const t = this.tokens[idx];
      if (t.kind === 'newline') return null;
      if (t.kind === 'bracket_close') {
        // Evaluate tagContent
        const trimmed = tagContent.trim();
        if (trimmed.startsWith('/')) return null; // closing tag

        const eqIdx = trimmed.indexOf('=');
        const tagName = (eqIdx >= 0 ? trimmed.slice(0, eqIdx) : trimmed).trim().toLowerCase();
        let attrValue = eqIdx >= 0 ? trimmed.slice(eqIdx + 1).trim() : undefined;
        if (attrValue && ((attrValue.startsWith('"') && attrValue.endsWith('"')) || (attrValue.startsWith("'") && attrValue.endsWith("'")))) {
          attrValue = attrValue.slice(1, -1);
        }

        // If immediately followed by (url) or {attributes}, it is a Markdown construct, not BBCode
        if (idx + 1 < this.tokens.length) {
          const nextToken = this.tokens[idx + 1];
          if (nextToken.kind === 'paren_open' || nextToken.kind === 'brace_open') {
            return null;
          }
        }

        if (/^[a-z0-9_-]+$/i.test(tagName)) {
          return { tagName, attrValue, tokenEndIndex: idx };
        }
        return null;
      }
      tagContent += this.tokenValue(t);
      idx++;
    }

    return null;
  }

  private peekBBCodeCloseTag(startIndex: number): { tagName: string; tokenEndIndex: number } | null {
    if (this.tokens[startIndex]?.kind !== 'bracket_open') return null;
    let idx = startIndex + 1;
    let tagContent = '';

    while (idx < this.tokens.length) {
      const t = this.tokens[idx];
      if (t.kind === 'newline') return null;
      if (t.kind === 'bracket_close') {
        const trimmed = tagContent.trim();
        if (trimmed.startsWith('/')) {
          const tagName = trimmed.slice(1).trim().toLowerCase();
          if (/^[a-z0-9_-]+$/i.test(tagName)) {
            return { tagName, tokenEndIndex: idx };
          }
        }
        return null;
      }
      tagContent += this.tokenValue(t);
      idx++;
    }

    return null;
  }

  private isMatchingCloseTag(closeTagName: string, openTagName: string): boolean {
    const c = closeTagName.toLowerCase();
    const o = openTagName.toLowerCase();
    if (c === o) return true;
    if ((c === 'centre' || c === 'center') && (o === 'centre' || o === 'center')) return true;
    if ((c === 'u' || c === 'underline') && (o === 'u' || o === 'underline')) return true;
    if ((c === 's' || c === 'strike' || c === 'strikethrough') && (o === 's' || o === 'strike' || o === 'strikethrough')) return true;
    if ((c === 'b' || c === 'bold') && (o === 'b' || o === 'bold')) return true;
    if ((c === 'i' || c === 'italic') && (o === 'i' || o === 'italic')) return true;
    if ((c === 'box' || c === 'boxw') && (o === 'box' || o === 'boxw')) return true;
    return false;
  }

  private parseBBCodeBlock(openTag: BBCodeTagInfo): MarkdownNode {
    const t = openTag.tagName.toLowerCase();
    if (t === 'code') {
      this.current = openTag.tokenEndIndex + 1;
      let raw = '';
      while (!this.isAtEnd()) {
        if (this.check('bracket_open')) {
          const closeTag = this.peekBBCodeCloseTag(this.current);
          if (closeTag && closeTag.tagName.toLowerCase() === 'code') {
            this.current = closeTag.tokenEndIndex + 1;
            this.match('newline');
            break;
          }
        }
        const p = this.advance();
        raw += this.tokenValue(p);
      }
      if (raw.startsWith('\r\n')) raw = raw.slice(2);
      else if (raw.startsWith('\n')) raw = raw.slice(1);
      if (raw.endsWith('\r\n')) raw = raw.slice(0, -2);
      else if (raw.endsWith('\n')) raw = raw.slice(0, -1);
      return { type: 'code_block', lang: '', value: raw };
    }

    this.current = openTag.tokenEndIndex + 1;
    this.match('newline');

    const children: MarkdownNode[] = [];

    while (!this.isAtEnd()) {
      if (this.check('bracket_open')) {
        const closeTag = this.peekBBCodeCloseTag(this.current);
        if (closeTag && this.isMatchingCloseTag(closeTag.tagName, openTag.tagName)) {
          this.current = closeTag.tokenEndIndex + 1;
          this.match('newline');
          break;
        }
      }

      if (this.check('newline')) {
        this.advance();
        while (this.match('newline')) {
          children.push({ type: 'empty_line' });
        }
      } else {
        const block = this.parseBlock();
        if (block) children.push(block);
        else break;
      }
    }

    return this.createBBCodeNode(openTag.tagName, openTag.attrValue, children);
  }

  private parseBBCodeInline(openTag: BBCodeTagInfo): MarkdownNode {
    const t = openTag.tagName.toLowerCase();
    if (t === 'c') {
      this.current = openTag.tokenEndIndex + 1;
      let raw = '';
      while (!this.isAtEnd()) {
        if (this.check('bracket_open')) {
          const closeTag = this.peekBBCodeCloseTag(this.current);
          if (closeTag && closeTag.tagName.toLowerCase() === 'c') {
            this.current = closeTag.tokenEndIndex + 1;
            break;
          }
        }
        if (this.check('newline')) break;
        const p = this.advance();
        raw += this.tokenValue(p);
      }
      return { type: 'code_inline', value: raw };
    }

    if (t === 'raw' || t === 'noparse' || t === 'plain') {
      this.current = openTag.tokenEndIndex + 1;
      let raw = '';
      while (!this.isAtEnd()) {
        if (this.check('bracket_open')) {
          const closeTag = this.peekBBCodeCloseTag(this.current);
          if (closeTag && this.isMatchingCloseTag(closeTag.tagName, openTag.tagName)) {
            this.current = closeTag.tokenEndIndex + 1;
            break;
          }
        }
        if (this.check('newline')) {
          this.advance();
          raw += '\n';
        } else {
          const p = this.advance();
          raw += this.tokenValue(p);
        }
      }
      return { type: 'bbcode_tag', tagName: t === 'noparse' ? 'raw' : t, attrValue: openTag.attrValue, children: [{ type: 'text', value: raw }] };
    }

    this.current = openTag.tokenEndIndex + 1;
    const children: MarkdownNode[] = [];

    while (!this.isAtEnd()) {
      if (this.check('bracket_open')) {
        const closeTag = this.peekBBCodeCloseTag(this.current);
        if (closeTag && this.isMatchingCloseTag(closeTag.tagName, openTag.tagName)) {
          this.current = closeTag.tokenEndIndex + 1;
          break;
        }
      }

      if (this.check('newline')) {
        this.advance();
        children.push({ type: 'text', value: '\n' });
      } else {
        const child = this.parseInline();
        if (child) children.push(child);
        else break;
      }
    }

    return this.createBBCodeNode(openTag.tagName, openTag.attrValue, children);
  }

  private createBBCodeNode(tagName: string, attrValue: string | undefined, children: MarkdownNode[]): MarkdownNode {
    const t = tagName.toLowerCase();
    switch (t) {
      case 'b':
      case 'bold':
        return { type: 'strong', children };
      case 'i':
      case 'italic':
        return { type: 'emphasis', children };
      case 'u':
      case 'underline':
        return { type: 'underline', children };
      case 's':
      case 'strike':
      case 'strikethrough':
        return { type: 'strikethrough', children };
      case 'c':
        return { type: 'code_inline', value: children.map(c => ('value' in c ? (c as any).value : '')).join('') };
      case 'color':
      case 'colour':
        return { type: 'color', color: attrValue || '#ffffff', children };
      case 'size':
        return { type: 'font_size', size: attrValue || '100', children };
      case 'font':
        return { type: 'font', font: attrValue || 'sans-serif', children };
      case 'centre':
      case 'center':
        return { type: 'center', children };
      case 'right':
        return { type: 'right', children };
      case 'left':
        return { type: 'left', children };
      case 'align':
        return { type: (attrValue === 'center' || attrValue === 'right' || attrValue === 'left' ? attrValue : 'center') as any, children };
      case 'box':
      case 'boxw':
        return { type: 'box', title: attrValue || 'Box', rawTitle: attrValue, children };
      case 'spoilerbox':
        return { type: 'spoilerbox', title: attrValue || 'Spoiler', rawTitle: attrValue, children };
      case 'spoiler':
        return { type: 'spoiler', children };
      case 'quote':
        return { type: 'blockquote', source: attrValue, children };
      case 'notice':
        return { type: 'notice', color: attrValue, children };
      case 'wnotice':
        return { type: 'wnotice', color: attrValue, children };
      default:
        return { type: 'bbcode_tag', tagName: t, attrValue, children };
    }
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
