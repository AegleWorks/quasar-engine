/**
 * Edits battery — every kind of edit on the REAL 547KB osu! fixture.
 *
 * Loads `packages/quasar/500KCharsTest` (~547 KB: 60 imagemaps, hundreds of
 * `[centre]`/`[colour]` gradient inlines, links) and drives it through 24
 * edit phases covering every edit class:
 *
 *   - inline typing (1 char at start/giant block/paragraph, backspace,
 *     char delete, word replace, tag-boundary edit)
 *   - blank-run growth/shrink
 *   - special blocks (imagemap content, url text)
 *   - structural block edits (prepend heading, insert box/quote/code,
 *     delete first/last/middle block, convert paragraph→heading, append)
 *   - big edits (8KB paste, 20KB delete, replace imagemap, nuke-most)
 *
 * The invariant is the engine's core contract: after EVERY edit the
 * windowed-patched DOM must equal the full re-render (`morphHTML` of
 * `renderer.render(root)`). That is the differential that proves the
 * incremental paths never leave the DOM diverging — no matter where the
 * edit lands or what it does. `stats.windowed` is recorded per phase so a
 * regression that silently downgrades to the full walk is visible.
 *
 * A separate phase simulates holding a key down: 60 consecutive 1-char
 * appends, each applied and patched separately, with a MutationObserver
 * proving the DOM churn stays O(1)-per-keystroke (not O(blocks)).
 *
 * Run with `PROFILE=1` for the per-phase timings; the default run is pure
 * correctness.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { morphHTML } from '../Visitors/DOMMorpher'
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

/** Strip data-node-id so the differential is structural, not identity-based. */
function stripIds(html: string): string {
  return html.replace(/ data-node-id="[^"]*"/g, '')
}

/** Ground truth: a fresh element morphed with the full render of the root. */
function morphDOM(model: BBCodeDocumentModel, renderer: HTMLRenderer): HTMLDivElement {
  const el = document.createElement('div')
  if (model.redRoot) morphHTML(el, renderer.render(model.redRoot))
  return el
}

const insertAt = (s: string, pos: number, text: string): string =>
  s.slice(0, pos) + text + s.slice(pos)
const del = (s: string, start: number, end: number): string => s.slice(0, start) + s.slice(end)

/** Position right after the next blank line (realistic Enter + paste spot). */
function afterBlank(s: string, pos: number): number {
  const i = s.indexOf('\n\n', pos)
  return i === -1 ? s.length : i + 2
}

interface Phase {
  name: string
  edit: (src: string) => string
  /** True: the windowed path MUST fire (small local edit). False: bail is fine. */
  expectWindowed: boolean
}

