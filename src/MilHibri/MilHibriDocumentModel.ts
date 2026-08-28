import { DocumentModel, type DocumentModelOptions } from '../Model/DocumentModel';
import { GreenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import { scanMarkdown } from '../Markdown/MarkdownLexer';
import { parseMarkdown } from '../Markdown/MarkdownParser';
import { markdownAstToGreenTree, greenToRedNode } from '../Markdown/MarkdownToGreenNode';

export interface MilHibriDocumentModelOptions extends DocumentModelOptions {
  source?: string;
}

/**
 * DocumentEngine — MilHibriDocumentModel
 * 
 * First-class DocumentModel for the MilHibri language:
 * Unifies 100% of osu! BBCode and 100% of Markdown + Modern Industry Extensions
 * into a single unified, collision-free AST.
 */
export class MilHibriDocumentModel extends DocumentModel {
  constructor(options: MilHibriDocumentModelOptions = {}) {
    super({ source: '', language: 'milhibri' });
    if (options.source) {
      this.rebuild(options.source);
    }
  }

  static fromSource(source: string): MilHibriDocumentModel {
    return new MilHibriDocumentModel({ source });
  }

  protected parseToGreen(source: string): GreenNode {
    try {
      const tokens = scanMarkdown(source);
      const ast = parseMarkdown(tokens);
      return markdownAstToGreenTree(ast);
    } catch (error) {
      console.warn('[MilHibriDocumentModel] Parse error:', error);
      return greenLeaf('text', source);
    }
  }

  protected buildRedFromGreen(green: GreenNode): RedNode {
    return greenToRedNode(green);
  }

  applyTextUpdate(newSource: string): void {
    if (this.source === newSource) return;
    this.rebuild(newSource);
  }

  applyChange(change: any): void {
    const before = this.source.slice(0, change.start);
    const after = this.source.slice(change.end);
    this.rebuild(before + change.text + after);
  }
}
