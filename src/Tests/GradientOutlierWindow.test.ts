import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'

/**
 * `gradient-outlier` reads a colour's run neighbours, two each way. A window
 * pass that re-validates only the window kept a stale verdict, or missed a new
 * one, for a colour whose neighbour two steps away was edited.
 */

const filler = Array.from({ length: 40 }, (_, i) => `line ${i} of plain prose`).join('\n')
const run = ['#000000', '#101010', '#202020', '#ffffff', '#404040', '#505050', '#606060']
  .map((c, i) => `[color=${c}]${'abcdefg'[i]}[/color]`).join('')

function outliers(model: BBCodeDocumentModel): string[] {
  model.ensureAnalyzed()
  return model.diagnostics!.items
    .filter(d => d.code === 'gradient-outlier')
    .map(d => JSON.stringify([d.message, d.range, d.data]))
}

function expectMatchesFullPass(src: string, edit: (s: string) => string): void {
  const model = new BBCodeDocumentModel({ source: src })
  outliers(model)
  const next = edit(src)
  model.applyTextUpdate(next)
  const window = outliers(model)
  expect(model.lastAnalyze?.scope).toBe('window')
  expect(window).toEqual(outliers(new BBCodeDocumentModel({ source: next })))
}

describe('gradient-outlier after a window pass', () => {
  const src = `${filler}\n\n[centre]\n${filler}\n${run}\n${filler}\n[/centre]\n\n${filler}`

  it('recolouring a neighbour two steps away refreshes the verdict', () => {
    expectMatchesFullPass(src, s => s.replace('#505050', '#ffff00'))
  })

  it('text typed into the run splits it', () => {
    expectMatchesFullPass(src, s => s.replace('[color=#505050]', 'split here [color=#505050]'))
  })

  it('removing a colour two steps away', () => {
    expectMatchesFullPass(src, s => s.replace('[color=#202020]c[/color]', ''))
  })
})
