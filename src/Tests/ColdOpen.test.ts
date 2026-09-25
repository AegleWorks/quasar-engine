import { describe, it, expect } from 'vitest'
import { scanBBCode, createBBCodeScanner } from '../Lexer/BBCodeLexer'
import { parseTokensToGreen } from '../BBCode/Parser'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { RedNode, NO_DIAGNOSTICS, NO_METADATA } from '../Syntax/RedNode'
import { REFERENCE_DOCUMENT } from './referenceDocument'

/**
 * What opening a document cheaper must not change (docs/12, "Opening a
 * document"): the lexer's native fast paths answer exactly what its char
 * loops did, the streamed tokens build the same tree as the array, and the
 * red node's lazily made `range` and `id` behave as the eager ones did.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Bracket soup: tags, stray brackets, nesting in attributes, newlines, raw blocks. */
function soup(rand: () => number, length: number): string {
  const bits = ['[', ']', '[/', 'b]', '[b]', '[/b]', '[color=red]', '[/color]', '[box=[b]t[/b]]', '[/box]',
    '[x y]', '[ ]', 'hola ', '\n', '\r\n', '[code]', '[/code]', '[c]', '=', '[*]', 'ab']
  let out = ''
  while (out.length < length) out += bits[Math.floor(rand() * bits.length)]
  return out
}

/** The char loop `findMatchingBracket` replaced its common case with. */
function matchByScan(source: string, from: number): number {
  let depth = 0
  for (let j = from + 1; j < source.length; j++) {
    const c = source.charCodeAt(j)
    if (c === 91) depth++
    else if (c === 93) {
      if (depth === 0) return j
      depth--
    }
  }
  return -1
}

describe('opening a document — what the cheaper path must keep', () => {
  it('every opening tag ends at the `]` the char loop pairs its `[` with, and text runs stop where it did', () => {
    const rand = mulberry32(2026)
    for (let doc = 0; doc < 300; doc++) {
      const source = soup(rand, 200 + Math.floor(rand() * 600))
      const tokens = scanBBCode(source)
      let at = 0
      let rawContent = false
      for (const t of tokens) {
        // The text right after a raw opener is literal content (`[code]…`).
        const inRaw = rawContent
        rawContent = t.kind === 'open' && (t.tag === 'code' || t.tag === 'c')
        // Contiguous cover of the source, in order.
        expect(t.start, `doc ${doc}`).toBe(at)
        at = t.end
        if (t.kind === 'open') expect(t.end - 1, `doc ${doc} open @${t.start}`).toBe(matchByScan(source, t.start))
        if (t.kind === 'text' && t.value === '[' && source[t.start + 1] !== '/') {
          // A bare `[` that is not a failed closer had no `]` to pair with —
          // or one whose tag was invalid; either way the scan agrees on which.
          const m = matchByScan(source, t.start)
          if (m !== -1) expect(/^\[[a-zA-Z0-9_*-]+/.test(source.slice(t.start, m)), `doc ${doc} bare @${t.start}`).toBe(false)
        }
        if (t.kind === 'text' && !inRaw && t.value.length > 1 && t.value[0] !== '[') {
          // Plain text runs to the next `[`, `\n` or `\r` — never past, never short.
          expect(/[[\r\n]/.test(t.value), `doc ${doc} text @${t.start}`).toBe(false)
          const next = source[t.end]
          if (t.end < source.length) expect(next === '[' || next === '\n' || next === '\r', `doc ${doc} text end @${t.end}`).toBe(true)
        }
      }
      expect(at).toBe(source.length)
    }
  })

  it('a run of unmatched brackets stays linear', () => {
    // Each `[` asks for a `]`; without the sticky "none left" answer every one
    // would search the rest of the text again — seconds here, not milliseconds.
    const source = 'x'.repeat(10) + '['.repeat(600_000)
    const t0 = performance.now()
    expect(scanBBCode(source).length).toBe(600_001)
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('tokens streamed from the scanner build the same tree as the collected array', () => {
    const rand = mulberry32(7)
    const docs = [REFERENCE_DOCUMENT, ...Array.from({ length: 40 }, () => soup(rand, 3000))]
    for (const source of docs) {
      for (const pairing of ['quasar', 'osu'] as const) {
        const fromArray = parseTokensToGreen(scanBBCode(source, { pairing }), source, { pairing })
        const fromCursor = parseTokensToGreen(createBBCodeScanner(source, { pairing }), source, { pairing })
        expect(fromCursor._hash).toBe(fromArray._hash)
        expect(fromCursor.width).toBe(source.length)
      }
    }
  })

  it('a red node makes its `range` on first read, and a range already handed out follows shifts', () => {
    const model = new BBCodeDocumentModel({ source: 'uno\n\n[b]dos[/b] tres\n\n[i]cuatro[/i]', autoAnalyze: false })
    const last = model.redRoot!.children[model.redRoot!.children.length - 1]
    const held = last.range
    expect(last.range).toBe(held)
    const before = { ...held }
    last.setStart(before.start + 7)
    expect(last.range).toBe(held)
    expect(held).toEqual({ start: before.start + 7, end: before.end + 7 })
    expect(last.innerStart).toBe(held.start + last.green.leadingWidth)
    expect(last.innerEnd).toBe(held.end - last.green.trailingWidth)
  })

  it('ids are minted on first read, unique, and stable once read', () => {
    const model = new BBCodeDocumentModel({ source: REFERENCE_DOCUMENT, autoAnalyze: false })
    const seen = new Set<string>()
    const walk = (n: RedNode): void => { seen.add(n.id); n.children.forEach(walk) }
    walk(model.redRoot!)
    const count = seen.size
    seen.clear()
    walk(model.redRoot!)
    expect(seen.size).toBe(count)
    const first = model.redRoot!.children[0]
    expect(first.id).toBe(first.id)
  })

  it('shared empties are frozen, and the writers take their own copy first', () => {
    const model = new BBCodeDocumentModel({ source: 'hola [b]mundo[/b]', autoAnalyze: false })
    const leaf = model.redRoot!.children[0].children[0]
    expect(leaf.diagnostics).toBe(NO_DIAGNOSTICS)
    expect(leaf.metadata).toBe(NO_METADATA)
    expect(Object.isFrozen(NO_DIAGNOSTICS) && Object.isFrozen(NO_METADATA)).toBe(true)
    expect(() => { (leaf.metadata as Record<string, unknown>).x = 1 }).toThrow()
    leaf.ownDiagnostics().push({ code: 'X', message: 'm', severity: 'info', range: { start: 0, end: 1 } } as never)
    expect(leaf.diagnostics).not.toBe(NO_DIAGNOSTICS)
    expect(NO_DIAGNOSTICS.length).toBe(0)
    RedNode.allowMutation(() => leaf.appendChild(new RedNode(leaf.green)))
    expect(leaf.children.length).toBe(1)
    expect(model.redRoot!.children[0].children[1].children.length).toBe(1)
  })
})
