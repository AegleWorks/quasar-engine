import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { registerValidatorFixes } from '../Fixes/validatorFixes'
import { getCodeFix } from '../Fixes/CodeFixRegistry'
import { applyEditsToSource } from '../Edits/applyEdits'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import type { Diagnostic } from '../Types/diagnostics'

/**
 * A window pass keeps the diagnostics outside the edited window and moves them
 * with their nodes. The fix providers read their offsets from `data`, so
 * `data` has to move too: a quick fix applied after typing above a finding
 * must edit the finding, not the characters that used to be there.
 */

const filler = Array.from({ length: 60 }, (_, i) => `paragraph ${i} [b]bold[/b] text`).join('\n\n')

function fixOf(d: Diagnostic, source: string): string {
  const ops = getCodeFix(d.code)!(d, { source, node: null })
  return applyEditsToSource(source, fixToSurgicalEdits({ operations: ops } as never))
}

describe('quick fixes after a window analysis', () => {
  it('a deprecated tag below an edit is renamed where it now is', () => {
    registerValidatorFixes()
    const src0 = `${filler}\n\n[strike]old[/strike]\n\n${filler}`
    const model = new BBCodeDocumentModel({ source: src0 })
    model.ensureAnalyzed()
    const src1 = 'XY' + src0
    model.applyTextUpdate(src1)
    model.ensureAnalyzed()
    expect(model.lastAnalyze?.scope).toBe('window')

    const d = model.diagnostics!.items.find(x => x.code === 'deprecated-tag')!
    const fresh = new BBCodeDocumentModel({ source: src1 })
    const truth = fresh.diagnostics!.items.find(x => x.code === 'deprecated-tag')!
    expect(d.data).toEqual(truth.data)
    expect(fixOf(d, src1)).toBe(fixOf(truth, src1))
    expect(fixOf(d, src1)).toContain('[s]old[/s]')
  })

  it('Fix-All after typing at the top fixes every finding in place', () => {
    registerValidatorFixes()
    const src0 = `${filler}\n\n[strike]a[/strike]\n\n${filler}\n\n[strike]b[/strike]`
    const model = new BBCodeDocumentModel({ source: src0 })
    model.ensureAnalyzed()
    model.applyTextUpdate('XY' + src0)
    model.fixAll('deprecated-tag')
    expect(model.source).toBe('XY' + src0.replaceAll('[strike]', '[s]').replaceAll('[/strike]', '[/s]'))
  })
})
