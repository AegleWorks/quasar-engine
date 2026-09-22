/**
 * Quasar Lightbulb Engine — built-in validator fixes.
 *
 * The other half of the analyzer split: validators emit diagnostics carrying
 * `{ code, data, equivalenceKey }` and no longer embed fixes. Each entry here
 * rebuilds the exact `FixOperation[]` the validator used to inline, purely
 * from the diagnostic `data` plus the provider context — never by mutating.
 *
 * A provider with missing or misshapen `data` (a legacy diagnostic, a foreign
 * producer) returns `[]`: resolution proceeds by code alone and the host
 * simply offers nothing. Descriptions are the validator originals verbatim so
 * the app keeps translating by code with the engine text as fallback.
 */

import type { Diagnostic, FixOperation } from '../Types/diagnostics'
import {
  registerCodeFix,
  type CodeFixMeta,
} from './CodeFixRegistry'

interface NameRange { start: number; end: number }

function rangeOf(value: unknown): NameRange | null {
  if (typeof value !== 'object' || value === null) return null
  const { start, end } = value as { start: unknown; end: unknown }
  return typeof start === 'number' && typeof end === 'number'
    ? { start, end }
    : null
}

interface BuiltinFix {
  code: string
  meta: CodeFixMeta
  fix: (data: any) => FixOperation[]
}

const BUILTIN_FIXES: BuiltinFix[] = [
  {
    code: 'unknown-tag',
    meta: {
      isAutomatic: false,
      title: (d: Diagnostic) => {
        const data = (d.data ?? {}) as { tag?: string; suggestion?: string }
        return `Replace [${data.tag}] with [${data.suggestion}]`
      },
    },
    fix: (data) => {
      if (typeof data.suggestion !== 'string') return []
      const opener = rangeOf(data.openerName)
      const closer = rangeOf(data.closerName)
      if (!opener || !closer) return []
      return [
        { kind: 'replace_text', range: opener, newText: data.suggestion },
        { kind: 'replace_text', range: closer, newText: data.suggestion },
      ]
    },
  },
  {
    code: 'orphan-closing-tag',
    meta: {
      isAutomatic: false,
      title: (d: Diagnostic) =>
        `Delete [/${(d.data as { tag?: string } | undefined)?.tag}]`,
    },
    fix: (data) => {
      const range = rangeOf(data.range)
      return range ? [{ kind: 'delete_range', range }] : []
    },
  },
  {
    code: 'deprecated-tag',
    meta: {
      isAutomatic: true,
      title: (d: Diagnostic) => {
        const data = (d.data ?? {}) as { spelling?: string; replacement?: string }
        return `Replace [${data.spelling}] with [${data.replacement}]`
      },
    },
    fix: (data) => {
      const open = rangeOf(data.openRange)
      if (!open || typeof data.replacement !== 'string') return []
      const ops: FixOperation[] = [
        { kind: 'replace_text', range: open, newText: data.replacement },
      ]
      const close = rangeOf(data.closeRange)
      if (close) ops.push({ kind: 'replace_text', range: close, newText: data.replacement })
      return ops
    },
  },
  {
    code: 'empty-tag',
    meta: { title: 'Remove the empty tag', isAutomatic: true },
    fix: (data) => {
      const range = rangeOf(data.range)
      return range ? [{ kind: 'delete_range', range }] : []
    },
  },
  {
    code: 'unclosed-tag',
    meta: {
      isAutomatic: true,
      title: (d: Diagnostic) =>
        `Insert [/${(d.data as { name?: string } | undefined)?.name}]`,
    },
    fix: (data) =>
      typeof data.name === 'string' && typeof data.position === 'number'
        ? [{ kind: 'insert_text', position: data.position, text: `[/${data.name}]` }]
        : [],
  },
  {
    code: 'crossed-tags',
    meta: {
      isAutomatic: false,
      title: (d: Diagnostic) =>
        `Move [/${(d.data as { tag?: string } | undefined)?.tag}] to where the tag actually closes`,
    },
    fix: (data) => {
      const closer = rangeOf(data.closerRange)
      if (typeof data.tag !== 'string' || typeof data.at !== 'number' || !closer) return []
      return [
        { kind: 'insert_text', position: data.at, text: `[/${data.tag}]` },
        { kind: 'delete_range', range: closer },
      ]
    },
  },
  {
    code: 'missing-url-protocol',
    meta: { title: 'Prefix the link with https://', isAutomatic: true },
    fix: (data) =>
      typeof data.position === 'number'
        ? [{ kind: 'insert_text', position: data.position, text: 'https://' }]
        : [],
  },
  {
    code: 'empty-link',
    meta: {
      isAutomatic: false,
      title: (d: Diagnostic) =>
        `Use "${(d.data as { href?: string } | undefined)?.href}" as the link text`,
    },
    fix: (data) =>
      typeof data.href === 'string' && typeof data.position === 'number'
        ? [{ kind: 'insert_text', position: data.position, text: data.href }]
        : [],
  },
  {
    code: 'box-missing-equals',
    meta: { title: "Add '=' to [box]", isAutomatic: true },
    fix: (data) => {
      const range = rangeOf(data.range)
      return range ? [{ kind: 'replace_text', range, newText: '[box=]' }] : []
    },
  },
  {
    code: 'redundant-nesting',
    meta: {
      isAutomatic: false,
      title: (d: Diagnostic) =>
        `Unwrap the inner [${(d.data as { name?: string } | undefined)?.name}]`,
    },
    fix: (data) => {
      const open = rangeOf(data.openRange)
      const close = rangeOf(data.closeRange)
      // Both ends or nothing: half an unwrap leaves an orphan closing tag.
      return open && close
        ? [
            { kind: 'delete_range', range: open },
            { kind: 'delete_range', range: close },
          ]
        : []
    },
  },
  {
    code: 'collapsible-gradient',
    meta: { title: 'Collapse into [gradient]', isAutomatic: false },
    fix: (data) => {
      const range = rangeOf(data.range)
      return range && typeof data.replacementText === 'string'
        ? [{ kind: 'replace_text', range, newText: data.replacementText }]
        : []
    },
  },
]

/**
 * Register every built-in validator fix. Overwriting the same codes makes
 * repeated calls idempotent — safe to invoke from the host constructor and
 * from each test file's setup.
 */
export function registerValidatorFixes(): void {
  for (const { code, meta, fix } of BUILTIN_FIXES) {
    registerCodeFix(code, (diagnostic) => fix(diagnostic.data), meta)
  }
}
