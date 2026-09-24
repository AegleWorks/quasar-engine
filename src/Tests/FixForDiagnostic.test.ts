import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { createDiagnostic } from '../Types/diagnostics'
import { fixForDiagnostic } from '../Fixes/fixForDiagnostic'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { applyEditsToSource } from '../Edits/applyEdits'

function diagnosticsOf(source: string) {
  const model = new BBCodeDocumentModel({ source, dialect: 'osu', autoAnalyze: true })
  model.ensureAnalyzed()
  return model.diagnostics?.items ?? []
}

describe('fixForDiagnostic', () => {
  it('resolves an engine diagnostic, which embeds no fix, through the registry', () => {
    const source = '[b]x'
    const d = diagnosticsOf(source).find((item) => item.code === 'unclosed-tag')!
    expect(d.fixes).toBeUndefined()

    const fix = fixForDiagnostic(d)
    expect(fix).not.toBeNull()
    expect(fix!.isAutomatic).toBe(true)
    expect(applyEditsToSource(source, fixToSurgicalEdits(fix!))).toBe('[b]x[/b]')
  })

  it('treats data the provider cannot read as no fix instead of throwing', () => {
    const d = createDiagnostic('unclosed-tag', 'Unclosed tag', 'warning', { data: 'not an object' })
    expect(fixForDiagnostic(d)).toBeNull()
  })

  it('falls back to an embedded fix for diagnostics from outside the engine', () => {
    const embedded = { description: 'Do it', isAutomatic: false, operations: [] }
    const d = createDiagnostic('foreign-code', 'Foreign', 'info', { fixes: [embedded] })
    expect(fixForDiagnostic(d)).toBe(embedded)
  })

  it('returns null when there is neither a provider nor an embedded fix', () => {
    expect(fixForDiagnostic(createDiagnostic('foreign-code', 'Foreign', 'info'))).toBeNull()
  })
})
