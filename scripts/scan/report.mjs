#!/usr/bin/env node
// Report: what is common across a scan.   node scripts/scan/report.mjs <scan.jsonl> [--top 15] [--json]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const topIdx = process.argv.indexOf('--top')
const TOP = topIdx === -1 ? 15 : Number(process.argv[topIdx + 1])
if (!file || file.startsWith('--')) {
  console.error('usage: node scripts/scan/report.mjs <scan.jsonl> [--top N] [--json]')
  process.exit(2)
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP)
const pct = (n, d) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`)
const quantile = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0)

const codePages = new Map(), codeTotal = new Map(), tagPages = new Map(), kinds = new Map(), kindExample = new Map()
const osu = { match: 0, diverges: 0, 'no-golden': 0, 'osu-error': 0 }
const crashed = rows.filter((r) => r.error)
for (const r of rows) {
  osu[r.osu] = (osu[r.osu] ?? 0) + 1
  for (const [c, n] of Object.entries(r.codes)) { bump(codePages, c); bump(codeTotal, c, n) }
  for (const t of Object.keys(r.tags)) bump(tagPages, t)
  if (r.diffKind) { bump(kinds, r.diffKind); if (!kindExample.has(r.diffKind)) kindExample.set(r.diffKind, r.name) }
}
const compared = osu.match + osu.diverges

const summary = {
  pages: rows.length,
  quasarCrashes: crashed.length,
  osu,
  matchRate: compared ? osu.match / compared : null,
  ms: {
    parseP50: quantile(rows.map((r) => r.parseMs), 0.5), parseP95: quantile(rows.map((r) => r.parseMs), 0.95),
    analyzeP50: quantile(rows.map((r) => r.analyzeMs), 0.5), analyzeP95: quantile(rows.map((r) => r.analyzeMs), 0.95),
    previewP50: quantile(rows.map((r) => r.previewMs), 0.5), previewP95: quantile(rows.map((r) => r.previewMs), 0.95),
    osuParseP50: quantile(rows.map((r) => r.osuParseMs ?? 0), 0.5), osuParseP95: quantile(rows.map((r) => r.osuParseMs ?? 0), 0.95),
    renderP50: quantile(rows.map((r) => r.renderMs ?? 0), 0.5), renderP95: quantile(rows.map((r) => r.renderMs ?? 0), 0.95),
    reduceP50: quantile(rows.map((r) => r.reduceMs ?? 0), 0.5), reduceP95: quantile(rows.map((r) => r.reduceMs ?? 0), 0.95),
  },
  bytesP50: quantile(rows.map((r) => r.bytes), 0.5), bytesMax: Math.max(0, ...rows.map((r) => r.bytes)),
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, codes: top(codePages), tags: top(tagPages), divergences: top(kinds) }, null, 2))
  process.exit(0)
}

const lines = []
lines.push(`# Scan report: ${rows.length} pages\n`)
lines.push(`- Quasar crashes: ${crashed.length}`)
lines.push(`- osu!: ${osu.match} match, ${osu.diverges} diverge (${pct(osu.match, compared)} match), ${osu['osu-error']} osu-web errors, ${osu['no-golden']} not compared`)
lines.push(`- ms p50/p95: parse ${summary.ms.parseP50}/${summary.ms.parseP95}, analyze ${summary.ms.analyzeP50}/${summary.ms.analyzeP95}, preview ${summary.ms.previewP50}/${summary.ms.previewP95}`)
if (rows[0]?.renderMs !== undefined) {
  lines.push(`- preview split, ms p50/p95: osu parse ${summary.ms.osuParseP50}/${summary.ms.osuParseP95}, render ${summary.ms.renderP50}/${summary.ms.renderP95}, comparer ${summary.ms.reduceP50}/${summary.ms.reduceP95} (the comparer is the scan's own cost, not Quasar's)`)
}
lines.push(`- bytes: median ${summary.bytesP50}, max ${summary.bytesMax}\n`)
lines.push('## Diagnostics (pages affected, total findings)\n')
for (const [c, p] of top(codePages)) lines.push(`- ${c}: ${p} pages (${pct(p, rows.length)}), ${codeTotal.get(c)} findings`)
lines.push('\n## Tags (pages using it)\n')
for (const [t, p] of top(tagPages)) lines.push(`- [${t}]: ${p} pages (${pct(p, rows.length)})`)
lines.push('\n## Where the preview differs from osu! (first differing line, text elided)\n')
for (const [k, n] of top(kinds)) lines.push(`- ${n} pages, e.g. ${kindExample.get(k)}\n  ${k}`)
if (crashed.length) {
  lines.push('\n## Quasar crashes\n')
  for (const r of crashed.slice(0, TOP)) lines.push(`- ${r.name}: ${r.error}`)
}
console.log(lines.join('\n'))
