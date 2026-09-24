import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createDiagnostic } from '../Types/diagnostics'
import type { Diagnostic, FixOperation } from '../Types/diagnostics'
import {
  registerCodeFix,
  getCodeFix,
  getCodeFixMeta,
  unregisterCodeFix,
} from '../Fixes/CodeFixRegistry'
import { registerValidatorFixes } from '../Fixes/validatorFixes'
import { queryLightbulb } from '../Fixes/LightbulbHost'
import {
  fixAll,
  fixAllDocuments,
  planFixAll,
  MAX_FIX_ALL_PASSES,
  UnimplementedError,
  type FixAllTarget,
} from '../Fixes/BatchFixer'
import { registerLinterFixes, Linter } from '../Linter/Linter'
import {
  registerRefactoring,
  unregisterRefactoring,
  matchRefactorings,
} from '../Fixes/RefactoringRegistry'
import { combineBoldsProvider } from '../Fixes/refactorings/combineBolds'
import { applyEditsToSource } from '../Edits/applyEdits'
import { computeTextDelta } from '../Reconciler/SurgicalReconciler'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { PluginAPI } from '../Plugins/PluginAPI'
import type { RedNode } from '../Syntax/RedNode'
import type { NodeId } from '../Types/core'

/**
 * U2 (lightbulb engine core): host, batch fixer, validator strip, Linter
 * port, plugin contributions.
 *
 * Written RED-first: LightbulbHost, BatchFixer and validatorFixes do not
 * exist yet. Spec acceptance mapping:
 * - lightbulb-host/spec.md: ranked menu with kinds + preview, fixAll candidate
 * - fix-all/spec.md: document Fix-All in one transact, multipass <= 10 + cycle
 * - code-fixes/spec.md: fix resolves by code, miss is empty, overlap rejects
 * - diagnostics/spec.md: code+data round-trip, missing data tolerated
 * - linter-rules/spec.md: migrated output equals legacy, edge-touch allowed
 */

const KEY = 'u2-batch'

function diagFor(
  code: string,
  range: { start: number; end: number } | null = null,
): Diagnostic {
  return createDiagnostic(code, `u2 ${code}`, 'warning', {
    range,
    equivalenceKey: KEY,
  })
}

function opsOf(source: string, code: string, d: Diagnostic): FixOperation[] {
  const provider = getCodeFix(code)
  expect(provider, `no provider for ${code}`).toBeDefined()
  return provider!(d, { source, node: null })
}

beforeAll(() => {
  registerValidatorFixes()
  registerLinterFixes()
  registerRefactoring(combineBoldsProvider)
})

afterEach(() => {
  for (const code of [
    'u2-rank-auto',
    'u2-rank-manual',
    'u2-kind-refactor',
    'u2-ov-a',
    'u2-ov-b',
    'u2-edge-a',
    'u2-edge-b',
    'u2-intra',
    'u2-n1',
    'u2-n2',
    'u2-cycle-a',
    'u2-cycle-b',
    'u2-grow',
    'u2-plugin-fix',
  ]) {
    unregisterCodeFix(code)
  }
  unregisterRefactoring('u2-test-ref')
})

function parseRoot(source: string): { root: RedNode; source: string } {
  const model = new BBCodeDocumentModel({ source })
  model.analyze()
  expect(model.redRoot, `no redRoot for ${JSON.stringify(source)}`).not.toBeNull()
  return { root: model.redRoot!, source }
}

// ─── 2.1 LightbulbHost ───────────────────────────────────────────

