# 16. Renderer benchmarks, workers y DOM

Este documento recoge tres cosas que se midieron juntas y conviene no separar:

1. Las optimizaciones del renderer que **sí** quedaron.
2. Dos experimentos que se midieron, empeoraron y se revirtieron.
3. El pipeline completo en Chrome —render de Quasar, inserción en el DOM,
   layout y worker— con la pregunta de si mover el render a workers tiene
   sentido en NovaLooky.

Todo lo de abajo está medido, no estimado. El arnés del navegador vive en
`scripts/browser-bench/` y el bench de corpus en Node sigue siendo
`scripts/bench/run.mjs` y los scripts de `scratch/` usados durante la
investigación.

---

## 1. Lo que quedó

### Caché de URLs del purificador (`src/Osu/osuUrl.ts`)

El cache era un FIFO con `Map.keys().next()` para expulsar. Parece O(1) y no lo
es: con un working set justo por encima del tope (143.773 URLs distintas en el
corpus contra 131.072 entradas), cada llamada borraba la entrada más vieja y el
iterador del `Map` recorría la tabla llena de huecos para encontrar la
siguiente viva. Resultado: **38 µs por llamada**, diez veces más que calcular
la respuesta desde cero.

Cambios:

- Buffer circular de claves: expulsión O(1), sin preguntarle al `Map`.
- `normalizePercent` sólo corre si la cadena contiene `%`.
- `percentEncode` devuelve la cadena original si no escapó nada.

Medición aislada (339.778 URLs del corpus):

| | Antes | Después |
|---|---:|---:|
| Pasada caliente | 12.873 ms (38 µs/llamada) | 577–770 ms (1,7–2,3 µs/llamada) |

### Imagemaps (`src/Visitors/HTMLRenderer.ts`)

`isOsuImagemapAreaLine` hacía `line.search`, cuatro `exec(/^[0-9.]+/)` con un
`slice` por campo y un `test` final; `imagemapFields` creaba cinco objetos
`{value, at}` por línea. Ahora ambos leen `charCodeAt` y `imagemapFields` usa
escalares. Las líneas en blanco, la línea de URL y el cierre también se
comprueban sin regex.

### `trimOsuEdges`

`startsWith`/`endsWith` sobre un cuerpo renderizado (un rope de `+=`) hacen que
V8 aplane el string entero para mirar sus primeros/últimos bytes. Se sustituyen
por `startsWithAt`, que compara con `charCodeAt` y no aplana.

### Corpus (Node, 8.761 páginas, 75,4 MB de HTML)

| | Antes | Después |
|---|---:|---:|
| Parse | 1,35–1,41 s | 1,33–1,40 s |
| Render | 2,24–2,29 s | 2,10–2,14 s |
| Total | ~3,6 s | ~3,5 s |
| p50 por página | 0,19 ms | 0,17 ms |
| p90 | 1,27 ms | 1,17 ms |
| p99 | 5,59 ms | 5,10 ms |
| Peor página (18275201) | 161 ms | 144 ms |

El parser no cambió: se perfiló por fases (lexer ~267 ms, green ~949 ms, red
~185 ms por corpus) y no se encontró una mejora segura que justificara el
riesgo.

---

## 2. Experimentos revertidos

Se conservan aquí porque el resultado negativo es parte del mapa.

### `WeakMap` → `Map` en los memoizadores del modelo semántico

`OsuSemanticModel` memoiza los cuatro escaneos de saltos de línea por nodo. Un
`Map` fuerte parece más rápido en microbenchmark, pero mantiene vivos todos los
nodos del snapshot hasta que muere el modelo. En el corpus completo:

- `Map` fuerte: **~4,5 s** de total (25% más lento).
- `WeakMap`: ~3,6 s.

El colector acaba copiando árboles que el `WeakMap` deja ir en cuanto el render
deja de mirarlos. Revertido; el comentario en el archivo lo deja anotado.

### Estados de saltos de línea empaquetados en enteros

Los tres estados (`OpenState`, `CloseState`, `AfterCloseState`) se empaquetaron
en números (`newlines × 16 | blank × 8 | code`) para eliminar un objeto por paso
de cada caminata. La hipótesis era que esos objetos eran parte del GC.

Medición: **sin mejora apreciable** en render ni en GC (1,44 s de escaneos y
~2,2 s de GC, igual que con objetos). Más complejidad sin premio; revertido.

La lección: en este corpus el GC no lo dominan los objetos pequeños de estado,
sino los tokens, los nodos y el HTML.

---

## 3. Workers y DOM en Chrome

### Método

`scripts/browser-bench/` compila Quasar con esbuild (`NODE_ENV=production`) y
lo carga en Chrome 155 headless vía Playwright (`channel: 'chrome'`). Sirve las
páginas del corpus desde un servidor local; las imágenes remotas se sustituyen
por un PNG de 1×1 para que la red no contamine las medidas.

