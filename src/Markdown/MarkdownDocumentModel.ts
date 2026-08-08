import { DocumentModel, type DocumentModelOptions } from '../Model/DocumentModel';
import { GreenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import { scanMarkdown } from './MarkdownLexer';
import { parseMarkdown } from './MarkdownParser';
import { markdownAstToGreenTree, greenToRedNode } from './MarkdownToGreenNode';

export interface MarkdownDocumentModelOptions extends DocumentModelOptions {
  source?: string;
  language?: string;
}

export class MarkdownDocumentModel extends DocumentModel {
  constructor(options: MarkdownDocumentModelOptions = {}) {
    super({ source: '', language: options.language ?? 'markdown' });
    if (options.source) {
      this.rebuild(options.source);
    }
  }

  static fromMarkdown(source: string): MarkdownDocumentModel {
    return new MarkdownDocumentModel({ source });
  }

  protected parseToGreen(source: string): GreenNode {
    try {
      const tokens = scanMarkdown(source);
      const ast = parseMarkdown(tokens);
      return markdownAstToGreenTree(ast);
    } catch (error) {
      console.warn('[MarkdownDocumentModel] Parse error:', error);
      return greenLeaf('text', source);
    }
  }

  protected buildRedFromGreen(green: GreenNode): RedNode {
    return greenToRedNode(green);
  }

  // Override text updates to bypass incremental parsing completely.
  // The Markdown AST currently strips markup tokens (like **, [, ]), 
  // so GreenTree lengths do not match the raw text lengths. 
  // Incremental parsing relies on exact byte offsets, so it fails destructively here.
  applyTextUpdate(newSource: string): void {
    if (this.source === newSource) return;
    this.rebuild(newSource);
  }

  applyChange(change: any): void {
    // Fallback to full rebuild using the text change
    const before = this.source.slice(0, change.start);
    const after = this.source.slice(change.end);
    this.rebuild(before + change.text + after);
  }
}
