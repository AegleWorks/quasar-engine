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
import { openingTagName, closingTagNameRange } from '../Semantic/SemanticAnalyzer'
import type { Diagnostic, FixOperation } from '../Types/diagnostics'
import { registerCodeFix, type CodeFixMeta } from '../Fixes/CodeFixRegistry'
import { applyEditsToSource } from '../Edits/applyEdits'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

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
  /**
   * Opaque payload for the `CodeFixRegistry` provider of this code — the same
   * ranges the legacy closure below applies, so the two cannot drift.
   */
  data?: unknown
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

export interface LinterOptions {
  /**
   * Attach the legacy `fix` closures to issues (default `true`). They compute
   * the same source rewrite as the registered providers — the parity the
   * lightbulb migration proves — and stay until consumers move to the
   * registry, at which point the flag (and the closures) go away.
   */
  legacyFixes?: boolean
  /** Where a legacy `fix.apply()` delivers the rewritten source. */
  onLegacyFix?: (newSource: string) => void
}

function opsToEdits(ops: FixOperation[]): SurgicalEdit[] {
  const edits: SurgicalEdit[] = []
  for (const op of ops) {
    if (op.kind === 'replace_text') edits.push({ start: op.range.start, end: op.range.end, text: op.newText })
    else if (op.kind === 'insert_text') edits.push({ start: op.position, end: op.position, text: op.text })
    else if (op.kind === 'delete_range') edits.push({ start: op.range.start, end: op.range.end, text: '' })
  }
  return edits
}

interface LinterFixDefinition {
  code: string
  meta: CodeFixMeta
  fix: (diagnostic: Diagnostic) => FixOperation[]
}

function linterData(diagnostic: Diagnostic): any {
  return diagnostic.data ?? {}
}

/**
 * The 4 builtin rules as `FixOperation[]` providers. The two structural rules
 * without a safe rewrite (`max-quote-depth`, `invalid-url-protocol`) register
 * empty providers on purpose: unwrapping a quote or rewriting an unsafe
 * scheme changes what the reader sees, so there is nothing automatic to offer
 * and the host stays silent for them.
 */
const LINTER_FIXES: LinterFixDefinition[] = [
  {
    code: 'no-nested-bold',
    meta: { title: 'Unwrap the inner tag', isAutomatic: false },
    fix: (diagnostic) => {
      const data = linterData(diagnostic)
      const open = data.openRange
      const close = data.closeRange
      if (!open || !close) return []
      return [
        { kind: 'delete_range', range: { start: open.start, end: open.end } },
        { kind: 'delete_range', range: { start: close.start, end: close.end } },
      ]
    },
  },
  {
    code: 'no-empty-tags',
    meta: { title: 'Remove the empty tag', isAutomatic: true },
    fix: (diagnostic) => {
      const range = linterData(diagnostic).range
      return range ? [{ kind: 'delete_range', range: { start: range.start, end: range.end } }] : []
    },
  },
  {
    code: 'max-quote-depth',
    meta: { title: 'Unwrap the quote', isAutomatic: false },
    fix: () => [],
  },
  {
    code: 'invalid-url-protocol',
    meta: { title: 'Fix the URL protocol', isAutomatic: false },
    fix: () => [],
  },
]

/**
 * Register the Linter providers in the `CodeFixRegistry`. Overwriting the
 * same codes makes repeated calls idempotent.
 */
export function registerLinterFixes(): void {
  for (const { code, meta, fix } of LINTER_FIXES) {
    registerCodeFix(code, (diagnostic, _context) => fix(diagnostic), meta)
  }
}

export class Linter {
  private rules: Map<string, LintRule> = new Map()
  private readonly legacyFixes: boolean
  private readonly onLegacyFix?: (newSource: string) => void

  constructor(options?: LinterOptions) {
    this.legacyFixes = options?.legacyFixes ?? true
    this.onLegacyFix = options?.onLegacyFix
    registerLinterFixes()
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
   * The legacy `fix` closure for one rule firing, or `undefined` when the
   * flag is off or the rule has no safe rewrite. It applies the same
   * operations the registered provider returns, so parity is structural.
   */
  private legacyFix(
    description: string,
    source: string,
    ops: FixOperation[],
  ): LintIssue['fix'] {
    if (!this.legacyFixes || ops.length === 0) return undefined
    return {
      description,
      apply: () => {
        this.onLegacyFix?.(applyEditsToSource(source, opsToEdits(ops)))
      },
    }
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
      validate: (node, context) => {
        if (node.kind === 'bold' && node.parent?.kind === 'bold') {
          const source = context.source
          const name = openingTagName(node, source) ?? 'b'
          const openEnd = source.indexOf(']', node.range.start)
          const closing = closingTagNameRange(node, source, name)
          const openRange =
            openEnd > node.range.start && openEnd < node.range.end
              ? { start: node.range.start, end: openEnd + 1 }
              : null
          const closeRange = closing
            ? { start: closing.start - 2, end: node.range.end }
            : null
          const ops: FixOperation[] =
            openRange && closeRange
              ? [
                  { kind: 'delete_range', range: openRange },
                  { kind: 'delete_range', range: closeRange },
                ]
              : []
          return {
            code: 'no-nested-bold',
            message: 'Nested [b] tags are redundant',
            severity: 'warning' as LintSeverity,
            nodeId: node.id,
            range: null,
            data: ops.length === 2 ? { name, openRange, closeRange } : undefined,
            fix: this.legacyFix(`Unwrap the inner [${name}]`, source, ops),
          }
        }
        return null
      },
    })

    this.register({
      code: 'no-empty-tags',
      severity: 'hint',
      description: 'Empty tags have no effect',
      validate: (node, context) => {
        if (['bold', 'italic', 'underline', 'strikethrough', 'color', 'font_size', 'spoiler'].includes(node.kind)) {
          if (node.children.length === 0 && (node.text === '' || !node.text)) {
            const range = { start: node.range.start, end: node.range.end }
            const ops: FixOperation[] = [{ kind: 'delete_range', range }]
            return {
              code: 'no-empty-tags',
              message: `Empty [${node.kind}] tag has no effect`,
              severity: 'hint' as LintSeverity,
              nodeId: node.id,
              range: null,
              data: { range },
              fix: this.legacyFix('Remove the empty tag', context.source, ops),
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
