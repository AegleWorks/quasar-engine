/**
 * The benchmark workloads. `run.mjs` bundles this file once per engine (`@q`
 * is aliased to that engine's `src/index.ts`) and runs every workload in a
 * fresh process, so a cold figure is really cold and no workload warms the
 * JIT for the next one.
 *
 * A child process is `node bundle.cjs <workload> <corpus.json> <fixture>` and
 * prints one JSON line: `{ "metrics": { name: number | string } }`. Numbers
 * are milliseconds unless the name says otherwise (`…KB`, `…MB`, `…count`,
 * `…exp` for a log-log scaling exponent). A string is an error or a skip,
 * reported as is.
 */
import * as Q from '@q'

const E = Q as any
type Metrics = Record<string, number | string>

const now = () => performance.now()
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {})

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const parse = (source: string, extra: object = {}) =>
  new E.BBCodeDocumentModel({ source, autoAnalyze: false, maxUndo: 0, incremental: false, ...extra })

/** Time `fn` `reps` times after `warm` unmeasured calls; the median. */
function median(fn: () => void, reps = 7, warm = 2): number {
  for (let i = 0; i < warm; i++) fn()
  const t: number[] = []
  for (let i = 0; i < reps; i++) {
    const t0 = now()
    fn()
    t.push(now() - t0)
  }
  return t.sort((a, b) => a - b)[Math.floor(reps / 2)]
}

// ─── Real documents ──────────────────────────────────────────────────────────

/** Every corpus document through one phase; ms per pass over the whole corpus. */
function corpusPass(docs: string[], phase: string): Metrics {
  const out: Metrics = {}
  const models = phase === 'parse' || phase === 'parse.osu' || phase === 'forum' ? null : docs.map(d => parse(d))
  const renderer = new E.HTMLRenderer({ dialect: 'miliastry', theme: 'osu' })
  const step: Record<string, () => void> = {
    'parse': () => { for (const d of docs) parse(d) },
    'parse.osu': () => { for (const d of docs) parse(d, { pairing: 'osu', dialect: 'osu' }) },
    'analyze': () => { for (const m of models!) m.analyze() },
    'render': () => { for (const m of models!) renderer.render(m.redRoot) },
    'export.osu': () => { for (const m of models!) new E.BBCodeExporter(m.tagRegistry, 'osu').export(m.redRoot) },
    'forum': () => { for (const d of docs) E.BBCodeDocumentModel.renderForum(d, { dialect: 'miliastry' }) },
  }
  const t0 = now()
  step[phase]()
  out[`corpus.${phase}.cold`] = now() - t0
  out[`corpus.${phase}.warm`] = median(step[phase], 9, 3)
  return out
}

function fixtureOpen(src: string): Metrics {
  const out: Metrics = {}
  gc()
  const before = process.memoryUsage().heapUsed
  let t0 = now()
  let m = parse(src)
  out['fixture.open.cold'] = now() - t0
  gc()
  out['fixture.open.heapMB'] = (process.memoryUsage().heapUsed - before) / 1048576
  const warm: number[] = []
  for (let i = 0; i < 9; i++) {
    m = null
    t0 = now()
    m = parse(src)
    warm.push(now() - t0)
  }
  warm.sort((a, b) => a - b)
  out['fixture.open.warm.p50'] = quantile(warm, 0.5)
  out['fixture.open.warm.best'] = warm[0]
  return out
}

function fixturePhases(src: string): Metrics {
  const m = parse(src)
  const renderer = new E.HTMLRenderer({ dialect: 'miliastry', theme: 'osu' })
  let t0 = now()
  renderer.render(m.redRoot)
  const coldRender = now() - t0
  t0 = now()
  m.analyze()
  const coldAnalyze = now() - t0
  return {
    'fixture.render.cold': coldRender,
    'fixture.render.warm': median(() => renderer.render(m.redRoot), 5, 1),
    'fixture.analyze.cold': coldAnalyze,
    'fixture.analyze.warm': median(() => m.analyze(), 5, 1),
    'fixture.export.osu': median(() => new E.BBCodeExporter(m.tagRegistry, 'osu').export(m.redRoot), 5, 1),
    'fixture.forum': median(() => E.BBCodeDocumentModel.renderForum(src, { dialect: 'miliastry' }), 3, 1),
    'fixture.parse.osu': median(() => parse(src, { pairing: 'osu', dialect: 'osu' }), 3, 1),
  }
}