describe('U2 LightbulbHost: ranked LSP-kinded resolution', () => {
  function rankedFixture(): { source: string; root: RedNode; diags: Diagnostic[] } {
    const source = '[b]a[/b][b]b[/b]'
    const { root } = parseRoot(source)
    registerCodeFix(
      'u2-rank-auto',
      () => [{ kind: 'insert_text', position: 0, text: '!' }],
      { title: 'Auto fix', isAutomatic: true },
    )
    registerCodeFix(
      'u2-rank-manual',
      () => [{ kind: 'insert_text', position: 1, text: '?' }],
      { title: 'Manual fix', isAutomatic: false },
    )
    const offset = source.indexOf('a')
    const diags = [
      createDiagnostic('u2-rank-auto', 'auto', 'warning', {
        range: { start: 0, end: 3 },
        equivalenceKey: 'u2-rank-key',
      }),
      createDiagnostic('u2-rank-manual', 'manual', 'warning', {
        range: { start: 0, end: 3 },
      }),
    ]
    return { source, root, diags }
  }

  it('returns quickfix before refactor before source.fixAll', () => {
    const { source, root, diags } = rankedFixture()
    const actions = queryLightbulb({
      source,
      root,
      offset: source.indexOf('a'),
      diagnostics: diags,
    })
    expect(actions.map((a) => a.kind)).toEqual([
      'quickfix',
      'quickfix',
      'refactor.rewrite',
      'source.fixAll',
    ])
  })

  it('orders automatic fixes before manual ones and flags them', () => {
    const { source, root, diags } = rankedFixture()
    const actions = queryLightbulb({
      source,
      root,
      offset: source.indexOf('a'),
      diagnostics: diags,
    })
    expect(actions.slice(0, 2).map((a) => a.isAutomatic)).toEqual([true, false])
  })

  it('previews each fix without mutating the source', () => {
    const { source, root, diags } = rankedFixture()
    const before = source
    const actions = queryLightbulb({
      source,
      root,
      offset: source.indexOf('a'),
      diagnostics: diags,
    })
    expect(actions[0].preview).toBe('![b]a[/b][b]b[/b]')
    expect(actions[1].preview).toBe('[?b]a[/b][b]b[/b]')
    expect(source).toBe(before)
  })

  it('exposes a Fix-All candidate with kind source.fixAll for safe automatic fixes', () => {
    const { source, root, diags } = rankedFixture()
    const actions = queryLightbulb({
      source,
      root,
      offset: source.indexOf('a'),
      diagnostics: diags,
    })
    const fixAllAction = actions.filter((a) => a.kind === 'source.fixAll')
    expect(fixAllAction).toHaveLength(1)
    expect(fixAllAction[0].isAutomatic).toBe(true)
    // Manual fix has no key, auto fix without key offers no Fix-All either.
    const manualOnly = queryLightbulb({
      source,
      root,
      offset: source.indexOf('a'),
      diagnostics: [diags[1]],
    })
    expect(manualOnly.map((a) => a.kind)).not.toContain('source.fixAll')
  })

  it('maps provider kinds (refactor.extract/rewrite) through meta', () => {
    registerCodeFix(
      'u2-kind-refactor',
      () => [{ kind: 'insert_text', position: 0, text: '!' }],
      { title: 'Rewrite', isAutomatic: false, kind: 'refactor.rewrite' },
    )
    const source = 'hello'
    const actions = queryLightbulb({
      source,
      root: null,
      offset: 1,
      diagnostics: [diagFor('u2-kind-refactor', { start: 0, end: 5 })],
    })
    expect(actions.map((a) => a.kind)).toEqual(['refactor.rewrite'])
    expect(actions[0].preview).toBe('!hello')
  })

  it('returns empty with no error when no provider is registered', () => {
    const actions = queryLightbulb({
      source: 'hello',
      root: null,
      offset: 1,
      diagnostics: [diagFor('u2-never-registered', { start: 0, end: 5 })],
    })
    expect(actions).toEqual([])
  })

  it('forwards code+data verbatim to the provider (round-trip)', () => {
    const payload = { expected: '[/b]', at: 12 }
    const received: Diagnostic[] = []
    registerCodeFix(
      'u2-rank-auto',
      (d) => {
        received.push(d)
        return []
      },
      { title: 'Auto fix', isAutomatic: true },
    )
    const d = createDiagnostic('u2-rank-auto', 'auto', 'warning', {
      range: { start: 0, end: 3 },
      data: payload,
      equivalenceKey: 'u2-rt',
    })
    queryLightbulb({ source: '[b]x', root: null, offset: 1, diagnostics: [d] })
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(d)
    expect(received[0].data).toEqual(payload)
  })

  it('tolerates legacy diagnostics without data: resolution proceeds by code alone', () => {
    registerCodeFix(
      'u2-rank-manual',
      (d) => {
        expect(d.data).toBeUndefined()
        return [{ kind: 'insert_text', position: 0, text: '!' }]
      },
      { title: 'Manual fix', isAutomatic: false },
    )
    const actions = queryLightbulb({
      source: 'x',
      root: null,
      offset: 0,
      diagnostics: [createDiagnostic('u2-rank-manual', 'legacy', 'warning')],
    })
    expect(actions).toHaveLength(1)
    expect(actions[0].preview).toBe('!x')
  })

  it('ignores diagnostics outside the queried range', () => {
    registerCodeFix(
      'u2-rank-manual',
      () => [{ kind: 'insert_text', position: 0, text: '!' }],
      { title: 'Manual fix', isAutomatic: false },
    )
    const actions = queryLightbulb({
      source: 'hello world',
      root: null,
      offset: 1,
      range: { start: 0, end: 2 },
      diagnostics: [diagFor('u2-rank-manual', { start: 6, end: 11 })],
    })
    expect(actions).toEqual([])
  })
})

