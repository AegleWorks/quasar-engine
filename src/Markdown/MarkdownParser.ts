import { MarkdownToken, MarkdownFenceToken, MarkdownContainerToken, scanMarkdown } from './MarkdownLexer';
import { MAX_NESTING_DEPTH } from '../BBCode/Parser';
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

/**
 * BBCode tags with no body. `[separator]` is a rule, not a container; waiting
 * for a `[/separator]` that will never come used to consume the rest of the
 * document as its children, and an exporter that ignores those children then
 * deleted everything after the tag.
 */
const SELF_CLOSING_BBCODE_TAGS = new Set(['separator', 'br', 'hr'])

/**
 * Spelling aliases, folded so `[/bold]` answers `[b]` and `[/center]` answers
 * `[centre]`. Same equivalence `isMatchingCloseTag` applies while parsing.
 */
function canonicalBBCodeTag(name: string): string {
  switch (name.toLowerCase()) {
    case 'bold': return 'b'
    case 'italic': return 'i'
    case 'underline': return 'u'
    case 'strike':
    case 'strikethrough': return 's'
    case 'center': return 'centre'
    case 'boxw': return 'box'
    case 'colour': return 'color'
    default: return name.toLowerCase()
  }
}

const MEDIA_RAW_BODY_TAGS = new Set([
  'img', 'youtube', 'audio', 'video',
]);

const BLOCK_BBCODE_TAGS = new Set([
  'box', 'boxw', 'spoilerbox', 'centre', 'center', 'right', 'left', 'align', 'quote', 'notice', 'wnotice', 'code',
  'columns', 'tables', 'row', 'th', 'col', 'glass', 'card', 'neon-box', 'scroll', 'separator', 'list', 'group', 'svg', 'imagemap', 'image',
]);

export interface MarkdownParseOptions {
  /**
   * How a newline inside a paragraph is treated.
   *
   * `soft` is Markdown's rule: the newline stays inside the paragraph as a
   * `\n` text node, so a browser collapses it to a space. `hard` is BBCode's
   * rule: every newline ends the line, so it becomes a sibling `spacing` /
   * `empty_line` node and renders as `<br>`. MilHibri uses `hard`; the
   * Markdown importer keeps `soft`.
   */
  lineBreaks?: 'soft' | 'hard';
  /**
   * Parse a text run, not a document.
   *
   * Inline-only mode does not interpret single `*`/`_` emphasis or `->`
   * alignment: inside an osu! page those are ordinary prose far more often
   * than Markdown. Double emphasis, `~~`, `++`, inline code and links stay
   * available, because those are unambiguous.
   */
  inlineOnly?: boolean;
  /** Original source, used by inline-only boundary checks. */
  source?: string;
}

/**
 * DocumentEngine — MarkdownParser
 * 
 * Parses Markdown tokens with hybrid BBCode embedding support into a typed AST.
 */
export class MarkdownParser {
  private tokens: MarkdownToken[];
  private current: number = 0;
  /** `parseInline` frames on the stack: the inline nesting depth. */
  private inlineDepth = 0
  /** Last index of each closing tag, built once; see `hasClosingTagAfter`. */
  private closeIndexByTag: Map<string, number> | null = null;
  /** Whether newlines end lines (BBCode) instead of softening (Markdown). */
  private readonly hardBreaks: boolean;
  /** Inline-only mode: see {@link MarkdownParseOptions.inlineOnly}. */
  private readonly inlineOnly: boolean;
  /** Original source, when the caller has it (inline mode). */
  private readonly source: string;

  constructor(tokens: MarkdownToken[], options: MarkdownParseOptions = {}) {
    this.tokens = tokens;
    this.hardBreaks = options.lineBreaks === 'hard';
    this.inlineOnly = options.inlineOnly === true;
    this.source = options.source ?? '';
  }

  /** Whether `index` is a word character in the source. */
  private isWordCharAt(index: number): boolean {
    if (index < 0 || index >= this.source.length) return false;
    return /[A-Za-z0-9_]/.test(this.source[index]);
  }

