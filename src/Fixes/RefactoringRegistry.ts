/**
 * Quasar Lightbulb Engine — RefactoringRegistry
 *
 * Context-triggered refactorings resolved from RedNode + offset, no diagnostic
 * needed. Providers supply a preview via `applyEditsToSource` so the lightbulb
 * can show the outcome without mutating the document.
 */

import type { CodeActionKind } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { applyEditsToSource } from '../Edits/applyEdits'

export interface RefactoringProvider {
  /** Stable id (e.g. 'combine-bolds') */
  id: string
  /** Human-readable menu title */
  title: string
  /** LSP kinds this refactoring offers as */
  kinds: CodeActionKind[]
  /** Whether this refactoring applies at the offset */
  match(node: RedNode | null, offset: number, source: string): boolean
  /** Source edits for the refactoring; MUST NOT mutate the document */
  edits(node: RedNode | null, offset: number, source: string): SurgicalEdit[]
}

const providers = new Map<string, RefactoringProvider>()

export function registerRefactoring(provider: RefactoringProvider): void {
  providers.set(provider.id, provider)
}

export function unregisterRefactoring(id: string): void {
  providers.delete(id)
}

export function getRefactoring(id: string): RefactoringProvider | undefined {
  return providers.get(id)
}

/** Every registered provider whose `match` accepts this context. */
export function matchRefactorings(
  node: RedNode | null,
  offset: number,
  source: string,
): RefactoringProvider[] {
  const found: RefactoringProvider[] = []
  for (const provider of providers.values()) {
    if (provider.match(node, offset, source)) found.push(provider)
  }
  return found
}

/**
 * Preview the refactoring result as source text, without mutating anything.
 * Accepts either the provider or its registered id.
 */
export function previewRefactoring(
  providerOrId: RefactoringProvider | string,
  node: RedNode | null,
  offset: number,
  source: string,
): string {
  const provider =
    typeof providerOrId === 'string' ? providers.get(providerOrId) : providerOrId
  if (!provider) throw new Error(`Unknown refactoring: ${providerOrId}`)
  return applyEditsToSource(source, provider.edits(node, offset, source))
}