// ─── 2.2 BatchFixer ──────────────────────────────────────────────

function recordingTarget(
  initial: string,
  diags: (source: string) => Diagnostic[],
): FixAllTarget & { transacts: SurgicalEdit[][]; committed: () => string } {
  let current = initial
  const transacts: SurgicalEdit[][] = []
  return {
    transacts,
    committed: () => current,
    getSource: () => current,
    getDiagnostics: () => diags(current),
    transact: (edits) => {
      transacts.push([...edits])
      current = applyEditsToSource(current, edits)
    },
  }
}

describe('U2 BatchFixer: document Fix-All', () => {
  it('applies N same-key diagnostics in one transact, DESC by offset', () => {
    registerCodeFix('u2-n1', () => [{ kind: 'insert_text', position: 1, text: '1' }], {
      title: 'n1',
      isAutomatic: true,
    })
    registerCodeFix('u2-n2', () => [{ kind: 'insert_text', position: 4, text: '2' }], {
      title: 'n2',
      isAutomatic: true,
    })
    const target = recordingTarget('abcd', (source) =>
      source === 'abcd' ? [diagFor('u2-n1'), diagFor('u2-n2')] : [],
    )
    const result = fixAll(target, KEY)
    expect(result.applied).toBe(2)
    expect(result.deferred).toBe(0)
    expect(result.passes).toBe(1)
    expect(result.cycle).toBeUndefined()
    expect(target.transacts).toHaveLength(1)
    expect(target.transacts[0].map((e) => e.start)).toEqual([4, 1])
    expect(target.committed()).toBe('a1bcd2')
  })

  it('filters by equivalenceKey: other keys are left alone', () => {
    registerCodeFix('u2-n1', () => [{ kind: 'insert_text', position: 0, text: '!' }], {
      title: 'n1',
      isAutomatic: true,
    })
    const other = createDiagnostic('u2-n1', 'other key', 'warning', {
      equivalenceKey: 'different-key',
    })
    const target = recordingTarget('ab', (source) =>
      source === 'ab' ? [diagFor('u2-n1'), other] : [],
    )
    const result = fixAll(target, KEY)
    expect(result.applied).toBe(1)
    expect(target.committed()).toBe('!ab')
  })

  it('rejects the whole fix on overlap while others proceed', () => {
    registerCodeFix(
      'u2-ov-a',
      () => [{ kind: 'replace_text', range: { start: 0, end: 5 }, newText: 'a' }],
      { title: 'a', isAutomatic: true },
    )
    registerCodeFix(
      'u2-ov-b',
      () => [{ kind: 'replace_text', range: { start: 3, end: 8 }, newText: 'b' }],
      { title: 'b', isAutomatic: true },
    )
    const plan = planFixAll('0123456789', [diagFor('u2-ov-a'), diagFor('u2-ov-b')], KEY)
    expect(plan.applied).toBe(1)
    expect(plan.deferred).toBe(1)
    // DESC wins: the later offset survives.
    expect(plan.accepted).toEqual([{ start: 3, end: 8, text: 'b' }])
  })

  it('allows edge-touching fixes and rejects true overlap', () => {
    registerCodeFix(
      'u2-edge-a',
      () => [{ kind: 'replace_text', range: { start: 0, end: 5 }, newText: 'a' }],
      { title: 'a', isAutomatic: true },
    )
    registerCodeFix(
      'u2-edge-b',
      () => [{ kind: 'replace_text', range: { start: 5, end: 10 }, newText: 'b' }],
      { title: 'b', isAutomatic: true },
    )
    const plan = planFixAll('0123456789', [diagFor('u2-edge-a'), diagFor('u2-edge-b')], KEY)
    expect(plan.applied).toBe(2)
    expect(plan.deferred).toBe(0)
    expect(plan.accepted).toHaveLength(2)
  })

  it('discards a fix whose own ops overlap (per-diagnostic atomicity)', () => {
    registerCodeFix(
      'u2-intra',
      () => [
        { kind: 'replace_text', range: { start: 0, end: 5 }, newText: 'a' },
        { kind: 'replace_text', range: { start: 3, end: 8 }, newText: 'b' },
      ],
      { title: 'intra', isAutomatic: true },
    )
    const target = recordingTarget('0123456789', () => [diagFor('u2-intra')])
    const result = fixAll(target, KEY)
    expect(result.applied).toBe(0)
    expect(result.deferred).toBe(1)
    expect(target.transacts).toEqual([])
    expect(target.committed()).toBe('0123456789')
  })

  it('stops with a cycle warning on cyclically re-triggering fixes', () => {
    registerCodeFix('u2-cycle-a', () => [{ kind: 'insert_text', position: 1, text: '!' }], {
      title: 'a',
      isAutomatic: true,
    })
    registerCodeFix('u2-cycle-b', () => [{ kind: 'delete_range', range: { start: 1, end: 2 } }], {
      title: 'b',
      isAutomatic: true,
    })
    const target = recordingTarget('ab', (source) => [
      source === 'ab'
        ? createDiagnostic('u2-cycle-a', 'a', 'warning', { equivalenceKey: KEY })
        : createDiagnostic('u2-cycle-b', 'b', 'warning', { equivalenceKey: KEY }),
    ])
    const result = fixAll(target, KEY)
    expect(result.passes).toBeLessThanOrEqual(MAX_FIX_ALL_PASSES)
    expect(result.cycle).toMatch(/cycle/i)
    expect(result.applied).toBe(2)
  })

  it('caps multipass at maxPasses with a cycle warning', () => {
    registerCodeFix('u2-grow', () => [{ kind: 'insert_text', position: 0, text: 'x' }], {
      title: 'grow',
      isAutomatic: true,
    })
    const target = recordingTarget('ab', () => [diagFor('u2-grow')])
    const result = fixAll(target, KEY, { maxPasses: 3 })
    expect(result.passes).toBe(3)
    expect(result.applied).toBe(3)
    expect(result.cycle).toMatch(/3 passes/)
    expect(target.committed()).toBe('xxxab')
  })

  it('bounds the default multipass at 10', () => {
    expect(MAX_FIX_ALL_PASSES).toBe(10)
  })

  it('throws Unimplemented for project/solution scope', () => {
    const target = recordingTarget('ab', () => [])
    expect(() => fixAll(target, KEY, { scope: 'project' })).toThrow(UnimplementedError)
    expect(() => fixAll(target, KEY, { scope: 'solution' })).toThrow(UnimplementedError)
    expect(target.transacts).toEqual([])
  })

  it('uses transact as the sole edit path (one call per pass)', () => {
    registerCodeFix('u2-n1', () => [{ kind: 'insert_text', position: 1, text: '1' }], {
      title: 'n1',
      isAutomatic: true,
    })
    const target = recordingTarget('abcd', (source) =>
      source === 'abcd' ? [diagFor('u2-n1')] : [],
    )
    const before = target.committed()
    fixAll(target, KEY)
    expect(before).toBe('abcd')
    expect(target.transacts).toHaveLength(1)
    expect(target.committed()).toBe('a1bcd')
  })

  it('fixes all documents and aggregates the result', () => {
    registerCodeFix('u2-n1', () => [{ kind: 'insert_text', position: 0, text: '!' }], {
      title: 'n1',
      isAutomatic: true,
    })
    const first = recordingTarget('ab', (source) =>
      source === 'ab' ? [diagFor('u2-n1')] : [],
    )
    // Second doc converges after its single diagnostic is fixed: model the
    // re-analyze honestly by clearing diagnostics once the source changed.
    const converging = recordingTarget('cd', (source) =>
      source === 'cd' ? [diagFor('u2-n1')] : [],
    )
    const result = fixAllDocuments([first, converging], KEY)
    expect(result.applied).toBe(2)
    expect(first.committed()).toBe('!ab')
    expect(converging.committed()).toBe('!cd')
  })

  it('converges on real analyzer diagnostics through a model-backed target', () => {
    const model = new BBCodeDocumentModel({ source: '[b]x' })
    const target: FixAllTarget = {
      getSource: () => model.source,
      getDiagnostics: () => model.analyze().diagnostics.items,
      findNode: (d) => (d.nodeId ? (model.findNode(d.nodeId) ?? null) : null),
      transact: (edits) => {
        const before = model.source
        const after = applyEditsToSource(before, edits)
        const [delta] = computeTextDelta(before, after)
        if (delta) model.applyChange({ start: delta.start, end: delta.end, text: delta.text }, 'fix-all')
      },
    }
    const result = fixAll(target, 'unclosed-tag')
    expect(result.cycle).toBeUndefined()
    expect(model.source).toBe('[b]x[/b]')
    expect(model.analyze().diagnostics.items.map((d) => d.code)).not.toContain('unclosed-tag')
  })
})

