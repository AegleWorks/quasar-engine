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

import type { CodeActionKind, Diagnostic } from '../Types/diagnostics'
import type { RedNode } from '../Syntax/RedNode'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { getCodeFix, getCodeFixMeta } from './CodeFixRegistry'
import { matchRefactorings } from './RefactoringRegistry'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { applyEditsToSource } from '../Edits/applyEdits'
import { editsConflict } from '../Edits/EditPlan'
import { changedRegion, rebaseEditsThrough, rebaseOffset } from '../Edits/rebaseEdits'
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
  /**
   * The text `diagnostics` were computed against, when it is not `source`.
   *
   * Analysis runs once the user stops typing, so the diagnostics on screen
   * can be a few keystrokes old. Their ranges, and the edits their fixes
   * return, are offsets of THAT text: the host maps the ranges forward and
   * rebases the edits (`rebaseEdits`), and drops a fix the typing touched —
   * applied as computed it would land beside its target. Omitted: they
   * describe `source`.
   */
  diagnosticsSource?: string
  /**
   * Every diagnostic of the document, in the same text as `diagnostics`.
   * Fix All gathers its fixes from here — without it, only from the
   * diagnostics in the span, which is rarely "all".
   */
  documentDiagnostics?: Diagnostic[]
}

export interface LightbulbAction {
  title: string
  kind: CodeActionKind
  /** Automatic fixes rank first and feed the Fix-All candidate */
  isAutomatic: boolean
  /**
   * Resulting source if taken; the document is never mutated. Computed the
   * first time it is read: it is a copy of the whole document, and a menu
   * that only lists titles never needs it.
   */
  readonly preview: string
  /** Edits against the query's `source` */
  edits: SurgicalEdit[]
  /** Null for context refactorings, which need no diagnostic */
  diagnostic: Diagnostic | null
  /** The diagnostic's range in the query's `source` (mapped when it was computed on older text) */
  diagnosticRange?: { start: number; end: number } | null
  /** For `source.fixAll`: how many findings it fixes. */
  count?: number
}

function kindRank(kind: CodeActionKind): number {
  switch (kind) {
    case 'quickfix': return 0
    case 'refactor':
    case 'refactor.extract':
    case 'refactor.rewrite': return 1
    case 'source.fixAll': return 2
    default: return 3
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

/** An action whose `preview` is only built if someone reads it. */
function withLazyPreview(source: string, action: Omit<LightbulbAction, 'preview'>): LightbulbAction {
  let preview: string | undefined
  return Object.defineProperty(action, 'preview', {
    get: () => (preview ??= applyEditsToSource(source, action.edits)),
    enumerable: true,
    configurable: true,
  }) as LightbulbAction
}

interface ResolvedFix {
  title: string
  kind: CodeActionKind
  isAutomatic: boolean
  /** In the query's `source` */
  edits: SurgicalEdit[]
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
    const from = query.diagnosticsSource ?? query.source
    const region = from === query.source ? null : changedRegion(from, query.source)
    const actions: LightbulbAction[] = []

    /** The diagnostic's range now; null when the typing replaced what it pointed at. */
    const rangeNow = (d: Diagnostic): { start: number; end: number } | null | undefined => {
      if (!d.range) return undefined
      const start = rebaseOffset(d.range.start, region)
      const end = rebaseOffset(d.range.end, region)
      return start === null || end === null ? null : { start, end }
    }

    /** The fix for `d`, in the query's text; null when there is none or the typing touched it. */
    const fixFor = (d: Diagnostic, node: RedNode | null): ResolvedFix | null => {
      const provider = getCodeFix(d.code)
      if (!provider) return null
      let ops: ReturnType<typeof provider>
      try {
        ops = provider(d, { source: from, node })
      } catch {
        // A provider that chokes on a diagnostic's data loses its own fix,
        // never the rest of the menu.
        return null
      }
      if (ops.length === 0) return null
      const edits = rebaseEditsThrough(
        fixToSurgicalEdits({ description: '', isAutomatic: false, operations: ops }),
        region,
      )
      if (!edits) return null
      const meta = getCodeFixMeta(d.code)
      const title = typeof meta?.title === 'function' ? meta.title(d) : (meta?.title ?? d.message)
      return { title, kind: meta?.kind ?? 'quickfix', isAutomatic: meta?.isAutomatic ?? false, edits }
    }

    for (const diagnostic of query.diagnostics) {
      const range = rangeNow(diagnostic)
      if (range === null) continue
      if (!overlaps(range, window)) continue
      // The node is looked up in the current tree, so it only describes the
      // diagnostic's text when that text is current.
      const node = region ? null : query.root?.findNodeAtOffset(range?.start ?? query.offset) ?? null
      const fix = fixFor(diagnostic, node)
      if (!fix) continue
      actions.push(withLazyPreview(query.source, { ...fix, diagnostic, diagnosticRange: range ?? null }))
    }

    const at = query.root?.findNodeAtOffset(query.offset) ?? null
    for (const provider of matchRefactorings(at, query.offset, query.source)) {
      const edits = provider.edits(at, query.offset, query.source)
      for (const kind of provider.kinds) {
        actions.push(withLazyPreview(query.source, {
          title: provider.title,
          kind,
          isAutomatic: false,
          edits,
          diagnostic: null,
        }))
      }
    }

    actions.push(...this.fixAllCandidates(query, actions, (d) => (rangeNow(d) === null ? null : fixFor(d, null))))

    actions.sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        Number(b.isAutomatic) - Number(a.isAutomatic) ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    )
    return actions
  }

  /**
   * One `source.fixAll` entry per equivalence key offered in the span with a
   * safe automatic fix. It gathers that key's fixes across the WHOLE document
   * (`documentDiagnostics`) — a "Fix all" that fixed only what was under the
   * caret would be the quick fix again under another name — and merges them,
   * skipping a fix that overlaps one already taken (whole, never half: a fix
   * is atomic) the way `BatchFixer` would refuse it. Offered only when it
   * fixes two findings or more.
   */
  private fixAllCandidates(
    query: LightbulbQuery,
    actions: LightbulbAction[],
    fixFor: (d: Diagnostic) => ResolvedFix | null,
  ): LightbulbAction[] {
    const keys = new Map<string, Diagnostic>()
    for (const action of actions) {
      const key = action.diagnostic?.equivalenceKey
      if (action.isAutomatic && key && !keys.has(key)) keys.set(key, action.diagnostic!)
    }
    if (keys.size === 0) return []
    const all = query.documentDiagnostics ?? query.diagnostics
    const candidates: LightbulbAction[] = []
    for (const [key, first] of keys) {
      const merged: SurgicalEdit[] = []
      let count = 0
      for (const d of all) {
        if (d.equivalenceKey !== key) continue
        const fix = fixFor(d)
        if (!fix || !fix.isAutomatic) continue
        if (fix.edits.some((edit) => merged.some((kept) => editsConflict(kept, edit)))) continue
        merged.push(...fix.edits)
        count++
      }
      // One finding is the quick fix already on the menu, under another name.
      if (count < 2) continue
      merged.sort((a, b) => b.start - a.start || b.end - a.end)
      candidates.push(withLazyPreview(query.source, {
        title: `Fix all '${key}'`,
        kind: 'source.fixAll',
        isAutomatic: true,
        edits: merged,
        diagnostic: first,
        count,
      }))
    }
    return candidates
  }
}

/** Query the lightbulb without holding a host instance. */
export function queryLightbulb(query: LightbulbQuery): LightbulbAction[] {
  return new LightbulbHost().query(query)
}
