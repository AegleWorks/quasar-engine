import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mayHaveSameNameNesting } from '../Visitors/sameNameNestingGate'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

/**
 * The regex gate this scanner replaced, kept verbatim as the oracle. The
 * scanner must answer exactly what it answered for every input: a looser gate
 * only costs a re-parse, but a stricter one would skip a flatten osu! needs.
 */
const FLATTENABLE_TAG_RE = /\[(\/?)(b|i|u|s|strike|spoiler|heading|centre|left|right|color|size)(?:=[^\]]*)?\]/g

function regexGate(source: string): boolean {
  const depth = new Map<string, number>()
  for (const match of source.matchAll(FLATTENABLE_TAG_RE)) {
    const name = match[2] === 's' ? 'strike' : match[2]
    const open = depth.get(name) ?? 0
    if (match[1]) {
      if (open > 0) depth.set(name, open - 1)
    } else {
      if (open > 0) return true
      depth.set(name, 1)
    }
  }
  return false
}

/** mulberry32: deterministic, so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRAGMENTS = [
  '[', ']', '/', '=', ' ', '\n', 'x', 'B', '1', '#f00',
  'b', 'i', 'u', 's', 'strike', 'spoiler', 'heading', 'centre', 'left', 'right', 'color', 'size',
  'bold', 'sizes', 'box', 'quote',
  '[b]', '[/b]', '[s]', '[/s]', '[strike]', '[/strike]', '[color=#fff]', '[/color]',
  '[size=150]', '[/size]', '[centre]', '[/centre]', '[spoiler]', '[/spoiler]', '[B]', '[b ]', '[color=',
]

describe('mayHaveSameNameNesting', () => {
  it.each([
    ['', false],
    ['[b]x[/b]', false],
    ['[b][b]x[/b][/b]', true],
    ['[b]x[/b][b]y[/b]', false],
    ['[s][strike]x', true],
    ['[strike]a[/s][s]b', false],
    ['[color=#f00][color=#0f0]x', true],
    ['[color=[b]x][b]', false],
    ['[color=#f00', false],
    ['[B][B]', false],
    ['[b1][b1]', false],
    ['[/b][b][b]', true],
    ['[spoiler=x]a[spoiler]', true],
    ['[size=50]a[/size][size=50]b', false],
    ['[centre][notice][centre]', true],
  ])('%j → %s, like the regex gate', (source, expected) => {
    expect(regexGate(source)).toBe(expected)
    expect(mayHaveSameNameNesting(source)).toBe(expected)
  })

  it('agrees with the regex gate on 20 000 random documents', () => {
    const random = prng(0x5eed)
    for (let n = 0; n < 20_000; n++) {
      const parts: string[] = []
      const length = 1 + Math.floor(random() * 40)
      for (let k = 0; k < length; k++) parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)])
      const source = parts.join('')
      if (mayHaveSameNameNesting(source) !== regexGate(source)) {
        throw new Error(`gate disagrees with the regex on case ${n}: ${JSON.stringify(source)}`)
      }
    }
  })

  it('agrees with the regex gate on the osu! export of the 547 KB fixture', () => {
    const path = join(__dirname, '..', '..', '500KCharsTest')
    if (!existsSync(path)) return
    const model = new BBCodeDocumentModel({ source: readFileSync(path, 'utf8'), dialect: 'osu', autoAnalyze: false })
    const exported = new BBCodeExporter(model.tagRegistry, 'miliastry').export(model.redRoot!)
    expect(mayHaveSameNameNesting(exported)).toBe(regexGate(exported))
  })
})