// ─── 2.3 Validators emit code+data only ───────────────────────────

function analyzed(source: string): { model: BBCodeDocumentModel; diags: Diagnostic[] } {
  const model = new BBCodeDocumentModel({ source })
  const diags = model.analyze().diagnostics.items
  return { model, diags }
}

function providerOutput(source: string, code: string): string {
  const { diags } = analyzed(source)
  const d = diags.find((item) => item.code === code)
  expect(d, `no '${code}' for ${JSON.stringify(source)}`).toBeDefined()
  expect(d!.fixes, `'${code}' still embeds fixes`).toBeUndefined()
  const ops = opsOf(source, code, d!)
  return applyEditsToSource(
    source,
    ops.flatMap((op) => {
      if (op.kind === 'replace_text') return [{ start: op.range.start, end: op.range.end, text: op.newText }]
      if (op.kind === 'insert_text') return [{ start: op.position, end: op.position, text: op.text }]
      return [{ start: op.range.start, end: op.range.end, text: '' }]
    }),
  )
}

describe('U2 validators: code+data only, fixes live in the registry', () => {
  it('unclosed-tag carries data + equivalenceKey, provider closes the tag', () => {
    const { diags } = analyzed('[b]x')
    const d = diags.find((item) => item.code === 'unclosed-tag')!
    expect(d.fixes).toBeUndefined()
    expect(d.equivalenceKey).toBe('unclosed-tag')
    expect(d.data).toMatchObject({ name: 'b' })
    expect(providerOutput('[b]x', 'unclosed-tag')).toBe('[b]x[/b]')
  })

  it('deprecated-tag renames both ends through the provider', () => {
    const { diags } = analyzed('[strike]x[/strike]')
    const d = diags.find((item) => item.code === 'deprecated-tag')!
    expect(d.fixes).toBeUndefined()
    expect(d.equivalenceKey).toBe('deprecated-tag')
    expect(providerOutput('[strike]x[/strike]', 'deprecated-tag')).toBe('[s]x[/s]')
  })

  it('empty-tag deletes through the provider', () => {
    expect(providerOutput('antes [i][/i] fin', 'empty-tag')).toBe('antes  fin')
  })

  it('missing-url-protocol prefixes https:// through the provider', () => {
    expect(providerOutput('[url=www.osu.ppy.sh]click[/url]', 'missing-url-protocol')).toBe(
      '[url=https://www.osu.ppy.sh]click[/url]',
    )
  })

  it('manual findings carry data but no equivalenceKey (opt out of Fix-All)', () => {
    const { diags } = analyzed('[bold]x[/bold]')
    const d = diags.find((item) => item.code === 'unknown-tag')!
    expect(d.fixes).toBeUndefined()
    expect(d.equivalenceKey).toBeUndefined()
    expect(d.data).toMatchObject({ tag: 'bold', suggestion: 'b' })
    expect(providerOutput('[bold]x[/bold]', 'unknown-tag')).toBe('[b]x[/b]')
  })

  it('unknown-tag without a suggestion offers no ops (missing data tolerated)', () => {
    const { diags } = analyzed('[Chocolate]x[/Chocolate]')
    const d = diags.find((item) => item.code === 'unknown-tag')!
    expect(opsOf('[Chocolate]x[/Chocolate]', 'unknown-tag', d)).toEqual([])
  })

  // Every built-in validator fix wraps as `(diagnostic) => fix(diagnostic.data)`
  // and its body dereferences `data.*` directly — the wrapper is the one place
  // that must guard, not each fix. A dataless diagnostic (no `data` at all, or
  // one whose `data` is `null`) must resolve to `[]` for every registered
  // code, never throw.
  const VALIDATOR_FIX_CODES = [
    'unknown-tag',
    'orphan-closing-tag',
    'deprecated-tag',
    'empty-tag',
    'unclosed-tag',
    'crossed-tags',
    'missing-url-protocol',
    'empty-link',
    'box-missing-equals',
    'redundant-nesting',
    'collapsible-gradient',
  ]

  it.each(VALIDATOR_FIX_CODES)(
    "'%s' returns [] for a diagnostic with no data",
    (code) => {
      const provider = getCodeFix(code)
      expect(provider, `no provider registered for '${code}'`).toBeDefined()
      const diagnostic = createDiagnostic(code, 'no data', 'warning')
      expect(diagnostic.data).toBeUndefined()
      expect(provider!(diagnostic, { source: '', node: null })).toEqual([])
    },
  )

  it.each(VALIDATOR_FIX_CODES)(
    "'%s' returns [] for a diagnostic whose data is null",
    (code) => {
      const provider = getCodeFix(code)!
      const diagnostic = createDiagnostic(code, 'null data', 'warning', { data: null })
      expect(provider(diagnostic, { source: '', node: null })).toEqual([])
    },
  )
})

