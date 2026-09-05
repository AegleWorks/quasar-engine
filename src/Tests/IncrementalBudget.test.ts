/**
 * The budget — what must still be true after the next change to this engine.
 *
 * Every O(n)-per-keystroke term this work removed came back at least once
 * while it was being removed, and none of them announced themselves: the
 * suite stayed green, the documents still rendered correctly, and typing at
 * the end of a long post simply got slow again. A differential cannot catch
 * that, because a slow answer and a fast one are the same answer.
 *
 * So the thresholds here are RELATIVE, to one full rebuild of the same
 * document measured in the same run. An absolute millisecond budget on a
 * shared CI machine is either so loose it catches nothing or so tight it
 * fails on a noisy neighbour; "a keystroke must cost a fraction of a rebuild"
 * holds on any machine and is exactly the property that breaks when an O(n)
 * scan sneaks back onto the edit path.
 *
 * The measured margins on the 547 KB fixture are wide, and deliberately so:
 * the point is to catch a term coming BACK, not to police the last 20%. A
 * keystroke at the end of the document costs 1/117th of a rebuild and one in
 * the middle 1/23rd, against a bound of an eighth; a keystroke re-validates 4
 * of the document's 38.522 nodes, against a bound of 200; the bracket
 * boundary check reads 3.643 characters at worst, against a bound of 8.192
 * and against the half a million the scan it replaced read.
 *
 * `PROFILE=1` prints the numbers and the fallback tally.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'

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

/** Median, which is what a keystroke budget is about — not the GC outlier. */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function percentile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

/**
 * The unit every budget below is measured in: parse + red tree + a full
 * semantic pass over the whole fixture, which is what an engine with no
 * incremental path does on every keystroke.
 *
 * Three runs, median: the first pays for cold code and a cold heap.
 */
function fullRebuildCost(src: string): number {
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
    model.analyze()
    runs.push(performance.now() - t0)
  }
  return median(runs)
}

interface BurstResult {
  perKey: number[]
  windowedParses: number
  windowedAnalyses: number
  reasons: Map<string, number>
}

/**
 * `keys` single-character insertions at `at(text)`, each applied as an exact
 * delta and analysed, timing the engine work for each one.
 */
function burst(src: string, keys: number, at: (text: string) => number): BurstResult {
  const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
  model.analyze()
  let text = src
  const out: BurstResult = { perKey: [], windowedParses: 0, windowedAnalyses: 0, reasons: new Map() }

  for (let i = 0; i < keys; i++) {
    const pos = at(text)
    const t0 = performance.now()
    model.applyChange({ start: pos, end: pos, text: 'a' })
    const result = model.analyze()
    out.perKey.push(performance.now() - t0)
    text = text.slice(0, pos) + 'a' + text.slice(pos)

    if (model.lastReparsePath === 'incremental') out.windowedParses++
    else {
      const reason = String(model.lastReparseFallbackReason)
      out.reasons.set(reason, (out.reasons.get(reason) ?? 0) + 1)
    }
    if (result.scope === 'window') out.windowedAnalyses++
  }
  return out
}

function report(name: string, result: BurstResult, full: number): void {
  if (!PROFILE) return
  const p50 = median(result.perKey)
  console.log(
    `[budget] ${name}: parse=${result.windowedParses}/${result.perKey.length} ` +
    `analyze=${result.windowedAnalyses}/${result.perKey.length} ` +
    `p50=${p50.toFixed(2)}ms p95=${percentile(result.perKey, 0.95).toFixed(2)}ms ` +
    `max=${Math.max(...result.perKey).toFixed(2)}ms — rebuild=${full.toFixed(1)}ms ` +
    `(1/${(full / p50).toFixed(0)}) fallbacks=${JSON.stringify([...result.reasons])}`,
  )
}

