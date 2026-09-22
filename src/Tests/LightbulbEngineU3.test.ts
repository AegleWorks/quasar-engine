import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createDiagnostic } from '../Types/diagnostics'
import type { Diagnostic } from '../Types/diagnostics'
import {
  registerCodeFix,
  getCodeFix,
  unregisterCodeFix,
} from '../Fixes/CodeFixRegistry'
import { registerValidatorFixes } from '../Fixes/validatorFixes'
import { registerLinterFixes, Linter } from '../Linter/Linter'
import { MAX_FIX_ALL_PASSES } from '../Fixes/BatchFixer'
import { applyEditsToSource } from '../Edits/applyEdits'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { NodeId } from '../Types/core'

/**
 * U3 (lightbulb engine entry + gaps): DocumentModel Fix-All entry docs and
 * wiring, unit gaps versus U1/U2, and model-backed integration.
 *
 * Written RED-first: `DocumentModel.fixAll` / `asFixAllTarget` do not exist
 * yet. Spec acceptance mapping:
 * - code-fixes/spec.md: miss is empty (3.2), overlap rejects atomically (3.2)
 * - linter-rules/spec.md: edge-touch allowed (3.2), 4-rule parity (3.3)
 * - diagnostics/spec.md: code+data round-trip through the entry (3.2)
 * - fix-all/spec.md: document Fix-All in one transact per pass (3.3),
 *   multipass <= 10 + cycle warning through the entry (3.3)
 *
 * Gap rule: every behavior below is pinned through the real model entry
 * (`model.fixAll`), never through the synthetic `recordingTarget` U2 used —
 * that entry path is what U1/U2 left untested.
 */

const KEY = 'unclosed-tag'

beforeAll(() => {
  registerValidatorFixes()
  registerLinterFixes()
})

afterEach(() => {
  // Restore any provider a test overwrote or removed (idempotent).
  registerValidatorFixes()
  registerLinterFixes()
})

function unclosedIn(model: BBCodeDocumentModel): Diagnostic[] {
  return model.analyze().diagnostics.items.filter((d) => d.code === KEY)
}

// ─── 3.2 Unit gaps (through the real entry) ──────────────────────

describe('U3 unit gaps: engine behaviors through the model entry', () => {
  it('registry miss through the entry is empty with no error', () => {
    unregisterCodeFix(KEY)
    const model = new BBCodeDocumentModel({ source: '[b]x' })
    expect(unclosedIn(model)).toHaveLength(1)
    const result = model.fixAll(KEY)
    expect(result).toEqual({ applied: 0, deferred: 0, passes: 0 })
    expect(model.source).toBe('[b]x')
  })

  it('rejects a fix whose own ops overlap while others proceed', () => {
    registerCodeFix(
      KEY,
      () => [
        { kind: 'replace_text', range: { start: 0, end: 5 }, newText: 'a' },
        { kind: 'replace_text', range: { start: 3, end: 8 }, newText: 'b' },
      ],
      { title: 'intra', isAutomatic: true },
    )
    const model = new BBCodeDocumentModel({ source: '[b]x[i]y' })
    expect(unclosedIn(model).length).toBeGreaterThan(0)
    const result = model.fixAll(KEY)
    expect(result.applied).toBe(0)
    expect(result.deferred).toBeGreaterThan(0)
    expect(model.source).toBe('[b]x[i]y')
  })

  it('allows edge-touching fixes in one pass', () => {
    const model = new BBCodeDocumentModel({ source: 'a[i][/i][b][/b]z' })
    const empties = model
      .analyze()
      .diagnostics.items.filter((d) => d.code === 'empty-tag')
    expect(empties).toHaveLength(2)
    const result = model.fixAll('empty-tag')
    expect(result.applied).toBe(2)
    expect(result.deferred).toBe(0)
    expect(result.passes).toBe(1)
    expect(result.cycle).toBeUndefined()
    expect(model.source).toBe('az')
  })

  it('forwards code+data verbatim to the provider through the entry', () => {
    const received: Diagnostic[] = []
    registerCodeFix(
      KEY,
      (d) => {
        received.push(d)
        return []
      },
      { title: 'spy', isAutomatic: true },
    )
    const model = new BBCodeDocumentModel({ source: '[b]x' })
    const diags = unclosedIn(model)
    expect(diags).toHaveLength(1)
    const result = model.fixAll(KEY)
    expect(result.applied).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(diags[0])
    expect(received[0].data).toMatchObject({ name: 'b' })
  })
})

