/**
 * Benchmark — 500k-character engine test on REAL osu! BBCode.
 *
 * Uses the real user-profile document at `packages/quasar/500KCharsTest`
 * (~547 KB, thousands of color-gradient inlines, boxes, notices, imagemaps).
 * Run with `PROFILE=1` for the diagnostic numbers (the default run is a
 * correctness smoke test).
 *
 * The flow mirrors production exactly: ONE model, `applyTextUpdate` per edit,
 * `patchBlocksInto(container, model.redRoot)` per patch. Each DOM path gets
 * its own container (own patch cache), primed on the previous state so every
 * measurement honestly consumes the fresh change.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { patchBlocksInto } from '../Visitors/BlockPatcher'

const PROFILE = process.env.PROFILE === '1'

function loadFixture(): string {
  const candidates = [
    join(process.cwd(), 'packages', 'quasar', '500KCharsTest'),
    join(process.cwd(), '500KCharsTest'),
    join(__dirname, '..', '..', '500KCharsTest'),
  ]
  const p = candidates.find(c => existsSync(c))
  if (!p) throw new Error(`Fixture not found in: ${candidates.join(', ')}`)
  return readFileSync(p, 'utf-8')
}

function bench(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

describe('Quasar @ 500k chars (real fixture)', () => {
  it('engine correctness + (PROFILE=1) diagnostics on the 547KB fixture', () => {
    const src = loadFixture()
    const n = src.length
    if (PROFILE) console.log(`[500k] fixture chars=${n} lines=${src.split('\n').length}`)
    expect(n).toBeGreaterThan(500_000)

    const renderer = new HTMLRenderer()
    let renders = 0
    const counting = new Proxy(renderer, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver)
        if (prop === 'render' && typeof v === 'function') {
          return (node: unknown) => {
            renders++
            return v.call(target, node)
          }
        }
        return v
      },
    })

    let model!: BBCodeDocumentModel
    const tNew = bench(() => {
      model = new BBCodeDocumentModel({ source: src })
    })
    if (PROFILE) console.log(`[500k] bootstrap(new model+parse): ${tNew.toFixed(1)}ms`)

    const blocks = model.redRoot?.children.length ?? 0
    if (PROFILE) console.log(`[500k] top-level blocks=${blocks}`)

    if (PROFILE) {
      const sizes = model.redRoot!.children.map((b) => b.range.end - b.range.start).sort((a, b) => b - a)
      console.log(
        `[500k] block-size profile: max=${sizes[0]} median=${sizes[Math.floor(sizes.length / 2)]} ` +
          `mean=${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}`,
      )
    }

    const mid = Math.floor(src.length * 0.6)
    const edits: Array<[string, string]> = [
      ['start-insert', '[heading]TOP[/heading]\n\n' + src],
      ['mid-insert', src.slice(0, mid) + '[heading]MID[/heading]\n\n' + src.slice(mid)],
      ['end-append', src + '\n\n[box]fin[/box]'],
      ['inline-char', src.replace('hxovc', 'hxovcX')],
    ]

    for (const [name, next] of edits) {
      // Prime both containers on the previous state.
      const elWin = document.createElement('div')
      const elFull = document.createElement('div')
      patchBlocksInto(elWin, model.redRoot!, { renderer })
      patchBlocksInto(elFull, model.redRoot!, { renderer })

      // Apply the edit once; the root below is the ONE the model now holds.
      const tParse = bench(() => model.applyTextUpdate(next))
      const root = model.redRoot!
      if (PROFILE && model.lastReparseTimings) {
        const t = model.lastReparseTimings
        console.log(
          `[500k]   reparse path=${model.lastReparsePath} fallback=${model.lastReparseFallbackReason} ` +
            `findAffected=${t.findAffected.toFixed(1)}ms safe=${t.safeBoundary.toFixed(1)}ms ` +
            `parse=${t.parse.toFixed(1)}ms buildRed=${t.buildRed.toFixed(1)}ms mutate=${t.mutate.toFixed(1)}ms`,
        )
      }

      renders = 0
      let statsWin: ReturnType<typeof patchBlocksInto>
      const tWin = bench(() => {
        statsWin = patchBlocksInto(elWin, root, { renderer: counting, minWindowedBlocks: 0 })
      })
      const winRenders = renders

      renders = 0
      let statsFull: ReturnType<typeof patchBlocksInto>
      const tFull = bench(() => {
        statsFull = patchBlocksInto(elFull, root, { renderer: counting, change: undefined as never })
      })
      const fullRenders = renders

      // Default production path: no forced option — the patcher picks the
      // windowed vs full decision on its own (MIN_WINDOWED_BLOCKS applies).
      const elDef = document.createElement('div')
      model.applyTextUpdate(src)
      patchBlocksInto(elDef, model.redRoot!, { renderer })
      model.applyTextUpdate(next)
      const tDefault = bench(() => {
        patchBlocksInto(elDef, root, { renderer: counting })
      })
      const defaultMs = tDefault

      if (PROFILE) {
        console.log(
          `[500k] ${name}: parse=${tParse.toFixed(1)}ms ` +
            `windowed=${tWin.toFixed(2)}ms renders=${winRenders} ` +
            `(${statsWin!.mode}/${statsWin!.windowed ? 'win' : 'full'}, ${statsWin!.patched}/${statsWin!.total}) ` +
            `defaultPath=${defaultMs.toFixed(2)}ms ` +
            `full=${tFull.toFixed(2)}ms renders=${fullRenders} (${statsFull!.patched}/${statsFull!.total})`,
        )
      }

      expect(stripIds(elWin.innerHTML)).toBe(stripIds(elFull.innerHTML))

      model.applyTextUpdate(src)
    }
  }, 120_000)
})

function stripIds(html: string): string {
  return html.replace(/ data-node-id="[^"]*"/g, '')
}