/**
 * Random single-character keystrokes at random places, each one undone right
 * after (the undo is timed too). Undoing keeps the document the fixture: left
 * to accumulate, random typing soon breaks a tag for good — a space typed into
 * `[c|olor=…]` makes an unclosed raw `[c]` that swallows the rest of the
 * document — and from then on every keystroke measures that one accident.
 */
function fixtureKeystrokes(src: string): Metrics {
  const m = new E.BBCodeDocumentModel({ source: src, autoAnalyze: false, maxUndo: 0 })
  const rand = mulberry32(12)
  const alphabet = 'abcde xyz[]/=\n'
  const times: number[] = []
  let rebuilds = 0
  for (let i = 0; i < 300; i++) {
    const at = Math.floor(rand() * src.length)
    const next = rand() < 0.7
      ? src.slice(0, at) + alphabet[Math.floor(rand() * alphabet.length)] + src.slice(at)
      : src.slice(0, at) + src.slice(at + 1)
    for (const text of [next, src]) {
      const t0 = now()
      m.applyTextUpdate(text)
      const dt = now() - t0
      if (i >= 10) times.push(dt)
      if (m.lastReparsePath === 'full_rebuild') rebuilds++
    }
  }
  times.sort((a, b) => a - b)
  return {
    'fixture.keys.p50': quantile(times, 0.5),
    'fixture.keys.p90': quantile(times, 0.9),
    'fixture.keys.p99': quantile(times, 0.99),
    'fixture.keys.mean': times.reduce((a, b) => a + b, 0) / times.length,
    'fixture.keys.rebuilds.count': rebuilds,
  }
}

/** Typing a sentence into prose, then deleting it: the common case. */
function fixtureTyping(src: string): Metrics {
  const m = new E.BBCodeDocumentModel({ source: src, autoAnalyze: false, maxUndo: 0 })
  const at = src.indexOf('\n', Math.floor(src.length * 0.6)) + 1
  const sentence = 'the quick brown fox jumps over the lazy dog '
  const times: number[] = []
  const timesChange: number[] = []
  let text = src
  for (let i = 0; i < sentence.length; i++) {
    const next = text.slice(0, at + i) + sentence[i] + text.slice(at + i)
    const t0 = now()
    m.applyTextUpdate(next)
    times.push(now() - t0)
    text = next
  }
  for (let i = sentence.length - 1; i >= 0; i--) {
    const t0 = now()
    m.applyChange({ start: at + i, end: at + i + 1, text: '' })
    timesChange.push(now() - t0)
  }
  times.sort((a, b) => a - b)
  timesChange.sort((a, b) => a - b)
  return {
    'fixture.typing.textUpdate.p50': quantile(times, 0.5),
    'fixture.typing.textUpdate.p90': quantile(times, 0.9),
    'fixture.typing.applyChange.p50': quantile(timesChange, 0.5),
    'fixture.typing.applyChange.p90': quantile(timesChange, 0.9),
  }
}

