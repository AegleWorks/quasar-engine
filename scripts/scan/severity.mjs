#!/usr/bin/env node
// Severity ranking of a scan's divergences: not `how many pages differ` but `how badly they
// differ, and how many pages one cause accounts for`.
//
//   node scripts/scan/severity.mjs <out.jsonl> --src <dir> --goldens <dir> [--json <file>]
//   node scripts/scan/severity.mjs <out.jsonl> --src <dir> --goldens <dir> --page osu/123.bbcode
//
// Prints, for every page recorded as `diverges`:
//   - a histogram by worst change kind (content / structure / style / spacing, see severity.ts),
//   - an impact ranking of the causes: the elided first-differing line groups pages, so one row
//     is one thing to fix, ordered by worst kind first and page count second,
//   - with --page, every change window of that page and both sides' lines around it.
//
// Needs `esbuild` and `jsdom` resolvable from the working directory: run it from the Miliastry
// monorepo root, like `run.mjs`.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const SCAN = args[0] && resolve(args[0])
const SRC = flag('src') && resolve(flag('src'))
const GOLDENS = flag('goldens') && resolve(flag('goldens'))
const PAGE = flag('page')
if (!SCAN || !SRC || !GOLDENS) {
  console.error('usage: node scripts/scan/severity.mjs <out.jsonl> --src <dir> --goldens <dir> [--json <file>] [--page <name>]')
  process.exit(2)
}