Se miden tres páginas y dos lotes:

- **mediana**: `osu/26095913`, 1,3 KB de fuente, 3,9 KB de HTML.
- **corriente**: `osu/12246812`, 10,6 KB de fuente, 25 KB de HTML (p90).
- **patológica**: `osu/18275201`, 58,5 KB de fuente, **1,94 MB de HTML** y
  156.000 etiquetas (52.000 líneas vacías).
- **lote 300**: 300 páginas repartidas por toda la distribución, 4,06 MB de
  HTML.
- **lote pesado 200**: las 200 páginas más grandes, 15,3 MB de HTML.

El contenedor replica la tarjeta de NovaLooky: `.card-frame` de 380×480,
`.card-page` de 924 px con `padding: 20px 22px` y `transform: scale(0.41)`.

### Página individual: hilo principal vs worker

`warmRoundTripMs` es `postMessage` → render en el worker → HTML de vuelta;
`warmWorkerMs` es sólo el render dentro del worker. El arranque del worker se
mide aparte (crear el Worker y esperar su primer mensaje).

| Página | Principal | Worker (ida y vuelta) | Render en worker | Arranque | Cold (arranque + 1.ª) |
|---|---:|---:|---:|---:|---:|
| Mediana (1,3 KB) | 0,10 ms | 0,5 ms | 0,4 ms | 15 ms | 6,6 ms |
| Corriente (10,6 KB) | 1,0 ms | 2,5 ms | 2,2 ms | 16 ms | 14,1 ms |
| Patológica (1,94 MB) | 120,6 ms | 159,9 ms | 119,3 ms | 21,2 ms | 140,3 ms |

**Conclusión:** para una página suelta, el worker pierde siempre en tiempo
hasta tener el HTML. En la mediana y en la corriente pierde por 2–25×; en la
patológica pierde ~30% (el coste de serializar 1,9 MB de HTML de vuelta). Lo
único que gana es que el hilo principal queda libre durante el render: la
interfaz no se congela 120 ms.

### Lotes: reparto entre workers

Tiempo desde el primer `postMessage` hasta la última respuesta. El arranque de
los workers no está incluido en `totalMs` (se muestra aparte).

| Lote | Principal | 2 workers | 4 workers | 8 workers | Arranque (8) |
|---|---:|---:|---:|---:|---:|
| 120 páginas (0,87 MB) | 61,2 ms | 63,6 ms | 44,7 ms (**−27%**) | 38,1 ms (**−38%**) | 30,4 ms |
| 300 páginas (4,06 MB) | 221,5 ms | 219,4 ms | 207,4 ms (−6%) | 220,9 ms (−0%) | 37,1 ms |
| Pesado 200 (15,3 MB) | 548,3 ms | 517,7 ms (−6%) | 420,9 ms (**−23%**) | 449,6 ms (−18%) | 29,6 ms |

**Conclusión:** los workers sí ganan en lotes, pero el techo lo pone el
transporte del HTML, no el render. Con 4,06 MB el 8.º worker ya no aporta; con
15,3 MB el óptimo es 4. Un pool persistente de ~4 workers es la configuración
razonable: pagar 20–30 ms de arranque una vez y repartir 120–200 páginas.

### Pipeline DOM: dónde se va el tiempo

Render de Quasar → `innerHTML` en un contenedor **desconectado** → mover al DOM
visible → `getBoundingClientRect()` (layout) → dos `requestAnimationFrame`.
El idle base de dos frames en este Chrome es ~33 ms.

| Página | Render | Parse desconectado | Attach | Layout | Total hasta layout | Frame |
|---|---:|---:|---:|---:|---:|---:|
| Mediana | 0,3 ms | 0,4 ms | 0,0 ms | 0,4 ms | 1,1 ms | 32,2 ms |
| Corriente | 2,3 ms | 1,4 ms | 0,4 ms | 2,3 ms | 6,4 ms | 26,9 ms |
| Patológica | 117,3 ms | **61,0 ms** | 2,5 ms | **280,4 ms** | **461,2 ms** | **68,2 ms** |

**La hipótesis se cumple, y con margen:** en la página patológica el DOM pesa
**cuatro veces más** que el render de Quasar. De los ~461 ms hasta tener layout:

- 117 ms (25%) son Quasar;
- 61 ms (13%) son parsear el HTML con `innerHTML`;
- 280 ms (61%) son layout/estilo de las 156.000 etiquetas.

Y el frame siguiente tarda ~68 ms (≈35 ms por encima del idle), así que el
pintado también se nota. Para una página corriente el pipeline completo son
~6 ms: no hay nada que optimizar ahí.

### Colapsar las rachas de saltos (`collapseBlankRuns`)