// ─── 3.3 Integration (live model) ────────────────────────────────

describe('U3 integration: document Fix-All through the model entry', () => {
  it('fixes a document end to end and stays undoable', () => {
    const model = new BBCodeDocumentModel({ source: '[b]x[i]y' })
    expect(unclosedIn(model)).toHaveLength(2)
    const result = model.fixAll(KEY)
    expect(result.applied).toBe(2)
    expect(result.cycle).toBeUndefined()
    // Two passes, not one: both closers insert at the same offset and two
    // zero-width inserts at one offset conflict by the EditConflicts
    // contract, so each pass takes one and defers the other.
    expect(result.passes).toBe(2)
    expect(model.source).toBe('[b]x[i]y[/i][/b]')
    expect(unclosedIn(model)).toHaveLength(0)
    // Each pass pushed exactly one undo entry: unwinding all passes
    // restores the original source.
    let undone = 0
    while (model.source !== '[b]x[i]y' && undone <= result.passes) {
      expect(model.undo()).toBe(true)
      undone++
    }
    expect(model.source).toBe('[b]x[i]y')
    expect(undone).toBe(result.passes)
  })

  it('bounds multipass at 10 with a cycle warning through the entry', () => {
    registerCodeFix(
      KEY,
      () => [{ kind: 'insert_text', position: 0, text: 'x' }],
      { title: 'grow', isAutomatic: true },
    )
    const model = new BBCodeDocumentModel({ source: '[b]x' })
    const result = model.fixAll(KEY)
    expect(result.passes).toBeLessThanOrEqual(MAX_FIX_ALL_PASSES)
    expect(result.passes).toBe(MAX_FIX_ALL_PASSES)
    expect(result.cycle).toMatch(/cycle|passes/i)
    expect(result.applied).toBe(MAX_FIX_ALL_PASSES)
  })

  it('Linter parity: provider output equals the legacy closure on the live model', () => {
    const cases: Array<{ source: string; code: string; fixable: boolean }> = [
      { source: '[b][b]doble[/b][/b]', code: 'no-nested-bold', fixable: true },
      { source: 'antes [i][/i] fin', code: 'no-empty-tags', fixable: true },
      {
        source: '[quote][quote][quote][quote]hi[/quote][/quote][/quote][/quote]',
        code: 'max-quote-depth',
        fixable: false,
      },
      {
        source: '[url=javascript:alert(1)]x[/url]',
        code: 'invalid-url-protocol',
        fixable: false,
      },
    ]
    for (const { source, code, fixable } of cases) {
      const model = new BBCodeDocumentModel({ source })
      expect(model.redRoot, `no redRoot for ${JSON.stringify(source)}`).not.toBeNull()
      let captured: string | null = null
      const linter = new Linter({ onLegacyFix: (next) => { captured = next } })
      const issue = linter
        .lint(model.redRoot!, model.source)
        .issues.find((item) => item.code === code)
      expect(issue, `no '${code}' issue for ${JSON.stringify(source)}`).toBeDefined()
      const viaLegacy = issue!.fix ? (issue!.fix.apply(), captured) : null

      const node = model.redRoot!.findById(issue!.nodeId as NodeId)
      const diag = createDiagnostic(code, issue!.message, 'warning', {
        nodeId: issue!.nodeId as NodeId,
        range: issue!.range,
        data: issue!.data,
      })
      const provider = getCodeFix(code)
      expect(provider, `no provider for ${code}`).toBeDefined()
      const ops = provider!(diag, { source: model.source, node })
      const viaProvider =
        ops.length === 0
          ? null
          : applyEditsToSource(
              model.source,
              ops.flatMap((op) => {
                if (op.kind === 'replace_text')
                  return [{ start: op.range.start, end: op.range.end, text: op.newText }]
                if (op.kind === 'insert_text')
                  return [{ start: op.position, end: op.position, text: op.text }]
                if (op.kind === 'delete_range')
                  return [{ start: op.range.start, end: op.range.end, text: '' }]
                return [{ start: op.range.start, end: op.range.start, text: '' }]
              }),
            )
      expect(viaProvider).toBe(viaLegacy)
      if (fixable) {
        expect(viaProvider, `'${code}' should rewrite`).not.toBeNull()
        model.applyTextUpdate(viaProvider!)
        expect(model.source).toBe(viaLegacy)
      } else {
        expect(viaProvider).toBeNull()
        expect(issue!.fix).toBeUndefined()
      }
    }
  })
})
