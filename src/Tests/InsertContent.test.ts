import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { insertContent, isBlockContent } from '../Commands/InsertContent'
import type { TextChange } from '../Incremental/ChangeTracker'
import { REFERENCE_DOCUMENT } from './referenceDocument'

/**
 * Pasting and inserting (`Commands/InsertContent.ts`): at the caret, unless
 * that place cannot hold the content. Every row of the module's table is a
 * case here. `|` marks the caret (and where it lands after), `«…»` a range.
 */

type Dialect = 'miliastry' | 'osu'
const parser = (dialect: Dialect) => (source: string) => new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!

function marked(input: string) {
  const bar = input.indexOf('|')
  if (bar !== -1) return { source: input.replace('|', ''), start: bar, end: bar }
  const start = input.indexOf('«')
  const end = input.indexOf('»') - 1
  return { source: input.replace('«', '').replace('»', ''), start, end }
}

function apply(source: string, changes: TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

function paste(input: string, content: string, dialect: Dialect = 'miliastry'): string {
  const parse = parser(dialect)
  const { source, start, end } = marked(input)
  const edit = insertContent(parse(source), source, { start, end }, content, parse)!
  const out = apply(source, edit.changes)
  return out.slice(0, edit.selection.start) + '|' + out.slice(edit.selection.start)
}

const NOTICE = '[notice]aviso[/notice]'

describe('what counts as a block', () => {
  it.each([
    [NOTICE, true], ['[box=T]x[/box]', true], ['[list][*]a[/list]', true], ['[centre]x[/centre]', true],
    ['[b]hola[/b]', false], ['texto\nen dos líneas', false], ['[color=red]x[/color] y', false],
  ])('%j → %j', (content, block) => {
    expect(isBlockContent(content, parser('miliastry'))).toBe(block)
  })
})

describe.each(['miliastry', 'osu'] as Dialect[])('insertContent (%s)', (dialect) => {
  it.each([
    // The caret is the intent: in the middle of a paragraph, in the middle.
    ['Hola | mundo', NOTICE, `Hola ${NOTICE}| mundo`],
    ['Hola | mundo', '[b]pegado[/b]', 'Hola [b]pegado[/b]| mundo'],
    // Inside a box, a notice, a list item: inside.
    ['[box=T]\n  Pri|mera\n[/box]', NOTICE, `[box=T]\n  Pri${NOTICE}|mera\n[/box]`],
    ['[list]\n[*]un|o\n[/list]', NOTICE, `[list]\n[*]un${NOTICE}|o\n[/list]`],
    // In an inline tag, inline content stays; a block goes to the end of the line, outside every inline tag.
    ['[b]Neg|rita[/b] y más\nsiguiente', '[i]x[/i]', '[b]Neg[i]x[/i]|rita[/b] y más\nsiguiente'],
    ['[b]Neg|rita[/b] y más\nsiguiente', NOTICE, `[b]Negrita[/b] y más${NOTICE}|\nsiguiente`],
    ['[b][i]mu|ndo[/i][/b] y más', NOTICE, `[b][i]mundo[/i][/b] y más${NOTICE}|`],
    // …and inside a box, that line's end is still inside the box.
    ['[box=T]\n  [b]Pri|mera[/b] línea\n  Segunda\n[/box]', NOTICE, `[box=T]\n  [b]Primera[/b] línea${NOTICE}|\n  Segunda\n[/box]`],
    // A heading holds one line: the block goes right after it.
    ['[heading]Tí|tulo[/heading]\nx', NOTICE, `[heading]Título[/heading]${NOTICE}|\nx`],
    // A box's heading: into the first line of that box's content.
    ['[box=Mi Ca|ja]\n  Primera\n[/box]', NOTICE, `[box=Mi Caja]\n${NOTICE}|\n  Primera\n[/box]`],
    ['[box=Mi Ca|ja]Primera[/box]', NOTICE, `[box=Mi Caja]\n${NOTICE}|\nPrimera[/box]`],
    ['[box=Mi Ca|ja]\n  Primera\n[/box]', 'Nueva', '[box=Mi CaNueva|ja]\n  Primera\n[/box]'],
    // In [code], everything is literal, at the caret.
    ['[code]a|b[/code]', NOTICE, `[code]a${NOTICE}|b[/code]`],
  ])('%j + %j → %j', (input, content, expected) => {
    expect(paste(input, content, dialect)).toBe(expected)
  })

  it('a selection is replaced, and no tag it cut is left orphaned', () => {
    expect(paste('Hola «mun»do', 'X', dialect)).toBe('Hola X|do')
    expect(paste('[b]Neg«rita[/b] y lu»ego', 'X', dialect)).toBe('[b]NegX|[/b]ego')
  })

  it('the whole document selected and typed over becomes what was typed', () => {
    const source = '[b]Hola[/b]\n\n[box=T]\n  x\n[/box]'
    expect(paste(`«${source}»`, 'Nuevo', dialect)).toBe('Nuevo|')
  })
})

describe('insertContent — any caret, on a real document', () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it.each(['miliastry', 'osu'] as Dialect[])('%s: the pasted text is all there, and everything else is untouched', (dialect) => {
    const parse = parser(dialect)
    const visible = (source: string) => {
      const probe = document.createElement('div')
      probe.innerHTML = new HTMLRenderer({ dialect }).render(parse(source))
      return (probe.textContent ?? '').replace(/\s+/g, '')
    }
    const SOURCE = REFERENCE_DOCUMENT
    const before = visible(SOURCE)
    const rand = mulberry32(5)
    let tried = 0
    for (let i = 0; i < 150; i++) {
      const at = Math.floor(rand() * SOURCE.length)
      const leaf = parse(SOURCE).findNodeAtOffset(at)
      if (!leaf || leaf.kind !== 'text') continue
      const content = i % 2 ? NOTICE : '[b]pegado[/b]'
      const edit = insertContent(parse(SOURCE), SOURCE, { start: at, end: at }, content, parse)!
      // One pure insertion: nothing of the author's source is rewritten.
      expect(edit.changes).toHaveLength(1)
      expect(edit.changes[0].end - edit.changes[0].start).toBe(0)
      const after = apply(SOURCE, edit.changes)
      // Every character that was visible still is, plus the pasted text.
      const shown = visible(after)
      const added = content === NOTICE ? 'aviso' : 'pegado'
      expect(shown.length, `${content} at ${at}`).toBe(before.length + added.length)
      expect(shown.replace(added, ''), `${content} at ${at}`).toBe(before)
      tried++
    }
    expect(tried).toBeGreaterThan(50)
  })
})