/** Post-edit analysis on the fixture: the debounced pass an editor waits for. */
function fixtureEditAnalyze(src: string): Metrics {
  const m = new E.BBCodeDocumentModel({ source: src, autoAnalyze: true, maxUndo: 0 })
  const at = src.indexOf('\n', Math.floor(src.length * 0.4)) + 1
  const times: number[] = []
  let text = src
  for (let i = 0; i < 30; i++) {
    text = text.slice(0, at + i) + 'a' + text.slice(at + i)
    m.applyTextUpdate(text)
    const t0 = now()
    m.ensureAnalyzed()
    times.push(now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    'fixture.editAnalyze.p50': quantile(times, 0.5),
    'fixture.editAnalyze.p90': quantile(times, 0.9),
    'fixture.editAnalyze.scope': String(m.lastAnalyze?.scope ?? 'none'),
  }
}

/**
 * `analyze()` asked again with nothing new to analyse — the memo path.
 *
 * This is the shape a diagnostics panel, a lightbulb or a revalidate button
 * produces: the document has not changed since the last pass, so there is
 * nothing to compute and only the previous answer to hand back. Before the
 * memo this paid a full pass over the fixture on every call.
 *
 * The report also carries the diagnostics count and whether the repeated call
 * returned the same result object, so a run that got faster by returning
 * nothing is visible in the numbers rather than hidden by them.
 */
function fixtureAnalyzeRepeat(src: string): Metrics {
  const m = parse(src)
  const first = m.analyze()
  const t = median(() => { m.analyze() }, 9, 1)
  return {
    'fixture.analyzeRepeat.p50': t,
    'fixture.analyzeRepeat.diagnostics': m.diagnostics?.items.length ?? 0,
    'fixture.analyzeRepeat.sameResult': m.analyze() === first ? 1 : 0,
  }
}

/**
 * Editor services on the fixture: source locations, structural queries,
 * formatting and Markdown export. These are the paths a consumer calls while
 * a document is open, so they are measured on the real 547 KB document rather
 * than on a synthetic string.
 */
function fixtureEditor(src: string): Metrics {
  const out: Metrics = {}
  const t0 = now()
  const text = new E.SourceText(src)
  // Force the index, then translate every visible position the way an error
  // panel or an LSP host does.
  const lines = text.lineCount
  out['editor.source.index'] = now() - t0
  out['editor.source.lines'] = lines

  const lookups = 100_000
  const t1 = now()
  let sink = 0
  for (let i = 0; i < lookups; i++) sink += text.positionAt((i * 7919) % src.length).line
  out['editor.source.positionAt100k'] = now() - t1
  out['editor.source.lookupChecksum'] = sink % 97

  const m = parse(src)
  if (typeof E.query !== 'function' || typeof E.QueryEngine !== 'function') {
    out['editor.query.all'] = 'unavailable in this engine'
    return out
  }
  const engine = new E.QueryEngine()
  const all = E.query('*')
  const colors = E.query('[color]')
  out['editor.query.all.nodes'] = engine.execute(all, m.redRoot).total
  out['editor.query.all'] = median(() => engine.execute(all, m.redRoot), 5, 1)
  out['editor.query.colors.nodes'] = engine.execute(colors, m.redRoot).total
  out['editor.query.colors'] = median(() => engine.execute(colors, m.redRoot), 5, 1)

  if (typeof E.Formatter === 'function') {
    const formatter = new E.Formatter()
    out['editor.format'] = median(() => formatter.format(m.redRoot), 3, 1)
    out['editor.format.all'] = median(
      () => formatter.format(m.redRoot, {
        blockNewlines: true,
        collapseEmptyLines: true,
        normalizeInlineWhitespace: true,
      }),
      3, 1,
    )
  }
  if (typeof E.MarkdownExporter === 'function') {
    out['editor.markdown.export'] = median(() => new E.MarkdownExporter().export(m.redRoot), 3, 1)
  }
  return out
}

/** Markdown export of the whole fixture: block separation must stay linear. */
function fixtureMarkdown(src: string): Metrics {
  const m = parse(src)
  const exporter = new E.MarkdownExporter()
  const text = exporter.export(m.redRoot)
  return {
    'fixture.markdown.export': median(() => exporter.export(m.redRoot), 5, 1),
    'fixture.markdown.bytes': text.length,
    'fixture.markdown.separators': (text.match(/\n\n/g) ?? []).length,
  }
}

// ─── Adversarial scaling ─────────────────────────────────────────────────────

const rep = (s: string, n: number) => s.repeat(n)
const ROT = ['[b]', '[i]', '[u]', '[s]', '[color=red]', '[size=150]']
const ROT_CLOSE = ['[/b]', '[/i]', '[/u]', '[/s]', '[/color]', '[/size]']

/** `n` is a count of repeating units; each generator's unit is a few bytes. */
export const GENERATORS: Record<string, (n: number) => string> = {
  'nest.open': n => rep('[b]', n) + 'x',
  'nest.closed': n => rep('[b]', n) + 'x' + rep('[/b]', n),
  'nest.mixed': n => {
    let o = '', c = ''
    for (let i = 0; i < n; i++) { o += ROT[i % 6]; c = ROT_CLOSE[i % 6] + c }
    return o + 'x' + c
  },
  'nest.box': n => rep('[box=t]', n) + 'x' + rep('[/box]', n),
  'nest.quote': n => rep('[quote]', n) + 'x' + rep('[/quote]', n),
  'nest.list': n => rep('[list][*]', n) + 'x',
  'orphans': n => rep('x[/b]', n),
  'crossed': n => rep('[b][i]x[/b][/i]', n),
  'unclosed.flat': n => rep('[color=red]x ', n),
  'unclosed.lines': n => rep('[b]x\n', n),
  'brackets.open': n => rep('[', n),
  'brackets.close': n => rep(']', n),
  'brackets.pairs': n => rep('[[]', n),
  'brackets.attr': n => '[color=' + rep('[', n) + ']x',
  'raw.unclosed': n => '[code]' + rep('[b]x[/b]', n),
  'newlines': n => rep('\n', n),
  'blank.paragraphs': n => rep('a\n\n', n),
  'longline': n => rep('abcdefghij', n),
  'attr.long': n => '[color=' + rep('a', n) + ']x[/color]',
  'url.many': n => rep('[url=https://x.y/z]a[/url] ', n),
  'img.many': n => rep('[img]https://x.y/z.png[/img]', n),
  'tags.flat': n => rep('[b]x[/b] ', n),
  'unknown.tags': n => rep('[zz]x[/zz] ', n),
  'heading.lines': n => rep('[heading]x[/heading]\n', n),
}

/** Units per size step. Total bytes per step = unit length × n. */
const SIZES = [1000, 4000, 16000, 64000]
const PHASE_BUDGET_MS = 4000

function scaling(gen: string): Metrics {
  const out: Metrics = {}
  const make = GENERATORS[gen]
  const phases: Record<string, (src: string) => void> = {
    parse: src => parse(src),
    analyze: src => {
      const m = parse(src)
      m.analyze()
    },
    render: src => {
      const m = parse(src)
      new E.HTMLRenderer({ dialect: 'miliastry', theme: 'osu' }).render(m.redRoot)
    },
    export: src => {
      const m = parse(src)
      new E.BBCodeExporter(m.tagRegistry, 'osu').export(m.redRoot)
    },
    osu: src => parse(src, { pairing: 'osu', dialect: 'osu' }),
    edit: src => {
      // Ten single-character edits in the middle, each a reparse.
      const m = new E.BBCodeDocumentModel({ source: src, autoAnalyze: false, maxUndo: 0 })
      let text = src
      for (let i = 0; i < 10; i++) {
        const at = Math.floor(text.length / 2) + i
        text = text.slice(0, at) + 'q' + text.slice(at)
        m.applyTextUpdate(text)
      }
    },
  }
  for (const [phase, fn] of Object.entries(phases)) {
    const times: number[] = []
    for (const n of SIZES) {
      const src = make(n)
      let t: number
      try {
        // Best of 3 at the small sizes, one shot once a run takes long.
        const t0 = now()
        fn(src)
        t = now() - t0
        if (t < 200) {
          for (let k = 0; k < 2; k++) {
            const t1 = now()
            fn(src)
            t = Math.min(t, now() - t1)
          }
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 60)
        out[`${gen}.${phase}.n${n}`] = `THROW ${msg}`
        break
      }
      out[`${gen}.${phase}.n${n}`] = t
      times.push(t)
      if (t > PHASE_BUDGET_MS) {
        out[`${gen}.${phase}.stop`] = `over ${PHASE_BUDGET_MS} ms at n=${n}`
        break
      }
    }
    // Exponent between the two largest sizes reached: 1 is linear, 2 quadratic.
    if (times.length >= 2) {
      const a = times[times.length - 2], b = times[times.length - 1]
      if (a > 0.5) out[`${gen}.${phase}.exp`] = Math.log(b / a) / Math.log(4)
    }
  }
  out[`${gen}.bytesAt64k`] = make(64000).length
  return out
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export const WORKLOADS: string[] = [
  'corpus.parse', 'corpus.parse.osu', 'corpus.analyze', 'corpus.render', 'corpus.export.osu', 'corpus.forum',
  'fixture.open', 'fixture.phases', 'fixture.keys', 'fixture.typing', 'fixture.editAnalyze', 'fixture.analyzeRepeat', 'fixture.editor',
  'fixture.markdown',
  ...Object.keys(GENERATORS).map(g => `scale.${g}`),
]

export function runWorkload(name: string, corpus: string[], fixture: string): Metrics {
  if (name.startsWith('corpus.')) return corpusPass(corpus, name.slice('corpus.'.length))
  if (name.startsWith('scale.')) return scaling(name.slice('scale.'.length))
  switch (name) {
    case 'fixture.open': return fixtureOpen(fixture)
    case 'fixture.phases': return fixturePhases(fixture)
    case 'fixture.keys': return fixtureKeystrokes(fixture)
    case 'fixture.typing': return fixtureTyping(fixture)
    case 'fixture.editAnalyze': return fixtureEditAnalyze(fixture)
    case 'fixture.analyzeRepeat': return fixtureAnalyzeRepeat(fixture)
    case 'fixture.editor': return fixtureEditor(fixture)
    case 'fixture.markdown': return fixtureMarkdown(fixture)
  }
  throw new Error(`unknown workload ${name}`)
}
