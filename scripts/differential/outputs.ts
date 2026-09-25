/**
 * Every observable output Quasar produces for one source, keyed by name. The
 * differential bundles this file twice, once against each engine, and
 * compares the maps. `@q` is aliased to the engine's `src/index.ts`.
 */
import * as Q from '@q'

const E = Q as any
// Node ids are a process-local counter, so their NUMBERS are not output: two
// engines that mint them in a different order render the same page. Stripped
// as an attribute, and normalised where a render nested inside an attribute
// (a `[profile]` whose name holds a tag) carries them escaped once or twice
// (`&quot;`, `&amp;quot;`, `%22`, `%2522`).
const strip = (h: string) => h
  .replace(/ data-node-id="[^"]*"/g, '')
  .replace(/(data-node-id(?:=|%3D|%253D)(?:&quot;|&amp;quot;|%22|%2522))n\d+/g, '$1n')
const DIALECTS = ['osu', 'miliastry', 'lyne'] as const
const EFFECTS = [
  { kind: 'gradient', colors: ['#ff0000', '#0000ff'] },
  { kind: 'grow' },
  { kind: 'rainbow' },
  { kind: 'central_gradient', colors: ['#ff0000', '#00ff00'] },
  { kind: 'multi_gradient', colors: ['#ff0000', '#00ff00', '#0000ff'] },
]

export function outputs(source: string, html: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  const safe = (k: string, f: () => string) => {
    try { out[k] = f() } catch (e) { out[k] = 'THROW:' + String((e as Error)?.message ?? e) }
  }
  const model = (dialect: string, pairing?: string) =>
    new E.BBCodeDocumentModel({ source, dialect, pairing, incremental: false, autoAnalyze: false, maxUndo: 0 })

  // The preview, under both pairings (default and "what osu! shows").
  for (const pairing of ['quasar', 'osu'] as const) for (const dialect of DIALECTS) {
    safe(`render.${pairing}.${dialect}`, () =>
      strip(new E.HTMLRenderer({ dialect, theme: dialect === 'lyne' ? 'lyne' : 'osu' }).render(model(dialect, pairing).redRoot)))
  }
  for (const dialect of DIALECTS) safe(`forum.${dialect}`, () => E.BBCodeDocumentModel.renderForum(source, { dialect }))
  // What gets published, to each target.
  const m = model('miliastry')
  for (const target of DIALECTS) safe(`export.${target}`, () => new E.BBCodeExporter(m.tagRegistry, target).export(m.redRoot))
  // Effects rewrite the tree; their export is the observable.
  if (source.length < 20000) for (const e of EFFECTS) safe(`effect.${e.kind}`, () => {
    const mm = model('miliastry')
    return new E.BBCodeExporter(mm.tagRegistry, 'miliastry').export(E.applyEffect(mm.redRoot, e))
  })
  // The HTML importer, when the corpus has the page's HTML.
  if (html !== null) safe('import.html', () =>
    new E.BBCodeExporter(undefined, 'osu').export(new E.HTMLDocumentModel({ source: html }).redRoot))
  return out
}
