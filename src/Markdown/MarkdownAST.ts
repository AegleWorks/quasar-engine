/**
 * DocumentEngine — Markdown AST Nodes
 */

export type MarkdownNode = 
  | MarkdownDocument
  | MarkdownParagraph
  | MarkdownHeading
  | MarkdownText
  | MarkdownCodeBlock
  | MarkdownCodeInline
  | MarkdownStrong
  | MarkdownEmphasis
  | MarkdownLink
  | MarkdownImage
  | MarkdownList
  | MarkdownListItem
  | MarkdownBlockquote
  | MarkdownSpoiler
  | MarkdownNotice
  | MarkdownSpacing
  | MarkdownEmptyLine;

export interface MarkdownDocument {
  type: 'document';
  children: MarkdownNode[];
}

export interface MarkdownParagraph {
  type: 'paragraph';
  children: MarkdownNode[];
}

export interface MarkdownHeading {
  type: 'heading';
  level: number;
  children: MarkdownNode[];
}

export interface MarkdownText {
  type: 'text';
  value: string;
}

export interface MarkdownCodeBlock {
  type: 'code_block';
  lang: string;
  value: string;
}

export interface MarkdownCodeInline {
  type: 'code_inline';
  value: string;
}

export interface MarkdownStrong {
  type: 'strong';
  children: MarkdownNode[];
}

export interface MarkdownEmphasis {
  type: 'emphasis';
  children: MarkdownNode[];
}

export interface MarkdownLink {
  type: 'link';
  url: string;
  children: MarkdownNode[];
}

export interface MarkdownImage {
  type: 'image';
  url: string;
  alt: string;
}

export interface MarkdownList {
  type: 'list';
  ordered: boolean;
  children: MarkdownListItem[];
}

export interface MarkdownListItem {
  type: 'list_item';
  children: MarkdownNode[];
}

export interface MarkdownBlockquote {
  type: 'blockquote';
  children: MarkdownNode[];
}

/** `>!` spoiler block — produced by MarkdownParser, maps to BBCode [spoiler]. */
export interface MarkdownSpoiler {
  type: 'spoiler';
  children: MarkdownNode[];
}

/** `> [!NOTE]` callout — produced by MarkdownParser, maps to BBCode [notice]. */
export interface MarkdownNotice {
  type: 'notice';
  children: MarkdownNode[];
}

export interface MarkdownSpacing {
  type: 'spacing';
}

export interface MarkdownEmptyLine {
  type: 'empty_line';
}
