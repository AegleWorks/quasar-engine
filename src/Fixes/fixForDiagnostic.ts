/**
 * The engine's fix for one diagnostic, in the shape embedded fixes used to have.
 *
 * Diagnostics no longer carry `fixes`: the fix is resolved by code through the
 * `CodeFixRegistry`, from the diagnostic's opaque `data`. Every UI that shows a
 * single "apply fix" button needs exactly this lookup, so it lives here rather
 * than in each caller — a caller that kept reading `diagnostic.fixes` silently
 * lost its button when the engine stopped filling it.
 */

import type { Diagnostic, DiagnosticFix } from '../Types/diagnostics'
import { getCodeFix, getCodeFixMeta, isAutomaticFix } from './CodeFixRegistry'
import { ensureValidatorFixes } from './validatorFixes'
import { ensureLinterFixes } from '../Linter/Linter'

/**
 * Resolve the fix for `diagnostic`, or `null` when there is none.
 *
 * Defines the built-in providers first (idempotent, and never over a runtime
 * override), so a caller that never loaded the editor's fix module still gets
 * them. A provider that throws on
 * data it does not understand counts as "no fix". Diagnostics from outside the
 * engine that still embed a fix keep working through the fallback.
 */
export function fixForDiagnostic(diagnostic: Diagnostic): DiagnosticFix | null {
  ensureValidatorFixes()
  ensureLinterFixes()

  const provider = getCodeFix(diagnostic.code)
  if (provider) {
    try {
      const operations = provider(diagnostic, { source: '', node: null })
      if (operations.length > 0) {
        const meta = getCodeFixMeta(diagnostic.code)
        const description = typeof meta?.title === 'function'
          ? meta.title(diagnostic)
          : (meta?.title ?? diagnostic.message)
        return { description, isAutomatic: isAutomaticFix(diagnostic), operations }
      }
    } catch {
      // Fall through to the embedded fix, as if there were no provider.
    }
  }
  return diagnostic.fixes?.[0] ?? null
}
