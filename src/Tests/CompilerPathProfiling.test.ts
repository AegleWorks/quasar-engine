/**
 * Compiler-path profiling harness (opt-in).
 *
 * Measures the exact compiler pipeline the app runs per keystroke:
 *   Lexer → Parser → GreenNodePool → red build (reuse) → SemanticAnalyzer
 *   → HTMLRenderer.render → DOMMorpher.morphHTML (the visual node).
 *
 * The app additionally wraps this in `BBCodePipeline` (MiliastryNovaFeatures),
 * which defers the parse to `requestIdleCallback` above SYNC_THRESHOLD=5000 —
 * the quasar engine itself is synchronous, and this harness times the engine.
 *
 * Opt-in so `npm test` stays silent:
 *   QUASAR_PROFILE=1 npx vitest run src/Tests/CompilerPathProfiling.test.ts
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { morphHTML } from '../Visitors/DOMMorpher'
import { REFERENCE_DOCUMENT } from './referenceDocument'

const PROFILE = process.env.QUASAR_PROFILE === '1'
/** Report sink: vitest swallows console.log when stdout is not a TTY. */
const reportLines: string[] = []
function report(line = ''): void {
  reportLines.push(line)
  console.log(line)
}

// ─── Timing helpers ─────────────────────────────────────────

function summarize(samples: number[]): { mean: number; min: number; p50: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b)
  const n = s.length
  return {
    mean: s.reduce((a, b) => a + b, 0) / n,
    min: s[0],
    p50: s[Math.floor(n * 0.5)],
    p95: s[Math.min(n - 1, Math.floor(n * 0.95))],
  }
}

function timeIt(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return (performance.now() - t0) * 1000 // µs
}

/** warmup (JIT) then measure; returns µs samples. */
function bench(measure: number, warmup: number, fn: () => void): number[] {
  for (let i = 0; i < warmup; i++) fn()
  const out: number[] = []
  for (let i = 0; i < measure; i++) out.push(timeIt(fn))
  return out
}

function row(name: string, samples: number[]): void {
  const s = summarize(samples)
  report(
    `  ${name.padEnd(20)} mean ${s.mean.toFixed(1).padStart(8)} µs | min ${s.min.toFixed(1).padStart(8)} | p50 ${s.p50.toFixed(1).padStart(8)} | p95 ${s.p95.toFixed(1).padStart(8)}`,
  )
}

// ─── Scenarios ──────────────────────────────────────────────

