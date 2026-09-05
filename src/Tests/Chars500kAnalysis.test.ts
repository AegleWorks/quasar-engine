/**
 * Incremental semantic analysis — the differential that is its whole contract.
 *
 * `SemanticAnalyzer.analyzeWindow` re-validates the nodes an edit could have
 * changed and keeps every other node's verdict from the previous pass. The
 * promise it makes is not "fewer nodes" but "the same diagnostics": whatever a
 * window pass returns must be, item for item, what a full pass over the same
 * text would have returned. Anything else is a stale error in the editor's
 * panel, or a real one that never shows up.
 *
 * So every test here runs the same edits twice — once through a model that
 * analyses incrementally, once through a model that is rebuilt from the final
 * text — and compares the whole diagnostic collection after EVERY edit. The
 * edits are the 24-phase battery from `Chars500kEdits.test.ts` on the real
 * 547 KB fixture, a 60-key burst, and a random fuzz over a document written to
 * provoke the checkers (unknown tags, crossings, colour runs).
 *
 * `PROFILE=1` adds the per-edit timings and the window/full split.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic } from '../Types/diagnostics'
import type { AnalyzeScope } from '../Semantic/SemanticAnalyzer'

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

/**
 * A diagnostic reduced to everything a consumer can see.
 *
 * Node ids are deliberately NOT part of it: an incremental reparse builds new
 * red nodes for the window, so the ids inside it differ from a rebuild's by
 * construction and always have. What must not differ is the message, the
 * severity, the range, and every range inside the fixes and related spans —
 * those are what the editor draws and what a quick fix applies.
 */
function fingerprint(d: Diagnostic): string {
  return JSON.stringify({
    code: d.code,
    severity: d.severity,
    message: d.message,
    range: d.range,
    related: d.related?.map(r => ({ message: r.message, range: r.range })),
    fixes: d.fixes?.map(f => ({ description: f.description, operations: f.operations })),
  })
}

function fingerprints(model: BBCodeDocumentModel): string[] {
  return (model.diagnostics?.items ?? []).map(fingerprint)
}

/** Analyse `source` from scratch — the ground truth for any window pass. */
function truthFor(source: string): string[] {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  model.analyze()
  return fingerprints(model)
}

function counts(model: BBCodeDocumentModel): string {
  const d = model.diagnostics
  return `${d?.errorCount ?? 0}/${d?.warningCount ?? 0}/${d?.infoCount ?? 0}/${d?.hintCount ?? 0}`
}

const insertAt = (s: string, pos: number, text: string): string => s.slice(0, pos) + text + s.slice(pos)
const del = (s: string, start: number, end: number): string => s.slice(0, start) + s.slice(end)

function afterBlank(s: string, pos: number): number {
  const i = s.indexOf('\n\n', pos)
  return i === -1 ? s.length : i + 2
}

interface Phase { name: string; edit: (src: string) => string }

