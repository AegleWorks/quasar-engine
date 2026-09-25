import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { insertLineBreak, joinBackward, joinForward, deleteSelection } from '../Commands/StructuralEdits'
import type { FormatEdit } from '../Commands/InlineFormat'
import type { TextChange } from '../Incremental/ChangeTracker'
import { REFERENCE_DOCUMENT } from './referenceDocument'

/**
 * Enter, Backspace and Delete as text edits (`Commands/StructuralEdits.ts`).
 * Cases mark the caret with `|` and a range with `«…»`; the result shows
 * where the caret lands with `|` too.
 */

type Cmd = (root: any, source: string, sel: { start: number; end: number }) => FormatEdit | null

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

function run(cmd: Cmd, input: string, dialect: 'miliastry' | 'osu' = 'miliastry'): string | null {
  const { source, start, end } = marked(input)
  const root = new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
  const edit = cmd(root, source, { start, end })
  if (!edit) return null
  const out = apply(source, edit.changes)
  return out.slice(0, edit.selection.start) + '|' + out.slice(edit.selection.start)
}

describe('insertLineBreak (Enter)', () => {
  it.each([
    ['pá|rrafo', 'pá\n|rrafo'],
    ['línea|\n\nsiguiente', 'línea\n|\n\nsiguiente'],
    ['[b]Negr|ita[/b]', '[b]Negr\n|ita[/b]'],
    ['[box=T]\n  Primera|\n  Segunda\n[/box]', '[box=T]\n  Primera\n|\n  Segunda\n[/box]'],
    ['[notice]un |aviso[/notice]', '[notice]un \n|aviso[/notice]'],
    // At a block's edge one `\n` is swallowed as layout: it takes two to show a line.
    ['[notice]|aviso[/notice]', '[notice]\n\n|aviso[/notice]'],
    ['[notice]aviso|[/notice]', '[notice]aviso\n|\n[/notice]'],
    // Inside an inline format there is no swallowed edge.
    ['[b]|Negrita[/b]', '[b]\n|Negrita[/b]'],
    // A list item: the next [*], spelled as the item's own.
    ['[list]\n[*]uno|\n[*]dos\n[/list]', '[list]\n[*]uno\n[*]|\n[*]dos\n[/list]'],
    ['[list]\n[*]u|no\n[/list]', '[list]\n[*]u\n[*]|no\n[/list]'],
    // An empty last item: out of the list.
    ['[list]\n[*]uno\n[*]|\n[/list]\nfin', '[list]\n[*]uno\n[/list]\n|\nfin'],
    // A heading holds one line.
    ['[heading]Título|[/heading]\nx', '[heading]Título[/heading]\n|\nx'],
    ['[heading]Tí|tulo[/heading]', '[heading]Tí[/heading]\n[heading]|tulo[/heading]'],
    ['[heading]|Título[/heading]', '\n[heading]|Título[/heading]'],
  ])('%j → %j', (input, expected) => {
    expect(run(insertLineBreak, input)).toBe(expected)
  })

  it('declines a range (the caller deletes it first)', () => {
    expect(run(insertLineBreak, 'a«b»c')).toBeNull()
  })
})

