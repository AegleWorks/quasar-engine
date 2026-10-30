import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 43117)
const BASE = `http://127.0.0.1:${PORT}/`

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) resolve()
  })
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)))
})

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--js-flags=--expose-gc', '--disable-background-timer-throttling'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (url.hostname === '127.0.0.1' && url.port === String(PORT)) return route.continue()
  if (route.request().resourceType() === 'image') {
    return route.fulfill({ status: 200, contentType: 'image/png', body: pixel })
  }
  return route.abort()
})
const page = await context.newPage()
page.setDefaultTimeout(180000)
page.on('console', (message) => {
  if (message.type() === 'error') console.error('[page]', message.text())
})
page.on('pageerror', (error) => console.error('[pageerror]', error.message))

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForFunction(() => window.__benchReady === true)

const bench = (name, ...args) => page.evaluate(
  ({ name, args }) => window.__bench[name](...args),
  { name, args },
)

const results = {}
const take = async (label, promise) => {
  const value = await promise
  results[label] = value
  console.log(label.padEnd(34), JSON.stringify(value))
  return value
}

await take('meta', page.evaluate(() => window.__bench.meta))
await take('idleFrameMs', bench('idleFrame'))
await take('dom.average', bench('domPipeline', 'common', 7))
await take('dom.median', bench('domPipeline', 'median', 7))
await take('dom.pathological', bench('domPipeline', 'pathological', 5))
await take('dom.pathological.br', bench('domPipelineVariant', 'pathological', 'br', 5))
await take('dom.pathological.collapse', bench('domPipelineVariant', 'pathological', 'collapse', 5))
await take('dom.common.br', bench('domPipelineVariant', 'common', 'br', 5))
await take('dom.common.collapse', bench('domPipelineVariant', 'common', 'collapse', 5))

await take('grid.24.plain', bench('gridPipeline', 24, false, 3))
await take('grid.24.contentVisibility', bench('gridPipeline', 24, true, 3))
await take('grid.24.collapse', bench('gridPipeline', 24, false, 3, 'collapse'))
await take('grid.24.collapse.visibility', bench('gridPipeline', 24, true, 3, 'collapse'))

await take('single.common.main', bench('singleMain', 'common'))
await take('single.common.worker', bench('singleWorker', 'common'))
await take('single.median.main', bench('singleMain', 'median'))
await take('single.median.worker', bench('singleWorker', 'median'))
await take('single.pathological.main', bench('singleMain', 'pathological', 5))
await take('single.pathological.worker', bench('singleWorker', 'pathological', 5))

await take('batch.120.main', bench('batchMain', 120))
for (const workers of [2, 4, 8]) {
  await take(`batch.120.workers${workers}`, bench('batchWorkers', 120, workers))
}
await take('batch.300.main', bench('batchMain', 300))
for (const workers of [2, 4, 8]) {
  await take(`batch.300.workers${workers}`, bench('batchWorkers', 300, workers))
}

await take('heavy.200.main', bench('batchMain', 200, 'heavy'))
for (const workers of [2, 4, 8]) {
  await take(`heavy.200.workers${workers}`, bench('batchWorkers', 200, workers, 'heavy'))
}

const out = process.env.BENCH_OUT ?? join(tmpdir(), 'quasar-browser-bench.json')
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`results written to ${out}`)
await browser.close()
server.kill()