describe('Quasar @ 500k — every edit kind on the real fixture', () => {
  it('batería de 24 ediciones con diferencial contra el morph completo', () => {
    const src0 = loadFixture()
    const renderer = new HTMLRenderer()
    const winOpts = { renderer, minWindowedBlocks: 0 }

    let current = src0
    let model = new BBCodeDocumentModel({ source: current })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, winOpts) // prime the patch cache

    const phases: Phase[] = [
      { name: 'type-1char-at-start', expectWindowed: true, edit: (s) => insertAt(s, 0, 'X') },
      {
        name: 'type-1char-in-giant-gradient',
        expectWindowed: true,
        edit: (s) => insertAt(s, s.indexOf('◆') + 1, 'X'),
      },
      {
        name: 'type-1char-in-paragraph',
        expectWindowed: true,
        edit: (s) => {
          const p = s.indexOf('hxovc | Feel comfortable checking!')
          return p === -1 ? s : insertAt(s, p, 'X')
        },
      },
      { name: 'delete-1char-middle', expectWindowed: true, edit: (s) => del(s, s.indexOf('hxovc'), s.indexOf('hxovc') + 1) },
      { name: 'backspace-at-end', expectWindowed: true, edit: (s) => s.slice(0, -1) },
      { name: 'replace-word', expectWindowed: true, edit: (s) => s.replace('Twitch', 'TwitchTV') },
      {
        name: 'edit-at-tag-boundary',
        expectWindowed: true,
        edit: (s) => insertAt(s, s.indexOf('[/color]') + 8, 'Y'),
      },
      { name: 'grow-blank-run', expectWindowed: true, edit: (s) => s.replace('\n\n', '\n\n\n\n\n') },
      {
        name: 'shrink-blank-run',
        expectWindowed: true,
        edit: (s) => {
          const i = s.indexOf('\n\n\n\n')
          return i === -1 ? s.replace('\n\n', '\n') : s.slice(0, i) + '\n\n' + s.slice(i + 4)
        },
      },
      {
        name: 'edit-inside-imagemap',
        expectWindowed: true,
        edit: (s) => s.replace('hxovc.s-ul.eu/84A4eZfV', 'hxovc.s-ul.eu/84A4eZfV2'),
      },
      { name: 'edit-url-link-text', expectWindowed: true, edit: (s) => s.replace('Chess', 'ChessTV') },
      { name: 'prepend-heading-block', expectWindowed: true, edit: (s) => '[heading]TOP[/heading]\n\n' + s },
      {
        name: 'insert-box-block-mid',
        expectWindowed: true,
        edit: (s) => insertAt(s, afterBlank(s, Math.floor(s.length * 0.5)), '[box]caja nueva[/box]\n\n'),
      },
      {
        name: 'insert-quote-block-mid',
        expectWindowed: true,
        edit: (s) => insertAt(s, afterBlank(s, Math.floor(s.length * 0.6)), '[quote]cita nueva[/quote]\n\n'),
      },
      {
        name: 'insert-code-block-mid',
        expectWindowed: true,
        edit: (s) => insertAt(s, afterBlank(s, Math.floor(s.length * 0.4)), '[code]codigo nuevo[/code]\n\n'),
      },
      {
        name: 'convert-paragraph-to-heading',
        expectWindowed: true,
        edit: (s) => s.replace('hxovc | Feel comfortable checking!', '[heading]WELCOME[/heading]'),
      },
      {
        name: 'delete-middle-imagemap',
        expectWindowed: true,
        edit: (s) => {
          const a = s.indexOf('[imagemap]')
          if (a === -1) return s
          const b = s.indexOf('[/imagemap]', a)
          const end = b === -1 ? s.length : b + '[/imagemap]'.length
          const after = s.indexOf('\n\n', end)
          return del(s, a, after === -1 ? end : after + 2)
        },
      },
      { name: 'append-block-at-end', expectWindowed: true, edit: (s) => s + '\n\n[box]fin[/box]' },
      { name: 'delete-last-block', expectWindowed: true, edit: (s) => s.slice(0, s.lastIndexOf('\n\n')) },
      {
        name: 'delete-first-block',
        expectWindowed: true,
        edit: (s) => {
          const i = s.indexOf('\n\n')
          return i === -1 ? s : s.slice(i + 2)
        },
      },
      {
        name: 'paste-8kb-mid',
        expectWindowed: false, // 300 bloques nuevos: el churn cubre casi la mitad del doc → baila a full (correcto)
        edit: (s) => {
          const chunk = Array.from({ length: 300 }, () => '[centre][size=100][color=#ABCDEF]▬[/color][/size]').join('\n\n')
          return insertAt(s, afterBlank(s, Math.floor(s.length * 0.3)), chunk + '\n\n')
        },
      },
      {
        name: 'delete-20k-mid',
        // Regresión del 2026-08-10: borrar 20k en el medio tras un paste de
        // 8KB re-keyea 24 runs sobrevivientes a ~24 posiciones de la banda de
        // identidad del patcher — la ventana vieja los perdía, el walk insertaba
        // duplicados y el DOM divergía (452 vs 428 childNodes). El fix extiende
        // la banda mientras el run viejo sea twin (reference-identical) de la
        // ventana nueva, así que este caso ahora es windowed Y correcto.
        expectWindowed: true,
        edit: (s) => del(s, Math.floor(s.length * 0.5), Math.floor(s.length * 0.5) + 20_000),
      },
      {
        name: 'replace-imagemap-content',
        expectWindowed: true,
        edit: (s) => s.replace('Sarichus', 'Sarichus2'),
      },
      {
        name: 'nuke-most-of-doc',
        expectWindowed: false, // window > half → must bail to full and still be exact
        edit: (s) => s.slice(0, 800) + s.slice(s.length - 800),
      },
    ]

    const results: Array<{
      name: string
      parseMs: number
      patchMs: number
      windowed: boolean
      patched: number
      total: number
    }> = []

    for (const phase of phases) {
      const next = phase.edit(current)
      if (next === current) {
        if (PROFILE) console.log(`[500k-edits] ${phase.name}: SKIP (edit sin cambio)`)
        continue
      }

      const t0 = performance.now()
      model.applyTextUpdate(next)
      model.ensureAnalyzed()
      const parseMs = performance.now() - t0
      const root = model.redRoot!

      const t1 = performance.now()
      const stats = patchBlocksInto(el, root, winOpts)
      const patchMs = performance.now() - t1

      const expected = morphDOM(model, renderer)
      expect(stripIds(el.innerHTML), `divergencia tras "${phase.name}"`).toBe(stripIds(expected.innerHTML))

      if (phase.expectWindowed) {
        expect(
          stats.windowed,
          `"${phase.name}" debió ir por la ventana pero fue ${stats.mode}/${stats.windowed ? 'win' : 'full'}`,
        ).toBe(true)
      }

      if (PROFILE && model.lastReparsePath) {
        console.log(
          `[500k-edits]   └ reparse=${model.lastReparsePath}${model.lastReparseFallbackReason ? ` (${model.lastReparseFallbackReason})` : ''}`,
        )
      }

      results.push({
        name: phase.name,
        parseMs,
        patchMs,
        windowed: !!stats.windowed,
        patched: stats.patched,
        total: stats.total,
      })
      current = next
    }

    if (PROFILE) {
      console.log('\n[500k-edits] ---- batería (windowed forzado) ----')
      for (const r of results) {
        console.log(
          `[500k-edits] ${r.name.padEnd(28)} parse=${r.parseMs.toFixed(1).padStart(7)}ms ` +
            `patch=${r.patchMs.toFixed(2).padStart(7)}ms ` +
            `${r.windowed ? 'WIN ' : 'FULL'} patched=${r.patched}/${r.total}`,
        )
      }
      const win = results.filter((r) => r.windowed).length
      const worst = results.reduce((m, r) => Math.max(m, r.patchMs), 0)
      console.log(`[500k-edits] windowed=${win}/${results.length} worst-patch=${worst.toFixed(2)}ms`)
    }
  }, 300_000)

  it('ráfaga de teclas (60x append de 1 char) — DOM churn O(1) por tecla', () => {
    let s = loadFixture()
    const renderer = new HTMLRenderer()
    const winOpts = { renderer, minWindowedBlocks: 0 }

    let model = new BBCodeDocumentModel({ source: s })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, winOpts)

    const mo = new MutationObserver(() => {})
    mo.observe(el, { childList: true })

    const patchTimes: number[] = []
    let winCount = 0
    let maxMutations = 0
    let worstPatch = 0

    for (let k = 0; k < 60; k++) {
      s += 'a'
      model.applyTextUpdate(s)
      model.ensureAnalyzed()
      const t0 = performance.now()
      const stats = patchBlocksInto(el, model.redRoot!, winOpts)
      const dt = performance.now() - t0
      patchTimes.push(dt)
      worstPatch = Math.max(worstPatch, dt)
      if (stats.windowed) winCount++
      maxMutations = Math.max(maxMutations, mo.takeRecords().length)
    }
    mo.disconnect()

    // Correctness after the burst: the DOM must equal the full re-render.
    const expected = morphDOM(model, renderer)
    expect(stripIds(el.innerHTML)).toBe(stripIds(expected.innerHTML))

    const sorted = [...patchTimes].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length / 2)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    if (PROFILE) {
      console.log(
        `[500k-edits] ráfaga: win=${winCount}/60 maxMutations/tecla=${maxMutations} ` +
          `patch p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms worst=${worstPatch.toFixed(2)}ms`,
      )
    }

    // O(1) per keystroke: never an O(blocks) rebuild storm in the burst.
    expect(maxMutations).toBeLessThanOrEqual(12)
    expect(winCount).toBeGreaterThanOrEqual(55)
  }, 300_000)
})
