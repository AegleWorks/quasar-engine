/**
 * DocumentEngine — Formatter
 *
 * Formats the document tree into "pretty" BBCode.
 * Normalizes indentation, spacing, and whitespace.
 *
 * Uses the TagRegistry and Visitor pattern.
 * Plugins can register custom formatters for custom tags.
 */

import { RedNode } from '../Syntax/RedNode'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import type { TagRegistry } from '../Model/TagRegistry'

export interface FormatOptions {
  /** Whether to add newlines between block elements */
  blockNewlines?: boolean
  /** Whether to normalize whitespace inside inline elements */
  normalizeInlineWhitespace?: boolean
  /** Maximum line width (0 = no limit) */
  maxLineWidth?: number
  /** Whether to collapse consecutive empty lines */
  collapseEmptyLines?: boolean
  /** Indentation string */
  indent?: string
}

export class Formatter {
  /**
   * Format a RedNode tree (extracts text while preserving exact layout/spacing).
   */
  format(root: RedNode): string {
    return this.formatNode(root)
  }

  /**
   * Format a single node at a given depth.
   */
  private formatNode(node: RedNode): string {
    if (node.kind === 'text') {
      return node.text
    }

    if (node.kind === 'spacing' || node.kind === 'empty_line') {
      return '\n'
    }

    if (node.children) {
      return node.children.map(c => this.formatNode(c)).join('')
    }

    return ''
  }
}
