/**
 * Structural fuzz — the invariants a parser must not break on bad input.
 *
 * `Fuzzer.test.ts` fuzzes publishing (export idempotence, minifier safety);
 * the incremental suites fuzz the trees produced by edits. Neither asks the
 * questions a malformed document raises about the tree itself, which is what
 * this file does: for 4000 random strings built from the punctuation that
 * usually breaks a parser, in both dialects, assert that
 *
 *  - nothing throws (parse, analyze, render, export);
 *  - the green tree partitions the text exactly, leaf widths included;
 *  - the red tree satisfies every structural invariant;
 *  - `findNodeAtOffset` returns the deepest node containing the caret, or
 *    null — never an offset outside the node it names;
 *  - every diagnostic range is inside the document and well ordered.
 *
 * The generator is seeded and overridable (`QUASAR_FUZZ_SEED`), so a failure
 * is replayable and becomes a regression test.
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { checkPartition } from '../Syntax/partition'
import { checkRedTree } from '../Syntax/redTreeInvariants'
import type { RedNode } from '../Syntax/RedNode'

const SEED = Number(process.env.QUASAR_FUZZ_SEED ?? 0xa11d_17)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fragments chosen for the states they create, not for resembling prose:
 * balanced and unbalanced brackets, closers with no opener, attributes with
 * quotes and spaces, raw blocks, CR/LF mixes, a NUL and an astral character.
 */
const FRAGMENTS = [
  '[b]', '[/b]', '[i]', '[/i]', '[color=#f00]', '[/color]', '[size=50]', '[/size]',
  '[box=Title]', '[/box]', '[spoilerbox=[b]Hi[/b]]', '[/spoilerbox]', '[url=https://x.y]', '[/url]',
  '[img]https://x.y/a.png[/img]', '[code]', '[/code]', '[c]', '[/c]', '[quote=A]', '[/quote]',
  '[list]', '[/list]', '[*]', '[notice]', '[/notice]', '[heading]', '[/heading]',
  '[b', 'b]', '[', ']', '[/', '[=', '[]', '[/]', '[[b]]', '[b=]', '[color=]', '[/color=red]',
  'a', 'hello', ' ', '  ', '\n', '\n\n', '\r\n', '\r', '\t', '🎵', 'café', '\u0000',
  ']', '=', '"', "'", '[/BOX]', '[B]', '[/B]', '[box = [b]x[/b]]',
  '[style=x]', '[/style]', '[gradient=#f00,#00f]', '[/gradient]', '[br]', '[hr]',
]

describe('structure fuzz — malformed input', () => {
  const renderer = new HTMLRenderer({ dialect: 'miliastry', theme: 'osu' })
  const failures: string[] = []

  it(`keeps every invariant over 4000 random documents (seed ${SEED})`, () => {
    const rand = mulberry32(SEED)

    for (let iter = 0; iter < 4000; iter++) {
      const length = 1 + Math.floor(rand() * 14)
      let source = ''
      for (let i = 0; i < length; i++) source += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]

      for (const dialect of ['miliastry', 'osu'] as const) {
        const label = `${dialect} ${JSON.stringify(source)}`

        let model: BBCodeDocumentModel
        try {
          model = new BBCodeDocumentModel({
            source,
            dialect,
            pairing: dialect === 'osu' ? 'osu' : undefined,
            autoAnalyze: false,
          })
        } catch (error) {
          failures.push(`THROW parse ${label}: ${(error as Error).message}`)
          continue
        }

        const green = model.greenRoot!
        const partition = checkPartition(green, source.length, { checkLeafWidths: true })
        if (partition.length > 0) {
          failures.push(`PARTITION ${label}: ${partition[0].kind} ${partition[0].detail}`)
        }

        const root = model.redRoot!
        const invariants = checkRedTree(root, { source })
        if (invariants.length > 0) {
          failures.push(`RED ${label}: ${invariants[0].kind} ${invariants[0].detail}`)
        }

        checkCaretResolution(root, source.length, label, failures)

        let diagnostics
        try {
          diagnostics = model.analyze()
        } catch (error) {
          failures.push(`THROW analyze ${label}: ${(error as Error).message}`)
          continue
        }
        for (const diagnostic of diagnostics.diagnostics.items) {
          const range = diagnostic.range
          if (range && (range.start < 0 || range.end > source.length || range.start > range.end)) {
            failures.push(`DIAG range ${label}: ${diagnostic.code} ${range.start}..${range.end}`)
            break
          }
        }

        try {
          renderer.render(root)
        } catch (error) {
          failures.push(`THROW render ${label}: ${(error as Error).message}`)
        }
        try {
          new BBCodeExporter(model.tagRegistry, 'osu').export(root)
        } catch (error) {
          failures.push(`THROW export ${label}: ${(error as Error).message}`)
        }
      }

      if (failures.length > 12) break
    }

    expect(failures.slice(0, 13)).toEqual([])
  })
})

/**
 * Every offset resolves to a node that contains it and has no containing
 * descendant. The end of the document is the one offset no character owns;
 * the root claims it so a caret parked after the last character has a node.
 */
function checkCaretResolution(
  root: RedNode,
  sourceLength: number,
  label: string,
  failures: string[],
): void {
  for (let offset = 0; offset <= sourceLength; offset++) {
    const hit = root.findNodeAtOffset(offset)
    if (hit === null) {
      failures.push(`CARET null ${label} @${offset}`)
      return
    }
    const range = hit.range
    const atEndOfDocument = offset === sourceLength && hit.parent === null
    if (!(offset >= range.start && offset < range.end) && !atEndOfDocument) {
      failures.push(`CARET range ${label} @${offset} -> ${hit.kind}[${range.start},${range.end})`)
      return
    }

    let deeper = false
    hit.walk(node => {
      if (node === hit) return
      const childRange = node.range
      if (offset >= childRange.start && offset < childRange.end) deeper = true
    })
    if (deeper) {
      failures.push(`CARET not deepest ${label} @${offset} -> ${hit.kind}`)
      return
    }
  }
}
