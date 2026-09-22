/**
 * Quasar Lightbulb Engine — LightbulbHost.
 *
 * Resolves what the lightbulb shows at a caret or range: ranked quick
 * fixes from the `CodeFixRegistry`, context refactorings from the
 * `RefactoringRegistry`, and one `source.fixAll` candidate per equivalence
 * key holding safe automatic fixes.
 *
 * Ranking is LSP kinds first (`quickfix`, then `refactor.*`, then
 * `source.fixAll`), automatic before manual inside a kind, title second.
 * Dual-kind is two entries — the `quickfix` and its `source.fixAll` sibling —
 * so a client that understands only quick fixes keeps working.
 *
 * Everything here is pure: previews render through `applyEditsToSource` and
 * the source is never mutated. The diagnostic (code+data) travels verbatim
 * into the provider — the same object the analyzer produced.
 */

import type { CodeActionKind, Diagnostic, FixOperation } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { getCodeFix, getCodeFixMeta } from './CodeFixRegistry'
import { matchRefactorings, previewRefactoring } from './RefactoringRegistry'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { applyEditsToSource } from '../Edits/applyEdits'
import { editsConflict } from '../Edits/EditPlan'
import { registerValidatorFixes } from './validatorFixes'
import { registerLinterFixes } from '../Linter/Linter'

export interface LightbulbQuery {
  source: string
  root: RedNode | null
  /** Caret offset; the anchor when no range is given */
  offset: number
  /** Queried span; defaults to the caret point */
  range?: { start: number; end: number } | null
  /** Document diagnostics; the host keeps those overlapping the span */
  diagnostics: Diagnostic[]
}

export interface LightbulbAction {
  title: string
  kind: CodeActionKind
  /** Automatic fixes rank first and feed the Fix-All candidate */
  isAutomatic: boolean
  /** Resulting source if taken; the document is never mutated */
  preview: string
  edits: SurgicalEdit[]
  /** Null for context refactorings, which need no diagnostic */
  diagnostic: Diagnostic | null
}

function kindRank(kind: CodeActionKind): number {
  switch (kind) {
    case 'quickfix': return 0
    case 'refactor':
    case 'refactor.extract':
    case 'refactor.rewrite': return 1
    case 'source.fixAll': return 2
  }
}

function overlaps(
  range: { start: number; end: number } | null | undefined,
  window: { start: number; end: number },
): boolean {
  // A finding with no range cannot be located; hiding its fix would be worse.
  if (range === null || range === undefined) return true
  return range.start <= window.end && range.end >= window.start
}

function previewOf(source: string, ops: FixOperation[]): {
  edits: SurgicalEdit[]
  preview: string
} {
  const edits = fixToSurgicalEdits({ description: '', isAutomatic: false, operations: ops })
  return { edits, preview: applyEditsToSource(source, edits) }
}

export class LightbulbHost {
  constructor() {
    // Providers are global tables; registering twice is overwriting with the
    // same values. The host guarantees its own fix sources exist so a bare
    // `new LightbulbHost()` answers with built-ins and no extra setup.
    registerValidatorFixes()
    registerLinterFixes()
  }

  query(query: LightbulbQuery): LightbulbAction[] {
    const window = query.range ?? { start: query.offset, end: query.offset }
    const actions: LightbulbAction[] = []

    for (const diagnostic of query.diagnostics) {
      if (!overlaps(diagnostic.range, window)) continue
      const provider = getCodeFix(diagnostic.code)
      if (!provider) continue
      const node = query.root?.findNodeAtOffset(diagnostic.range?.start ?? query.offset) ?? null
      const ops = provider(diagnostic, { source: query.source, node })
      if (ops.length === 0) continue
      const meta = getCodeFixMeta(diagnostic.code)
      const title =
        typeof meta?.title === 'function'
          ? meta.title(diagnostic)
          : (meta?.title ?? diagnostic.message)
      const { edits, preview } = previewOf(query.source, ops)
      actions.push({
        title,
        kind: meta?.kind ?? 'quickfix',
        isAutomatic: meta?.isAutomatic ?? false,
        preview,
        edits,
        diagnostic,
      })
    }

    const at = query.root?.findNodeAtOffset(query.offset) ?? null
    for (const provider of matchRefactorings(at, query.offset, query.source)) {
      const edits = provider.edits(at, query.offset, query.source)
      for (const kind of provider.kinds) {
        actions.push({
          title: provider.title,
          kind,
          isAutomatic: false,
          preview: previewRefactoring(provider, at, query.offset, query.source),
          edits,
          diagnostic: null,
        })
      }
    }

    actions.push(...this.fixAllCandidates(query.source, actions))

    actions.sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        Number(b.isAutomatic) - Number(a.isAutomatic) ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    )
    return actions
  }

  /**
   * One `source.fixAll` entry per equivalence key whose automatic fixes can
   * batch. The preview merges the key's fixes back-to-front, skipping
   * overlaps the same way `BatchFixer` would refuse them.
   */
  private fixAllCandidates(source: string, actions: LightbulbAction[]): LightbulbAction[] {
    const byKey = new Map<string, LightbulbAction[]>()
    for (const action of actions) {
      const key = action.diagnostic?.equivalenceKey
      if (!action.isAutomatic || !key) continue
      const list = byKey.get(key)
      if (list) list.push(action)
      else byKey.set(key, [action])
    }
    const candidates: LightbulbAction[] = []
    for (const [key, group] of byKey) {
      const merged: SurgicalEdit[] = []
      for (const action of group) {
        for (const edit of [...action.edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
          if (!merged.some((kept) => editsConflict(kept, edit))) merged.push(edit)
        }
      }
      merged.sort((a, b) => b.start - a.start || b.end - a.end)
      candidates.push({
        title: `Fix all '${key}'`,
        kind: 'source.fixAll',
        isAutomatic: true,
        preview: applyEditsToSource(source, merged),
        edits: merged,
        diagnostic: group[0].diagnostic,
      })
    }
    return candidates
  }
}

/** Query the lightbulb without holding a host instance. */
export function queryLightbulb(query: LightbulbQuery): LightbulbAction[] {
  return new LightbulbHost().query(query)
}
