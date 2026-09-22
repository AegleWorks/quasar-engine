import { describe, it, expect } from 'vitest'
import { createDiagnostic } from '../Types/diagnostics'
import type { CodeActionKind, Diagnostic } from '../Types/diagnostics'
import { registerCodeFix, getCodeFix, unregisterCodeFix } from '../Fixes/CodeFixRegistry'
import {
  registerRefactoring,
  unregisterRefactoring,
  matchRefactorings,
  previewRefactoring,
} from '../Fixes/RefactoringRegistry'
import { combineBoldsProvider } from '../Fixes/refactorings/combineBolds'
import {
  extractTemplateProvider,
  extractTemplateEdits,
} from '../Fixes/refactorings/extractTemplate'
import { applyEditsToSource } from '../Edits/applyEdits'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { RedNode } from '../Syntax/RedNode'

/**
 * U1 (lightbulb engine foundation): types + registries + example refactorings.
 *
 * Written RED-first: every import above names production code specified by
 * design.md that does not exist yet. Spec acceptance mapping:
 * - diagnostics/spec.md: opaque data round-trip, legacy-without-data tolerated
 * - code-fixes/spec.md: registry resolves by code, miss returns empty, no mutation
 * - code-refactorings/spec.md: combine-bolds offered with preview, empty context
 */

function parseRoot(source: string): { root: RedNode; source: string } {
  const model = new BBCodeDocumentModel({ source })
  model.analyze()
  expect(model.redRoot, `no redRoot for ${JSON.stringify(source)}`).not.toBeNull()
  return { root: model.redRoot!, source }
}

function legacyDiagnostic(code: string): Diagnostic {
  return createDiagnostic(code, 'legacy without data', 'warning')
}

describe('U1 diagnostics: opaque data + equivalenceKey + CodeActionKind', () => {
  it('preserves code+data verbatim for the codeAction round-trip', () => {
    const payload = { expected: '[/b]', at: 12 }
    const diag = createDiagnostic('unclosed-tag', 'missing close', 'error', {
      data: payload,
      equivalenceKey: 'unclosed-tag',
    })
    expect(diag.code).toBe('unclosed-tag')
    expect(diag.data).toEqual(payload)
    expect(diag.equivalenceKey).toBe('unclosed-tag')

    // The host forwards code+data without dropping: a provider registered by
    // code observes the identical payload object contents.
    registerCodeFix('u1-round-trip', (received) => {
      expect(received.code).toBe('unclosed-tag')
      expect(received.data).toEqual(payload)
      return []
    })
    try {
      getCodeFix('u1-round-trip')!(diag, { source: '[b]x', node: null })
    } finally {
      unregisterCodeFix('u1-round-trip')
    }
  })

  it('tolerates legacy diagnostics without data: resolution proceeds by code alone', () => {
    const diag = legacyDiagnostic('u1-legacy-code')
    expect(diag.data).toBeUndefined()
    expect(diag.equivalenceKey).toBeUndefined()

    registerCodeFix('u1-legacy-code', (received) => {
      expect(received.data).toBeUndefined()
      return [{ kind: 'insert_text', position: 0, text: '!' }]
    })
    try {
      const ops = getCodeFix('u1-legacy-code')!(diag, { source: 'x', node: null })
      expect(ops).toHaveLength(1)
      expect(ops[0]).toEqual({ kind: 'insert_text', position: 0, text: '!' })
    } finally {
      unregisterCodeFix('u1-legacy-code')
    }
  })

  it('exposes the LSP code-action kinds from the design', () => {
    const kinds: CodeActionKind[] = [
      'quickfix',
      'refactor.extract',
      'refactor.rewrite',
      'source.fixAll',
    ]
    expect(kinds).toHaveLength(4)
  })
})