La página patológica tiene 52.000 líneas vacías, cada una un `<div
class="bb-empty-line"><br></div>`. Un render de sólo lectura no necesita un
elemento por línea vacía: el primero de la racha sigue siendo el `<br>` de
siempre y el resto se paga con **un** `<div>` de altura `n - 1` lh. El `lh`
resuelve contra el `line-height` heredado, así que la racha ocupa exactamente
lo mismo que las cajas de línea que sustituye.

La opción se llama `collapseBlankRuns` y está apagada por defecto. Exige
`idMode: 'none'` explícito y no admite `lineHandles`: el editor necesita un
elemento por línea para poner el caret, el clic y el resaltado, y el colapso
es justo lo contrario. `BBCodeBatchRenderer`, `renderBBCode` y
`BBCodeDocumentModel.renderForum` ya fuerzan `idMode: 'none'`, así que en el
camino de feed/preview basta con activarla.

Misma corrida, misma página, mismo Chrome:

| Patológica (18275201) | Sin colapsar | `collapseBlankRuns` |
|---|---:|---:|
| HTML | 1.938.284 B | **15.436 B** (126×) |
| Etiquetas | 156.190 | **276** |
| Render de Quasar | 115,1 ms | **37,8 ms** |
| Parse desconectado | 58,6 ms | **0,7 ms** |
| Layout | 272,7 ms | **0,8 ms** |
| Total hasta layout | 448,8 ms | **39,3 ms** |
| `scrollHeight` | 987.945 px | **987.945 px** |

El `scrollHeight` idéntico es la condición del experimento, no un extra: si el
espaciador midiera distinto, la comparación con el HTML de osu! dejaría de
valer. También se midió la variante de cambiar cada línea vacía por un `<br>`
suelto: baja a 222.878 B y 95,2 ms de layout, pero sigue dejando 52.226 cajas.
El colapso es el que ataca el número de cajas, que es lo que domina el layout.

En una página corriente no hay regresión: 6,2 ms → 4,9 ms hasta layout y el
mismo `scrollHeight`; el HTML crece 112 B porque un espaciador cuesta algo más
que una sola línea vacía, y sólo se usa en rachas de dos o más (donde empata o
gana).

En la rejilla de NovaLooky (24 tarjetas, la patológica primero) el layout de la
rejilla entera queda así:

| 24 tarjetas (parseo + attach + layout) | Tiempo |
|---|---:|
| Sin colapsar | 348,9 ms |
| `collapseBlankRuns` | 29,5 ms |
| Colapso + `content-visibility: auto` | 16,1 ms |

`content-visibility: auto` en `.card-frame` es seguro porque el alto de la
tarjeta es explícito: la tarjeta fuera de la ventana conserva su altura y se
salta layout y pintura. NovaLooky usa las dos cosas.

Supuesto de CSS: el espaciador mide `n - 1` veces el `line-height` heredado. Un
host que le diera a `.bb-empty-line` un `min-height` o márgenes mayores que su
caja de línea tendría que estilar `.bb-blank-run` igual; los estilos de osu!
de Quasar no lo hacen.

### Qué significa para NovaLooky

- **Página individual:** no mover a worker. El render ya cuesta 0,1–1 ms; un
  worker añade ida y vuelta y arranque. La excepción es aislar la página
  patológica para no congelar la UI, asumiendo ~30% más de latencia hasta el
  HTML.
- **Lotes / precarga:** sí, un pool de ~4 workers persistentes. La ganancia
  realista es 25–38% en lotes de 120–200 páginas; no escala a 8 cuando el HTML
  transferido supera unos pocos MB.
- **El siguiente cuello de botella no es el parser ni el render:** es el DOM.
  Colapsar las rachas de líneas vacías (`collapseBlankRuns`) ataca 331 ms de
  parseo + layout en la patológica sin mover el render a un worker, y deja el
  pipeline en 39 ms. Es lo que hace NovaLooky, junto con `content-visibility`
  en las tarjetas.
- Lo que queda por optimizar es el contenido real que sí se ve: imágenes (el
  bench las sustituye por un PNG de 1×1 y no mide su decodificación) y el
  número de bloques de una página, no sus líneas vacías.

### Limitaciones

- Headless Chrome en una sola máquina; los valores absolutos no son los de un
  portátil con la GPU activa.
- Las imágenes reales se sustituyen por un PNG de 1×1: no se mide su decodificación
  ni el layout que imponen sus dimensiones.
- No se carga el CSS de osu-web, así que el layout del HTML es el de los estilos
  de NovaLooky, no el de la web real.
- El `PerformanceObserver` de `longtask` no devolvió entradas en este Chrome
  headless; el bloqueo del hilo principal se mide directamente como el tiempo
  síncrono del lote.

## 4. Reproducir

```bash
CORPUS_DIR="/ruta/a/BBCode-corpus/pages" npm run bench:browser -w @miliastry/quasar
```

Los detalles de cada métrica están en
`scripts/browser-bench/README.md`.
