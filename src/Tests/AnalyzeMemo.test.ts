/**
 * `analyze()` is a question about the document, not a job that has to run.
 *
 * These pin the two halves of that: asking twice with nothing changed returns
 * the pass already computed, and every input that can change an answer makes
 * the next call a real analysis again. The second half is the one that matters
 * — a memo that misses an invalidation is a stale diagnostics panel.
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic } from '../Types/diagnostics'

const DOC = [
  '[box=Title]',
  'Some [b]bold[/b] text and [i]italics[/i].',
  '[/box]',
  '',
  '[quote]a quote[/quote]',
].join('\n')

const codes = (model: BBCodeDocumentModel) =>
  model.diagnostics!.items.map((d: Diagnostic) => `${d.code}@${d.range?.start}`)

describe('analyze() memo', () => {
  it('returns the previous pass, unchanged, when nothing has happened', () => {
    const model = new BBCodeDocumentModel({ source: DOC, autoAnalyze: false })

    const first = model.analyze()
    const second = model.analyze()
    const third = model.analyze()

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(model.lastAnalyze).toBe(first)
    expect(second.diagnostics).toBe(first.diagnostics)
    expect(second.nodesAnalyzed).toBe(first.nodesAnalyzed)
    expect(second.scope).toBe('full')
  })

  it('a repeat after a window pass is a repeat too', () => {
    // Long enough, and edited in the middle, that the reparse and its analysis
    // stay a window instead of widening to the whole document.
    const paragraphs = Array.from({ length: 200 }, (_, i) => `paragraph ${i} with [b]bold[/b] text`).join('\n\n')
    const model = new BBCodeDocumentModel({ source: paragraphs, autoAnalyze: false })
    model.analyze()

    const at = paragraphs.indexOf('paragraph 100') + 'paragraph 100'.length
    model.applyChange({ start: at, end: at, text: 'Z' })
    const windowed = model.analyze()
    expect(windowed.scope).toBe('window')

    const again = model.analyze()
    expect(again).toBe(windowed)
    expect(again.scope).toBe('window')
    expect(again.window).toEqual(windowed.window)
  })

  it('an edit invalidates it, and the next pass sees the new text', () => {
    const model = new BBCodeDocumentModel({ source: 'hello', autoAnalyze: false })
    expect(model.analyze().diagnostics.items).toHaveLength(0)

    model.applyTextUpdate('[strike]old[/strike]')
    const after = model.analyze()

    expect(after.scope).toBe('full')
    expect(after.diagnostics.items.some(d => d.code === 'deprecated-tag')).toBe(true)
  })

  it('a rebuild invalidates it even when the text is identical', () => {
    const model = new BBCodeDocumentModel({ source: DOC, autoAnalyze: false })
    const first = model.analyze()

    model.rebuild(DOC)
    const second = model.analyze()

    expect(second).not.toBe(first)
    const fresh = new BBCodeDocumentModel({ source: DOC, autoAnalyze: false })
    fresh.analyze()
    expect(codes(model)).toEqual(codes(fresh))
  })

  it('registering a validator invalidates it', () => {
    const model = new BBCodeDocumentModel({ source: DOC, autoAnalyze: false })
    model.analyze()
    expect(model.diagnostics!.items.some(d => d.code === 'memo-probe')).toBe(false)

    model.registerValidator({
      code: 'memo-probe',
      severity: 'warning',
      kinds: ['text'],
      validate: (node) => (
        node.kind === 'text' && node.text.includes('bold')
          ? {
              code: 'memo-probe',
              message: 'probe',
              severity: 'warning',
              tags: [],
              range: node.range,
              nodeId: node.id,
              nodeKind: node.kind,
              source: 'test',
            }
          : null
      ),
    })

    const after = model.analyze()
    expect(after.diagnostics.items.some(d => d.code === 'memo-probe')).toBe(true)

    // …and the answer it computed is now the one a repeat returns.
    expect(model.analyze()).toBe(after)
  })

  it('changing the tokens invalidates it', () => {
    const model = new BBCodeDocumentModel({ source: '[color=$accent]x[/color]', autoAnalyze: false })

    model.semanticAnalyzer.tokens = { palette: {} }
    expect(model.analyze().diagnostics.items.some(d => d.code === 'unresolved-token')).toBe(true)

    model.semanticAnalyzer.tokens = { palette: { accent: '#abcdef' } }
    expect(model.analyze().diagnostics.items.some(d => d.code === 'unresolved-token')).toBe(false)
  })

  it('changing the dialect invalidates it', () => {
    // `[sparkle]` exists in lyne and miliastry, not in osu.
    const model = new BBCodeDocumentModel({ source: '[sparkle]x[/sparkle]', dialect: 'osu', autoAnalyze: false })
    expect(model.analyze().diagnostics.items.some(d => d.code === 'unknown-tag')).toBe(true)

    model.semanticAnalyzer.dialect = 'lyne'
    expect(model.analyze().diagnostics.items.some(d => d.code === 'unknown-tag')).toBe(false)
  })

  it('the debounced pass after a direct analyze costs nothing', async () => {
    const model = new BBCodeDocumentModel({ source: DOC, autoAnalyze: true })
    model.ensureAnalyzed()

    model.applyTextUpdate('[strike]x[/strike]')
    // Answer now, the way a caller that needs diagnostics synchronously does.
    const direct = model.analyze()
    expect(direct.diagnostics.items.some(d => d.code === 'deprecated-tag')).toBe(true)

    // The post-edit debounce still fires; it finds the answer already computed.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(model.lastAnalyze).toBe(direct)
  })

  it('agrees with a fresh model after every edit of a sequence', () => {
    const model = new BBCodeDocumentModel({ source: DOC, autoAnalyze: false })
    model.analyze()

    const edits: Array<{ at: number; remove: number; text: string }> = [
      { at: 0, remove: 0, text: '[strike]' },
      { at: DOC.length, remove: 0, text: '[/strike]' },
      { at: DOC.indexOf('quote') + 5, remove: 0, text: 'Z' },
      { at: 0, remove: 9, text: '' },
    ]
    let text = DOC
    for (const edit of edits) {
      text = text.slice(0, edit.at) + edit.text + text.slice(edit.at + edit.remove)
      model.applyTextUpdate(text)
      // Twice: the first pass answers, the second must return that same answer.
      const result = model.analyze()
      expect(model.analyze()).toBe(result)

      const fresh = new BBCodeDocumentModel({ source: text, autoAnalyze: false })
      fresh.analyze()
      expect(codes(model)).toEqual(codes(fresh))
    }
  })
})