describe('joinBackward (Backspace) and joinForward (Delete)', () => {
  it.each([
    ['uno\n|dos', 'uno|dos'],
    ['uno\n\n|dos', 'uno\n|dos'],
    ['[box=T]\n  Primera\n|  Segunda\n[/box]', '[box=T]\n  Primera|  Segunda\n[/box]'],
    ['[list]\n[*]uno\n[*]|dos\n[/list]', '[list]\n[*]uno|dos\n[/list]'],
  ])('Backspace %j → %j', (input, expected) => {
    expect(run(joinBackward, input)).toBe(expected)
  })

  it('indentation is not text on the canvas: after it, the caret is at the line\'s start', () => {
    expect(run(joinBackward, 'uno\n  |dos')).toBe('uno  |dos')
    expect(run(joinBackward, '[box=T]\n  |Primera\n[/box]')).toBe('[box=T]\n  |Primera\n[/box]')
  })

  it('leaves a container\'s own edge newline alone: it is the author\'s layout', () => {
    expect(run(joinBackward, '[box=T]\n|  Primera\n[/box]')).toBe('[box=T]\n|  Primera\n[/box]')
    expect(run(joinForward, '[box=T]\n  Primera|\n[/box]')).toBe('[box=T]\n  Primera|\n[/box]')
  })

  it('declines inside a line: deleting a character is ordinary typing', () => {
    expect(run(joinBackward, 'ab|c')).toBeNull()
    expect(run(joinForward, 'a|bc')).toBeNull()
    // The first item has nothing to join with; the browser turns it into text.
    expect(run(joinBackward, '[list]\n[*]|uno\n[/list]')).toBeNull()
  })

  it.each([
    ['uno|\ndos', 'uno|dos'],
    ['[list]\n[*]uno|\n[*]dos\n[/list]', '[list]\n[*]uno|dos\n[/list]'],
  ])('Delete %j → %j', (input, expected) => {
    expect(run(joinForward, input)).toBe(expected)
  })
})

describe('deleteSelection', () => {
  it.each([
    ['a«bc»d', 'a|d'],
    // Cutting into a [b]: its opener stays, so what is left stays bold.
    ['pá«rrafo.\n\n[b]Neg»rita[/b]', 'pá|[b]rita[/b]'],
    // Cutting out of a [b]: its closer stays.
    ['[b]Neg«rita[/b] y lu»ego', '[b]Neg|[/b]ego'],
    // A whole element inside the range goes with it.
    ['a«b [i]c[/i] d»e', 'a|e'],
    // From one list item into the next: they join.
    ['[list]\n[*]un«o\n[*]do»s\n[/list]', '[list]\n[*]un|s\n[/list]'],
  ])('%j → %j', (input, expected) => {
    expect(run(deleteSelection, input)).toBe(expected)
    expect(run(joinBackward, input)).toBe(expected)
  })
})

describe('structural edits — any caret, on a real document', () => {
  const SOURCE = REFERENCE_DOCUMENT

  function mulberry32(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it.each(['miliastry', 'osu'] as const)('%s: Enter keeps every visible character, Backspace after it gives the source back, and a deletion leaves no orphan tag', (dialect) => {
    const parse = (source: string) => new BBCodeDocumentModel({ source, dialect, autoAnalyze: false }).redRoot!
    const visible = (source: string) => {
      const probe = document.createElement('div')
      probe.innerHTML = new HTMLRenderer({ dialect }).render(parse(source))
      return (probe.textContent ?? '').replace(/\s+/g, '')
    }
    const brackets = (text: string) => (text.match(/[[\]]/g) ?? []).length
    const before = visible(SOURCE)
    const rand = mulberry32(11)
    let roundTrips = 0
    for (let i = 0; i < 200; i++) {
      // A caret on text: offsets inside tags are never where a canvas puts one.
      const at = Math.floor(rand() * SOURCE.length)
      const leaf = parse(SOURCE).findNodeAtOffset(at)
      if (!leaf || leaf.kind !== 'text') continue

      const enter = insertLineBreak(parse(SOURCE), SOURCE, { start: at, end: at })!
      const broken = apply(SOURCE, enter.changes)
      expect(visible(broken), `Enter at ${at}`).toBe(before)

      const back = joinBackward(parse(broken), broken, enter.selection)
      if (back && enter.changes.length === 1 && enter.changes[0].text === '\n') {
        expect(apply(broken, back.changes), `Enter+Backspace at ${at}`).toBe(SOURCE)
        roundTrips++
      }

      const end = Math.min(SOURCE.length, at + 1 + Math.floor(rand() * 150))
      const del = deleteSelection(parse(SOURCE), SOURCE, { start: at, end })
      if (del) expect(brackets(visible(apply(SOURCE, del.changes))), `delete ${at}-${end}`).toBeLessThanOrEqual(brackets(before))
    }
    expect(roundTrips).toBeGreaterThan(50)
  })
})
