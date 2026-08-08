import { GreenNode, greenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import type { NodeKind } from '../Types/core';
import type { MarkdownNode, MarkdownText } from './MarkdownAST';

export function markdownAstToGreenTree(root: MarkdownNode): GreenNode {
  let currentOffset = 0;

  function convert(node: MarkdownNode): GreenNode {
    const start = currentOffset;
    const children: GreenNode[] = [];
    let kind: NodeKind = 'document';
    let text = '';

    switch (node.type) {
      case 'document':
        kind = 'document';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'paragraph':
        kind = 'text'; // DocumentEngine paragraphs are usually groups or blocks, treating as paragraph block if we want.
        // Actually DocumentEngine uses 'text' or 'group'
        kind = 'document'; // Let's use group or document as container
        for (const child of node.children) children.push(convert(child));
        break;
      case 'heading':
        kind = 'heading';
        // Faking the '#' text length for the heading level offset
        currentOffset += node.level; 
        text = `=${node.level}`; // Use text as metadata like BBCode
        for (const child of node.children) children.push(convert(child));
        break;
      case 'strong':
        kind = 'bold';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'emphasis':
        kind = 'italic';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'text':
        kind = 'text';
        text = node.value;
        currentOffset += text.length;
        break;
      case 'link':
        kind = 'url';
        text = `=${node.url}`;
        for (const child of node.children) children.push(convert(child));
        break;
      case 'image':
        kind = 'image';
        text = node.url;
        currentOffset += text.length;
        break;
      case 'code_block':
        kind = 'code';
        children.push(greenLeaf('text', node.value));
        currentOffset += node.value.length;
        break;
      case 'list':
        kind = 'list';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'list_item':
        kind = 'list_item';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'spoiler':
        kind = 'spoiler';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'notice':
        kind = 'notice';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'blockquote':
        kind = 'quote';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'spacing':
        kind = 'spacing';
        text = '\n';
        currentOffset += 1;
        break;
      case 'empty_line':
        kind = 'empty_line';
        text = '\n\n';
        currentOffset += 2;
        break;
      // `image` and `code_inline` used to land in `default`, which discarded
      // them as empty text nodes — Markdown images never survived conversion.
      case 'image':
        kind = 'image';
        text = `=${node.url}`;
        if (node.alt) {
          children.push(greenLeaf('text', node.alt));
          currentOffset += node.alt.length;
        }
        break;
      case 'code_inline':
        kind = 'inline_code';
        children.push(greenLeaf('text', node.value));
        currentOffset += node.value.length;
        break;
      default: {
        // Exhaustiveness guard: adding a MarkdownNode variant without a case
        // here is now a compile error rather than a silently dropped node.
        const unhandled: never = node;
        void unhandled;
        kind = 'text';
        break;
      }
    }

    const end = currentOffset;
    // Map text container to group for proper DocumentEngine representation if not text
    const actualKind = kind === 'document' && node.type === 'paragraph' ? 'group' : kind;
    return greenNode(actualKind as string, text, children);
  }

  return convert(root);
}

export function greenToRedNode(green: GreenNode, parent?: RedNode | null): RedNode {
  // Simple metadata extraction based on heading text
  let metadata: Record<string, unknown> = {};
  if (green.kind === 'heading' && green.text.startsWith('=')) {
    metadata = { level: parseInt(green.text.slice(1)) || 1 };
  }

  const red = new RedNode(green, {
    parent: parent ?? null,
    kind: (green.kind as NodeKind) || 'text',
    metadata
  });

  const greenChildren = green.children as GreenNode[];
  if (greenChildren.length > 0) {
    const kids: RedNode[] = new Array(greenChildren.length);
    for (let i = 0; i < greenChildren.length; i++) {
      kids[i] = greenToRedNode(greenChildren[i], red);
    }
    red.initChildren(kids);
  }

  return red;
}

export function markdownAstToRedTree(root: MarkdownNode): RedNode {
  const green = markdownAstToGreenTree(root);
  return greenToRedNode(green);
}
