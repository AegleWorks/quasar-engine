import { defineConfig } from 'tsup'

/**
 * Build de publicación (`npm run build`).
 *
 * `tsc` emitía imports relativos sin extensión (válidos para bundlers, pero
 * rotos en Node ESM puro). tsup (esbuild) resuelve los imports y genera:
 *   - dist/index.js        (ESM)
 *   - dist/index.cjs       (CJS)
 *   - dist/index.d.ts      (types)
 * Los CSS de tema no se importan desde TS (los consumidores los importan por
 * ruta), así que `scripts/copy-css.mjs` los copia a dist/Visuals aparte.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  splitting: true,
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Sin dependencias runtime: el bundle es autocontenido.
  external: [],
})
