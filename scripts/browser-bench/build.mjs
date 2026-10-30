import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'dist'), { recursive: true })

const shared = {
  bundle: true,
  target: 'es2022',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}

await build({
  ...shared,
  entryPoints: [join(here, 'harness.ts')],
  format: 'esm',
  outfile: join(here, 'dist', 'harness.js'),
})

await build({
  ...shared,
  entryPoints: [join(here, 'worker.ts')],
  format: 'iife',
  outfile: join(here, 'dist', 'worker.js'),
})

console.log('built dist/harness.js and dist/worker.js')
