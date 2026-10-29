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
  // A swallowed newline's marker carries its node's id, escaped inside effects too.
  .replace(/(data-bb-nl(?: |%20|%2520)hidden)(?: |%20|%2520)data-node-id(?:=|%3D|%253D)(?:&quot;|&amp;quot;|%22|%2522)n(?:&quot;|&amp;quot;|%22|%2522)/g, '$1')
const DIALECTS = ['osu', 'miliastry', 'lyne'] as const

/** Plain text of a red tree, including the newlines a spacing leaf carries. */
const plainText = (n: any): string =>
  n.kind === 'text' ? n.text
  : n.kind === 'spacing' || n.kind === 'empty_line' ? '\n'
  : n.children.map(plainText).join('')

/**
 * The effect kernel, not the tree transformers.
 *
 * `applyEffect` used to rewrite a red tree here; it was the only consumer of
 * the pre-split tree transformers. The differential now reads the one
 * implementation the tag handlers and the studio share, so these keys survive
 * the removal of that API and keep covering the maths that actually renders.
 */
const EFFECTS = [
  { name: 'gradient', kind: 'gradient', params: { colors: ['#ff0000', '#0000ff'] } },
  { name: 'gradient-radial', kind: 'gradient', params: { colors: ['#ff0000', '#00ff00'], axis: 'radial', wave: 'sine', cycles: 2 } },
  { name: 'gradient-steps', kind: 'gradient', params: { colors: ['#ff0000', '#00ff00', '#0000ff'], steps: 4 } },
  { name: 'grow', kind: 'grow', params: {} },
  { name: 'rainbow', kind: 'rainbow', params: {} },
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
  // The effect kernel on the document's plain text. Stable tuples rather than
  // segment objects: key order is not an observable, and JSON.stringify would
  // turn a harmless refactor into a differential failure.
  if (source.length < 20000) {
    const text = plainText(m.redRoot)
    for (const e of EFFECTS) safe(`effect.${e.name}`, () =>
      JSON.stringify(E.evaluateEffect(text, e.kind, e.params).map(
        (s: { text: string; color?: string; size?: number }) => [s.text, s.color ?? null, s.size ?? null],
      )))
  }
  // The HTML importer, when the corpus has the page's HTML.
  if (html !== null) safe('import.html', () =>
    new E.BBCodeExporter(undefined, 'osu').export(new E.HTMLDocumentModel({ source: html }).redRoot))
  return out
}
