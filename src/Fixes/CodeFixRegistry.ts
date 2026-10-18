/**
 * Quasar Lightbulb Engine — CodeFixRegistry
 *
 * Pure fix providers keyed by diagnostic code. Analyzers emit diagnostics
 * carrying `{ code, data }`; the host resolves a fix by code alone and the
 * provider returns atomic `FixOperation[]` without mutating anything.
 *
 * Two layers. The engine's own providers are BUILT-INS: defined once
 * (`defineBuiltinCodeFix`) and never overwritten. Everything registered at
 * runtime (`registerCodeFix`, a plugin) is an OVERRIDE stacked on top, and
 * removing it uncovers whatever was under it. Both used to live in one flat
 * map, so every `new LightbulbHost()` re-registered the built-ins over a
 * plugin's override, unregistering a plugin deleted the built-in it had
 * replaced, and Fix-All found no provider at all in a process where nothing
 * had registered the built-ins yet.
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
  /**
   * How Fix-All combines this code's fixes when several are single
   * insertions at the SAME offset. Absent: they conflict, and one lands per
   * pass. `'innermost-first'`: they are one insertion, ordered by diagnostic
   * start, latest first — which is how closers of tags nested inside each
   * other must be written (`[/i][/b]`).
   */
  mergeInsertions?: 'innermost-first'
}

interface Entry {
  provider: CodeFixProvider
  meta: CodeFixMeta | undefined
}

const builtins = new Map<string, Entry>()
/** Runtime registrations per code, latest last. */
const overrides = new Map<string, Entry[]>()
/** Built-ins hidden by `unregisterCodeFix` until registered again or reset. */
const hidden = new Set<string>()

/**
 * Define one of the engine's own providers. Called by the modules that own
 * them (`registerValidatorFixes`, `registerLinterFixes`); idempotent.
 */
export function defineBuiltinCodeFix(code: string, provider: CodeFixProvider, meta?: CodeFixMeta): void {
  builtins.set(code, { provider, meta })
}

/**
 * Register a provider for `code`, over whatever is there. Returns a function
 * that removes exactly this registration — a plugin uses it to take back its
 * own fix without disturbing another plugin's, or the built-in under both.
 */
export function registerCodeFix(
  code: string,
  provider: CodeFixProvider,
  meta?: CodeFixMeta,
): () => void {
  const entry: Entry = { provider, meta }
  const stack = overrides.get(code)
  if (stack) stack.push(entry)
  else overrides.set(code, [entry])
  hidden.delete(code)
  return () => {
    const current = overrides.get(code)
    if (!current) return
    const at = current.lastIndexOf(entry)
    if (at === -1) return
    current.splice(at, 1)
    if (current.length === 0) overrides.delete(code)
  }
}

function resolve(code: string): Entry | undefined {
  const stack = overrides.get(code)
  if (stack && stack.length > 0) return stack[stack.length - 1]
  return hidden.has(code) ? undefined : builtins.get(code)
}

export function getCodeFix(code: string): CodeFixProvider | undefined {
  return resolve(code)?.provider
}

export function getCodeFixMeta(code: string): CodeFixMeta | undefined {
  const entry = resolve(code)
  if (entry === undefined) return undefined
  // An override registered without metadata keeps the built-in's, as a
  // re-registration without metadata always has.
  return entry.meta ?? (hidden.has(code) ? undefined : builtins.get(code)?.meta)
}

/**
 * Remove every provider for `code`: the runtime registrations and, until
 * something registers it again or the built-ins are reset, the built-in.
 */
export function unregisterCodeFix(code: string): void {
  overrides.delete(code)
  if (builtins.has(code)) hidden.add(code)
}

/**
 * Put `codes` back to their built-ins: drop their runtime registrations and
 * un-hide them. What `registerValidatorFixes()` means since built-ins stopped
 * being re-registered over everything.
 */
export function resetCodeFixes(codes: Iterable<string>): void {
  for (const code of codes) {
    overrides.delete(code)
    hidden.delete(code)
  }
}

/**
 * Whether `diagnostic`'s fix is automatic: its code's provider says so AND the
 * diagnostic takes part in Fix-All. A validator leaves `equivalenceKey` off a
 * finding whose usual repair would change what the reader sees there — an
 * empty `[box]` still paints its header — and that finding's fix is then
 * offered, never applied without asking.
 */
export function isAutomaticFix(diagnostic: Diagnostic): boolean {
  return getCodeFixMeta(diagnostic.code)?.isAutomatic === true && diagnostic.equivalenceKey !== undefined
}
