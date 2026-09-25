import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { REFERENCE_DOCUMENT } from './referenceDocument'
import { toggleInlineFormat, applyColor, type ToggleFormat, type FormatEdit } from '../Commands/InlineFormat'
import type { TextChange } from '../Incremental/ChangeTracker'

/**
 * Toolbar formatting as text edits (`Commands/InlineFormat.ts`): the minimal
 * changes, always well nested, the author's spelling kept everywhere else.
 *
 * Cases are written with the selection marked: `«…»` a range, `|` a caret.
 */

function marked(input: string): { source: string; start: number; end: number } {
  const caret = input.indexOf('|')
  if (caret !== -1) return { source: input.replace('|', ''), start: caret, end: caret }
  const start = input.indexOf('«')
  const end = input.indexOf('»') - 1
  return { source: input.replace('«', '').replace('»', ''), start, end }
}

function apply(source: string, changes: TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

function run(input: string, act: (root: any, source: string, sel: { start: number; end: number }) => FormatEdit | null) {
  const { source, start, end } = marked(input)
  const root = new BBCodeDocumentModel({ source, autoAnalyze: false }).redRoot!
  const edit = act(root, source, { start, end })
  if (!edit) return null
  const result = apply(source, edit.changes)
  return { result, selected: result.slice(edit.selection.start, edit.selection.end), action: edit.action }
}

const toggle = (input: string, format: ToggleFormat = 'bold') =>
  run(input, (root, source, sel) => toggleInlineFormat(root, source, sel, format))

describe('toggleInlineFormat — on', () => {
  it.each([
    ['Hola «mundo» cruel', 'Hola [b]mundo[/b] cruel', 'mundo'],
    ['«Hola» mundo', '[b]Hola[/b] mundo', 'Hola'],
    // A selection hugging a whole element takes it in as a unit.
    ['a «x [i]y[/i] z» b', 'a [b]x [i]y[/i] z[/b] b', 'x [i]y[/i] z'],
    // Cut by an [i] boundary: one wrapper per side, never crossed tags.
    ['«x [i]y»y[/i] z', '[b]x [/b][i][b]y[/b]y[/i] z', 'x [/b][i][b]y'],
    // A line break ends the run; each line gets its own wrapper.
    ['«uno\ndos»', '[b]uno[/b]\n[b]dos[/b]', 'uno[/b]\n[b]dos'],
    // Inside a box: only the text, never the box's own markup.
    ['[box=T]\n«Primera»\n[/box]', '[box=T]\n[b]Primera[/b]\n[/box]', 'Primera'],
    // Partly bold already: the inner [b] merges into the new one.
    ['«a [b]b[/b] c»', '[b]a b c[/b]', 'a b c'],
  ])('%j → %j', (input, expected, selected) => {
    const r = toggle(input)!
    expect(r.result).toBe(expected)
    expect(r.selected).toBe(selected)
    expect(r.action).toBe('wrap')
  })

  it('a caret inside a word applies to that word', () => {
    expect(toggle('Hola mun|do cruel')!.result).toBe('Hola [b]mundo[/b] cruel')
    expect(toggle('[b]Neg|rita[/b] y')!.result).toBe('Negrita y')
  })

  it('a caret at the edge of a word, or between words, answers null (the caller decides)', () => {
    // "hola|" + Bold means "what I type next": not the word behind the caret.
    expect(toggle('Hola mundo| cruel')).toBeNull()
    expect(toggle('Hola |mundo')).toBeNull()
    expect(toggle('Hola  | cruel')).toBeNull()
  })

  it('each format has its tag', () => {
    expect(toggle('«x»', 'italic')!.result).toBe('[i]x[/i]')
    expect(toggle('«x»', 'underline')!.result).toBe('[u]x[/u]')
    expect(toggle('«x»', 'strikethrough')!.result).toBe('[s]x[/s]')
  })
})

describe('toggleInlineFormat — off', () => {
  it.each([
    // The whole content: just the two tags go.
    ['[b]«Negrita»[/b] y', 'Negrita y', 'Negrita'],
    // Part of it: split, with the author's spelling of the tag.
    ['[B]«Neg»rita[/B]', 'Neg[B]rita[/B]', 'Neg'],
    ['[B]Ne«g»rita[/B]', '[B]Ne[/B]g[B]rita[/B]', 'g'],
    // Nested: the [i] stays, the bold is wrapped back inside it.
    ['[b][i]a«b»c[/i][/b]', '[i][b]a[/b]b[b]c[/b][/i]', 'b'],
    // A selection hugging the whole element from outside.
    ['x «[b]y[/b]» z', 'x y z', 'y'],
  ])('%j → %j', (input, expected, selected) => {
    const r = toggle(input)!
    expect(r.result).toBe(expected)
    expect(r.selected).toBe(selected)
    expect(r.action).toBe('unwrap')
  })

  it('on then off gives back the source', () => {
    const source = 'Hola mundo, [color=#ABCDEF]esto[/color] se queda.'
    const on = toggle(`Hola «mundo», [color=#ABCDEF]esto[/color] se queda.`)!
    expect(on.result).toBe('Hola [b]mundo[/b], [color=#ABCDEF]esto[/color] se queda.')
    const at = on.result.indexOf('mundo')
    const off = toggle(on.result.slice(0, at) + '«mundo»' + on.result.slice(at + 5))!
    expect(off.result).toBe(source)
  })
})

describe('applyColor', () => {
  const color = (input: string, hex = '#f472b6') => run(input, (root, source, sel) => applyColor(root, source, sel, hex))

  it('wraps a plain selection', () => {
    expect(color('Hola «mundo»')!.result).toBe('Hola [color=#f472b6]mundo[/color]')
  })

  it('recolors a [color] whose content is exactly the selection, keeping its spelling', () => {
    const r = color('[COLOR="#ABCDEF"]«texto»[/COLOR]')!
    expect(r.result).toBe('[COLOR="#f472b6"]texto[/COLOR]')
    expect(r.action).toBe('recolor')
  })

  it('drops a [color] lying wholly inside the selection', () => {
    expect(color('«a [color=red]b[/color] c»')!.result).toBe('[color=#f472b6]a b c[/color]')
  })

  it('nests inside a [color] it only partly covers', () => {
    expect(color('[color=red]a«b»c[/color]')!.result).toBe('[color=red]a[color=#f472b6]b[/color]c[/color]')
  })
})

describe('toggleInlineFormat — any selection, on a real document', () => {
  // Stray brackets, a rich box title, lists, nested size/bold: the reference profile.
  const SOURCE = REFERENCE_DOCUMENT

  const visible = (source: string, dialect: 'miliastry' | 'osu') => {
    const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
    const probe = document.createElement('div')
    probe.innerHTML = new HTMLRenderer({ dialect }).render(root)
    return (probe.textContent ?? '').replace(/\s+/g, '')
  }

  function mulberry32(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it.each(['miliastry', 'osu'] as const)('%s: never changes the text a reader sees, and ON then OFF on its own selection keeps it too', (dialect) => {
    const parse = (source: string) => new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
    const rand = mulberry32(7)
    const before = visible(SOURCE, dialect)
    const formats: ToggleFormat[] = ['bold', 'italic', 'underline', 'strikethrough']
    let tried = 0
    for (let i = 0; i < 300; i++) {
      const a = Math.floor(rand() * SOURCE.length)
      const b = Math.min(SOURCE.length, a + Math.floor(rand() * 120))
      const format = formats[i % formats.length]
      const root = parse(SOURCE)
      const edit = toggleInlineFormat(root, SOURCE, { start: a, end: b }, format)
      if (!edit) continue
      tried++
      const once = apply(SOURCE, edit.changes)
      expect(visible(once, dialect), `${format} ${a}-${b}`).toBe(before)

      const again = toggleInlineFormat(parse(once), once, edit.selection, format)!
      expect(again, `${format} ${a}-${b} again`).not.toBeNull()
      expect(again.action).toBe(edit.action === 'wrap' ? 'unwrap' : 'wrap')
      expect(visible(apply(once, again.changes), dialect), `${format} ${a}-${b} twice`).toBe(before)
    }
    expect(tried).toBeGreaterThan(200)
  })
})
