/**
 * The incremental surface, as a consumer sees it.
 *
 * An editor that wants to know what the engine actually re-did on the last
 * keystroke — to skip re-measuring untouched blocks, to draw a performance
 * overlay, to keep a regression from quietly downgrading everything to the
 * full path — reads four things: `lastReparseWindow`, `lastReparseFallbackReason`,
 * `lastAnalyze.scope` and the `analysisScope` on `diagnostics_updated`. This
 * pins their meaning, because a value that is merely *present* is worse than
 * one that is absent: it will be trusted.
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { DocumentEvent } from '../Events/EventBus'

/** Long enough to clear `MIN_SOURCE_LENGTH`, so the window path is available. */
function longDocument(): string {
  return Array.from({ length: 200 }, (_, i) =>
    `Parrafo ${i} con [b]negrita[/b] y [color=#FF0000]color[/color].`,
  ).join('\n\n')
}

describe('the incremental API a consumer reads', () => {
  it('lastReparseWindow describes the CURRENT text and contains the edit', () => {
    let src = longDocument()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
    expect(model.lastReparseWindow, 'no hay edición todavía').toBeNull()

    // Dentro del texto llano de un párrafo, no a mitad de una etiqueta.
    const at = src.indexOf('Parrafo 100') + 'Parrafo 100'.length
    model.applyChange({ start: at, end: at, text: 'XYZ' })
    src = src.slice(0, at) + 'XYZ' + src.slice(at)

    expect(model.lastReparsePath).toBe('incremental')
    const window = model.lastReparseWindow!
    expect(window).not.toBeNull()
    // In the NEW coordinates, and covering the text that was inserted.
    expect(window.start).toBeLessThanOrEqual(at)
    expect(window.end).toBeGreaterThanOrEqual(at + 3)
    expect(window.end).toBeLessThanOrEqual(src.length)
    expect(src.slice(window.start, window.end)).toContain('XYZ')
    // And it is a window, not the document.
    expect(window.end - window.start).toBeLessThan(src.length / 2)
  })

  it('a full rebuild reports a null window and a reason', () => {
    const model = new BBCodeDocumentModel({ source: longDocument(), autoAnalyze: false })
    // A stray closer of a tag left pending: the window guard declines, and
    // `reason` is how a consumer finds out why a document edits slowly.
    model.applyTextUpdate('[quote][b]x[/quote]\n\n' + longDocument())
    if (model.lastReparsePath === 'full_rebuild') {
      expect(model.lastReparseWindow).toBeNull()
      expect(model.lastReparseFallbackReason).not.toBeNull()
    }
    // A rebuild from scratch always clears it.
    model.rebuild(longDocument())
    expect(model.lastReparseWindow).toBeNull()
  })

  it('lastAnalyze.scope tells the two analysis routes apart, and both agree', () => {
    let src = longDocument()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })

    const first = model.analyze()
    expect(first.scope).toBe('full')
    expect(first.window).toBeNull()

    // Una etiqueta desconocida: cerrada y autocontenida, así que la ventana
    // sobrevive, y despierta a `unknown-tag`, así que el análisis cambia.
    const at = src.indexOf('Parrafo 100') + 'Parrafo 100'.length
    model.applyChange({ start: at, end: at, text: ' [bold]typo[/bold]' })
    src = src.slice(0, at) + ' [bold]typo[/bold]' + src.slice(at)

    const second = model.analyze()
    expect(second.scope).toBe('window')
    expect(second.window).not.toBeNull()
    expect(second.nodesAnalyzed).toBeLessThan(first.nodesAnalyzed)

    // The scope is about the route, never about the answer.
    const truth = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
    truth.analyze()
    expect(model.diagnostics!.items.map(d => `${d.code}@${d.range?.start}`))
      .toEqual(truth.diagnostics!.items.map(d => `${d.code}@${d.range?.start}`))
  })

  it('diagnostics_updated carries the scope and the window', async () => {
    const src = longDocument()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: true })
    model.analyze()

    const seen: DocumentEvent[] = []
    model.events.on('diagnostics_updated', e => { seen.push(e) })

    const at = src.indexOf('Parrafo 50')
    model.applyChange({ start: at, end: at, text: 'Z' })
    // The analysis is debounced; `ensureAnalyzed` runs it now.
    model.ensureAnalyzed()

    expect(seen.length).toBe(1)
    expect(seen[0].analysisScope).toBe('window')
    expect(seen[0].analysisWindow).not.toBeNull()
    // Whole-document diagnostics on both routes — a consumer must not merge.
    expect(seen[0].diagnostics).toBe(model.diagnostics)
  })
})
