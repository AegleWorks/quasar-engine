import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { LightbulbHost } from '../Fixes/LightbulbHost'
import { applyEditsToSource } from '../Edits/applyEdits'
import { rebaseEdits, changedRegion, rebaseOffset } from '../Edits/rebaseEdits'
import type { Diagnostic } from '../Types/diagnostics'

/**
 * Fixes on diagnostics a few keystrokes old.
 *
 * Analysis waits for the user to stop typing, so the diagnostics on screen —
 * and the ranges inside their `data` — describe an older text. A fix applied
 * with those offsets lands beside its target. The host maps them forward
 * (`diagnosticsSource`), and drops what the typing touched.
 */

function analyze(source: string): Diagnostic[] {
  return new BBCodeDocumentModel({ source, dialect: 'osu', autoAnalyze: false }).analyze().diagnostics.items
}

function treeOf(source: string) {
  return new BBCodeDocumentModel({ source, dialect: 'osu', autoAnalyze: false }).redRoot
}

describe('rebaseEdits', () => {
  const from = 'Hola [box]x[/box]'
  it('before the change stays, after it moves, across it is refused', () => {
    const to = 'ZZHola [box]x[/box]'
    expect(rebaseEdits([{ start: 5, end: 10, text: '[box=]' }], from, to)).toEqual([{ start: 7, end: 12, text: '[box=]' }])
    expect(rebaseEdits([{ start: 0, end: 4, text: 'Adiós' }], from, 'Hola [box]x[/box]!')).toEqual([{ start: 0, end: 4, text: 'Adiós' }])
    expect(rebaseEdits([{ start: 5, end: 10, text: '[box=]' }], from, 'Hola [bo]x[/box]')).toBeNull()
  })

  it('an insertion at the very point of an insertion has no order: refused', () => {
    expect(rebaseEdits([{ start: 5, end: 5, text: 'A' }], 'abcdefgh', 'abcdeBfgh')).toBeNull()
  })

  it('offsets inside what was replaced are gone', () => {
    const region = changedRegion('abcdef', 'abXYZf')!
    expect(rebaseOffset(1, region)).toBe(1)
    expect(rebaseOffset(3, region)).toBeNull()
    expect(rebaseOffset(5, region)).toBe(5)
    expect(rebaseOffset(6, region)).toBe(6)
  })
})

describe('the lightbulb on diagnostics of an older text', () => {
  const analyzed = 'Intro\n\n[box]uno[/box]\n\n[box]dos[/box]'
  const diagnostics = analyze(analyzed).filter((d) => d.code === 'box-missing-equals')

  it('the fixture has two bare boxes', () => {
    expect(diagnostics).toHaveLength(2)
  })

  it('typing before the box: the fix lands on the box, not one character off', () => {
    const current = 'XIntro\n\n[box]uno[/box]\n\n[box]dos[/box]'
    const caret = current.indexOf('[box]uno') + 2
    const actions = new LightbulbHost().query({
      source: current, root: treeOf(current), offset: caret,
      diagnostics, diagnosticsSource: analyzed,
    })
    const fix = actions.find((a) => a.kind === 'quickfix' && a.diagnostic?.code === 'box-missing-equals')!
    expect(fix).toBeDefined()
    expect(applyEditsToSource(current, fix.edits)).toBe('XIntro\n\n[box=]uno[/box]\n\n[box]dos[/box]')
    expect(fix.diagnosticRange!.start).toBe(current.indexOf('[box]uno'))
  })

  it('without the older text, the same query corrupts the document (what the app did)', () => {
    const current = 'XIntro\n\n[box]uno[/box]\n\n[box]dos[/box]'
    const caret = current.indexOf('[box]uno') + 2
    const actions = new LightbulbHost().query({ source: current, root: treeOf(current), offset: caret, diagnostics })
    const fix = actions.find((a) => a.kind === 'quickfix' && a.diagnostic?.code === 'box-missing-equals')!
    // One character off: the newline eaten, a stray `]` left behind.
    expect(applyEditsToSource(current, fix.edits)).toBe('XIntro\n[box=]]uno[/box]\n\n[box]dos[/box]')
  })

  it('typing inside the box the fix rewrites: no fix, rather than a wrong one', () => {
    const current = analyzed.replace('[box]uno', '[bo]uno')
    const caret = current.indexOf('[bo]uno') + 1
    const actions = new LightbulbHost().query({
      source: current, root: treeOf(current), offset: caret,
      diagnostics, diagnosticsSource: analyzed,
    })
    expect(actions.filter((a) => a.diagnostic?.code === 'box-missing-equals' && a.kind === 'quickfix')).toHaveLength(0)
  })

  it('Fix all covers the document, not only the span', () => {
    const caret = analyzed.indexOf('[box]uno') + 2
    const actions = new LightbulbHost().query({
      source: analyzed, root: treeOf(analyzed), offset: caret,
      diagnostics: diagnostics.filter((d) => d.range!.start <= caret && d.range!.end >= caret),
      documentDiagnostics: diagnostics,
    })
    const all = actions.find((a) => a.kind === 'source.fixAll')!
    expect(all).toBeDefined()
    expect(applyEditsToSource(analyzed, all.edits)).toBe('Intro\n\n[box=]uno[/box]\n\n[box=]dos[/box]')
  })

  it('a preview is built only when read', () => {
    const caret = analyzed.indexOf('[box]uno') + 2
    const [first] = new LightbulbHost().query({ source: analyzed, root: treeOf(analyzed), offset: caret, diagnostics })
    const descriptor = Object.getOwnPropertyDescriptor(first, 'preview')!
    expect(typeof descriptor.get).toBe('function')
    expect(first.preview).toBe(applyEditsToSource(analyzed, first.edits))
  })
})
