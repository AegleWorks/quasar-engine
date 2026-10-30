# Browser bench — render, DOM y workers

Mide el pipeline real en Chrome, no en Node: cuánto tarda Quasar en producir el
HTML, cuánto cuesta insertarlo, cuánto layout provoca y cuánto tarda un worker
en devolverlo. Nació de la pregunta de si merece la pena mover el render fuera
del hilo principal en NovaLooky.

## Cómo correrlo

```bash
CORPUS_DIR="/ruta/a/BBCode-corpus/pages" npm run bench:browser -w @miliastry/quasar
```

- `CORPUS_DIR` por defecto es `~/Main Bridge/BBCode-corpus/pages`.
- Usa el Chrome del sistema vía Playwright (`channel: 'chrome'`).
- Las imágenes remotas se sustituyen por un PNG de 1×1 para que la red no
  contamine las medidas; el layout es el del HTML, sin las dimensiones de las
  imágenes reales.
- El bundle se compila con `NODE_ENV=production` (el `FREEZE_CHILDREN` de
  `GreenNode` apagado), que es lo que ve un usuario de la build.
- El resultado se escribe en `$BENCH_OUT` o en `$TMPDIR/quasar-browser-bench.json`.

Páginas medidas: la mediana del corpus (1,3 KB), una página «corriente» del
percentil 90 (10,6 KB), la patológica de 18275201 (58,5 KB → 1,9 MB de HTML) y
dos lotes: 300 páginas repartidas por toda la distribución y las 200 más
grandes (15,3 MB de HTML).

## Qué mide

| Métrica | Qué es |
|---|---|
| `renderMs` | `renderDetailed()`: parse + render de Quasar, en el hilo actual |
| `detachedParseMs` | `innerHTML = html` sobre un contenedor **fuera** del documento |
| `attachMs` | mover ese contenedor al DOM visible |
| `layoutMs` | `getBoundingClientRect()` que fuerza layout y estilos |
| `frameMs` | dos `requestAnimationFrame` desde después del layout; el idle base son ~33 ms |
| `warmRoundTripMs` | `postMessage` → render en worker → HTML de vuelta |
| `warmWorkerMs` | sólo el render dentro del worker (lo que reporta él mismo) |
| `startupMs` | crear los workers y esperar su primer mensaje |

## Resultados (Chrome 155, este equipo)

Ver `docs/16-Renderer-Benchmarks-and-Workers.md` para la tabla completa y las
conclusiones. En corto:

- Una página individual **no** gana con worker: 0,5 ms de ida y vuelta contra
  0,1 ms en el hilo principal en la mediana; en la patológica, 117 ms contra
  111 ms, más 21 ms de arranque.
- Los lotes sí: 8 workers bajan 120 páginas de 58 a 38 ms; 200 páginas grandes
  de 537 a 415 ms con 4 workers. El transporte del HTML pone el techo.
- En la página patológica el DOM pesa más que Quasar: 118 ms de render frente a
  60 ms de parseo desconectado + 290 ms de layout. Con `collapseBlankRuns`
  (medido como `dom.pathological.collapse`) esa página baja de 1,9 MB de HTML
  y 156.000 etiquetas a 15 KB y 276, con el mismo `scrollHeight`: 449 ms hasta
  layout pasan a 39 ms. En la rejilla de 24 tarjetas, 349 ms de layout pasan a
  29,5 (o 16,1 con `content-visibility: auto`).
- `dom.*.br` cambia cada línea vacía por un `<br>` sobre el string: se conserva
  como contraprueba (222 KB, 95 ms de layout), no como candidato.
- `dom.common.collapse` vigila que una página corriente no empeore.
