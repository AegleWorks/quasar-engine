#!/usr/bin/env node
// Benchmark: how fast is this working tree, and how does it compare to <base>?
//
//   node scripts/bench/run.mjs [--base <ref>] [--corpus <dir>] [--runs 3]
//                              [--only <regex>] [--json <file>] [--timeout 120]
//
// Bundles `workloads.ts` with esbuild against this working tree (and, with
// `--base`, against <base> extracted with `git archive`; the working tree is
// never touched), with `process.env.NODE_ENV` set to "production". Every
// workload runs in its own process, `--runs` times per engine, alternating
// engines run by run so machine noise falls on both. The figure reported is
// the median across processes.
//
// Workloads: the corpus of real documents (each phase over all of them), the
// 547 KB fixture (open, render, analysis, export, random keystrokes, typing),
// and adversarial inputs at 1k → 64k repeating units (deep nesting, unclosed
// and crossed tags, bracket soup, raw blocks…), whose `.exp` is the log-log
// growth between the two largest sizes: ~1 is linear, ~2 quadratic.
//
// Needs `esbuild` and `jsdom` resolvable from the working directory (run it
// from the Miliastry monorepo root). The corpus defaults to the monorepo's
// `docs/ai` when it is there.

import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')

// ─── Child: one workload, one process ───────────────────────────────────────
if (process.argv[2] === '--child') {
  const [, , , bundlePath, workload, corpusPath, fixturePath, jsdomPath] = process.argv
  const { JSDOM } = createRequire(jsdomPath)('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const k of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'NodeFilter', 'DocumentFragment']) {
    globalThis[k] = dom.window[k]
  }
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
  const fixture = existsSync(fixturePath) ? readFileSync(fixturePath, 'utf8') : ''
  const engine = createRequire(import.meta.url)(bundlePath)
  const metrics = engine.runWorkload(workload, corpus, fixture)
  process.stdout.write(JSON.stringify({ metrics }) + '\n')
  process.exit(0)
}

// ─── Parent ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const BASE = flag('base')
const RUNS = Number(flag('runs', 3))
const ONLY = flag('only') ? new RegExp(flag('only')) : null
const JSON_OUT = flag('json')
const TIMEOUT_MS = Number(flag('timeout', 120)) * 1000
const monorepoCorpus = resolve(REPO, '../../docs/ai')
const CORPUS = flag('corpus', existsSync(monorepoCorpus) ? monorepoCorpus : null)

const need = createRequire(join(process.cwd(), 'noop.js'))
const esbuild = need('esbuild')
const jsdomPath = need.resolve('jsdom')

const work = mkdtempSync(join(tmpdir(), 'quasar-bench-'))

async function bundle(name, engineDir) {
  const outfile = join(work, `${name}.cjs`)
  await esbuild.build({
    entryPoints: [join(HERE, 'workloads.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    outfile, alias: { '@q': join(engineDir, 'src/index.ts') }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  return outfile
}

const engines = []
if (BASE) {
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', BASE], { encoding: 'utf8' }).trim()
  const baseDir = join(work, 'base')
  mkdirSync(baseDir)
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${sha}" src | tar -x -C "${baseDir}"`])
  engines.push({ name: `base ${sha.slice(0, 7)}`, file: await bundle('base', baseDir) })
}
engines.push({ name: 'head', file: await bundle('head', REPO) })

// The corpus, as one JSON array the children read.
const sources = []
if (CORPUS && statSync(CORPUS).isDirectory()) {
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, f.name)
      if (f.isDirectory()) { walk(p); continue }
      if (/\.(html|md|json)$/i.test(f.name)) continue
      sources.push(readFileSync(p, 'utf8'))
    }
  }
  walk(CORPUS)
}
const corpusPath = join(work, 'corpus.json')
writeFileSync(corpusPath, JSON.stringify(sources))
const fixturePath = join(REPO, '500KCharsTest')

const { WORKLOADS } = createRequire(import.meta.url)(engines[engines.length - 1].file)
const workloads = WORKLOADS.filter((w) => {
  if (ONLY && !ONLY.test(w)) return false
  if (w.startsWith('corpus.') && sources.length === 0) return false
  if (w.startsWith('fixture.') && !existsSync(fixturePath)) return false
  return true
})

console.log(`quasar bench: ${workloads.length} workloads × ${RUNS} runs × ${engines.length} engine(s); ` +
  `corpus ${sources.length} docs (${(sources.reduce((n, s) => n + s.length, 0) / 1024).toFixed(0)} KB), node ${process.version}`)

function runChild(engine, workload) {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child',
    engine.file, workload, corpusPath, fixturePath, jsdomPath], {
    encoding: 'utf8', timeout: TIMEOUT_MS, env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 1 << 26,
  })
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { error: `TIMEOUT/${r.signal ?? 'killed'} after ${TIMEOUT_MS / 1000}s` }
  const line = r.stdout.trim().split('\n').pop()
  try { return JSON.parse(line) } catch {
    return { error: `CRASH ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 120) ?? ''}` }
  }
}

const results = {} // engine → metric → values[]
for (const e of engines) results[e.name] = {}
for (const w of workloads) {
  for (let run = 0; run < RUNS; run++) {
    // Alternate the order run by run so neither engine always goes first.
    const order = run % 2 === 0 ? engines : [...engines].reverse()
    for (const e of order) {
      const res = runChild(e, w)
      const bag = results[e.name]
      if (res.error) { (bag[`${w}.error`] ??= []).push(res.error); continue }
      for (const [k, v] of Object.entries(res.metrics)) (bag[k] ??= []).push(v)
    }
  }
  process.stdout.write('.')
}
process.stdout.write('\n')

const med = (vs) => {
  const nums = vs.filter((v) => typeof v === 'number')
  if (nums.length === 0) return vs[0]
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const fmt = (v) => typeof v !== 'number' ? String(v)
  : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)

const keys = [...new Set(engines.flatMap((e) => Object.keys(results[e.name])))]
const table = {}
const width = Math.max(...keys.map((k) => k.length))
for (const k of keys) {
  const row = engines.map((e) => (results[e.name][k] ? med(results[e.name][k]) : undefined))
  table[k] = Object.fromEntries(engines.map((e, i) => [e.name, row[i]]))
  let line = k.padEnd(width) + '  ' + row.map((v) => (v === undefined ? '-' : fmt(v)).padStart(12)).join('')
  if (engines.length === 2 && typeof row[0] === 'number' && typeof row[1] === 'number' && !k.endsWith('.count') && !k.endsWith('.exp') && row[0] > 0) {
    line += `  ${((row[1] / row[0] - 1) * 100).toFixed(1).padStart(7)}%`
  }
  console.log(line)
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ engines: engines.map((e) => e.name), runs: RUNS, table }, null, 2))
