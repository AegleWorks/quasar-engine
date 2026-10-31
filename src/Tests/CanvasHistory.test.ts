import { describe, it, expect } from 'vitest'
import { CanvasHistory } from '../Reconciler/CanvasHistory'
import type { TextChange } from '../Incremental/ChangeTracker'

function apply(source: string, changes: readonly TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

/** A document with a history, driven the way the canvas drives it. */
function doc(start: string) {
  let text = start
  const history = new CanvasHistory()
  const none = { before: null, after: null }
  return {
    get text() { return text },
    history,
    edit(changes: TextChange[], join = false) {
      history.record(text, changes, none, join)
      text = apply(text, changes)
    },
    outside(change: TextChange) {
      text = apply(text, [change])
      history.rebase(change)
    },
    undo() { for (const s of history.undo() ?? []) text = apply(text, s.changes) },
    redo() { for (const s of history.redo() ?? []) text = apply(text, s.changes) },
  }
}

describe('CanvasHistory', () => {
  it('takes an edit back and puts it again', () => {
    const d = doc('Hola')
    d.edit([{ start: 4, end: 4, text: '\n' }])
    d.undo()
    expect(d.text).toBe('Hola')
    d.redo()
    expect(d.text).toBe('Hola\n')
  })

  it('undoes a replacement, and several changes at once', () => {
    const d = doc('ab cd')
    d.edit([{ start: 0, end: 2, text: 'XYZ' }, { start: 3, end: 5, text: '' }])
    expect(d.text).toBe('XYZ ')
    d.undo()
    expect(d.text).toBe('ab cd')
    d.redo()
    expect(d.text).toBe('XYZ ')
  })

  it('folds a run of keystrokes into one step', () => {
    const d = doc('')
    d.edit([{ start: 0, end: 0, text: 'a' }])
    d.edit([{ start: 1, end: 1, text: 'b' }], true)
    d.edit([{ start: 2, end: 2, text: 'c' }], true)
    d.edit([{ start: 3, end: 3, text: '\n' }])
    d.undo()
    expect(d.text).toBe('abc')
    d.undo()
    expect(d.text).toBe('')
    d.redo()
    expect(d.text).toBe('abc')
  })

  it('a new edit drops what could be redone', () => {
    const d = doc('a')
    d.edit([{ start: 1, end: 1, text: 'b' }])
    d.undo()
    d.edit([{ start: 1, end: 1, text: 'c' }])
    expect(d.history.redo()).toBeNull()
  })

  it('has nothing to give when empty', () => {
    const history = new CanvasHistory()
    expect(history.undo()).toBeNull()
    expect(history.redo()).toBeNull()
  })

  it('carries its offsets through a change made outside: the Text Studio rewriting the tag', () => {
    const d = doc('[gradient=#000,#fff]Hola[/gradient]')
    const end = '[gradient=#000,#fff]Hola'.length
    d.edit([{ start: end, end, text: '\nx' }])
    // Another palette: the opener grows by six characters.
    d.outside({ start: 19, end: 19, text: ',#123' })
    d.undo()
    expect(d.text).toBe('[gradient=#000,#fff,#123]Hola[/gradient]')
    d.redo()
    expect(d.text).toBe('[gradient=#000,#fff,#123]Hola\nx[/gradient]')
  })

  it('forgets everything when an outside change overlaps what it remembers', () => {
    const d = doc('abcdef')
    d.edit([{ start: 2, end: 2, text: 'X' }])
    d.outside({ start: 0, end: 7, text: 'nuevo' })
    expect(d.history.undo()).toBeNull()
  })
})