// ─── 2.4 Linter port ─────────────────────────────────────────────

function legacyOutput(
  source: string,
  code: string,
): { viaLegacy: string | null; viaProvider: string | null } {
  let captured: string | null = null
  const linter = new Linter({ onLegacyFix: (next) => { captured = next } })
  const { root } = parseRoot(source)
  const result = linter.lint(root, source)
  const issue = result.issues.find((item) => item.code === code)
  expect(issue, `no '${code}' issue for ${JSON.stringify(source)}`).toBeDefined()
  const viaLegacy = issue!.fix ? (issue!.fix.apply(), captured) : null

  const node = root.findById(issue!.nodeId as NodeId)
  const diag = createDiagnostic(code, issue!.message, 'warning', {
    nodeId: issue!.nodeId as NodeId,
    range: issue!.range,
    data: issue!.data,
  })
  const ops = getCodeFix(code)!(diag, { source, node })
  const viaProvider =
    ops.length === 0
      ? null
      : applyEditsToSource(
          source,
          ops.flatMap((op) => {
            if (op.kind === 'replace_text') return [{ start: op.range.start, end: op.range.end, text: op.newText }]
            if (op.kind === 'insert_text') return [{ start: op.position, end: op.position, text: op.text }]
            return [{ start: op.range.start, end: op.range.end, text: '' }]
          }),
        )
  return { viaLegacy, viaProvider }
}