const PHASES: Phase[] = [
  { name: 'type-1char-at-start', edit: s => insertAt(s, 0, 'X') },
  { name: 'type-1char-in-giant-gradient', edit: s => insertAt(s, s.indexOf('◆') + 1, 'X') },
  {
    name: 'type-1char-in-paragraph',
    edit: s => {
      const p = s.indexOf('hxovc | Feel comfortable checking!')
      return p === -1 ? s : insertAt(s, p, 'X')
    },
  },
  { name: 'delete-1char-middle', edit: s => del(s, s.indexOf('hxovc'), s.indexOf('hxovc') + 1) },
  { name: 'backspace-at-end', edit: s => s.slice(0, -1) },
  { name: 'replace-word', edit: s => s.replace('Twitch', 'TwitchTV') },
  { name: 'edit-at-tag-boundary', edit: s => insertAt(s, s.indexOf('[/color]') + 8, 'Y') },
  { name: 'grow-blank-run', edit: s => s.replace('\n\n', '\n\n\n\n\n') },
  {
    name: 'shrink-blank-run',
    edit: s => {
      const i = s.indexOf('\n\n\n\n')
      return i === -1 ? s.replace('\n\n', '\n') : s.slice(0, i) + '\n\n' + s.slice(i + 4)
    },
  },
  { name: 'edit-inside-imagemap', edit: s => s.replace('hxovc.s-ul.eu/84A4eZfV', 'hxovc.s-ul.eu/84A4eZfV2') },
  { name: 'edit-url-link-text', edit: s => s.replace('Chess', 'ChessTV') },
  { name: 'prepend-heading-block', edit: s => '[heading]TOP[/heading]\n\n' + s },
  { name: 'insert-box-block-mid', edit: s => insertAt(s, afterBlank(s, Math.floor(s.length * 0.5)), '[box]caja nueva[/box]\n\n') },
  { name: 'insert-quote-block-mid', edit: s => insertAt(s, afterBlank(s, Math.floor(s.length * 0.6)), '[quote]cita nueva[/quote]\n\n') },
  { name: 'insert-code-block-mid', edit: s => insertAt(s, afterBlank(s, Math.floor(s.length * 0.4)), '[code]codigo nuevo[/code]\n\n') },
  { name: 'convert-paragraph-to-heading', edit: s => s.replace('hxovc | Feel comfortable checking!', '[heading]WELCOME[/heading]') },
  {
    name: 'delete-middle-imagemap',
    edit: s => {
      const a = s.indexOf('[imagemap]')
      if (a === -1) return s
      const b = s.indexOf('[/imagemap]', a)
      const end = b === -1 ? s.length : b + '[/imagemap]'.length
      const after = s.indexOf('\n\n', end)
      return del(s, a, after === -1 ? end : after + 2)
    },
  },
  { name: 'append-block-at-end', edit: s => s + '\n\n[box]fin[/box]' },
  { name: 'delete-last-block', edit: s => s.slice(0, s.lastIndexOf('\n\n')) },
  { name: 'delete-first-block', edit: s => (s.indexOf('\n\n') === -1 ? s : s.slice(s.indexOf('\n\n') + 2)) },
  {
    name: 'paste-8kb-mid',
    edit: s => {
      const chunk = Array.from({ length: 300 }, () => '[centre][size=100][color=#ABCDEF]▬[/color][/size]').join('\n\n')
      return insertAt(s, afterBlank(s, Math.floor(s.length * 0.3)), chunk + '\n\n')
    },
  },
  { name: 'delete-20k-mid', edit: s => del(s, Math.floor(s.length * 0.5), Math.floor(s.length * 0.5) + 20_000) },
  { name: 'replace-imagemap-content', edit: s => s.replace('Sarichus', 'Sarichus2') },
  { name: 'nuke-most-of-doc', edit: s => s.slice(0, 800) + s.slice(s.length - 800) },
  // A tag typed by hand, character by character — the state an editor is in
  // most of the time, and the one that produces transient diagnostics.
  { name: 'half-typed-tag-open', edit: s => insertAt(s, 0, '[colo') },
  { name: 'half-typed-tag-close', edit: s => insertAt(s, 5, 'r=#ABCDEF]sin cerrar') },
  { name: 'finish-the-tag', edit: s => insertAt(s, '[color=#ABCDEF]sin cerrar'.length, '[/color]\n\n') },
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('Quasar @ 500k — incremental semantic analysis', () => {
  it('la batería de ediciones: los diagnósticos incrementales son los del análisis completo', () => {
    let current = loadFixture()
    const model = new BBCodeDocumentModel({ source: current, autoAnalyze: false })
    model.analyze()

    const scopes: Record<AnalyzeScope, number> = { full: 0, window: 0 }
    let incrementalMs = 0
    let fullMs = 0

    for (const phase of PHASES) {
      const next = phase.edit(current)
      if (next === current) continue

      model.applyTextUpdate(next)
      const t0 = performance.now()
      const result = model.analyze()
      incrementalMs += performance.now() - t0
      scopes[result.scope]++
      current = next

      const t1 = performance.now()
      const truth = truthFor(current)
      fullMs += performance.now() - t1

      expect(fingerprints(model), `diagnósticos tras "${phase.name}" (scope=${result.scope})`)
        .toEqual(truth)
      if (PROFILE) {
        console.log(
          `[500k-analysis] ${phase.name}: scope=${result.scope} nodes=${result.nodesAnalyzed} ` +
          `${result.duration.toFixed(2)}ms diag=${counts(model)}`,
        )
      }
    }

    // The point of the exercise: most edits must not have walked the document.
    expect(scopes.window).toBeGreaterThan(scopes.full)
    if (PROFILE) {
      console.log(`[500k-analysis] window=${scopes.window} full=${scopes.full} ` +
        `incremental=${incrementalMs.toFixed(0)}ms vs desde-cero=${fullMs.toFixed(0)}ms`)
    }
  }, 600_000)

  it('ráfaga de 60 teclas: cada tecla deja los diagnósticos exactos', () => {
    let current = loadFixture()
    const model = new BBCodeDocumentModel({ source: current, autoAnalyze: false })
    model.analyze()

    // Al final del documento, que es donde escribe quien está redactando.
    const times: number[] = []
    let windowed = 0
    for (let i = 0; i < 60; i++) {
      const at = current.length
      model.applyChange({ start: at, end: at, text: 'a' })
      current = current + 'a'
      const t0 = performance.now()
      const result = model.analyze()
      times.push(performance.now() - t0)
      if (result.scope === 'window') windowed++
    }
    expect(fingerprints(model)).toEqual(truthFor(current))
    expect(windowed).toBe(60)

    times.sort((a, b) => a - b)
    if (PROFILE) {
      console.log(`[500k-analysis] ráfaga: window=${windowed}/60 analyze ` +
        `p50=${times[30].toFixed(2)}ms p95=${times[57].toFixed(2)}ms max=${times[59].toFixed(2)}ms`)
    }
  }, 600_000)

  it('fuzz sobre un documento hecho para los chequeos: 200 ediciones, cero divergencias', () => {
    // Cada pieza existe para despertar a un validador concreto: `[bold]` es
    // una etiqueta desconocida que se empareja con `[/bold]` (unknown-tag),
    // `[/b]` suelto es un cierre huérfano, la ristra de `[color]` es un
    // degradado colapsable, y `[quote][b]x[/quote]` deja un cruce pendiente.
    const pieces = [
      'texto ', '\n\n', '[b]negrita[/b]', '[bold]typo[/bold]', '[/b]',
      '[color=#FF0000]a[/color][color=#DD0022]b[/color][color=#BB0044]c[/color]',
      '[quote][b]x[/quote]', '[url=https://a.test]link[/url]', '[size=200]grande[/size]',
      '[list][*]uno[*]dos[/list]', '[code]crudo [/b] crudo[/code]', '[centre]centro[/centre]',
    ]
    const rand = mulberry32(0xd1a6)
    let current = ''
    for (let i = 0; i < 1500; i++) current += pieces[Math.floor(rand() * pieces.length)]

    const model = new BBCodeDocumentModel({ source: current, autoAnalyze: false })
    model.analyze()
    let windowed = 0

    for (let edit = 0; edit < 200; edit++) {
      const pos = Math.floor(rand() * (current.length + 1))
      const next = rand() < 0.6
        ? insertAt(current, pos, pieces[Math.floor(rand() * pieces.length)])
        : del(current, pos, Math.min(current.length, pos + 1 + Math.floor(rand() * 20)))
      if (next === current) continue
      model.applyTextUpdate(next)
      current = next
      const result = model.analyze()
      if (result.scope === 'window') windowed++
      expect(fingerprints(model), `edición ${edit} (scope=${result.scope})`).toEqual(truthFor(current))
    }
    // Este documento es hostil A PROPÓSITO: está hecho de cierres huérfanos y
    // de `[quote][b]x[/quote]`, justo lo que hace que el parser incremental
    // rechace la ventana (`region-not-isolated`, `pending-auto-close`), así
    // que la mayoría de estas ediciones acaban en rebuild — 12 de 200 medidas.
    // Lo que se prueba aquí es el diferencial, edición por edición; el reparto
    // ventana/completo en un documento real lo fija la batería de 547 KB.
    expect(windowed).toBeGreaterThan(5)
    if (PROFILE) console.log(`[500k-analysis] fuzz: window=${windowed}/200`)
  }, 600_000)
})
