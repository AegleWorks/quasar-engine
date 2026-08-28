import { defineConfig } from 'tsup'

/**
 * Build de publicación (`npm run build`).
 *
 * `tsc` emitía imports relativos sin extensión (válidos para bundlers, pero
 * rotos en Node ESM puro). tsup (esbuild) resuelve los imports y genera:
 *   - dist/index.mjs       (ESM)
 *   - dist/index.js        (CJS)
 * Los CSS de tema no se importan desde TS (los consumidores los importan por
 * ruta), así que `scripts/copy-css.mjs` los copia a dist/Visuals aparte.
 *
 * ── Las declaraciones NO se generan aquí ──────────────────────────────
 *
 * `dts: true` usaba `rollup-plugin-dts`, y eso dejó de funcionar con
 * TypeScript 7: el paquete `typescript` ya no es el compilador en JavaScript,
 * es el port nativo en Go. Su entrada principal exporta DOS claves
 * (`version` y `versionMajorMinor`) y la API clásica —`ts.sys`,
 * `ts.createProgram`— se mudó a `typescript/unstable/*`. El plugin lee
 * `ts.sys.useCaseSensitiveFileNames` al cargarse y revienta antes de mirar
 * una línea de fuente. No es cosa suya: le pasa a cualquier herramienta
 * construida sobre esa API, y `experimentalDts` de tsup —que llama a
 * `ts.createProgram`— tropieza con lo mismo.
 *
 * Así que las emite el propio compilador, por su binario, en un paso aparte
 * del script `build` (ver `tsconfig.build.json`). Es la misma decisión que
 * tomó Next con su `useTypeScriptCli`: cuando la API deja de existir, se
 * llama al programa.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  target: 'es2022',
  splitting: true,
  clean: true,
  treeshake: true,
  sourcemap: false,
})
