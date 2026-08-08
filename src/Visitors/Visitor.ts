/**
 * DocumentEngine — Visitor
 *
 * Base visitor pattern for traversing the Red Tree.
 * All exporters and renderers extend this.
 *
 * Instead of switch statements on tag names, use the visitor pattern.
 * New languages/exporters don't modify existing code.
 *
 * Inspired by SwiftSyntax's Visitor pattern.
 */

import { RedNode } from '../Syntax/RedNode'

export interface VisitorContext {
  source: string
  options: Record<string, unknown>
}

export abstract class Visitor<T = string> {
  protected context: VisitorContext = { source: '', options: {} }

  /**
   * Visit a node and produce an output value.
   */
  abstract visit(node: RedNode, context?: VisitorContext): T

  /**
   * Visit all children and combine results.
   */
  visitChildren(node: RedNode, separator: string = ''): T[] {
    return node.children.map(child => this.visit(child))
  }

  /**
   * Get the text content of a node.
   */
  getText(node: RedNode): string {
    return node.text || node.children.map(c => c.text).join('')
  }

  /**
   * Set the visitor context.
   */
  setContext(context: VisitorContext): void {
    this.context = context
  }
}