describe('U1 CodeFixRegistry', () => {
  it('resolves a registered provider by code and returns atomic FixOperation[]', () => {
    const source = '[b]x'
    registerCodeFix('u1-fix-basic', () => [
      { kind: 'insert_text', position: source.length, text: '[/b]' },
    ])
    try {
      const provider = getCodeFix('u1-fix-basic')
      expect(provider).toBeDefined()
      const ops = provider!(legacyDiagnostic('u1-fix-basic'), { source, node: null })
      expect(ops).toHaveLength(1)
      expect(applyEditsToSource(source, ops.map((op) =>
        op.kind === 'insert_text'
          ? { start: op.position, end: op.position, text: op.text }
          : { start: 0, end: 0, text: '' },
      ))).toBe('[b]x[/b]')
      // Providers MUST NOT mutate: the input document is untouched.
      expect(source).toBe('[b]x')
    } finally {
      unregisterCodeFix('u1-fix-basic')
    }
  })

  it('returns undefined for a code with no provider (host shows nothing, no error)', () => {
    expect(getCodeFix('u1-never-registered')).toBeUndefined()
  })

  it('latest registration wins for the same code', () => {
    registerCodeFix('u1-fix-overwrite', () => [])
    registerCodeFix('u1-fix-overwrite', () => [
      { kind: 'insert_text', position: 0, text: 'v2' },
    ])
    try {
      const ops = getCodeFix('u1-fix-overwrite')!(legacyDiagnostic('x'), {
        source: '',
        node: null,
      })
      expect(ops).toEqual([{ kind: 'insert_text', position: 0, text: 'v2' }])
    } finally {
      unregisterCodeFix('u1-fix-overwrite')
    }
  })
})

describe('U1 RefactoringRegistry', () => {
  it('matches a registered context provider and previews without mutating', () => {
    const { root, source } = parseRoot('[b]a[/b][b]b[/b]')
    registerRefactoring(combineBoldsProvider)
    try {
      const offset = source.indexOf('a')
      const found = matchRefactorings(root, offset, source)
      expect(found.map((p) => p.id)).toContain('combine-bolds')
      const preview = previewRefactoring('combine-bolds', root, offset, source)
      expect(preview).toBe('[b]ab[/b]')
      expect(source).toBe('[b]a[/b][b]b[/b]')
    } finally {
      unregisterRefactoring('combine-bolds')
    }
  })

  it('returns empty when no context matches', () => {
    const { root, source } = parseRoot('plain text, no bolds here')
    registerRefactoring(combineBoldsProvider)
    try {
      expect(matchRefactorings(root, 3, source)).toEqual([])
    } finally {
      unregisterRefactoring('combine-bolds')
    }
  })
})

describe('U1 combineBolds refactoring', () => {
  it('merges directly adjacent bolds into one', () => {
    const { root, source } = parseRoot('[b]a[/b][b]b[/b]')
    const offset = source.indexOf('a')
    expect(combineBoldsProvider.match(root, offset, source)).toBe(true)
    expect(applyEditsToSource(source, combineBoldsProvider.edits(root, offset, source))).toBe(
      '[b]ab[/b]',
    )
  })

  it('does not match bolds separated by text', () => {
    const { root, source } = parseRoot('[b]a[/b] middle [b]b[/b]')
    expect(combineBoldsProvider.match(root, source.indexOf('a'), source)).toBe(false)
  })

  it('does not match a lone bold with no bold sibling', () => {
    const { root, source } = parseRoot('[b]solo[/b]')
    expect(combineBoldsProvider.match(root, source.indexOf('s'), source)).toBe(false)
  })
})

describe('U1 extractTemplate refactoring', () => {
  it('wraps an explicit selection in a template block', () => {
    const source = 'before hello after'
    const edits = extractTemplateEdits(source, { start: 7, end: 12 })
    expect(edits).toHaveLength(2)
    expect(applyEditsToSource(source, edits)).toBe('before [template]hello[/template] after')
    expect(source).toBe('before hello after')
  })

  it('produces no edits for an empty selection', () => {
    expect(extractTemplateEdits('hello', { start: 2, end: 2 })).toEqual([])
  })

  it('matches a caret inside non-empty text and previews the extraction', () => {
    const { root, source } = parseRoot('hello world')
    registerRefactoring(extractTemplateProvider)
    try {
      const offset = source.indexOf('o')
      expect(extractTemplateProvider.match(root, offset, source)).toBe(true)
      expect(matchRefactorings(root, offset, source).map((p) => p.id)).toContain(
        'extract-template',
      )
      const preview = previewRefactoring('extract-template', root, offset, source)
      expect(preview).toContain('[template]')
      expect(preview).toContain('[/template]')
      expect(preview.length).toBeGreaterThan(source.length)
    } finally {
      unregisterRefactoring('extract-template')
    }
  })
})
