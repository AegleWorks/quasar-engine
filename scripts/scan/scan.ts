/**
 * One page through everything the scan measures. `run.mjs` bundles this file with esbuild and
 * calls `scanPage` once per document, in as many processes as it was given jobs.
 */
import { BBCodeDocumentModel } from '../../src/BBCode/BBCodeDocumentModel'
import { firstDifference, previewDoc, renderPreview, unwrapOsuHtml, visibleLines } from '../../src/Tests/support/visibleLines'

export interface PageResult {
  name: string
  bytes: number
  /** ms */
  parseMs: number
  analyzeMs: number
  /** Everything the preview step took: `osuParseMs + renderMs + reduceMs`. */
  previewMs: number
  /** The parse with `pairing: 'osu'` that the preview renders. */
  osuParseMs: number
  /** Quasar's HTMLRenderer alone. */
  renderMs: number
  /** The comparer turning the preview's HTML into lines: the scan's own cost, not Quasar's. */
  reduceMs: number
  /** Diagnostics by code, and the number of pages' worth of each severity. */
  codes: Record<string, number>
  severities: Record<string, number>
  /** Opening tags by lowercase name. */
  tags: Record<string, number>
  /** `no-golden`: osu! was not run for this page. `osu-error`: osu-web threw on it. */
  osu: 'match' | 'diverges' | 'no-golden' | 'osu-error'
  /** The first differing line with its text elided, so divergences of one kind group together. */
  diffKind?: string
  firstDiff?: string
  osuError?: string
  /** Quasar itself threw. */
  error?: string
}

const OPEN_TAG = /\[([a-z*][a-z0-9_*]*)(?=[=\s\]])/gi

/** `ctx|{style}text{style}text` → `ctx|{style}…{style}…`. */
const elide = (line: string): string => line.replace(/\|([^{]*)/, '|…').replace(/\}([^{]*)/g, '}…')

const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100

export function scanPage(name: string, source: string, golden: string | null, osuError: string | null): PageResult {
  const res: PageResult = {
    name, bytes: Buffer.byteLength(source), parseMs: 0, analyzeMs: 0, previewMs: 0, osuParseMs: 0, renderMs: 0, reduceMs: 0,
    codes: {}, severities: {}, tags: {}, osu: 'no-golden',
  }
  try {
    for (const m of source.matchAll(OPEN_TAG)) res.tags[m[1].toLowerCase()] = (res.tags[m[1].toLowerCase()] ?? 0) + 1

    let t = performance.now()
    const model = new BBCodeDocumentModel({ source, dialect: 'osu', incremental: false, autoAnalyze: false, maxUndo: 0 } as any)
    res.parseMs = ms(t)

    t = performance.now()
    model.analyze()
    res.analyzeMs = ms(t)
    for (const d of model.diagnostics?.items ?? []) {
      res.codes[d.code] = (res.codes[d.code] ?? 0) + 1
      res.severities[d.severity] = (res.severities[d.severity] ?? 0) + 1
    }

    const t0 = performance.now()
    t = t0
    const paired = previewDoc(source)
    res.osuParseMs = ms(t)
    t = performance.now()
    const html = renderPreview(paired)
    res.renderMs = ms(t)
    t = performance.now()
    const preview = visibleLines(html)
    res.reduceMs = ms(t)
    res.previewMs = ms(t0)

    if (osuError) {
      res.osu = 'osu-error'
      res.osuError = osuError
    } else if (golden !== null) {
      const osu = visibleLines(unwrapOsuHtml(golden))
      if (preview.join('\n') === osu.join('\n')) {
        res.osu = 'match'
      } else {
        res.osu = 'diverges'
        res.firstDiff = firstDifference(preview, osu)
        const i = preview.findIndex((l, k) => l !== osu[k])
        const at = i === -1 ? Math.min(preview.length, osu.length) : i
        res.diffKind = `${elide(preview[at] ?? '(none)')}  ⇢  ${elide(osu[at] ?? '(none)')}`
      }
    }
  } catch (e) {
    res.error = String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' | ')
  }
  return res
}
