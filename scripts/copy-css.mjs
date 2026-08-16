/**
 * Copia los CSS de tema de src/Visuals a dist/Visuals.
 * `tsc` solo emite JS/d.ts — los .css hay que copiarlos a mano para que el
 * paquete publicado incluya los estilos (los consumidores importan
 * `@miliastry/quasar/Visuals/osu.css` / `lyne.css`).
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src', 'Visuals')
const out = join(root, 'dist', 'Visuals')

mkdirSync(out, { recursive: true })
for (const file of readdirSync(src)) {
  if (file.endsWith('.css')) {
    cpSync(join(src, file), join(out, file))
    console.log('copied', `src/Visuals/${file}`, '→', `dist/Visuals/${file}`)
  }
}