describe('U2 Linter: 4 closures ported to FixOperation[] providers', () => {
  it('no-nested-bold parity: provider output equals the legacy closure result', () => {
    const { viaLegacy, viaProvider } = legacyOutput('[b][b]doble[/b][/b]', 'no-nested-bold')
    expect(viaLegacy).toBe('[b]doble[/b]')
    expect(viaProvider).toBe(viaLegacy)
  })

  it('no-empty-tags parity: provider output equals the legacy closure result', () => {
    const { viaLegacy, viaProvider } = legacyOutput('antes [i][/i] fin', 'no-empty-tags')
    expect(viaLegacy).toBe('antes  fin')
    expect(viaProvider).toBe(viaLegacy)
  })

  it('max-quote-depth has no safe rewrite: provider and legacy are both empty', () => {
    const src = '[quote][quote][quote][quote]hi[/quote][/quote][/quote][/quote]'
    const { viaLegacy, viaProvider } = legacyOutput(src, 'max-quote-depth')
    expect(viaLegacy).toBeNull()
    expect(viaProvider).toBeNull()
  })

  it('invalid-url-protocol has no safe rewrite: provider and legacy are both empty', () => {
    const { viaLegacy, viaProvider } = legacyOutput(
      '[url=javascript:alert(1)]x[/url]',
      'invalid-url-protocol',
    )
    expect(viaLegacy).toBeNull()
    expect(viaProvider).toBeNull()
  })

  it('legacy closures stay behind the flag: disabled means no fix on issues', () => {
    const linter = new Linter({ legacyFixes: false })
    const { root } = parseRoot('[b][b]doble[/b][/b]')
    const result = linter.lint(root, '[b][b]doble[/b][/b]')
    const issue = result.issues.find((item) => item.code === 'no-nested-bold')!
    expect(issue.fix).toBeUndefined()
    // The provider path is unaffected by the flag.
    expect(getCodeFix('no-nested-bold')).toBeDefined()
  })
})

