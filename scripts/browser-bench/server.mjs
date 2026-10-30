import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
const CORPUS = process.env.CORPUS_DIR ?? join(process.env.HOME, 'Main Bridge/BBCode-corpus/pages')

const paths = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.bbcode')) paths.push(path)
  }
}
walk(CORPUS)

const rows = paths
  .map((path) => ({ path, bytes: readFileSync(path).length }))
  .filter((row) => row.bytes > 0)
  .sort((a, b) => a.bytes - b.bytes)

const pageAt = (fraction) => {
  const row = rows[Math.min(rows.length - 1, Math.floor(rows.length * fraction))]
  return { id: relative(row.path), source: readFileSync(row.path, 'utf8'), bytes: row.bytes }
}
const relative = (path) => path.slice(CORPUS.length + 1).replace(/\.bbcode$/, '')

const pathologicalPath = paths.find((path) => path.endsWith('/osu/18275201.bbcode'))
const pathological = {
  id: relative(pathologicalPath),
  source: readFileSync(pathologicalPath, 'utf8'),
  bytes: readFileSync(pathologicalPath).length,
}

const stride = Math.max(1, Math.floor(rows.length / 299))
const batch = []
for (let i = 0; i < rows.length && batch.length < 299; i += stride) {
  const row = rows[i]
  batch.push({ id: relative(row.path), source: readFileSync(row.path, 'utf8'), bytes: row.bytes })
}
if (!batch.some((page) => page.id === pathological.id)) batch.push(pathological)

const heavy = rows
  .slice(-200)
  .map((row) => ({ id: relative(row.path), source: readFileSync(row.path, 'utf8'), bytes: row.bytes }))
if (!heavy.some((page) => page.id === pathological.id)) heavy.push(pathological)

const pages = {
  median: pageAt(0.5),
  common: pageAt(0.9),
  pathological,
  batch,
  heavy,
}

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Quasar worker / DOM bench</title>
<style>
  html, body { margin: 0; background: #151015; color: #eee; font: 14px system-ui, sans-serif; }
  #stage { display: grid; grid-template-columns: repeat(3, 380px); gap: 16px; padding: 16px; }
  .card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid transparent; border-radius: 8px; background: #2a2028; }
  .card-frame { position: relative; width: 380px; height: 480px; overflow: hidden; background: #1c1719; }
  .card-page { width: 924px; padding: 20px 0; transform-origin: top left; background: #1c1719; pointer-events: none; }
  .bbcode-preview img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="stage"></div>
<script type="module" src="./harness.js"></script>
</body>
</html>`

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const send = (status, type, body) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(body)
  }
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', html)
  if (url.pathname === '/harness.js') return send(200, 'text/javascript', readFileSync(join(dist, 'harness.js')))
  if (url.pathname === '/worker.js') return send(200, 'text/javascript', readFileSync(join(dist, 'worker.js')))
  if (url.pathname === '/pages.json') return send(200, 'application/json', JSON.stringify(pages))
  if (url.pathname === '/pixel.png') return send(200, 'image/png', pixel)
  send(404, 'text/plain', 'not found')
})

const port = Number(process.env.PORT ?? 43117)
server.listen(port, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${port}`))
