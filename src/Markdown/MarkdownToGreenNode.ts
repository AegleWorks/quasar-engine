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
        kind = 'paragraph';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'heading':
        kind = 'heading';
        currentOffset += node.level; 
        text = `=${node.level}`;
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
      case 'strikethrough':
        kind = 'strikethrough';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'underline':
        kind = 'underline';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'color':
        kind = 'color';
        text = `=${node.color}`;
        for (const child of node.children) children.push(convert(child));
        break;
      case 'font_size':
        kind = 'font_size';
        text = `=${node.size}`;
        for (const child of node.children) children.push(convert(child));
        break;
      case 'font':
        kind = 'font';
        text = `=${node.font}`;
        for (const child of node.children) children.push(convert(child));
        break;
      case 'center':
        kind = 'center';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'right':
        kind = 'right';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'left':
        kind = 'left';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'align':
        kind = 'align';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'box':
        kind = 'box';
        text = node.title ? `=${node.title}` : '';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'spoilerbox':
        kind = 'spoilerbox';
        text = node.title ? `=${node.title}` : '';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'separator':
        kind = 'separator';
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
      case 'code_block':
        kind = 'code';
        children.push(greenLeaf('text', node.value));
        currentOffset += node.value.length;
        break;
      case 'list':
        kind = 'list';
        text = node.ordered ? '=1' : '';
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
        text = node.color ? `=${node.color}` : '';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'wnotice':
        kind = 'wnotice';
        text = node.color ? `=${node.color}` : '';
        for (const child of node.children) children.push(convert(child));
        break;
      case 'blockquote':
        kind = 'quote';
        text = node.source ? `=${node.source}` : '';
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
      case 'image':
        kind = 'image';
        // In osu! BBCode, image content is the URL between [img] and [/img]
        children.push(greenLeaf('text', node.url));
        currentOffset += node.url.length;
        break;
      case 'code_inline':
        kind = 'inline_code';
        children.push(greenLeaf('text', node.value));
        currentOffset += node.value.length;
        break;
      case 'bbcode_tag':
        kind = node.tagName as NodeKind;
        text = node.attrValue ? `=${node.attrValue}` : '';
        for (const child of node.children) children.push(convert(child));
        break;
      default: {
        const unhandled: never = node;
        void unhandled;
        kind = 'text';
        break;
      }
    }

    return greenNode(kind as string, text, children);
  }

  return convert(root);
}

const EFFECT_TAGS = new Set(['glow', 'neon', 'outline', 'shimmer', 'ghost', 'rainbow', 'fire', 'ice', 'emboss', 'engrave']);
const ANIM_TAGS = new Set(['typewriter', 'wave', 'sparkle', 'glitch', 'levitate', 'pulse', 'bounce', 'shake', 'fade-in', 'fade-out']);
const CONTAINER_TAGS = new Set(['card', 'glass', 'neon-box', 'neonbox', 'square', 'circle', 'stack', 'flex', 'grid', 'middle']);

export function greenToRedNode(green: GreenNode, parent?: RedNode | null): RedNode {
  let metadata: Record<string, unknown> = {};
  let kind = (green.kind as NodeKind) || 'text';

  const attrValue = green.text.startsWith('=') ? green.text.slice(1) : undefined;

  if (EFFECT_TAGS.has(green.kind)) {
    kind = 'effect';
    metadata.effectType = green.kind;
    if (attrValue) metadata.color = attrValue;
  } else if (ANIM_TAGS.has(green.kind)) {
    kind = 'anim';
    metadata.animType = green.kind;
    if (attrValue) metadata.animParam = attrValue;
  } else if (CONTAINER_TAGS.has(green.kind)) {
    kind = 'container';
    metadata.containerType = green.kind;
    if (attrValue) metadata.color = attrValue;
  } else if (green.kind === 'row') {
    kind = 'table_row';
  } else if (green.kind === 'col') {
    kind = 'table_col';
    if (attrValue) metadata.variant = attrValue;
  } else if (green.kind === 'th') {
    kind = 'table_th';
    if (attrValue) metadata.variant = attrValue;
  } else if (green.kind === 'tables') {
    kind = 'tables';
    if (attrValue) metadata.variant = attrValue;
  } else if (green.kind === 'columns') {
    kind = 'columns';
    if (attrValue) metadata.columns = parseInt(attrValue) || 2;
  } else if (green.kind === 'scroll') {
    kind = 'scroll';
    if (attrValue) metadata.height = attrValue;
  } else if (green.kind === 'separator') {
    kind = 'separator';
    if (attrValue) metadata.variant = attrValue;
  } else if (green.kind === 'heading' && attrValue) {
    metadata.level = parseInt(attrValue) || 1;
  } else if (green.kind === 'color' && attrValue) {
    metadata.color = attrValue;
  } else if (green.kind === 'font_size' && attrValue) {
    metadata.size = attrValue;
  } else if (green.kind === 'font' && attrValue) {
    metadata.font = attrValue;
  } else if (green.kind === 'url' && attrValue) {
    metadata.href = attrValue;
  } else if (green.kind === 'list' && attrValue === '1') {
    metadata.ordered = true;
  } else if ((green.kind === 'box' || green.kind === 'boxw' || green.kind === 'spoilerbox') && attrValue) {
    metadata.title = attrValue;
    metadata.rawTitle = attrValue;
  } else if ((green.kind === 'notice' || green.kind === 'wnotice') && attrValue) {
    metadata.color = attrValue;
  } else if (green.kind === 'quote' && attrValue) {
    metadata.source = attrValue;
  } else if (green.kind === 'abbr' && attrValue) {
    metadata.title = attrValue;
  } else if (green.kind === 'tooltip' && attrValue) {
    metadata.tip = attrValue;
  } else if (green.kind === 'style' || green.kind === 'style_tag') {
    kind = 'style_tag';
    if (attrValue) metadata.style = attrValue;
  } else if (green.kind === 'image') {
    if (green.children.length > 0) {
      const first = green.children[0] as GreenNode;
      if (first.kind === 'text') {
        metadata.src = first.text;
      }
    }
  } else if (attrValue) {
    metadata.value = attrValue;
    metadata.raw = attrValue;
  }

  const red = new RedNode(green, {
    parent: parent ?? null,
    kind,
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
