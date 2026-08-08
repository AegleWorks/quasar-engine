import { DocumentModel, type DocumentModelOptions } from '../Model/DocumentModel';
import { GreenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import { htmlStringToGreenTree, greenToRedNode } from './HTMLToGreenNode';

export interface HTMLDocumentModelOptions extends DocumentModelOptions {
  source?: string;
  language?: string;
}

export class HTMLDocumentModel extends DocumentModel {
  constructor(options: HTMLDocumentModelOptions = {}) {
    super({ source: '', language: options.language ?? 'html' });
    if (options.source) {
      this.rebuild(options.source);
    }
  }

  static fromHTML(source: string): HTMLDocumentModel {
    return new HTMLDocumentModel({ source });
  }

  protected parseToGreen(source: string): GreenNode {
    try {
      return htmlStringToGreenTree(source);
    } catch (error) {
      console.warn('[HTMLDocumentModel] Parse error:', error);
      return greenLeaf('text', source);
    }
  }

  protected buildRedFromGreen(green: GreenNode): RedNode {
    return greenToRedNode(green);
  }
}