  /** `C++`, `M****`, `word**` — an opener glued to a word is prose. */
  private emphasisOpenBlocked(token: MarkdownToken): boolean {
    return this.inlineOnly && this.isWordCharAt(token.start - 1);
  }

  /** `**bold**word` — a closer glued to a word is prose too. */
  private emphasisCloseBlocked(token: MarkdownToken): boolean {
    return this.inlineOnly && this.isWordCharAt(token.end);
  }

  public parse(): MarkdownDocument {
    const doc: MarkdownDocument = {
      type: 'document',
      children: []
    };

    while (!this.isAtEnd()) {
      if (this.check('newline')) {
        const count = this.newlineRunLength();
        this.current += count;
        this.pushNewlineRun(doc.children, count);
        continue;
      }

      const node = this.parseBlock();
      if (node) doc.children.push(node);
      else break;
    }

    return doc;
  }

  private parseBlock(): MarkdownNode | null {
    if (this.isAtEnd()) return null;

    const token = this.peek();

    // A line made only of tildes is osu!'s separator, not empty
    // strikethrough: `~~~~` used to render as `<s></s>` and lose the marks.
    if (this.isTildeRuleLine()) {
      let raw = '';
      while (!this.isAtEnd() && !this.check('newline')) {
        raw += this.tokenValue(this.advance());
      }
      if (!this.hardBreaks) this.match('newline');
      return { type: 'paragraph', children: [{ type: 'text', value: raw }] };
    }

    // Horizontal Rule (---)
    if (token.kind === 'hr' || (token.kind === 'dash' && ('value' in token && token.value === '---'))) {
      this.advance();
      // In hard mode the line ending stays in the tree: the renderer hides the
      // newlines a block swallows, so dropping it here would hide the NEXT one.
      if (!this.hardBreaks) this.match('newline');
      return { type: 'separator' };
    }

    if (token.kind === 'hash' && this.isAtxHeading()) {
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
    
    if (token.kind === 'fence' && this.isFenceOpener(token)) {
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

      // A closer with no opener left to match is not an instruction. Consume
      // it as literal text so the document loop always makes progress:
      // `parseParagraph` stops when `parseInline` sees the closer and returns
      // null without advancing, which used to spin on the same token forever.
      const closeTag = this.peekBBCodeCloseTag(this.current);
      if (closeTag) {
        const literal = this.literalOpener({
          tagName: closeTag.tagName,
          attrValue: undefined,
          tokenEndIndex: closeTag.tokenEndIndex,
        });
        this.current = closeTag.tokenEndIndex + 1;
        return { type: 'paragraph', children: [{ type: 'text', value: literal }] };
      }
    }

    // Default to paragraph
    return this.parseParagraph();
  }

  /** A line made only of tildes is osu!'s separator, not empty strikethrough. */
  private isTildeRuleLine(index = this.current): boolean {
    if (this.tokens[index]?.kind !== 'tilde') return false
    let at = index
    let count = 0
    while (this.tokens[at]?.kind === 'tilde') {
      count += (this.tokens[at] as any).value.length
      at++
    }
    return count >= 3 && (!this.tokens[at] || this.tokens[at].kind === 'newline')
  }

  /**
   * CommonMark requires a space (or the line's end) after the `#` run.
   * osu! userpages are full of `#1 vermont`, which is prose, not a heading;
   * treating it as one turned the line into `[heading=1]` on export and moved
   * the text into an h2.
   */
  private isAtxHeading(index = this.current): boolean {
    if (this.tokens[index]?.kind !== 'hash') return false
    const next = this.tokens[index + 1]
    if (!next || next.kind === 'newline') return true
    return next.kind === 'text' && 'value' in next && (next as any).value.startsWith(' ')
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

    if (!this.hardBreaks) this.match('newline');

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
        // A fence, heading or other block on the next line is not a lazy
        // quote continuation: it belongs outside the quote. Without this the
        // rest of the document became quote text (and a fenced code block
        // showed as literal backticks).
        if (!this.check('gt') && this.startsBlockAt(this.current)) break;
        if (children.length > 0) {
          children.push(this.hardBreaks ? { type: 'spacing' } : { type: 'text', value: '\n' });
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
        if (!this.check('gt') && this.startsBlockAt(this.current)) break;
        children.push(this.hardBreaks ? { type: 'spacing' } : { type: 'text', value: '\n' });
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
    // The fence's own line ending is syntax, not content: Markdown drops it.
    // MilHibri keeps it so the renderer can hide exactly the newlines BBCode
    // hides, instead of hiding the one after them.
    const children: MarkdownNode[] = [];
    if (!this.hardBreaks) this.match('newline');

    while (!this.isAtEnd()) {
      if (this.check('container')) {
        this.advance(); // closing :::
        if (!this.hardBreaks) this.match('newline');
        break;
      }
      if (this.check('newline')) {
        const count = this.newlineRunLength();
        this.current += count;
        this.pushNewlineRun(children, count);
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

    // Fences and containers carry their info string in a second field; a
    // verbatim block must reconstruct the whole line, not just the marker.
    // (`::: details no` used to lose " details no" inside a code fence.)
    if (token.kind === 'container') return token.value + (token.info ? ' ' + token.info : '');
    if (token.kind === 'fence') return token.value + token.lang;

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

  /**
   * A bare `~~~~` line is an osu! userpage separator far more often than a
   * tilde code fence. Quasar's Markdown docs use backticks exclusively, so in
   * the hard-break (MilHibri) dialect a tilde fence needs an info string to
   * opt in. Markdown's own importer (soft breaks) keeps the full grammar.
   */
  private isFenceOpener(token: MarkdownToken): boolean {
    if (token.kind !== 'fence') return false
    return !this.hardBreaks || token.value.startsWith('`') || token.lang !== ''
  }

  private parseFence(): MarkdownNode {
    const token = this.advance() as MarkdownFenceToken;
    const value = token.lang;
    const marker = token.value[0] || '`';
    let code = '';
    while (!this.isAtEnd()) {
      const next = this.peek();
      // CommonMark's closer: same character, at least as long, at the start
      // of its own line, no info string. Anywhere else — even a run of
      // backticks in the middle of a code line — is content.
      if (
        next.kind === 'fence'
        && next.value[0] === marker
        && next.value.length >= token.value.length
        && next.lang === ''
        && this.isAtLineStart(this.current)
      ) {
        this.advance(); // close fence
        if (!this.hardBreaks) this.match('newline');
        break;
      }
      // Indentation before the closer is not code content.
      if (next.kind === 'text' && 'value' in next && /^[ \t]+$/.test((next as any).value)) {
        let at = this.current + 1;
        while (
          this.tokens[at]?.kind === 'text'
          && 'value' in this.tokens[at]
          && /^[ \t]+$/.test((this.tokens[at] as any).value)
        ) at++;
        const closer = this.tokens[at];
        if (closer?.kind === 'fence' && closer.lang === '' && this.isAtLineStart(at)) {
          this.current = at;
          continue;
        }
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
      if (this.match('newline')) {
        if (this.check('newline')) {
          items.push({ type: 'list_item', children });
          break; // End of list on double newline
        }
        // A fence indented under the item belongs to the item, not to a
        // paragraph after the list. Skipping the indentation here is enough
        // for the block to be parsed (and its content kept) instead of the
        // backticks becoming literal prose.
        const saved = this.current;
        let next = this.current;
        while (
          this.tokens[next]?.kind === 'text'
          && 'value' in this.tokens[next]
          && /^[ \t]+$/.test((this.tokens[next] as any).value)
        ) next++;
        const fence = this.tokens[next]
        if (fence?.kind === 'fence' && this.isFenceOpener(fence)) {
          this.current = next;
          children.push(this.parseFence());
          // In hard-break mode the fence leaves its line ending in the tree;
          // eating it here keeps the next `- item` in the same list.
          this.match('newline');
        } else {
          this.current = saved;
        }
      }
      items.push({ type: 'list_item', children });
    }
    return { type: 'list', ordered, children: items };
  }

  private isListItemMarker(index = this.current): boolean {
    if (this.tokens[index]?.kind !== 'bracket_open') return false
    const middle = this.tokens[index + 1]
    const star = middle && (middle.kind === 'star' || middle.kind === 'text')
      && 'value' in middle && (middle as any).value === '*'
    return !!star && this.tokens[index + 2]?.kind === 'bracket_close'
  }

  /** Whether the line starting at `index` is a block, not a lazy quote line. */
  private startsBlockAt(index: number): boolean {
    const token = this.tokens[index]
    if (!token) return false
    if (token.kind === 'fence') return this.isFenceOpener(token)
    if (token.kind === 'container' || token.kind === 'hr') return true
    if (token.kind === 'hash') return this.isAtxHeading(index)
    if (token.kind === 'dash' || token.kind === 'star') {
      const next = this.tokens[index + 1]
      return !!next && next.kind === 'text' && 'value' in next && (next as any).value.startsWith(' ')
    }
    if (token.kind === 'text' && /^\d+$/.test(((token as any).value as string).trim())) {
      const dot = this.tokens[index + 1]
      const next = this.tokens[index + 2]
      return dot?.kind === 'dot' && !!next && next.kind === 'text' && 'value' in next && (next as any).value.startsWith(' ')
    }
    if (token.kind === 'bracket_open') {
      const open = this.peekBBCodeOpenTag(index)
      return !!open && BLOCK_BBCODE_TAGS.has((open as BBCodeTagInfo).tagName.toLowerCase())
    }
    return false
  }

  /** Whether only indentation precedes `index` on its line. */
  private isAtLineStart(index: number): boolean {
    let i = index - 1
    while (i >= 0) {
      const token = this.tokens[i]
      if (token.kind === 'text' && 'value' in token && /^[ \t]+$/.test((token as any).value)) {
        i--
        continue
      }
      return token.kind === 'newline'
    }
    return true
  }

  private parseParagraph(): MarkdownParagraph {
    const children: MarkdownNode[] = [];
    
    while (!this.isAtEnd()) {
      if (this.check('newline')) {
        // BBCode ends the line here; the caller turns the newline into its own
        // node. Markdown keeps it inside the paragraph (a soft break).
        if (this.hardBreaks) break;
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
    // One `parseInline` frame per level of inline nesting. Past the BBCode
    // parser's own limit (`MAX_NESTING_DEPTH`), tokens come in as plain text:
    // every walker over the tree recurses per level, and the recursion here
    // ran out of stack first — the importer then gave up on the WHOLE
    // document and kept it as one text leaf.
    if (this.inlineDepth >= MAX_NESTING_DEPTH) {
      return { type: 'text', value: this.tokenValue(this.advance()) };
    }
    this.inlineDepth++;
    try {
      return this.parseInlineAt(terminator);
    } finally {
      this.inlineDepth--;
    }
  }

  /** Parse the whole token stream as inline content (no blocks). */
  public parseInlineSequence(): MarkdownNode[] {
    const nodes: MarkdownNode[] = [];
    while (!this.isAtEnd()) {
      const node = this.parseInline();
      if (!node) break;
      nodes.push(node);
    }
    return nodes;
  }

  private parseInlineAt(terminator?: { kind: string, value?: string }): MarkdownNode | null {

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

    // `[*]` is BBCode's list-item marker, not an emphasis opener. Left to the
    // `*` branch below, each nesting level re-scanned the entire rest of the
    // document looking for a closing `*`, which made `[list]` nests
    // exponential (24 levels = 27 s).
    if (this.isListItemMarker()) {
      this.current += 3
      return { type: 'text', value: '[*]' }
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
      // Inside a BBCode text run a `_` is prose far more often than Markdown
      // (`__init__`, a URL, a username), and the document-level detector does
      // not treat `__…__` as an unambiguous marker. Only `**` survives here.
      const ambiguousSingle = this.inlineOnly && (token.kind === 'underscore' || val.length === 1);
      const blocked = this.emphasisOpenBlocked(token);
      if (!ambiguousSingle && !blocked && (val === '**' || val === '__' || val === '*' || val === '_')) {
        const type = (val.length === 2) ? 'strong' : 'emphasis';
        
        const savedCurrent = this.current;
        const children: MarkdownNode[] = [];
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break;

          if (next.kind === token.kind && ('value' in next && next.value === val) && !this.emphasisCloseBlocked(next)) {
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

        if (closed && children.length > 0) {
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
      if (val === '~~' && !this.emphasisOpenBlocked(token)) {
        const savedCurrent = this.current;
        const children: MarkdownNode[] = [];
        let closed = false;

        while (!this.isAtEnd()) {
          const next = this.peek();
          if (next.kind === 'newline') break;

          if (next.kind === 'tilde' && ('value' in next && next.value === val) && !this.emphasisCloseBlocked(next)) {
            this.advance();
            closed = true;
            break;
          }

          const child = this.parseInline({ kind: 'tilde', value: val });
          if (child) children.push(child);
          else break;
        }

        if (closed && children.length > 0) {
          return { type: 'strikethrough', children }; 
        } else {
          this.current = savedCurrent;
          return { type: 'text', value: val };
        }
      }
    }
    
    // Underline (++) (CriticMarkup / markdown-it-ins)
    if (token.kind === 'plus' && ('value' in token && token.value === '++') && !this.emphasisOpenBlocked(token)) {
      const savedCurrent = this.current;
      const children: MarkdownNode[] = [];
      let closed = false;
      while (!this.isAtEnd()) {
        const next = this.peek();
        if (next.kind === 'newline') break;
        if (next.kind === 'plus' && ('value' in next && next.value === '++') && !this.emphasisCloseBlocked(next)) {
          this.advance();
          closed = true;
          break;
        }
        const child = this.parseInline({ kind: 'plus', value: '++' });
        if (child) children.push(child);
        else break;
      }
      if (closed && children.length > 0) {
        return { type: 'underline', children };
      } else {
        this.current = savedCurrent;
        return { type: 'text', value: '++' };
      }
    }

    // Alignment arrow (-> text <- or -> text ->). A block construct, so the
    // BBCode-structure hybrid leaves it alone inside a text run.
    if (token.kind === 'arrow_right' && !this.inlineOnly) {
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
    const innerDoc = new MarkdownParser(innerTokens, {
      lineBreaks: this.hardBreaks ? 'hard' : 'soft',
      inlineOnly: this.inlineOnly,
      source: rawText,
    }).parseInline();
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
            if (!this.hardBreaks) this.match('newline');
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

    // A tag with no body, or one whose closer the author never wrote, must
    // not claim the rest of the document. `[separator]` is a rule; an
    // unmatched `[box]` is a typo. Both become a literal/leaf node and the
    // parser continues after the opener, so later content survives.
    const selfClosing = SELF_CLOSING_BBCODE_TAGS.has(t)
    const hasClose = this.hasClosingTagAfter(t, openTag.tokenEndIndex + 1)
    if (selfClosing || !hasClose) {
      const literal = this.literalOpener(openTag)
      this.current = openTag.tokenEndIndex + 1
      if (selfClosing) {
        return this.createBBCodeNode(openTag.tagName, openTag.attrValue, [])
      }
      return {
        type: 'paragraph',
        children: [{ type: 'text', value: literal }],
      }
    }

    if (t === 'list') return this.parseBBCodeList(openTag)

    this.current = openTag.tokenEndIndex + 1;
    // Soft Markdown keeps the old parser's treatment: the newline that follows
    // the opener is syntax and disappears. MilHibri keeps it so the renderer's
    // own swallow budget lines up with the source, one node per newline.
    if (!this.hardBreaks) this.match('newline');

    const children: MarkdownNode[] = [];

    while (!this.isAtEnd()) {
      if (this.check('bracket_open')) {
        const closeTag = this.peekBBCodeCloseTag(this.current);
        if (closeTag && this.isMatchingCloseTag(closeTag.tagName, openTag.tagName)) {
          this.current = closeTag.tokenEndIndex + 1;
          if (!this.hardBreaks) this.match('newline');
          break;
        }
      }

      if (this.check('newline')) {
        const count = this.newlineRunLength();
        this.current += count;
        this.pushNewlineRun(children, count);
      } else {
        const block = this.parseBlock();
        if (block) children.push(block);
        else break;
      }
    }

    return this.createBBCodeNode(openTag.tagName, openTag.attrValue, children);
  }

  /**
   * `[list]` / `[list=1]` with `[*]` items. osu!'s list syntax is the one
   * piece of BBCode the Markdown importer did not understand: every `[*]`
   * stayed visible as prose (`list-leak` in the stress study), and a list
   * exported by MilHibri could not be re-imported.
   */
  private parseBBCodeList(openTag: BBCodeTagInfo): MarkdownNode {
    const ordered = (openTag.attrValue ?? '') === '1'
    this.current = openTag.tokenEndIndex + 1
    const items: MarkdownNode[] = []
    let children: MarkdownNode[] | null = null
    const finish = (): void => {
      if (children !== null) items.push({ type: 'list_item', children })
      children = null
    }

    while (!this.isAtEnd()) {
      if (this.check('bracket_open')) {
        const closeTag = this.peekBBCodeCloseTag(this.current)
        if (closeTag && this.isMatchingCloseTag(closeTag.tagName, openTag.tagName)) {
          this.current = closeTag.tokenEndIndex + 1
          break
        }
      }

      if (this.isListItemMarker()) {
        finish()
        children = []
        this.current += 3
        continue
      }

      if (children === null) {
        // The newline that follows `[list]` (and indentation between items)
        // is separator, not the first item's content.
        if (this.check('newline')) {
          this.current += this.newlineRunLength()
          continue
        }
        children = []
      }

      if (this.check('newline')) {
        const count = this.newlineRunLength()
        this.current += count
        this.pushNewlineRun(children, count)
      } else {
        const block = this.parseBlock()
        if (block) children.push(block)
        else children.push({ type: 'text', value: this.tokenValue(this.advance()) })
      }
    }
    finish()
    return { type: 'list', ordered, children: items } as MarkdownNode
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

    // Same recovery as the block path: an inline tag with no closer in the
    // rest of the document is literal text, not a container that eats the
    // remainder of the document.
    const selfClosing = SELF_CLOSING_BBCODE_TAGS.has(t)
    if (selfClosing || !this.hasClosingTagAfter(t, openTag.tokenEndIndex + 1)) {
      const literal = this.literalOpener(openTag)
      this.current = openTag.tokenEndIndex + 1
      if (selfClosing) {
        return this.createBBCodeNode(openTag.tagName, openTag.attrValue, [])
      }
      return { type: 'text', value: literal }
    }

    // Media and link bodies are VALUES, not prose. `[img]…__len__…[/img]`
    // used to parse the underscores as emphasis and `[url]a_b_c[/url]` as
    // italics, so the exported URL was rewritten with `[i]`/`[b]` inside it.
    if (MEDIA_RAW_BODY_TAGS.has(t)) {
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
          raw += this.tokenValue(this.advance());
        }
      }
      return this.createBBCodeNode(openTag.tagName, openTag.attrValue, [{ type: 'text', value: raw }]);
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
        if (this.hardBreaks) {
          // Inline tags never swallow a newline in BBCode: each one is a
          // break, not Markdown's soft space.
          const count = this.newlineRunLength();
          this.current += count;
          this.pushNewlineRun(children, count);
        } else {
          this.advance();
          children.push({ type: 'text', value: '\n' });
        }
      } else {
        const child = this.parseInline();
        if (child) children.push(child);
        else break;
      }
    }

    return this.createBBCodeNode(openTag.tagName, openTag.attrValue, children);
  }

  /** The opener exactly as the source spelled it, from its tokens. */
  private literalOpener(openTag: BBCodeTagInfo): string {
    let raw = ''
    for (let i = this.current; i <= openTag.tokenEndIndex && i < this.tokens.length; i++) {
      raw += this.tokenValue(this.tokens[i])
    }
    return raw
  }

  /**
   * Whether a closer for `tagName` exists after `fromIndex`.
   *
   * One index pass for the whole document, then O(1) per opener. A linear
   * scan per opener is quadratic on a document made of unmatched tags —
   * exactly the malformed input this check exists to handle.
   */
  private hasClosingTagAfter(tagName: string, fromIndex: number): boolean {
    if (this.closeIndexByTag === null) {
      const map = new Map<string, number>()
      for (let i = 0; i < this.tokens.length; i++) {
        if (this.tokens[i].kind !== 'bracket_open') continue
        const close = this.peekBBCodeCloseTag(i)
        if (close) map.set(canonicalBBCodeTag(close.tagName), i)
      }
      this.closeIndexByTag = map
    }
    return (this.closeIndexByTag.get(canonicalBBCodeTag(tagName)) ?? -1) > fromIndex
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
        // `[box=]` has an EMPTY title; `[box]` has none. Defaulting the empty
        // one to "Box" made MilHibri add a heading osu! never showed.
        return { type: 'box', title: attrValue ?? 'Box', rawTitle: attrValue, children };
      case 'spoilerbox':
        return { type: 'spoilerbox', title: attrValue ?? 'Spoiler', rawTitle: attrValue, children };
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

  // --- Newlines ---

  /** How many consecutive newline tokens sit at the cursor. */
  private newlineRunLength(): number {
    let count = 0;
    while (this.tokens[this.current + count]?.kind === 'newline') count++;
    return count;
  }

  /**
   * Turns a newline run into the nodes BBCode's own parser builds: a `spacing`
   * first (the line break) and one `empty_line` per extra newline. That shape
   * matters after a block, too: the renderer hides the newlines the tag
   * swallows, and if we dropped them here it would hide the NEXT one instead.
   *
   * Soft Markdown keeps its old behaviour — its paragraph already owns the line
   * terminator, so a run only adds blank lines.
   */
  private pushNewlineRun(children: MarkdownNode[], count: number): void {
    if (count <= 0) return;
    if (this.hardBreaks) {
      children.push({ type: 'spacing' });
      for (let i = 1; i < count; i++) children.push({ type: 'empty_line' });
      return;
    }
    for (let i = 0; i < count; i++) children.push({ type: 'empty_line' });
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

export function parseMarkdown(
  tokens: MarkdownToken[],
  options: MarkdownParseOptions = {},
): MarkdownDocument {
  const parser = new MarkdownParser(tokens, options);
  return parser.parse();
}

/**
 * Parse one text run as Markdown inline content.
 *
 * This is what the BBCode-structure hybrid uses: the BBCode engine owns the
 * block tree, and each text leaf is translated with the same inline rules the
 * Markdown importer has (double emphasis, `~~`, `++`, code and links), without
 * turning a line of prose into a heading or list.
 */
export function parseInlineMarkdown(
  source: string,
  options: Omit<MarkdownParseOptions, 'inlineOnly'> = {},
): MarkdownNode[] {
  const parser = new MarkdownParser(scanMarkdown(source), {
    ...options,
    lineBreaks: options.lineBreaks ?? 'hard',
    inlineOnly: true,
    source,
  });
  return parser.parseInlineSequence();
}
