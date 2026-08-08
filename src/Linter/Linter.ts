/**
 * DocumentEngine — Linter
 *
 * Lints the document tree for issues.
 * Similar to ESLint but for BBCode documents.
 *
 * Rules can be added via the Plugin API.
 */

import { RedNode } from '../Syntax/RedNode'
import type { SemanticAnalyzer, Validator } from '../Semantic/SemanticAnalyzer'

export type LintSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface LintRule {
  code: string
  severity: LintSeverity
  description: string
  validate(node: RedNode, context: LintContext): LintIssue | LintIssue[] | null
}

export interface LintContext {
  source: string
  allNodes: Map<string, RedNode>
}

export interface LintIssue {
  code: string
  message: string
  severity: LintSeverity
  nodeId: string
  range: { start: number; end: number } | null
  fix?: {
    description: string
    apply: () => void
  }
}

export interface LintResult {
  issues: LintIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
  hintCount: number
}

export class Linter {
  private rules: Map<string, LintRule> = new Map()

  constructor() {
    this.registerBuiltinRules()
  }

  /**
   * Register a lint rule.
   */
  register(rule: LintRule): void {
    this.rules.set(rule.code, rule)
  }

  /**
   * Unregister a lint rule.
   */
  unregister(code: string): void {
    this.rules.delete(code)
  }

  /**
   * Lint a RedNode tree.
   */
  lint(root: RedNode, source: string): LintResult {
    const issues: LintIssue[] = []
    const result = { issues, errorCount: 0, warningCount: 0, infoCount: 0, hintCount: 0 }

    // Build node index
    const allNodes = new Map<string, RedNode>()
    root.walk(node => { allNodes.set(node.id, node) })

    const context: LintContext = { source, allNodes }

    // Walk tree and apply rules
    root.walk(node => {
      for (const [, rule] of this.rules) {
        try {
          const r = rule.validate(node, context)
          if (r) {
            const items = Array.isArray(r) ? r : [r]
            for (const issue of items) {
              issues.push(issue)
              switch (issue.severity) {
                case 'error': result.errorCount++; break
                case 'warning': result.warningCount++; break
                case 'info': result.infoCount++; break
                case 'hint': result.hintCount++; break
              }
            }
          }
        } catch {
          // Rule error shouldn't break linting
        }
      }
    })

    return result
  }

  private registerBuiltinRules(): void {
    this.register({
      code: 'no-nested-bold',
      severity: 'warning',
      description: 'Nested bold tags are redundant',
      validate: (node) => {
        if (node.kind === 'bold' && node.parent?.kind === 'bold') {
          return {
            code: 'no-nested-bold',
            message: 'Nested [b] tags are redundant',
            severity: 'warning' as LintSeverity,
            nodeId: node.id,
            range: null,
          }
        }
        return null
      },
    })

    this.register({
      code: 'no-empty-tags',
      severity: 'hint',
      description: 'Empty tags have no effect',
      validate: (node) => {
        if (['bold', 'italic', 'underline', 'strikethrough', 'color', 'font_size', 'spoiler'].includes(node.kind)) {
          if (node.children.length === 0 && (node.text === '' || !node.text)) {
            return {
              code: 'no-empty-tags',
              message: `Empty [${node.kind}] tag has no effect`,
              severity: 'hint' as LintSeverity,
              nodeId: node.id,
              range: null,
            }
          }
        }
        return null
      },
    })

    this.register({
      code: 'max-quote-depth',
      severity: 'warning',
      description: 'Quote blocks should not be nested more than 3 levels deep',
      validate: (node) => {
        if (node.kind === 'quote') {
          let depth = 0
          let current = node.parent
          while (current) {
            if (current.kind === 'quote') depth++
            current = current.parent
          }
          if (depth >= 3) {
            return {
              code: 'max-quote-depth',
              message: 'Quote blocks should not be nested more than 3 levels deep',
              severity: 'warning' as LintSeverity,
              nodeId: node.id,
              range: null,
            }
          }
        }
        return null
      },
    })

    this.register({
      code: 'invalid-url-protocol',
      severity: 'error',
      description: 'URLs must start with http:// or https:// (javascript:, file:, etc. are not allowed)',
      validate: (node) => {
        if (node.kind === 'url') {
          const destination = String(node.metadata?.href ?? '') || node.text
          if (destination && !destination.startsWith('http://') && !destination.startsWith('https://') && !destination.startsWith('mailto:')) {
            return {
              code: 'invalid-url-protocol',
              message: 'URLs must start with http:// or https:// (javascript:, file:, etc. are not allowed)',
              severity: 'error' as LintSeverity,
              nodeId: node.id,
              range: null,
            }
          }
        }
        return null
      },
    })
  }
}