describe.skipIf(!PROFILE)('compiler path profiling (QUASAR_PROFILE=1)', () => {
  it(
    'rebuild / keystroke / render / morph across document sizes',
    () => {
    const docs: Array<[string, string]> = [
      ['small ~1.2KB', REFERENCE_DOCUMENT],
      ['mid   ~4.8KB', REFERENCE_DOCUMENT.repeat(4)],
      ['large ~19KB', REFERENCE_DOCUMENT.repeat(16)],
    ]

    report(
      '\nNOTE: app pipeline defers parse to requestIdleCallback above 5KB ' +
        '(BBCodePipeline SYNC_THRESHOLD); engine itself is sync.',
    )

    for (const [docName, source] of docs) {
      report(`\n=== ${docName} (${(source.length / 1024).toFixed(1)} KB) ===`)

      // ── 1. Full load / rebuild (constructor = lex+parse+pool+buildRed+analyze) ──
      const loads = bench(40, 10, () => { new BBCodeDocumentModel({ source }) })
      row('load (rebuild)', loads)

      const probe = new BBCodeDocumentModel({ source })
      let greenCount = 0
      probe.greenRoot!.walk(() => { greenCount++ })
      const probeHtml = new HTMLRenderer().render(probe.redRoot!)
      report(
        `  green nodes: ${greenCount} · html: ${probeHtml.length} chars · ` +
        `analyze: ${((probe.lastAnalyze?.duration ?? 0) * 1000).toFixed(1)} µs / ${probe.lastAnalyze?.nodesAnalyzed ?? 0} nodes`,
      )

      // ── 2. Keystroke (incremental, reuseRed) — insert 'X' at middle ──
      const model = new BBCodeDocumentModel({ source })
      const mid = Math.floor(source.length / 2)
      const sInsert = source.slice(0, mid) + 'X' + source.slice(mid)
      const sRevert = source

      model.applyTextUpdate(sInsert); model.ensureAnalyzed()
      model.applyTextUpdate(sRevert); model.ensureAnalyzed()

      const totalSamples: number[] = []
      const reparseSamples: number[] = []
      const parseSamples: number[] = []
      const buildRedSamples: number[] = []
      const miscReparseSamples: number[] = []
      const analyzeSamples: number[] = []
      for (let i = 0; i < 120; i++) {
        const t = timeIt(() => { model.applyTextUpdate(sInsert); model.ensureAnalyzed() })
        totalSamples.push(t)
        analyzeSamples.push((model.lastAnalyze?.duration ?? 0) * 1000)
        reparseSamples.push(t - (model.lastAnalyze?.duration ?? 0) * 1000)
        const timings = model.lastReparseTimings
        if (timings) {
          parseSamples.push(timings.parse * 1000)
          buildRedSamples.push(timings.buildRed * 1000)
          miscReparseSamples.push(
            (timings.findAffected + timings.safeBoundary + timings.mutate + timings.other) * 1000,
          )
        }
        timeIt(() => { model.applyTextUpdate(sRevert); model.ensureAnalyzed() })
      }
      row('keystroke total', totalSamples)
      row('  diff+reparse', reparseSamples)
      row('  parse', parseSamples)
      row('  buildRed', buildRedSamples)
      row('  find+mutate', miscReparseSamples)
      row('  analyze', analyzeSamples)

      // ── 3. Render to HTML ──
      const renderer = new HTMLRenderer()
      const htmlSamples = bench(80, 20, () => { renderer.render(model.redRoot!) })
      row('renderToHTML', htmlSamples)

      // Two HTML states that differ by exactly the inserted character, for morph.
      model.applyTextUpdate(sInsert); model.ensureAnalyzed()
      const htmlA = renderer.render(model.redRoot!)
      model.applyTextUpdate(sRevert); model.ensureAnalyzed()
      const htmlB = renderer.render(model.redRoot!)
      expect(htmlA.length).toBeGreaterThan(0)

      // ── 4. Morph to DOM (the visual node) ──
      const coldSamples = bench(30, 10, () => {
        morphHTML(document.createElement('div'), htmlA)
      })
      row('morph cold (innerHTML)', coldSamples)

      // Baseline: what a naive full innerHTML swap costs. If morph ≈ this,
      // the cost is DOM parsing of the full document, not the diff walk.
      const rawSamples = bench(30, 10, () => {
        const d = document.createElement('div')
        d.innerHTML = htmlA
      })
      row('baseline innerHTML=', rawSamples)

      const live = document.createElement('div')
      morphHTML(live, htmlA)
      const warmSamples: number[] = []
      for (let i = 0; i < 120; i++) {
        warmSamples.push(timeIt(() => morphHTML(live, i % 2 ? htmlA : htmlB)))
      }
      row('morph warm (diff)', warmSamples)

      // Per-keystroke compiler budget (sync part): keystroke total + render + morph warm.
      const total = summarize(totalSamples)
      const render = summarize(htmlSamples)
      const morph = summarize(warmSamples)
      const syncMs = (total.mean + render.mean + morph.mean) / 1000
      report(
        `  → sync compiler cost/keystroke ≈ ${syncMs.toFixed(2)} ms ` +
          `(${(1000 / Math.max(syncMs, 0.001)).toFixed(0)} keystrokes/s)`,
      )
    }

    const outPath = join(__dirname, '..', '..', 'bench-report.txt')
    writeFileSync(outPath, reportLines.join('\n') + '\n')
    report(`\nReport written to ${outPath}`)
  },
    120_000,
  )
})
