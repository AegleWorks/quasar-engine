import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { insertTypedText, replaceWithLineBreak } from '../Commands/InsertContent'
import { deleteRange, insertLineBreak } from '../Commands/StructuralEdits'
import { textOffsetOfSource, sourceOffsetOfText } from '../Reconciler/CanvasPositions'
import type { FormatEdit, SourceSelection } from '../Commands/InlineFormat'

/**
 * What a keystroke on the canvas does to the source. The browser side of these
 * lives in `scripts/wysiwyg-lab`, which runs them on a real Chrome next to
 * Lexical; here is what can be said without one. `|` is the caret, `«»` a selection.
 */

const NBSP = ' '
const parse = (source: string) => {
  const model = new BBCodeDocumentModel({ dialect: 'miliastry', autoAnalyze: false })
  model.rebuild(source)
  return model.redRoot!
}

function marked(text: string): { source: string; selection: SourceSelection } {
  const caret = text.indexOf('|')
  if (caret !== -1) return { source: text.replace('|', ''), selection: { start: caret, end: caret } }
  const start = text.indexOf('«')
  const end = text.indexOf('»') - 1
  return { source: text.replace('«', '').replace('»', ''), selection: { start, end } }
}

function run(text: string, command: (source: string, selection: SourceSelection) => FormatEdit | null): string {
  const { source, selection } = marked(text)
  const edit = command(source, selection)
  if (!edit) return 'declined'
  let out = source
  for (const c of [...edit.changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return `${out.slice(0, edit.selection.start)}|${out.slice(edit.selection.start)}`
}

const typed = (text: string, key: string) => run(text, (s, sel) => insertTypedText(parse(s), s, sel, key, parse))
const enter = (text: string) => run(text, (s, sel) => replaceWithLineBreak(parse(s), s, sel, parse))
const deleted = (text: string) => run(text, (s, sel) => deleteRange(parse(s), s, sel))

describe('typing', () => {
  it.each([
    ['ho|la', 'x', 'hox|la'],
    ['a\n|', 'x', 'a\nx|'],
    ['a\n\n|b', 'x', 'a\n\nx|b'],
    ['[b]a|[/b]', 'x', '[b]ax|[/b]'],
    ['[gradient=#000,#fff]a\n|[/gradient]', 'x', '[gradient=#000,#fff]a\nx|[/gradient]'],
    ['«todo»', 'x', 'x|'],
    ['a«b\nc»d', 'x', 'ax|d'],
  ])('%j + %j → %j', (text, key, expected) => {
    expect(typed(text, key)).toBe(expected)
  })
})

describe('a typed space stays on screen, as the browser would write it', () => {
  it.each([
    ['plain gap between words', 'a|b', ' ', 'a |b'],
    ['end of the document', 'a|', ' ', `a${NBSP}|`],
    ['end of a line', 'a|\nb', ' ', `a${NBSP}|\nb`],
    ['start of a line', 'a\n|b', ' ', `a\n${NBSP}|b`],
    ['after another space', 'a |b', ' ', `a ${NBSP}|b`],
    ['before another space', 'a| b', ' ', `a${NBSP}| b`],
    ['end of a block', '[notice]a|[/notice]', ' ', `[notice]a${NBSP}|[/notice]`],
    ['past an inline closer', '[b]a[/b]|', ' ', `[b]a[/b]${NBSP}|`],
    ['a word follows through an inline tag', 'a|[b]b[/b]', ' ', 'a |[b]b[/b]'],
  ])('%s', (_, text, key, expected) => {
    expect(typed(text, key)).toBe(expected)
  })

  it('goes back to a plain space when a word follows it', () => {
    expect(typed(`a${NBSP}|`, 'b')).toBe('a b|')
  })

  it('keeps one that really separates nothing visible', () => {
    expect(typed(`a ${NBSP}|`, 'b')).toBe(`a ${NBSP}b|`)
  })

  it('leaves raw content as typed', () => {
    expect(typed('[code]a|[/code]', ' ')).toBe('[code]a |[/code]')
  })
})

describe('Enter', () => {
  it.each([
    ['a|', 'a\n|'],
    ['a\n|', 'a\n\n|'],
    ['|', '\n|'],
    ['a|b', 'a\n|b'],
    ['«todo»', '\n|'],
    ['a«b»c', 'a\n|c'],
    ['a«b\nc»d', 'a\n|d'],
    ['[b]a«b[/b]c»d', '[b]a\n|[/b]d'],
  ])('%j → %j', (text, expected) => {
    expect(enter(text)).toBe(expected)
  })

  it('keeps visible the spaces it leaves on a line\'s edge', () => {
    expect(enter('a| b')).toBe(`a\n|${NBSP}b`)
    expect(enter('a |b')).toBe(`a${NBSP}\n|b`)
    expect(enter('a«x» b')).toBe(`a\n|${NBSP}b`)
  })

  it('leaves spaces in raw content alone', () => {
    expect(enter('[code]a| b[/code]')).toBe('[code]a\n| b[/code]')
  })

  it('is the canvas\' concern: a text editor shows every space', () => {
    expect(run('a| b', (s, sel) => insertLineBreak(parse(s), s, sel))).toBe('a\n| b')
  })
})

describe('deleting what the browser marked', () => {
  it.each([
    ['one character', 'a«b»c', 'a|c'],
    ['a line break', 'a«\n»b', 'a|b'],
    ['a blank line', 'a\n«\n»b', 'a\n|b'],
    ['across lines', 'a«b\nc»d', 'a|d'],
    ['the last letter of a format takes the format', 'a[b]«x»[/b]c', 'a|c'],
    ['the last letter of nested formats takes them all', 'a[b][i]«x»[/i][/b]c', 'a|c'],
    ['the whole colorizer tag empties the document', '[gradient=#000,#fff]«x»[/gradient]', '|'],
    ['part of a format leaves it', '[b]«x»y[/b]', '[b]|y[/b]'],
    ['a block keeps its tags', '[notice]«x»[/notice]', '[notice]|[/notice]'],
  ])('%s', (_, text, expected) => {
    expect(deleted(text)).toBe(expected)
  })

  it('keeps visible a space it leaves on a line\'s edge', () => {
    expect(deleted('a «b»')).toBe(`a${NBSP}|`)
    expect(deleted('a «b» c')).toBe(`a${NBSP}| c`)
    expect(deleted('«a» b')).toBe(`|${NBSP}b`)
  })
})

describe('the document\'s text as a coordinate', () => {
  const round = (source: string) => {
    const root = parse(source)
    for (let at = 0; at <= source.length; at++) {
      const text = textOffsetOfSource(root, at)
      expect(textOffsetOfSource(root, sourceOffsetOfText(root, text))).toBe(text)
    }
  }

  it('round-trips through tags and newlines', () => {
    round('a\n\nb')
    round('[gradient=#000,#fff]a\n\nb\n[/gradient]')
    round('[b][i]uno[/i]\n[/b]dos\n')
  })

  it('keeps a line\'s start apart from the end of the line above', () => {
    const before = parse('[gradient=#000,#fff]a\nb[/gradient]')
    const after = parse('[gradient=#111,#222,#333]a\nb[/gradient]')
    const start = '[gradient=#000,#fff]a\n'.length
    expect(sourceOffsetOfText(after, textOffsetOfSource(before, start))).toBe('[gradient=#111,#222,#333]a\n'.length)
  })

  it('lands inside a tag that opens the line, so the caret stays on that line', () => {
    const root = parse('a\n[b]b[/b]')
    expect(sourceOffsetOfText(root, 2)).toBe('a\n[b]'.length)
  })
})

describe('terminalLines', () => {
  const painted = (source: string, dialect: 'miliastry' | 'osu' | 'lyne' = 'miliastry') => {
    const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
    return new HTMLRenderer({ dialect, terminalLines: true, idMode: 'none' }).render(root)
  }
  const TAIL = '<span data-bb-tail><br><br></span>'

  it.each([
    ['a\n', `<span class="bb-paragraph">a</span>${TAIL}`],
    ['a\n\n', `<span class="bb-paragraph">a</span><br>${TAIL}`],
    ['\n', TAIL],
  ])('%j paints its last line', (source, html) => {
    expect(painted(source)).toBe(html)
  })

  it('crosses inline tags: the flow ends past them', () => {
    expect(painted('[b]a\n[/b]')).toContain(`<strong>a${TAIL}</strong>`)
    expect(painted('[b]a\n[/b]b')).not.toContain('data-bb-tail')
    expect(painted('[b]a\n[/b]\n')).toContain(`<strong>a<br></strong></span>${TAIL}`)
  })

  it('paints nothing in the middle of a text, or where a block follows', () => {
    expect(painted('a\nb')).not.toContain('data-bb-tail')
    expect(painted('a\n[notice]b[/notice]')).not.toContain('data-bb-tail')
  })

  it('leaves swallowed newlines to the caret', () => {
    expect(painted('[notice]a\n[/notice]')).not.toContain('data-bb-tail')
  })

  it('paints it inside an inline tag even with a swallowed newline past the closer', () => {
    expect(painted('[box=T]\n[i]a\n[/i]\n[/box]')).toContain(`<em>a${TAIL}</em>`)
  })

  it('reaches an effect painted a letter at a time', () => {
    expect(painted('[rainbow]a\n[/rainbow]')).toContain(TAIL)
  })
})
