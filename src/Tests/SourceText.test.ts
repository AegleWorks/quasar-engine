import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import {
  SourceText,
  formatDiagnostic,
  formatDiagnostics,
} from '../Source/SourceText'
import { createDiagnostic } from '../Types/diagnostics'

describe('SourceText — lines and positions', () => {
  it('indexes an empty document as one empty line', () => {
    const text = new SourceText('')
    expect(text.length).toBe(0)
    expect(text.lineCount).toBe(1)
    expect(text.lineStarts).toEqual([0])
    expect(text.positionAt(0)).toEqual({ line: 0, character: 0 })
    expect(text.getLineText(0)).toBe('')
    expect(text.offsetAt(0, 0)).toBe(0)
  })

  it('counts LF lines and puts EOF on the last line', () => {
    const text = new SourceText('uno\ndos\ntres')
    expect(text.lineCount).toBe(3)
    expect(text.lineStarts).toEqual([0, 4, 8])
    expect(text.positionAt(0)).toEqual({ line: 0, character: 0 })
    expect(text.positionAt(3)).toEqual({ line: 0, character: 3 })
    expect(text.positionAt(4)).toEqual({ line: 1, character: 0 })
    expect(text.positionAt(text.length)).toEqual({ line: 2, character: 4 })
    expect(text.getLineText(1)).toBe('dos')
    expect(text.getLineEnd(1)).toBe(7)
    expect(text.getLineEndIncludingBreak(1)).toBe(8)
  })

  it('treats CRLF as a single break, with positions on the new line after it', () => {
    const text = new SourceText('one\r\ntwo\r\nthree')
    expect(text.lineCount).toBe(3)
    expect(text.lineStarts).toEqual([0, 5, 10])
    expect(text.getLineText(0)).toBe('one')
    expect(text.getLineEnd(0)).toBe(3)
    expect(text.getLineEndIncludingBreak(0)).toBe(5)
    expect(text.positionAt(5)).toEqual({ line: 1, character: 0 })
    expect(text.positionAt(7)).toEqual({ line: 1, character: 2 })
    expect(text.offsetAt(1, 0)).toBe(5)
    expect(text.offsetAt(1, 2)).toBe(7)
  })

  it('treats a lone CR as a break too', () => {
    const text = new SourceText('a\rb\rc')
    expect(text.lineCount).toBe(3)
    expect(text.lineStarts).toEqual([0, 2, 4])
    expect(text.getLineText(1)).toBe('b')
    expect(text.positionAt(2)).toEqual({ line: 1, character: 0 })
  })

  it('clamps out-of-range offsets and characters', () => {
    const text = new SourceText('abc\ndef')
    expect(text.positionAt(-5)).toEqual({ line: 0, character: 0 })
    expect(text.positionAt(999)).toEqual({ line: 1, character: 3 })
    expect(text.offsetAt(-2, -2)).toBe(0)
    expect(text.offsetAt(99, 99)).toBe(text.length)
    // A character past the end of a non-final line clamps to its end, before
    // the break — it does not slide into the next line.
    expect(text.offsetAt(0, 99)).toBe(3)
    expect(text.offsetAt(0, 3)).toBe(3)
  })

  it('round-trips every position within every line', () => {
    const source = 'first\r\nsecond\nthird\rfourth\n'
    const text = new SourceText(source)
    for (let line = 0; line < text.lineCount; line++) {
      const length = text.getLineText(line).length
      for (let character = 0; character <= length; character++) {
        const offset = text.offsetAt(line, character)
        expect(text.positionAt(offset), `line ${line} char ${character}`).toEqual({ line, character })
      }
    }
  })

  it('exposes the line containing an offset with its break span', () => {
    const text = new SourceText('hola\nmundo')
    expect(text.lineAt(0)).toEqual({
      line: 0, start: 0, end: 4, endIncludingBreak: 5, text: 'hola',
    })
    expect(text.lineAt(7)).toEqual({
      line: 1, start: 5, end: 10, endIncludingBreak: 10, text: 'mundo',
    })
  })

  it('indexes a large document in one pass and resolves the last line exactly', () => {
    const lines = 20_000
    const source = Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')
    const text = new SourceText(source)
    expect(text.lineCount).toBe(lines)
    expect(text.positionAt(source.length)).toEqual({ line: lines - 1, character: `line ${lines - 1}`.length })
  })
})

describe('formatDiagnostic', () => {
  const source = 'first line\nsecond line'

  it('renders 1-based coordinates and the severity', () => {
    const diagnostic = createDiagnostic('unclosed-tag', 'Missing [/b]', 'warning', {
      range: { start: 11, end: 16 },
    })
    expect(formatDiagnostic(diagnostic, source, { filePath: 'post.bbcode' }))
      .toBe('post.bbcode(2,1): warning unclosed-tag: Missing [/b]')
  })

  it('omits coordinates when the diagnostic has no range', () => {
    const diagnostic = createDiagnostic('max-quote-depth', 'Too many quotes', 'error')
    expect(formatDiagnostic(diagnostic, source, { filePath: 'post.bbcode' }))
      .toBe('post.bbcode: error max-quote-depth: Too many quotes')
  })

  it('can name the producing rule and renders collections in order', () => {
    const a = createDiagnostic('a', 'first', 'hint', { range: { start: 0, end: 1 }, source: 'linter' })
    const b = createDiagnostic('b', 'second', 'info', { range: { start: 11, end: 12 } })
    expect(formatDiagnostics([a, b], new SourceText(source), { includeSource: true }))
      .toBe([
        '<source>(1,1): hint a [linter]: first',
        '<source>(2,1): info b [document-engine]: second',
      ].join('\n'))
  })

  it('does not keep the line index from the string overload', () => {
    const diagnostic = createDiagnostic('x', 'msg', 'error', { range: { start: 0, end: 1 } })
    expect(formatDiagnostic(diagnostic, 'a\r\nb')).toBe('<source>(1,1): error x: msg')
  })
})

describe('DocumentModel source locations', () => {
  it('maps offsets to lines and back, before and after an edit', () => {
    const model = new BBCodeDocumentModel({ source: 'aaa\nbbb', autoAnalyze: false })
    expect(model.positionAt(4)).toEqual({ line: 1, character: 0 })
    expect(model.offsetAt(1, 2)).toBe(6)
    expect(model.lineAt(5).text).toBe('bbb')

    model.applyChange({ start: 0, end: 0, text: 'x\n' })
    expect(model.positionAt(0)).toEqual({ line: 0, character: 0 })
    expect(model.positionAt(2)).toEqual({ line: 1, character: 0 })
    expect(model.positionAt(6)).toEqual({ line: 2, character: 0 })
    expect(model.lineAt(6).text).toBe('bbb')
  })

  it('reuses the index until the source changes', () => {
    const model = new BBCodeDocumentModel({ source: 'a\nb', autoAnalyze: false })
    expect(model.sourceText).toBe(model.sourceText)
    model.applyChange({ start: 0, end: 0, text: 'z' })
    expect(model.sourceText.text).toBe('za\nb')
    expect(model.sourceText).toBe(model.sourceText)
  })
})
