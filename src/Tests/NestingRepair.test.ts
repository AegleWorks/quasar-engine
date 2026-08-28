import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { repairNesting } from '../Repair/NestingRepair'

/**
 * `repairNesting` on real and synthetic damage.
 *
 * The contract it has to keep, in order of how much a user would care:
 *
 *  1. what the reader sees is what osu! shows;
 *  2. every byte the author wrote elsewhere survives untouched;
 *  3. running it twice does nothing the second time.
 */

const DOCS = join(__dirname, '../../../../docs/ai')
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), 'g')

const parse = (source: string) => new BBCodeDocumentModel({ source }).redRoot!
const repair = (source: string) => repairNesting(source, parse(source))

const render = (source: string): string =>
  new HTMLRenderer().render(parse(source)).replace(/ data-node-id="[^"]*"/g, '')

const visibleText = (source: string): string =>
  render(source).replace(/<[^>]+>/g, '\n').replace(ZERO_WIDTH, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')

/**
 * What is still damaged, according to the parser.
 *
 * Counting brackets with a regex is not good enough on real documents: a title
 * like `[box=[b]contest[/b]]` puts tags inside an attribute, and any scanner
 * that walks delimiters miscounts it. The parse tree is the authority.
 */
const stillDamaged = (source: string) => {
  const r = repair(source)
  return { orphans: r.orphans.length, unclosed: r.unclosed.length }
}

describe('repairNesting', () => {
  it('writes in the closer an unclosed tag never got', () => {
    const r = repair('[b]hola')
    expect(r.source).toBe('[b]hola[/b]')
    expect(r.unclosed.map(u => u.tag)).toEqual(['b'])
    expect(r.orphans).toEqual([])
  })

  it('closes a whole stack of unclosed tags, innermost first', () => {
    expect(repair('[centre][size=150][color=#FF0000]hola').source)
      .toBe('[centre][size=150][color=#FF0000]hola[/color][/size][/centre]')
  })

  it('deletes a closing tag that never had an opener', () => {
    const r = repair('hola [/box] mundo')
    expect(r.source).toBe('hola  mundo')
    expect(r.orphans.map(o => o.tag)).toEqual(['box'])
  })

  it('resolves a crossed pair by closing the inner tag where it really ended', () => {
    // `[i]` was auto-closed at the `[/b]`, so its closer is written in there;
    // the trailing `[/i]` had nothing left to close and goes.
    const r = repair('[b][i]x[/b][/i]')
    expect(r.source).toBe('[b][i]x[/i][/b]')
    expect(stillDamaged(r.source)).toEqual({ orphans: 0, unclosed: 0 })
  })

  it('drops a closer that repeats one already matched', () => {
    expect(repair('[box=T]a[/box][/box]').source).toBe('[box=T]a[/box]')
  })

  it('leaves well-formed BBCode completely alone', () => {
    const clean = '[centre][color=#F472B6]x[/color][/centre]\n\n[box= T ]\n  y\n[/box]'
    const r = repair(clean)
    expect(r.hasChanges).toBe(false)
    expect(r.source).toBe(clean)
  })

  it('does not touch a closing tag written inside [code]', () => {
    const source = '[code]\n[/box] no es una etiqueta aqui\n[/code]'
    expect(repair(source).hasChanges).toBe(false)
  })

  it('keeps the author spelling of everything it did not repair', () => {
    const source = '[centre][color=#F472B6]A[/color]\n\n[box= Gift from ]\n  sangria\n[/box]'
    const r = repair(source)
    expect(r.source).toContain('[color=#F472B6]')
    expect(r.source).toContain('[box= Gift from ]')
    expect(r.source).toContain('\n  sangria\n')
    expect(stillDamaged(r.source)).toEqual({ orphans: 0, unclosed: 0 })
  })
})

describe('repairNesting on the real userpages', () => {
  const broken = readFileSync(join(DOCS, 'NyuPenyu'), 'utf8')
  const goal = readFileSync(join(DOCS, 'NyuPenyuGoal'), 'utf8')

  it('balances the worst document in the repo', () => {
    const r = repair(broken)
    expect(r.orphans.length).toBeGreaterThan(0)
    expect(stillDamaged(r.source)).toEqual({ orphans: 0, unclosed: 0 })
  })

  it('makes it read exactly like osu! shows it', () => {
    expect(visibleText(repair(broken).source)).toBe(visibleText(goal))
  })

  it('edits only the damage, never the surrounding bytes', () => {
    const r = repair(broken)
    // Every edit is either a deletion of a closing tag or an insertion of one.
    for (const edit of r.edits) {
      const removed = broken.slice(edit.start, edit.end)
      expect(removed === '' || /^\[\/[a-zA-Z][a-zA-Z0-9]*\]$/.test(removed)).toBe(true)
      expect(edit.text === '' || /^\[\/[a-zA-Z][a-zA-Z0-9]*\]$/.test(edit.text)).toBe(true)
    }
    // And what is left of the source, with the edited spans cut out, is untouched.
    const survives = (text: string) => r.source.includes(text)
    expect(survives('[notice][centre][size=100]how to actually pronounce my name')).toBe(true)
    expect(survives('[url=https://imgur.com/a/5K9sHJy]')).toBe(true)
  })

  it('is a fixed point', () => {
    const once = repair(broken).source
    expect(repair(once).hasChanges).toBe(false)
  })

  it('finds nothing to repair in an already clean document', () => {
    const clean = readFileSync(join(DOCS, 'hxovc.bbcode'), 'utf8')
    expect(repair(clean).hasChanges).toBe(false)
  })
})