describe('Quasar @ 500k — the incremental budget', () => {
  it('escribir al FINAL del documento no cuesta un documento', () => {
    // The caret's home while a post is being written, and the case that used
    // to be worst: the bracket boundary check scanned the whole prefix, so
    // the further into the document the caret sat, the more each keystroke
    // cost. `BracketIndex` is why that is now flat.
    const src = loadFixture()
    const full = fullRebuildCost(src)
    const result = burst(src, 60, text => text.length)
    report('final', result, full)

    // Not one keystroke may leave the incremental path.
    expect(result.windowedParses).toBe(60)
    expect(result.windowedAnalyses).toBe(60)
    // And the whole keystroke — reparse, red tree, semantic pass — stays well
    // under a fraction of a rebuild. Measured at 1/117th here, 1/23rd below.
    expect(median(result.perKey)).toBeLessThan(full / 8)
    // No single keystroke may stall, either: a p95 in rebuild territory means
    // something on the path is occasionally walking the document.
    expect(percentile(result.perKey, 0.95)).toBeLessThan(full / 3)
  }, 600_000)

  it('escribir en MITAD del documento tampoco', () => {
    const src = loadFixture()
    const full = fullRebuildCost(src)
    // Inside a paragraph halfway down, moving forward as the text grows.
    const anchor = src.indexOf('hxovc | Feel comfortable checking!')
    const start = anchor === -1 ? Math.floor(src.length / 2) : anchor + 10
    let offset = 0
    const result = burst(src, 60, () => start + offset++)
    report('mitad', result, full)

    expect(result.windowedParses).toBe(60)
    expect(result.windowedAnalyses).toBe(60)
    expect(median(result.perKey)).toBeLessThan(full / 8)
    expect(percentile(result.perKey, 0.95)).toBeLessThan(full / 3)
  }, 600_000)

  it('el análisis incremental no vuelve a recorrer el documento', () => {
    // The count is the honest metric here: a window pass that quietly
    // degrades to visiting every node still returns the right diagnostics and
    // still reports `scope: 'window'`, so only `nodesAnalyzed` catches it.
    const src = loadFixture()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
    const first = model.analyze()
    expect(first.scope).toBe('full')

    let text = src
    const visited: number[] = []
    for (let i = 0; i < 30; i++) {
      const pos = text.length
      model.applyChange({ start: pos, end: pos, text: 'a' })
      text = text + 'a'
      const result = model.analyze()
      expect(result.scope).toBe('window')
      visited.push(result.nodesAnalyzed)
    }
    if (PROFILE) {
      console.log(`[budget] nodos por tecla: p50=${median(visited)} max=${Math.max(...visited)} ` +
        `de ${first.nodesAnalyzed} en el documento`)
    }
    // A keystroke at the end of a 40.000-node document touches a handful of
    // nodes. The bound is deliberately far above the measured single digits
    // and still four orders of magnitude below the document.
    expect(median(visited)).toBeLessThan(200)
    expect(Math.max(...visited)).toBeLessThan(first.nodesAnalyzed / 20)
  }, 600_000)

  it('el índice de corchetes no vuelve a leer el prefijo', () => {
    // The one term that is measured directly rather than through a clock,
    // because it is the one that was 22% of a keystroke and the one a
    // refactor would most plausibly reintroduce: characters of the prefix
    // read to answer "does every `[` before the window close before it?".
    const src = loadFixture()
    const model = new BBCodeDocumentModel({ source: src, autoAnalyze: false })
    const parser = model.incrementalParser
    let text = src
    let worst = 0
    for (const fraction of [1, 0.5, 0.25, 0.75, 1]) {
      const pos = Math.min(text.length, Math.floor(text.length * fraction))
      model.applyChange({ start: pos, end: pos, text: 'a' })
      text = text.slice(0, pos) + 'a' + text.slice(pos)
      worst = Math.max(worst, parser.lastBoundaryScan)
    }
    if (PROFILE) console.log(`[budget] mayor lectura del prefijo: ${worst} chars de ${text.length}`)
    // One index piece, wherever the caret is. The scan it replaced read up to
    // 500.000 characters for the same answer.
    expect(worst).toBeLessThanOrEqual(8192)
  }, 600_000)
})
