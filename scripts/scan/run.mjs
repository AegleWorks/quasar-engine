#!/usr/bin/env node
// Scan: push a folder of userpages through Quasar and, optionally, osu!'s own pipeline.
//
//   node scripts/scan/run.mjs --src <dir> --out <file.jsonl> [--goldens <dir> | --osu]
//                             [--jobs 4] [--limit N] [--osu-harness <dir>]
//
// One line of JSON per `*.bbcode` under <src>: sizes and timings, Quasar's diagnostics by code,
// the tags used, and whether the osu! preview shows what osu! publishes (see scan.ts). The
// output is appended to as pages finish, and pages already in it are skipped, so a killed run
// resumes where it stopped. Delete <out> to start over.
//
//   --goldens <dir>  osu!'s HTML for each page, mirrored as <name>.osu.html (the harness's output).
//   --osu            run the harness first: regenerate-goldens.sh <src> <dir>/goldens beside <out>.
//                    Needs Docker and ~/Main Bridge/osu-harness (or --osu-harness).
//
// Needs `esbuild` and `jsdom` resolvable from the working directory (run it from the Miliastry
// monorepo root). Then: node scripts/scan/report.mjs <out>.

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const need = createRequire(join(process.cwd(), 'noop.js'))

/** `trim()` as PHP does it: space, \t, \n, \r, NUL, \v — nothing else. */
const phpTrim = (s) => s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '')

// ─── Worker: scan the pages of one shard ─────────────────────────────────────
if (has('worker')) {
  const { JSDOM } = need('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const k of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'NodeFilter', 'DocumentFragment']) {
    globalThis[k] = dom.window[k]
  }
  const { scanPage } = createRequire(import.meta.url)(flag('bundle'))
  const job = JSON.parse(readFileSync(flag('job'), 'utf8'))
  for (const p of job.pages) {
    // PHP's `trim()`, not JavaScript's: osu! runs the page through PHP trim(),
    // which keeps U+3000/U+00A0 (JS strips them), so trimming like JS made a
    // page ending in an ideographic space diverge on one side only.
    const source = phpTrim(readFileSync(join(job.src, p), 'utf8'))
    const base = job.goldens ? join(job.goldens, p.replace(/\.bbcode$/, '')) : null
    const golden = base && existsSync(`${base}.osu.html`) ? readFileSync(`${base}.osu.html`, 'utf8') : null
    const osuError = base && existsSync(`${base}.osu.error.txt`) ? readFileSync(`${base}.osu.error.txt`, 'utf8').trim() : null
    appendFileSync(job.part, JSON.stringify(scanPage(p, source, golden, osuError)) + '\n')
  }
  process.exit(0)
}

// ─── Parent ──────────────────────────────────────────────────────────────────
const SRC = flag('src') && resolve(flag('src'))
const OUT = flag('out') && resolve(flag('out'))
if (!SRC || !OUT || !existsSync(SRC)) {
  console.error('usage: node scripts/scan/run.mjs --src <dir> --out <file.jsonl> [--goldens <dir> | --osu] [--jobs N] [--limit N]')
  process.exit(2)
}
const JOBS = Math.max(1, Number(flag('jobs', Math.max(1, cpus().length - 1))))
const LIMIT = Number(flag('limit', Infinity))

let GOLDENS = flag('goldens') && resolve(flag('goldens'))
if (has('osu')) {
  GOLDENS = join(dirname(OUT), 'goldens')
  const harness = resolve(flag('osu-harness', join(homedir(), 'Main Bridge', 'osu-harness')))
  console.error(`osu!: ${harness}/regenerate-goldens.sh ${SRC} -> ${GOLDENS}`)
  execFileSync(join(harness, 'regenerate-goldens.sh'), [SRC, GOLDENS], { stdio: 'inherit' })
}

const pages = []
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.isDirectory()) walk(join(d, f.name))
    else if (f.name.endsWith('.bbcode')) pages.push(join(d, f.name).slice(SRC.length + 1))
  }
}
walk(SRC)

const done = new Set()
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) if (line) done.add(JSON.parse(line).name)
}
const todo = pages.filter((p) => !done.has(p)).slice(0, LIMIT)
console.error(`${pages.length} pages, ${done.size} already scanned, ${todo.length} to do, ${JOBS} jobs${GOLDENS ? '' : ', no osu! goldens'}`)
if (todo.length === 0) process.exit(0)

const esbuild = need('esbuild')
const work = mkdtempSync(join(tmpdir(), 'quasar-scan-'))
const bundle = join(work, 'scan.cjs')
await esbuild.build({
  entryPoints: [join(HERE, 'scan.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: bundle, logLevel: 'error',
})

mkdirSync(dirname(OUT), { recursive: true })
const t0 = Date.now()
const shards = Array.from({ length: Math.min(JOBS, todo.length) }, (_, i) => todo.filter((_, k) => k % JOBS === i))
await Promise.all(shards.map((shard, i) => new Promise((ok, fail) => {
  const job = join(work, `job${i}.json`)
  writeFileSync(job, JSON.stringify({ src: SRC, goldens: GOLDENS ?? null, part: `${OUT}.part${i}`, pages: shard }))
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '--bundle', bundle, '--job', job], { stdio: 'inherit' })
  child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`worker ${i} exited ${code}`))))
})))

for (let i = 0; i < shards.length; i++) {
  const part = `${OUT}.part${i}`
  if (existsSync(part)) {
    appendFileSync(OUT, readFileSync(part))
    rmSync(part)
  }
}
rmSync(work, { recursive: true, force: true })
const secs = (Date.now() - t0) / 1000
console.error(`scanned ${todo.length} pages in ${secs.toFixed(1)}s (${(todo.length / secs).toFixed(0)}/s) -> ${OUT}`)