// ─── 2.5 Plugin contributions ────────────────────────────────────

describe('U2 plugins: codeFixes + refactorings contributions', () => {
  it('registers and unregisters codeFixes with the plugin lifecycle', () => {
    const api = new PluginAPI(new BBCodeDocumentModel({}))
    api.registerPlugin(
      { name: 'u2-test-plugin', version: '1.0.0' },
      {
        codeFixes: [
          {
            code: 'u2-plugin-fix',
            provider: () => [{ kind: 'insert_text', position: 0, text: '!' }],
            meta: { title: 'Plugin fix', isAutomatic: true },
          },
        ],
        refactorings: [
          {
            id: 'u2-test-ref',
            title: 'Test refactoring',
            kinds: ['refactor.rewrite'],
            match: () => true,
            edits: () => [],
          },
        ],
      },
    )
    expect(getCodeFix('u2-plugin-fix')).toBeDefined()
    expect(getCodeFixMeta('u2-plugin-fix')?.isAutomatic).toBe(true)
    expect(matchRefactorings(null, 0, '').map((p) => p.id)).toContain('u2-test-ref')

    api.unregisterPlugin('u2-test-plugin')
    expect(getCodeFix('u2-plugin-fix')).toBeUndefined()
    expect(getCodeFixMeta('u2-plugin-fix')).toBeUndefined()
    expect(matchRefactorings(null, 0, '').map((p) => p.id)).not.toContain('u2-test-ref')
  })
})