const need = createRequire(join(process.cwd(), 'noop.js'))
const { JSDOM } = need('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const k of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'NodeFilter', 'DocumentFragment']) {
  globalThis[k] = dom.window[k]
}
const esbuild = need('esbuild')
const work = mkdtempSync(join(tmpdir(), 'quasar-severity-'))
const bundle = join(work, 'severity.cjs')
await esbuild.build({
  entryPoints: [join(HERE, 'severity.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: bundle, logLevel: 'error',
})
const { pageSeverity, SEVERITY_RANK, pageLines } = createRequire(import.meta.url)(bundle)

const pages = readFileSync(SCAN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const goldenOf = (page) => {
  const path = join(GOLDENS, page.name.replace(/\.bbcode$/, '.osu.html'))
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const sourceOf = (page) => readFileSync(join(SRC, page.name), 'utf8')

// ─── One page in full ────────────────────────────────────────────────────────
if (PAGE) {
  const page = pages.find((p) => p.name === PAGE) ?? { name: PAGE }
  const golden = goldenOf(page)
  if (!golden) throw new Error(`no golden for ${PAGE}`)
  const result = pageSeverity(sourceOf(page), golden)
  console.log(`${PAGE}: ${result.worst}${result.known.length ? ` (known: ${result.known.join(', ')})` : ''}`)
  console.log(`${result.windows.length} window(s)\n`)
  const lines = pageLines(sourceOf(page), golden)
  for (const [i, w] of result.windows.entries()) {
    console.log(`#${i + 1} ${w.kind}${w.direction ? `/${w.direction}` : ''}  preview line ${w.previewLine} (${w.previewLines}) / osu! line ${w.osuLine} (${w.osuLines})`)
    console.log(`  ${w.detail}`)
    const from = Math.max(0, Math.min(w.previewLine, w.osuLine) - 2)
    const to = Math.max(w.previewLine + w.previewLines, w.osuLine + w.osuLines) + 1
    for (let k = from; k < to; k++) {
      const mark = k >= w.previewLine - 1 && k < w.previewLine - 1 + Math.max(w.previewLines, 1)
      console.log(`  ${mark ? '·' : ' '} ${String(k + 1).padStart(4)} pv ${lines.preview[k] ?? ''}`)
      console.log(`  ${mark ? '·' : ' '}      os ${lines.osu[k] ?? ''}`)
    }
    console.log('')
  }
  const out = flag('json')
  if (out) writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
  process.exit(0)
}

// ─── The whole scan ──────────────────────────────────────────────────────────
const results = []
let stale = 0
let missing = 0
for (const page of pages) {
  if (page.osu !== 'diverges') continue
  const golden = goldenOf(page)
  if (!golden) { missing++; continue }
  const severity = pageSeverity(sourceOf(page), golden)
  // A page the scan called `diverges` but this run sees as identical means the goldens passed
  // here are not the ones that scan used: a warning, not a page to rank.
  if (severity.windows.length === 0) stale++
  const worstWindow = severity.windows.find((w) => w.kind === severity.worst)
  results.push({
    name: page.name, ...severity, window: worstWindow, diffKind: page.diffKind, firstDiff: page.firstDiff,
    // Any glued window is enough: the page carries that cause even if something worse is on it too.
    merged: severity.windows.some((w) => w.merged),
  })
}

const tally = (rows) => {
  const by = { content: 0, structure: 0, style: 0, spacing: 0 }
  for (const r of rows) by[r.worst]++
  return by
}
const show = (by) => Object.entries(by).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')
const known = results.filter((r) => r.known.length > 0)
const unknown = results.filter((r) => r.known.length === 0)

console.log(`# Severity — ${results.length} divergent pages of ${pages.length}`)
console.log(`- every divergence:          ${show(tally(results))}`)
console.log(`- known, left alone (${String(known.length).padStart(3)}):    ${show(tally(known))}`)
console.log(`- to look at (${String(unknown.length).padStart(3)}):         ${show(tally(unknown))}`)

// Two parities, kept apart on purpose. `[profile]` resolution needs the id/name index osu! has
// and Quasar does not, so counting those pages against the preview measures a missing data
// source, not a missing rule. Reported from the scan rows, which know both sides of the corpus.
const matched = pages.filter((p) => p.osu === 'match').length
const compared = matched + results.length
const external = results.filter((r) => r.known.includes('profile-name-resolution')).length
if (compared > 0) {
  const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
  console.log(`\n## Parity`)
  console.log(`- offline (no profile resolution): ${matched}/${compared - external} = ${pct(matched, compared - external)}`)
  console.log(`- with profile resolution:         ${matched + external}/${compared} = ${pct(matched + external, compared)} (${external} pages need the index)`)
}
if (stale) console.log(`\n! ${stale} page(s) recorded as divergent compare identical here: wrong --goldens dir?`)
if (missing) console.log(`! ${missing} page(s) have no golden under ${GOLDENS}`)

// One cause = one signature (see severity.ts). Rank by how bad the worst change is, then by how
// many pages it accounts for: a broken list on 3 pages beats a blank line on 40.
const groups = new Map()
for (const r of unknown) {
  // Every page whose WORST change is the preview gluing what osu! broke is the SAME cause,
  // however the text at the break reads — that is what makes it worth its own row in the
  // ranking. The worst window is the one that names the page, so a page whose second problem
  // is glue is not counted here (it would inflate the row).
  const key = r.window?.merged ? 'glued: the break osu! has, missing' : (r.window?.signature ?? '(no window)')
  const group = groups.get(key) ?? { key, pages: [], known: 0 }
  group.pages.push(r)
  groups.set(key, group)
}
const ranked = [...groups.values()].sort((a, b) => {
  const wa = Math.max(...a.pages.map((p) => SEVERITY_RANK[p.worst]))
  const wb = Math.max(...b.pages.map((p) => SEVERITY_RANK[p.worst]))
  return wb - wa || b.pages.length - a.pages.length
})

console.log(`\n## Causes, worst first — ${ranked.length} for ${unknown.length} pages`)
for (const group of ranked.slice(0, 40)) {
  const worst = group.pages.reduce((w, p) => (SEVERITY_RANK[p.worst] > SEVERITY_RANK[w] ? p.worst : w), 'spacing')
  const dirs = new Set(group.pages.map((p) => p.window?.direction).filter(Boolean))
  const page = group.pages[0]
  const where = group.pages.length > 1
    ? `${group.pages.slice(0, 3).map((p) => p.name.replace(/^osu\//, '').replace(/\.bbcode$/, '')).join(' ')}${group.pages.length > 3 ? ` +${group.pages.length - 3}` : ''}`
    : page.name
  console.log(`\n[${group.pages.length}] ${worst}${dirs.size ? `/${[...dirs].join('|')}` : ''}  ${where}`)
  console.log(`    ${group.key}`)
  if (page.window) console.log(`    at preview ${page.window.previewLine} / osu! ${page.window.osuLine}: ${page.window.detail}`)
}

const tail = ranked.slice(40)
if (tail.length) console.log(`\n(${tail.length} more causes, ${tail.reduce((n, g) => n + g.pages.length, 0)} pages — rerun with --json to see them)`)

const out = flag('json')
if (out) {
  writeFileSync(out, JSON.stringify({ results, causes: ranked.map((g) => ({ ...g, pages: g.pages.map((p) => p.name) })) }, null, 1) + '\n')
  console.log(`\njson: ${out}`)
}
