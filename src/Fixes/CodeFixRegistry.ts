/**
 * Quasar Lightbulb Engine — CodeFixRegistry
 *
 * Pure fix providers keyed by diagnostic code. Analyzers emit diagnostics
 * carrying `{ code, data }`; the host resolves a fix by code alone and the
 * provider returns atomic `FixOperation[]` without mutating anything.
 */

import type { CodeActionKind, Diagnostic, FixOperation } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'

export interface CodeFixContext {
  /** Original source the diagnostic was reported against */
  source: string
  /** Deepest node at the diagnostic range, when the host could resolve one */
  node: RedNode | null
}

/**
 * A pure fix: diagnostic plus context in, atomic operations out.
 * MUST NOT mutate the document — application is the host's job.
 */
export type CodeFixProvider = (
  diagnostic: Diagnostic,
  context: CodeFixContext,
) => FixOperation[]

const providers = new Map<string, CodeFixProvider>()

/**
 * Static menu metadata for a fix: how the lightbulb shows it and whether it
 * is safe to batch. Registered alongside the provider; absent means a manual
 * `quickfix` titled with the diagnostic message.
 */
export interface CodeFixMeta {
  /** Menu title, or a function of the diagnostic when it depends on `data` */
  title?: string | ((diagnostic: Diagnostic) => string)
  /** Safe to apply without asking (Fix-All candidate, ranked first) */
  isAutomatic?: boolean
  /** LSP kind; defaults to `quickfix` */
  kind?: CodeActionKind
}

const metas = new Map<string, CodeFixMeta>()

export function registerCodeFix(
  code: string,
  provider: CodeFixProvider,
  meta?: CodeFixMeta,
): void {
  providers.set(code, provider)
  if (meta !== undefined) metas.set(code, meta)
}

export function getCodeFix(code: string): CodeFixProvider | undefined {
  return providers.get(code)
}

export function getCodeFixMeta(code: string): CodeFixMeta | undefined {
  return metas.get(code)
}

export function unregisterCodeFix(code: string): void {
  providers.delete(code)
  metas.delete(code)
}
