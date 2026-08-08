# 🌌 Quasar — Auditoría de Rendimiento y Roadmap de Optimización

> Auditoría estricta del motor completo (126 ficheros, ~17k LOC) realizada el **2026-07-31**.
> Todas las cifras de este documento son **medidas**, no estimadas. La metodología está al final.
>
> **Estado:** Semanas 1 a 11 ✅ completadas. **La auditoría está cerrada**: los cuatro
> pilares que el motor declaraba y no ejecutaba —*structural sharing*, *parseo incremental*,
> *identidad estable de nodos*, *offsets fiables*— funcionan y están validados diferencialmente.

---

## Índice

- [0. Veredicto](#0-veredicto)
- [1. Tabla de resultados](#1-tabla-de-resultados)
- [2. Hallazgos — Tier S (roto)](#2-hallazgos--tier-s-roto)
- [3. Hallazgos — Tier A (rendimiento)](#3-hallazgos--tier-a-rendimiento)
- [4. Hallazgos — Tier B (arquitectura)](#4-hallazgos--tier-b-arquitectura)
- [5. Semana 1 — Parar la hemorragia ✅](#5-semana-1--parar-la-hemorragia-)
- [6. Semana 2 — El 10× de verdad ✅](#6-semana-2--el-10-de-verdad-)
- [7. Semana 3 — Deuda estructural ✅](#7-semana-3--deuda-estructural--salvo-el-bloque-14--9)
- [7-bis. Semana 4 — La partición y el incremental ✅](#7-bis-semana-4--la-partición-y-el-incremental-)
- [7-ter. Semana 5 — Structural sharing de verdad ✅](#7-ter-semana-5--structural-sharing-de-verdad-)
- [7-quater. Semana 6 — El lexer ✅](#7-quater-semana-6--el-lexer)
- [7-quinquies. Semana 7 — Granularidad del incremental ✅](#7-quinquies-semana-7--granularidad-del-incremental)
- [7-sexies. Semana 8 — El parser ✅](#7-sexies-semana-8--el-parser)
- [7-septies. Semana 9 — El diff de `applyTextUpdate` ✅](#7-septies-semana-9--el-diff-de-applytextupdate)
- [7-octies. Semana 10 — `analyze()` ✅](#7-octies-semana-10--analyze)
- [7-nonies. Semana 11 — El memo de corchetes ✅](#7-nonies-semana-11--el-memo-de-corchetes-del-lexer)
- [8. Metodología de medición](#8-metodología-de-medición)

---

## 0. Veredicto

La arquitectura *sobre el papel* es correcta (Roslyn green/red, parseo incremental, pipeline de passes).
Pero el motor **no ejecutaba esa arquitectura**. Tres de sus cuatro pilares —*structural sharing*,
*parseo incremental*, *identidad estable de nodos*— estaban rotos o desconectados en runtime.

`QUASAR.MD §3` declara un presupuesto de **140 FPS / < 0.2 ms**. La medición real de partida
fue **290 ms por pulsación de tecla**: un factor **1450×** por encima del objetivo autoimpuesto.

---

## 1. Tabla de resultados

Documento de referencia: `src/problematic_sectionwgradient.milia` — 19.6 KB, 1736 nodos.

| Métrica | Baseline | Tras Semana 1 | Tras Semanas 2-3 | Objetivo |
|---|---|---|---|---|
| Vectores XSS vivos en el preview | 5 | **0** ✅ | 0 | — |
| Lexer, 16k `[` sin cerrar | 555.56 ms | **2.72 ms** ✅ | 2.72 ms | — |
| `NodeMatcher.match` (1 char) | 380.2 ms | 5.14 ms | **~0** ✅ (perezoso) | ~1 ms |
| **`DocumentModel.rebuild`** | 290.4 ms | 15.13 ms | **3.81 ms** ✅ | < 5 ms |
| **`HTMLRenderer.render`** | 1.95 ms | 1.43 ms | **0.290 ms** ✅ | < 0.3 ms |
| `render`, 4000 hermanos | 14.11 ms | 14.11 ms | **1.25 ms** ✅ | lineal |
| **`greenToRedNode`** | 3.95 ms | 2.13 ms | **0.252 ms** ✅ | < 0.8 ms |
| `new BBCodeDocumentModel` | 5.92 ms | 5.85 ms | **2.88 ms** ✅ | — |
| HTML emitido (doc de 19.2 KB) | — | 140.6 KB | **88.7 KB** ✅ | — |
| `parseTokensToGreen` | 0.583 ms | 0.546 ms | 0.644 ms | — |
| Errores `tsc --noEmit` | 48 | **0** ✅ | 0 ✅ | 0 (gate en CI) |
| Diagnósticos que el motor emitía | **0** (3 de 4 validadores inalcanzables) | 0 | **funcionan + `unclosed-tag` nuevo** ✅ | — |
| Suite de tests | 4 rojos + 60% flake | 170 verdes + 1 `expected fail` | **195 verdes, sin `expected fail`** ✅ | — |

### Semana 4 — lo que añadió

| Métrica | Antes (semana 3) | Tras Semana 4 | Nota |
|---|---|---|---|
| Documentos cuyo árbol particiona la fuente | **12.42%** | **100%** ✅ | 18.017 documentos |
| Violaciones de partición en el corpus | 270.771 | **0** ✅ | 5 tipos distintos |
| Punto fijo de `parse → export` | 99.67% | **100%** ✅ | el borrado de huérfanos lo rompía |
| Ediciones incrementales con árbol correcto | 3 de 6 escenarios | **22.100 de 22.100** ✅ | validación diferencial |
| Coste por pulsación (fixture 19.6 KB) | 2.78 ms (rebuild) | **1.22 ms** ✅ (−56%) | 100% de aciertos del incremental |
| Suite de tests | 195 verdes | **243 verdes** ✅ | +40 de partición, +8 de incremental |

### Semana 5 — lo que añadió

| Métrica | Antes | Tras Semana 5 | Nota |
|---|---|---|---|
| Deduplicación real de nodos verdes | **0%** | **59,6%** ✅ | 1736 nodos → 702 objetos |
| `collisionHits` del interner | 0 | **226** ✅ | el interning de nodos internos funciona |
| Memoria del árbol verde | 258 KB | **148 KB** (`leaves`) / **114 KB** (`full`) | −42% / −56% |
| Interner ON vs OFF: árbol, HTML, export, partición | *offsets mentían* | **100% idéntico** ✅ | 18.016 documentos, ambos modos |
| `shiftGreen` en el splice incremental | 14% del reparse | **eliminado** ✅ | ya no hay nada que desplazar |
| Suite de tests | 243 verdes | **259 verdes** ✅ | +16 de sharing |

### Semana 6 — el lexer

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| `scanBBCode`, fixture 19,6 KB | 0,618 ms | **0,278 ms** ✅ | **2,22×** |
| `scanBBCode`, 20 KB muy etiquetado | 0,576 ms | **0,263 ms** ✅ | 2,19× |
| `scanBBCode`, 20 KB en MAYÚSCULAS | 0,563 ms | **0,290 ms** ✅ | 1,94× |
| `scanBBCode`, 20 KB de texto plano | 0,073 ms | **0,058 ms** ✅ | 1,27× |
| **Coste por pulsación** | 1,09 ms | **0,905 ms** ✅ | −17% |
| Flujo de tokens vs el lexer anterior | — | **idéntico** ✅ | 56.049 docs, 776.021 tokens |
| Suite de tests | 259 verdes | **308 verdes** ✅ | +49, el lexer no tenía ninguno |

### Semana 7 — granularidad del incremental

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| `parse` por pulsación dentro de `[notice]` | 0,267 ms | **0,0098 ms** ✅ | **27×** — la región deja de ser el 66% del documento |
| Reparse dentro de `[notice]` | 0,688 ms | **0,378 ms** ✅ | −45% |
| Escribir al final del post | *rebuild completo* | **0,657 ms** ✅ | 43/43 aciertos; antes 0/43 |
| Pulsación con el caret al final | 1,92 ms | **0,657 ms** ✅ | −66% |
| Divergencias vs rebuild | — | **0 de 32.100** ✅ | fuzz diferencial |
| Suite de tests | 308 verdes | **311 verdes** ✅ | +3 de edición en raíz |

### Semana 8 — el parser

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| `parseTokensToGreen`, fixture 19,6 KB | 0,480 ms | **0,314 ms** ✅ | **1,53×**, A/B alternado contra HEAD |
| `Object.freeze` por nodo | 30% del parser | **0** en producción | se conserva en dev y en tests |
| Árbol idéntico al parser anterior | — | **196.076 parseos** ✅ | 1.985.691 nodos, 0 divergencias |
| Coste por pulsación | 0,698 ms | 0,700 ms | sin cambio, y es lo esperado |

### Semana 9 — el diff de `applyTextUpdate`

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| Pulsación, edición **en medio** | 0,702 ms | **0,620 ms** ✅ | −12%, A/B contra HEAD |
| Pulsación, **añadir al final** | 0,617 ms | 0,627 ms | sin cambio (ver abajo) |
| `TextChange` idéntico al anterior | — | **253.902 pares** ✅ | 0 divergencias |

### Semana 10 — `analyze()`

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| `analyze()`, documento limpio | 0,601 ms | **0,295 ms** ✅ | **2,0×**, mediana de 7 tandas |
| `analyze()`, documento lleno de errores | 1,58 ms | **1,12 ms** ✅ | 1,4× |
| `rebuild` con análisis | 2,74 ms | **2,03 ms** ✅ | −26% |
| Diagnósticos y su asignación a nodos | — | **idénticos** ✅ | 20.002 docs, 18.929 con diagnósticos |

### Semana 11 — el memo de corchetes del lexer

| Métrica | Antes | Después | Nota |
|---|---|---|---|
| `scanBBCode`, fixture 19,6 KB | 0,286 ms | **0,226 ms** ✅ | −21% |
| `scanBBCode`, 20 KB muy etiquetado | 0,283 ms | **0,199 ms** ✅ | −30% |
| `scanBBCode`, 16k corchetes sin cerrar | 1,996 ms | 2,004 ms | **sin cambio** — el arreglo del cuadrático sigue intacto |
| Flujo de tokens | — | **idéntico** ✅ | 56.012 docs, 882.752 tokens |

### Desglose del pipeline (baseline)

| Fase | ms | Nota |
|---|---|---|
| `scanBBCode` (lex) | 0.91 | aceptable |
| `parseTokensToGreen` | 0.82 | aceptable |
| **`greenToRedNode`** | **3.95** | más lento que lex+parse juntos |
| `HTMLRenderer.render` | 1.95 | sin caché |
| `new BBCodeDocumentModel` | 5.92 | por llamada |
| **`rebuild()` con matcher** | **290** | 🔴 |

---

## 2. Hallazgos — Tier S (roto)

### S1 · `GreenNode._hash` no existía — structural sharing era ficción ✅ RESUELTO

`GreenNodePool` y `RedNodeStore` leían una propiedad que la clase nunca definía:

```
src/Syntax/GreenNodePool.ts:151   h = this.hashCombine(h, children[0]._hash)   // undefined
src/Syntax/RedNodeStore.ts:52     const hash = green._hash.toString()          // TypeError
```

Consecuencias:
- `RedNodeStore.getOrCreate()` lanzaba `TypeError` en su primera línea. **Nunca se ejecutó.**
- `computeBucketKey()` hacía `seed ^= undefined` → coacciona a `0` → la clave **ignoraba los hijos**.
  Todos los `<kind, text, childCount>` iguales caían en el mismo bucket → interning `O(N)` por nodo → **`O(N²)` global**.

**Resuelto:** `_hash` implementado (FNV-1a, memoizado, *excluyendo el rango*). `RedNodeStore` ya
funciona: **53.5% de dedup** en un documento real.

### S2 · `internLeaf` devuelve rangos incorrectos ✅ RESUELTO (Semana 5) — ver §7-ter

```ts
// GreenNodePool.ts:68
const key = `${kind}:${text}`   // sin start/end
```

La clave ignora la posición: la segunda aparición de `"Hello"` devuelve el nodo cacheado
**con el rango de la primera**. Si se activa el interner, todo lo que depende de offsets
(incremental, `findNodeAtOffset`, diagnósticos, mapeo Monaco↔AST) empieza a mentir en silencio.

Además `internNode` (`GreenNodePool.ts:108-109`) exige `range.start`/`range.end` idénticos para
deduplicar → el mismo bloque pegado 10 veces da **0% de dedup y 100% del coste de escaneo**.
Confirmado tras arreglar `_hash`: `collisionHits: 0`.

### S3 · `NodeMatcher` — 380 ms por carácter escrito ✅ RESUELTO

Dos fallos multiplicándose:

1. **La Fase 1 (match por ID) nunca acertaba.** `RedNode` genera `createNodeId()` fresco en cada
   construcción → tras un `rebuild()` ningún ID coincide. `exact: 0`. Siempre.
2. **La Fase 2 era `O(n² · subárbol)`**: bucle anidado que recomputaba `fingerprint()` (un `walk()`
   completo con array de strings + `join()`) en cada comparación. 1736 × 1736 fingerprints.

Bonus: el resultado era **incoherente** — `moved: 1734` y `deleted: 1736` a la vez, porque la Fase 2
borraba de `unmatchedNew` pero nunca de `unmatchedOld` (`NodeMatcher.ts:133`).

**Resuelto:** fingerprints memoizados bottom-up (64 bits, dos lanes FNV) + índice por bucket con
cursor. Escalado ahora lineal. Coherencia arreglada: 1736 clasificaciones para 1736 nodos.

### S4 · XSS activo en el preview ✅ RESUELTO

`escapeHtml` cubría `& < > "` pero los valores de estilo se inyectaban **sin escapar ninguno**:

```
IN : [color=red;" onmouseover="alert(1)]hola[/color]
OUT: <span style="color:red;" onmouseover="alert(1);">hola</span>
                       ↑ atributo de evento real y funcional
```

Vectores confirmados: `color`, `size`, `font`, `shadow` (`HTMLRenderer.ts:218-240`) y `gradient`
(`:432` — el filtro `startsWith('#')` no salvaba nada: `#a" onmouseover="…` pasa).
Llegaba a `morphHTML()` / `dangerouslySetInnerHTML` en `Preview.tsx:56`,
`preview-panel.tsx:124`, `SnippetsWindow.tsx:309`.

**Resuelto:** `escapeHtml` escapa también `'`, y los valores CSS pasan por allowlists
(`CSS_COLOR_RE`, `CSS_SIZE_RE`, `CSS_FONT_RE`). Verificado: 0 inyecciones, render de BBCode válido
idéntico.

### S5 · El parser incremental deja el árbol mintiendo ✅ RESUELTO (Semana 4) — ver el punto 9

`IncrementalParser.reparse()` sustituye un subárbol in-place pero **nunca desplaza los offsets de
hermanos ni ancestros**. El propio código lo admite:

```ts
// IncrementalParser.ts:78
// Tree ranges are stale (after fast-path appends without range updates).
```

Y en vez de arreglarlo, hace un rebuild completo cuando detecta la corrupción. Peor:

```ts
return { green: newRootRed.green, ... }   // :151, :202
```

Devuelve el **green node viejo** de la raíz → `_greenRoot` y `_redRoot` quedan desincronizados
permanentemente tras la primera edición incremental.

Además `BBCodePipeline.process()` devuelve **la misma referencia** `this._model.redRoot` mutada
in-place: cualquier consumidor React que compare `prevAst !== nextAst` no ve nada.

### S6 · Lexer `O(n²)` con corchetes sin cerrar ✅ RESUELTO

Para cada `[`, se escaneaba hasta encontrar `]`; si no había, se escaneaba **hasta el final** y se
avanzaba *un solo carácter*.

| Entrada | Antes | Ahora |
|---|---|---|
| 2000 `[` sin cerrar | 12.25 ms | ~1 ms |
| 4000 `[` | 36.29 ms | ~1 ms |
| 8000 `[` | 143.38 ms | ~2 ms |
| 16000 `[` | **555.56 ms** | **2.72 ms** |

DoS por pegado: cualquier snippet de código o ASCII art con corchetes congelaba el editor.

**Resuelto:** un solo barrido descubre el `]` de *todos* los `[` que atraviesa vía la pila de
corchetes, y memoiza. `O(n²)` → `O(n)`.
**Validado diferencialmente** contra el algoritmo anterior: 149.894 posiciones comparadas,
**0 discrepancias** + 50.000 documentos aleatorios con cobertura contigua intacta.

---

## 3. Hallazgos — Tier A (rendimiento)

### A1 · `greenToRedNode` — 90% es ceremonia ✅ RESUELTO (Semana 2)

```
greenToRedNode (real)              2.59 ms
walk equivalente sin ceremonia     0.27 ms   ← 9.6×
walk + randomUUID                  0.78 ms
```

El coste no es construir el árbol, es:
- **`crypto.randomUUID()` por nodo** (1736 UUIDs). Además son 36 caracteres que se escupen en *cada*
  elemento HTML como `data-node-id` → HTML inflado y morphing más lento. Un contador monótono es
  ~7× más rápido y 4× más corto. La aleatoriedad no aporta nada: no son IDs distribuidos.
- **`RedNode.allowMutation(() => {...})` por nodo** — closure + `try/finally` + flag estático, 1736
  veces, para poblar hijos recién creados.
- **`extractGreenNodeMetadata`** aloja dos closures (`firstChildText`, `stripBBCode`) **por nodo**
  aunque el `switch` no las use.

### A2 · `previousSibling` / `nextSibling` / `index` son `O(n)` ✅ RESUELTO (Semana 2)

```ts
// RedNode.ts:132, 139, 146
const idx = this.parent.children.indexOf(this)
```

`HTMLRenderer.isPrevBlockBoundary()` (`:177`) recorre hermanos hacia atrás en bucle, y **cada paso
hace un `indexOf`** → render cuadrático:

| Hermanos raíz | ms |
|---|---|
| 500 | 0.96 |
| 1000 | 1.97 |
| 2000 | 5.33 |
| 4000 | **14.11** ← 2.6× por duplicación |

**Fix:** cachear `indexInParent` en el `RedNode`, invalidado en las mutaciones estructurales (que ya
pasan todas por `assertMutating`). Tres getters `O(n)` → `O(1)`, render lineal.

> Nota: `NodeMatcher` ya no usa el getter `index` (Semana 1 lo precomputa en su traversal), pero el
> `HTMLRenderer` y el `QueryEngine` sí siguen usándolo.

### A3 · Cero caché de render ⛔ DESCARTADO (Semana 2) — ver el aviso del punto 8

`RedNodeStore.ts:21` promete *"HTMLRenderer cache: same canonicalId = same HTML"*. **No existe.**
Cada pulsación re-renderiza el documento entero a string. Con `_hash` (ya disponible) + memo por
hash el hit ratio sería altísimo: el 99% del árbol no cambia entre teclas.

### A4 · `HTMLRenderer` construye strings por concatenación ✅ RESUELTO (Semana 2) — pero el cuello era `escapeHtml`

Cada `wrapInline`/`wrapBlock` hace `children.map(...).join('')` + template literal → dos arrays
intermedios y N strings temporales por nodo. Un `string[]` acumulador único en pre-orden elimina
casi todo.

Detalle: `this.depth` y `this.inlineLevel` se incrementan y decrementan religiosamente y
**no se leen nunca**. Estado muerto en el bucle caliente.

### A5 · Opciones descartadas en silencio ✅ RESUELTO (Semana 3)

```ts
// BBCodeDocumentModel.ts:48
super({ source: '', language: options.language ?? 'bbcode' })
```

`autoAnalyze` y `maxUndo` **nunca llegan a `DocumentModel`**. Verificado: pasar
`autoAnalyze: false` no cambia el tiempo. No se puede desactivar el análisis semántico.

`QuasarEngineService.parse()` (`:35`) construye un `BBCodeDocumentModel` completo por llamada
—instanciando `TagRegistry`, `NodeFactory`, `TreeBuilder`, `NodeMatcher`, `SemanticAnalyzer`,
`IncrementalParser`, `ChangeTracker`, `UndoManager`, `QueryEngine`, `EventBus`— para un parse de
usar y tirar. `SnippetsWindow` lo llama por cada snippet.

### A6 · `analyze()` es `O(N · D)` innecesariamente ✅ RESUELTO (Semana 3) — pero D era 0, ver el punto 15

`DocumentModel.analyze():404` hace un `walk()` completo para vaciar diagnósticos y luego un
`findById()` (`O(N)`) **por cada diagnóstico**. El `Map<id, node>` ya se construye dentro de
`SemanticAnalyzer.analyze()` — basta devolverlo.

### A7 · `ASTOptimizer` clona con `JSON.parse(JSON.stringify(...))` ✅ RESUELTO (Semana 3)

Cuatro sitios (`:84, :117, :123, :151`) y dos comparaciones por `JSON.stringify` (`:192-193`).
Deep-clone y deep-equal por serialización en un transformador que recorre todo el árbol.

### A8 · `DOMMorpher` sin keys ✅ RESUELTO (Semana 3) — pero no con keys, ver el punto 12

`morphNodes` empareja hijos **por índice**. Insertar un nodo al principio provoca una cascada de
`replaceChild` sobre todo lo que sigue — justo lo que un morpher debe evitar. Ya se emite
`data-node-id` en cada elemento: usarlo como key (como `morphdom`/`idiomorph`).
Además `Array.from(childNodes)` en cada nivel de recursión.

---

## 4. Hallazgos — Tier B (arquitectura)

### B1 · `tsc` no compilaba — 48 errores ✅ RESUELTO

Incluidos 3 que eran un **crash real en runtime** (`_hash`). `tsc` lo detectaba desde siempre;
simplemente nadie ejecutaba `tsc`.

Dos bugs latentes descubiertos al arreglar los tipos:

- **`MarkdownExporter.extractValue` leía `node.properties` / `node.attributes`**, que no existen en
  `RedNode` → devolvía `undefined` siempre. La exportación a Markdown llevaba desde siempre
  perdiendo destinos de enlace y títulos de quote/box. ✅ Reescrito.
- **`MarkdownToGreenNode` descartaba `image` y `code_inline`** (caían en `default` como texto vacío).
  ✅ Añadidos, y el `default` es ahora un guard de exhaustividad (`const unhandled: never = node`).
- `MarkdownSpoiler`/`MarkdownNotice` añadidos al union: el parser ya los producía con `as any`.

### B2 · El "lock de mutación" no protege nada ✅ RESUELTO (Semana 3) — ver el punto 13

`RedNode.assertMutating()` es un flag estático **global**. `allowMutation()` lo activa para todo el
proceso. No hay aislamiento por documento, transacción ni hilo. Es un `console.assert` caro
disfrazado de invariante — y el árbol rojo se muta libremente desde `IncrementalParser`,
`treeTransformers`, `Transaction` y `RedNodeStore`. La "inmutabilidad estricta" que `QUASAR.MD §3`
invoca para justificar la tolerancia a concurrencia **no está en el código**.

### B3 · Lógica duplicada palabra por palabra ✅ RESUELTO (Semana 3)

`RedNodeStore.extractIntrinsicMetadata()` (`:133-183`) es una **copia literal** de
`BBCodeToGreenNode.extractGreenNodeMetadata()` (`:184-236`). El propio comentario lo dice:
*"Mirrors extractGreenNodeMetadata"*. Dos fuentes de verdad para el mapeo attrs→metadata.

### B4 · Código muerto declarado como feature ✅ RESUELTO (Semana 3)

- `const SELF_CLOSING = new Set<string>([])` (`Parser.ts:39`) — **vacío**. Todas las ramas
  `SELF_CLOSING.has(...)` son inalcanzables.
- `IncrementalParser.fullReparse()` ignora el parser y devuelve el documento entero como **un único
  nodo de texto**. Si algo la llama, destruye el árbol.
- `SAFE_BOUNDARY_TAGS` es un array con `.includes()` en el bucle de ascenso (`:102`) → debería ser `Set`.
- Bloques copy-paste inertes en el lexer (asignan variables y las reasignan idénticas dos líneas después).

### B5 · Los tests mentían sobre el estado del motor ✅ RESUELTO (parcial)

- ✅ **4 tests permanentemente rojos** por `src/document_test.milia`, que no existe ni en el
  historial de git. Borrados (aprobado por el usuario), junto a `UrlImgBugEngine.test.ts` que
  importaba `../Engine/QuasarEngine` (inexistente) y era un duplicado sin aserciones de
  `UrlImgBug.test.ts`.
- ✅ **El fuzzer usaba `Math.random()` sin semilla.** Medido: `pass, FAIL, FAIL, FAIL, pass`
  → **60% de flake**, y cuando fallaba el payload se perdía. Ahora usa mulberry32 con semilla fija
  y override por `QUASAR_FUZZ_SEED`. Determinista 5/5.
- ✅ **`ASTOptimizer` no es idempotente** — resuelto en la Semana 3, punto 11.
- ⏳ Varios tests son `console.log` sin aserciones (`StudioDebugText`, `UrlImgBug`,
  `ProblematicSection`): imprimen, no verifican.

---

## 5. Semana 1 — Parar la hemorragia ✅

**Completada el 2026-07-31.** Suite: 170 verdes + 1 `expected fail`, determinista 5/5. `tsc`: 0 errores.

| # | Tarea | Estado |
|---|---|---|
| 1 | Escapar atributos + allowlist de valores CSS (S4) | ✅ |
| 2 | Cachear el fallo de `indexOf(']')` en el lexer (S6) | ✅ |
| 3 | Reescribir la Fase 2 de `NodeMatcher` + arreglar `unmatchedOld` (S3) | ✅ |
| 4 | `tsc --noEmit` en CI + arreglar los 13 errores de `src/` (B1) | ✅ |

### Ficheros tocados

```
src/Syntax/hash.ts                        NUEVO — primitivas FNV-1a compartidas
src/Syntax/GreenNode.ts                   _hash real (lazy, sentinela -1, `declare`)
src/Syntax/NodeMatcher.ts                 reescritura de fases 1-3
src/Lexer/BBCodeLexer.ts                  memo de emparejamiento de corchetes
src/Visitors/HTMLRenderer.ts              allowlists CSS + escapado de `'`
src/Visitors/MarkdownExporter.ts          extractValue arreglado (bug latente)
src/BBCode/Parser.ts                      cast NodeKind
src/Markdown/MarkdownAST.ts               + MarkdownSpoiler, MarkdownNotice
src/Markdown/MarkdownParser.ts            quitados dos `as any`
src/Markdown/MarkdownToGreenNode.ts       + image, code_inline, guard de exhaustividad
src/Studio/index.ts                       desambiguación de ColorStop
src/Tests/Fuzzer.test.ts                  mulberry32 con semilla
src/Tests/ASTOptimizerIdempotence.test.ts NUEVO — repro fijado del bug de idempotencia
src/Diff/__tests__/TreeDiffer.test.ts     tipos NodeId/NodeKind + imports vitest
src/Incremental/__tests__/…test.ts        TextChange sin `kind`
package.json                              scripts typecheck / verify
../../.github/workflows/quasar-verify.yml NUEVO — gate de CI
BORRADOS: StudioExport/Structure/Text/Equality.test.ts, UrlImgBugEngine.test.ts
```

### Trampa encontrada durante la implementación

El campo `_hashCache` costaba **23% del parseo** (0.583 → 0.718 ms). Con `target: ES2022`,
TypeScript activa `useDefineForClassFields` por defecto, así que una declaración de campo emite un
`defineProperty` en **cada construcción**. Solución: `private declare _hashCache: number` +
asignación en el constructor con centinela `-1`. Resultado: **0.546 ms**, por debajo del baseline.

> ⚠️ Esta trampa aplica a **cualquier campo nuevo** que se añada a `GreenNode` o `RedNode`.
> Medir siempre antes y después.

---

## 6. Semana 2 — El 10× de verdad ✅

**Completada el 2026-07-31.** Ambos objetivos alcanzados: `rebuild` 15.13 → **3.81 ms** (< 5) y
`render` 1.43 → **0.290 ms** (< 0.3). Suite: 170 verdes + 1 `expected fail`. `tsc`: 0 errores.

Orden de ataque: 6 → 7 → 8 → 5, elegido para no bloquear la semana tras el cambio estructural.

### 6. IDs monótonos + `indexInParent` cacheado (A1, A2) ✅

- `createNodeId()` pasa de `crypto.randomUUID()` a un contador monótono (`n0`, `n1`, …).
  Verificado antes de tocar nada: los `NodeId` **nunca se restauran desde persistencia**, solo se
  escriben, así que la aleatoriedad no aportaba nada. **HTML emitido: 140.6 → 88.7 KB (−37%)**.
- `indexInParent` cacheado con un diseño **auto-validante**: el getter confía en el índice solo si
  `parent.children[cached] === this`, y recomputa si no. Esa única comparación por referencia lo
  hace inmune al código que muta el array directamente (`treeTransformers` hace
  `cloned.children = []`), que es justo donde un caché con invalidación explícita mentiría en
  silencio. Además se siembra el índice en `appendChild`, así que la construcción nunca busca.
- Validado diferencialmente contra `indexOf`: **35.111 nodos, 0 discrepancias**, incluyendo
  5.382 mutaciones estructurales y manipulación directa del array a espaldas del caché.
- Render de 4000 hermanos: **14.11 → 5.20 ms** (ya lineal en este punto).

### 7. Quitar `allowMutation` del camino de construcción (A1) ✅

- Nuevo `RedNode.initChildren(children)`: adopta el array entero de una vez, fuera del lock. Antes
  se llamaba `allowMutation(() => { for (…) appendChild(…) })` **una vez por nodo** — 1736 closures,
  1736 `try/finally` y 1736 guardas de flag estático por parseo.
- Aplicado a los cuatro constructores de árbol rojo (`BBCodeToGreenNode`, `MarkdownToGreenNode`,
  `HTMLToGreenNode`, `UIBlocksToRedTree`) y a `RedNodeStore`.
- `extractGreenNodeMetadata`: las dos closures (`firstChildText`, `stripBBCode`) subidas a nivel de
  módulo — se alojaban por nodo aunque el `switch` no las usara.
- **`greenToRedNode`: 2.13 → 0.251 ms (8.5×)**, muy por debajo del objetivo de 0.8 ms.

### 8. Renderer (A3, A4) ✅ — con una desviación

- **El cuello real no era el `map/join` que señalaba A4, sino `escapeHtml`**: hacía cinco pasadas
  de regex sobre *cada* cadena, con hasta cinco asignaciones intermedias, aunque la prosa normal no
  contiene ninguno de esos cinco caracteres. Reescrito a un `test` + una sola pasada.
  Validado diferencialmente contra la implementación anterior: **208.212 casos, 0 discrepancias**
  (incluye todo el espacio de un carácter hasta U+2000 y 200.000 cadenas aleatorias).
- `renderChildren()` sustituye el idioma `map().join('')` en los 16 sitios.
- `this.depth` y `this.inlineLevel` borrados. `tsc` confirmó que `inlineLevel` seguía referenciado,
  pero solo para escribir: ocho `++`/`--` y ninguna lectura.
- **`render`: 1.567 → 0.290 ms. Con 4000 hermanos: 14.11 → 1.25 ms (11.3×).**

> ⚠️ **El caché por `_hash` NO se implementó, y no debe implementarse tal como está especificado.**
> Dos razones independientes, ambas verificadas:
> 1. El HTML lleva `node.id` incrustado en cada elemento. Cachear un subárbol por `_hash` haría que
>    dos subárboles estructuralmente idénticos emitieran **el mismo `data-node-id`** — ids
>    duplicados en el DOM, que es exactamente lo que rompería el plan A8 de usarlos como key del
>    morpher.
> 2. `spacing` y `empty_line` dependen de sus **hermanos** (`isPrevBlockBoundary`,
>    `isNextCodeBlock`), no solo de su subárbol. `_hash` no captura ese contexto, así que sería una
>    clave incorrecta para esos nodos.
>
> El objetivo de < 0.3 ms se alcanzó sin caché. Dato relacionado descubierto al analizarlo:
> ~~**`data-node-id` se escribe pero no lo lee nadie** en todo el repo — hoy es peso muerto en el HTML.~~
>
> ⚠️ **Esto es FALSO y borrarlo por creerlo rompería el editor.** `usePreviewClick.ts:108-112`
> hace `target.closest('[data-node-id]')` para traducir un clic en el preview a un nodo, y de ahí
> sale el evento que sincroniza la selección con Monaco. Es la mitad Preview→Monaco del sistema
> bidireccional. Corregido en la semana 7 al comprobarlo en vez de repetirlo.
>
> Lo que sí es cierto y **es peor**: son **33,4 KB de los 88,7 KB** del HTML (38%), y como los ids
> se regeneran en cada parseo, cambian en cada pulsación. Eso desactiva el camino rápido del
> `DOMMorpher`, que salta subárboles con `isEqualNode`: medido sobre una edición de un carácter,
> **2 de 5** hijos de primer nivel comparan iguales con los ids puestos, frente a **4 de 5** sin
> ellos. La solución no es borrarlos, es hacer los ids **estables** entre reparseos.

### 5. Structural sharing (S2) ⛔ en la Semana 2 — premisa refutada; ✅ RESUELTO en la Semana 5 (§7-ter)

**La decisión de adoptar el modelo Roslyn de anchura se tomó y luego se revirtió**, porque la
validación diferencial previa refutó el supuesto sobre el que se había tomado.

El modelo de anchura exige que el árbol sea una **partición** del texto fuente. Medido sobre 71.070
nodos (2 fixtures reales + 5.000 documentos aleatorios con semilla):

| Divergencia | Casos |
|---|---|
| Σ anchura de hijos ≠ anchura declarada | 34.366 |
| `parent.start` ≠ `firstChild.start` | 32.630 |
| Huecos entre hermanos | 6.272 |
| Solapes entre hermanos | 3.250 |

Dos causas, ambas confirmadas con casos mínimos:

1. **Los delimitadores no son tokens hijos.** En `[center]…[/center]` el texto `[center]` vive en el
   `text` del padre, no como hijo, así que el padre se extiende legítimamente más allá de sus hijos.
   Derivar posiciones sumando anchuras perdería los 8 caracteres de la etiqueta en cada anidamiento.
2. **Hay hermanos con rangos idénticos.** `"hola\n\nmundo"` produce
   `spacing [4..6]` y `empty_line [4..6]` — dos hermanos sobre los mismos 2 caracteres. Las anchuras
   se contarían dos veces y todos los offsets posteriores se desplazarían.

**Conclusión:** hacer el modelo Roslyn de verdad exige que el parser emita delimitadores y espaciado
como tokens reales del árbol. Eso no es quitar un campo, es reescribir el parser. Ver el punto 14 de
la semana 3, donde además resulta ser **prerrequisito del punto 9**.

En su lugar se atacó lo que de verdad bloqueaba el objetivo de la semana — abajo.

### 5-bis. `NodeMatcher` perezoso ✅ — lo que sí desbloqueó el objetivo

Perfilando el `rebuild` real (no las fases sueltas), `NodeMatcher.match` era **5.11 de 8.17 ms, el
62%**. Dos cambios:

- Una **Fase 0** que empareja subárboles sin cambios usando `green._hash`, recortando prefijo y
  sufijo comunes en cada nivel. Detalle que costó una iteración: exigir que los recuentos de hijos
  coincidieran antes de descender parecía razonable, pero significaba que **un solo nodo insertado
  cerca de la raíz desactivaba el camino rápido para todo el árbol** (medido: seguía en 5.11 ms).
  El recorte de prefijo/sufijo es inmune a eso.
  Un hash de 32 bits no es prueba de igualdad, así que cada emparejamiento se **verifica
  estructuralmente** antes de confirmarse, con commit atómico.
- **El hallazgo grande: nadie consume `nodeMatch`.** Se calculaba en cada pulsación —~3.5 ms, un
  objeto de resultado por nodo más cinco Maps/Sets— para rellenar un campo del evento que no lee
  ningún suscriptor, ni en `packages/quasar`, ni en `MiliastryCore`, ni en `MiliastryNovaFeatures`.
  Ahora es un **accessor perezoso** (`DocumentModel.defineLazyNodeMatch`): la capacidad sigue
  disponible y `event.nodeMatch` funciona igual para los llamantes, pero no se ejecuta
  especulativamente. Nota: la closure mantiene vivo `oldRoot` mientras se retenga el evento.
- Invariantes revalidadas: **307 escenarios de edición, 1.054.602 nodos, 487.284 pares `exact`
  verificados uno a uno, 0 fallos.** (La Fase 0 reclama nodos antes que las fases 1-3, así que la
  contabilidad que arregló la semana 1 se volvió a comprobar entera.)

### Desglose final de `rebuild` (3.81 ms)

| Fase | ms | % |
|---|---|---|
| `parseToGreen` (lex + parse) | 1.99 | 48.7% |
| `analyze()` | 1.28 | 31.5% |
| `buildRedFromGreen` | 0.79 | 19.4% |
| `NodeMatcher` | 0 (perezoso) | — |

Los siguientes objetivos naturales son `analyze()` (punto 10, A6) y el lexer.

### Ficheros tocados

```
src/Types/core.ts                     createNodeId monótono + __resetNodeIdCounter
src/Syntax/RedNode.ts                 _idxCache auto-validante, initChildren, reindexFrom
src/Syntax/NodeMatcher.ts             Fase 0 (prefijo/sufijo por _hash) + verifyIdentical
src/Syntax/RedNodeStore.ts            initChildren
src/Model/DocumentModel.ts            defineLazyNodeMatch en los dos caminos de evento
src/Visitors/HTMLRenderer.ts          escapeHtml 1 pasada, renderChildren, sin inlineLevel/depth
src/BBCode/BBCodeToGreenNode.ts       initChildren + closures de metadata a nivel de módulo
src/Markdown/MarkdownToGreenNode.ts   initChildren
src/HTML/HTMLToGreenNode.ts           initChildren
src/BBBlocks/UIBlocksToRedTree.ts     initChildren (dos ramas unificadas)
```

---

## 7. Semana 3 — Deuda estructural ✅ (salvo el bloque 14 → 9)

> ⚠️ **Leer primero el punto 14.** La semana 2 descubrió que el punto 9 no se puede hacer bien sin
> él, y que es también la vía real para el punto 5.

### 9. Arreglar el incremental de verdad (S5) ✅ RESUELTO en la Semana 4 — ver §7-bis

Estaba bloqueado por el 14, y con razón: `shiftRanges` no tiene una respuesta correcta mientras los
rangos no particionen la fuente. Con hermanos que ocupan el mismo `[4..6]` no hay una única cosa que
desplazar.

### 10. Limpieza (B3, B4, A5, A6, A7) ✅

- ✅ **B3** — `RedNodeStore` ya no lleva una copia literal de `extractGreenNodeMetadata`: recibe un
  `MetadataExtractor` por constructor (por defecto, ninguno). Además de deduplicar, arregla la
  violación de capas: `Syntax/` no debe conocer semántica de BBCode. El cableado vive en
  `createBBCodeRedNodeStore()`.
- ✅ **B4** — borrado `SELF_CLOSING` (Set vacío) y simplificadas sus dos condiciones inalcanzables;
  borrado `IncrementalParser.fullReparse()` (destruía el árbol, nadie la llamaba);
  `SAFE_BOUNDARY_TAGS` array → `Set`. Los "bloques copy-paste inertes en el lexer" ya no existían:
  la reescritura de la semana 1 se los había llevado.
- ✅ **A5** — `BBCodeDocumentModel` propaga `autoAnalyze`/`maxUndo` al `super()`. Ahora
  `autoAnalyze: false` **hace algo**: `rebuild` 3.78 → 2.41 ms (−36%). `QuasarEngineService.parse()`
  reutiliza un modelo scratch sin análisis en vez de construir un modelo completo por llamada:
  **3.4× por snippet** (0.057 → 0.0166 ms). `createDocumentModel()` se deja intacto porque
  `ErrorCheckerWindow` sí lee sus diagnósticos.
- ✅ **A6** — `SemanticAnalyzer.analyze()` devuelve el índice `allNodes` que ya construía, en un tipo
  aparte (`IndexedAnalyzeResult`) *a propósito*: el índice referencia todo el árbol, así que no debe
  colarse en un `AnalyzeResult` que alguien guarde a largo plazo. `DocumentModel` lo usa en vez de
  `findById()` por diagnóstico, y solo reasigna `node.diagnostics` cuando hay algo que limpiar
  (antes: 1736 arrays nuevos por `analyze`).
- ✅ **A7** — fuera `JSON.parse(JSON.stringify)` (4 sitios) y la comparación por `JSON.stringify`.
  Esta última **era un bug latente**: `JSON.stringify` es sensible al orden de las claves, así que
  `{color,size}` y `{size,color}` se consideraban distintos y dos nodos perfectamente fusionables se
  negaban a fusionarse según el orden en que se hubiera construido su metadata. Validado
  diferencialmente: 200.000 bolsas de metadata aleatorias, 0 discrepancias en el clonado y 0 en la
  igualdad, más el caso explícito del orden de claves, que ahora se resuelve bien.

> **Hallazgo nuevo (no estaba en la auditoría): A6 no mejoró nada medible, y la razón importa.**
> `analyze()` devuelve **cero diagnósticos** incluso en documentos llenos de errores, así que el
> `O(N·D)` nunca se ejecutaba: `D` es 0. Tres de los cuatro validadores integrados son
> inalcanzables — ver el punto 15.

### 11. Arreglar la idempotencia del `ASTOptimizer` (B5) ✅

Repro mínimo (minimizado de 356 → 71 chars):

```
[url=https://osu.ppy.sh][/url][notice][/notice][url=https://osu.ppy.sh]
```

**La causa no era la que suponía la auditoría.** El `transform()` ya itera a punto fijo
internamente, así que la no-idempotencia no estaba en el bucle: estaba en el **viaje de ida y
vuelta por texto**.

Los `paragraph` existen porque un elemento de bloque parte el contenido inline. Al eliminar ese
bloque —aquí un `[notice]` vacío— las dos mitades quedan como `paragraph` **adyacentes sin nada en
medio**, y `paragraph` está en `UNMERGEABLE`. Exportar ese árbol no emite separador alguno, así que
al reparsear los dos párrafos se funden en uno y una *segunda* pasada del optimizer encuentra más
trabajo.

**Arreglado** con `ASTOptimizer.isOrphanedParagraphPair`, que fusiona exactamente esa forma. El
arreglo es deliberadamente estrecho —solo cuando `spaces` está vacío, porque una línea en blanco
escrita por el usuario es una separación real y debe sobrevivir— y se apoya en una comprobación
empírica previa: **en 202.764 nodos (fixtures reales + 20.000 documentos aleatorios) el parser
produce esa forma cero veces**, así que la regla solo puede dispararse sobre árboles que ha creado
el propio optimizer.

Validado como propiedad, no solo en el repro: **30.002 documentos** (fixtures + 6 semillas × 5.000
aleatorios), `optimizar → exportar → reparsear → optimizar` da **0 operaciones** en todos, y **0**
pierden texto visible. Semillas del fuzzer que antes fallaban (`2`, `7`, `42`, `99999`): las cuatro
en verde.

El test pasó de `it.fails` a test de regresión normal, como estaba previsto — y con él **la suite
deja de tener `expected fail` por primera vez desde la semana 1: 172 verdes**.

### 12. `DOMMorpher` (A8) ✅ — pero **no** con keys por `data-node-id`

Vive en `src/Visitors/DOMMorpher.ts` (la auditoría no daba la ruta; no está en `RenderPipeline/`).
Lo consumen `Preview.tsx`, `MorphPreview.tsx` y las dos páginas `de-tester`.

**La solución que proponía A8 es inviable, y por la misma razón que ya invalidaba la Fase 1 del
`NodeMatcher`:** los `data-node-id` se regeneran en cada parseo. Medido sobre una edición de un
carácter, **0 de 3 ids sobreviven a un `rebuild`**. Emparejar por ellos no encontraría nada: cada
nodo parecería nuevo y el morpher degeneraría en un reemplazo completo. Usar `data-node-id` como key
exige antes identidad estable entre reparseos — el mismo bloqueo de siempre.

**Lo que sí se hizo:** recorte del prefijo y el sufijo idénticos con `isEqualNode` (comparación
estructural profunda nativa) antes de emparejar por índice. Un subárbol que compara igual se deja
**intacto**: sin recursión, sin bucles de atributos y, al no reemplazarse el nodo, su estado de
runtime (spoilers abiertos, reproducción, selección) se conserva gratis. `Array.from()` pasa a
copiar solo la ventana que cambió, no cada nivel entero. Las inserciones usan `insertBefore` contra
el sufijo preservado, no `appendChild`.

**El defecto, cuantificado.** Insertando un nodo al principio de 200 párrafos, el morpher anterior
dejaba **0** con su texto intacto —reescribía los 200, que es justo la cascada que un morpher existe
para evitar—; el nuevo deja los **200** y la inserción es su única operación sobre el DOM.

**El morpher no tenía ni un test**, siendo código que muta el DOM que el usuario está mirando.
Añadido `src/Tests/DOMMorpher.test.ts` (7 casos) con la propiedad central: tras el morph, el
contenedor debe ser estructuralmente idéntico a lo que habría producido un `innerHTML = newHTML`.
Verificado sobre 14 formas de edición a mano más **2.000 pares aleatorios** con semilla, además de
la preservación de identidad de nodos y de `<details open>`.

### 13. Revisar el lock de mutación (B2) ✅

**Decisión: se queda, descrito honestamente como lo que es.** Ni se hizo "real" ni se eliminó, y el
razonamiento está medido, no supuesto:

- **No puede ser un mecanismo de aislamiento.** Es un booleano estático único: abrir una frontera en
  cualquier sitio la abre en todos. Darle ámbito por documento obligaría a subir hasta la raíz en
  cada mutación y a pasar esa raíz por los **26 sitios de llamada**, para cazar mutación entre
  documentos: una clase de bug que un editor de un solo hilo no tiene.
- **Tampoco puede ser hermético.** `children` es un array público mutable, y `treeTransformers` le
  asigna directamente en **5 sitios**, saltándose los métodos por completo. Sellarlo exige hacer
  `children` privado — un cambio de API grande para el mismo beneficio pequeño.
- **Lo que sí aporta:** envolver una edición estructural marca la intención en el sitio de la
  llamada, y mutar fuera de una frontera falla ruidosamente en vez de en silencio. Eso vale una
  comprobación booleana.

Hecho además:
- **7 envoltorios muertos borrados** en `StudioEffects`: eran `allowMutation(() => greenToRedNode(x))`,
  y `greenToRedNode` dejó de mutar en la semana 2 (usa `initChildren`, fuera del lock).
- Mensaje de error: "transaction boundary" → "mutation boundary". Hay una clase `Transaction` de
  verdad en el motor y esto no lo es; llamarlo transacción confundía.
- **`QUASAR.MD` corregido.** Afirmaba "Tolerancia a Concurrencia gracias a inmutabilidad estricta".
  El árbol *verde* sí es inmutable y esa parte se conserva; la afirmación sobre el rojo era falsa y
  ahora dice qué es realmente el lock.

### 14. Hacer que el árbol particione la fuente ✅ RESUELTO en la Semana 4 — ver §7-bis

Descubierto al validar el punto 5 de la semana 2 (ver esa sección para las cifras completas).

**El problema.** Los rangos del árbol no son una partición del texto. Dos causas:

1. Los delimitadores no son nodos. `[center]` vive en el `text` del padre, así que el padre se
   extiende más allá de sus hijos: 32.630 casos de `parent.start != firstChild.start`.
2. Hay hermanos que ocupan el mismo rango. `"hola\n\nmundo"` → `spacing [4..6]` **y**
   `empty_line [4..6]`. Verificado con caso mínimo.

**Por qué importa más de lo que parece.** No es una cuestión estética: significa que el árbol no
puede responder sin ambigüedad a *"¿qué nodo está en el offset 5?"*. Todo lo que traduce posiciones
a nodos está construido sobre esa ambigüedad — `findNodeAtOffset`, el mapeo Monaco↔AST, los
diagnósticos, la preservación de selección al reparsear.

**Qué desbloquea:**
- El **punto 9** (S5, incremental) — `shiftRanges` es irrealizable correctamente sin esto.
- El **punto 5** (S2, structural sharing) — el modelo Roslyn de anchura, y con él el interning real.
- Offsets fiables para diagnósticos y para el editor.

**Qué exige:** que el lexer/parser emitan delimitadores y espaciado como tokens reales del árbol,
de forma que las anchuras sumen exactamente. Es un proyecto propio, no una tarea de una tarde, y
según la metodología de §8 hay que revalidarlo diferencialmente contra el parser actual antes de
darlo por bueno.

> **Corrección de la semana 4:** lo de "tokens reales del árbol" resultó ser la opción cara y
> equivocada. Ver §7-bis: el modelo de anchuras consigue la misma invariante sin tocar la forma del
> árbol, que es además lo que hace Roslyn de verdad.

### 15. Tres de los cuatro validadores del `SemanticAnalyzer` son inalcanzables ✅ RESUELTO

Descubierto al implementar A6: `analyze()` devuelve **0 diagnósticos** incluso sobre documentos
construidos a propósito con etiquetas desconocidas, sin cerrar y cierres huérfanos. Verificado caso
a caso:

| Validador | Por qué no dispara nunca |
|---|---|
| `unknown-tag` | Exige `node.kind === 'custom'`, pero `Parser.ts` convierte las etiquetas desconocidas en nodos `text` antes de que el analizador las vea |
| `deprecated-tag` | Busca `deprecated[node.text]` con la clave `'strike'`, pero `node.text` guarda los **atributos**, y `[strike]` parsea a kind `strikethrough` con `text` vacío |
| `nested-structure` | Exige hijos de `[code]` con kind ≠ `text`, pero el parser conserva el contenido de `code` como texto crudo, así que nunca los hay |
| `empty-tag` | ✅ Este sí funciona |

Consecuencia: el motor **no reporta ningún error de BBCode al usuario**, y `ErrorCheckerWindow`
—que existe para eso— siempre muestra la lista vacía.

**Segundo nivel de rotura, no detectado en la auditoría:** ningún validador rellenaba `range`. Aunque
hubieran disparado, el clic para saltar al error en `ErrorCheckerWindow` (`if (err.range)`) no habría
hecho nada y no habría línea ni columna.

#### Lo arreglado

- **`deprecated-tag`** — lee la grafía que escribió el autor desde la fuente. Hacía falta porque el
  árbol no la conserva: `[strike]` y `[s]` producen ambos el kind `strikethrough`. Detalle que
  costó una iteración: como `document`, `paragraph` y la etiqueta empiezan **en el mismo offset**
  (el problema de rangos del punto 14 asomando aquí), leer la fuente por offset disparaba el aviso
  **tres veces**; se ata al kind que la etiqueta produce.
- **`nested-tags-in-code`** — busca las etiquetas *dentro* del texto del bloque, que es donde están:
  el parser conserva el contenido de `[code]` como texto crudo justamente para no interpretarlas.
- **`empty-tag`** — ya funcionaba; ahora emite `range`.
- Todos los diagnósticos llevan `range`, así que el salto al error de `ErrorCheckerWindow` funciona.

#### `unclosed-tag` — validador nuevo

Decidido con el usuario. Es el error de BBCode que de verdad se comete, y el modo legacy lo cierra
en silencio por diseño, así que nada avisaba al autor.

La detección es **exacta, no heurística**: una etiqueta que el autor cerró termina justo en su
propio `[/tag]`, porque ahí es donde el parser pone el final del nodo; una que se cerró *por* él
termina donde el parser se rindió. Una sola regla cubre las dos formas —`[b]x` (nunca cerrada) y
`[b][i]x[/b]` (donde `[i]` lo auto-cierran las reglas de anidamiento legacy)— y no necesitó tocar el
parser ni añadir campos a `GreenNode`.

Validado contra falsos positivos, que es el riesgo real de un validador nuevo: **20.000 documentos
generados con anidamiento siempre equilibrado, 0 avisos**. Y 0 diagnósticos sobre el documento real
de 19.2 KB.

#### `unknown-tag` — se queda dormido, a propósito

Medido antes de decidir: sobre el documento real marcaría **0** etiquetas; sobre una frase de prosa
normal —`Combo de [90 misses] con teclado [Gateron Yellow]`— marcaría **4**, todas falsos positivos.
El parser renderiza las etiquetas desconocidas como texto *a propósito*, así que avisar sería ruido.
Documentado como dormido en `src/Tests/SemanticValidators.test.ts`.

#### Coste

`analyze` 1.390 → 1.352 ms **con los validadores ya funcionando**. La primera versión costaba
1.886 ms (+62%): se corrigió con un pre-filtro por kind y quitando dos asignaciones de string por
nodo (regex *sticky* anclada por `lastIndex` en vez de `slice`, y comparación del cierre con
`charCodeAt`). Tests: `src/Tests/SemanticValidators.test.ts`, 16 casos.

---

## 7-bis. Semana 4 — La partición y el incremental ✅

El bloque `14 → 9` completo. Se hizo en ese orden porque el 9 es irrealizable sin el 14, y eso
resultó ser literalmente cierto: la pieza central del incremental nuevo —"reparsea el interior del
contenedor"— **no se puede ni enunciar** sin la invariante de partición, porque "el interior" no era
un rango bien definido.

### 14. El árbol particiona la fuente ✅

**La decisión de diseño.** El roadmap proponía emitir los delimitadores como nodos hijos
(`open_tag`, `close_tag`). Se descartó: cambia la forma del árbol y rompe todo lo que itera
`children` — `HTMLRenderer`, `BBCodeExporter`, `ASTOptimizer`, `NodeMatcher`, `treeTransformers` y
las 2150 líneas de `StudioEffects`.

Se implementó en su lugar el **modelo de anchuras**, que es lo que Roslyn hace de verdad: el texto
propio de un nodo vive en `leadingWidth`/`trailingWidth`, no en nodos hijos.

```
element [0..17]  leading=3  trailing=4     "[b]hola mundo[/b]"
└─ text [3..13]                            "hola mundo"

3 + 10 + 4 == 17   ✓
```

La invariante, ahora ejecutable en `src/Syntax/partition.ts`:

```
node.start + leadingWidth      == firstChild.start
child[i].end                   == child[i+1].start
lastChild.end + trailingWidth  == node.end
```

**Los tres agujeros que había, y qué se hizo con cada uno:**

| Agujero | Antes | Ahora |
|---|---|---|
| Delimitadores sin dueño | `[b]hola[/b]` → `bold [0..13]` con un único hijo `[3..7]`; 6 chars de nadie | `leadingWidth`/`trailingWidth` |
| Hermanos solapados | `"hola\n\nmundo"` → `spacing [4..6]` **y** `empty_line [4..6]` | cada salto de línea tiene su propio rango |
| Cierres huérfanos borrados | `[/b]` sin apertura desaparecía del árbol y del export | se conserva como texto, igual que las etiquetas desconocidas |

Además: los auto-cierres ya no se tragan el delimitador ajeno (`[b][i]x[/b]` daba `italic` y `bold`
**ambos** acabando en 11), y la raíz abarca `[0..source.length]` siempre en vez de derivarse de sus
hijos.

**Coste de la invariante en `GreenNode`:** neutro. Se borró `fullWidth` —que era decorativo: con
hijos valía `sum(children.fullWidth)`, ignorando los delimitadores del propio nodo, y sus únicos 7
consumidores lo usaban como `fullWidth - width` para recuperar un `leadingWidth` que casi siempre
era 0— y los dos campos nuevos usan `declare`, que no emite `defineProperty` (ver §8, trampa 2).
`parseTokensToGreen` 0.659 → **0.606 ms**, un 8% más rápido.

**Validación diferencial** (18.017 documentos: 2 fixtures reales, 15 casos mínimos y 6 semillas ×
3.000 aleatorios con etiquetas desconocidas, sin cerrar, huérfanas y corchetes sueltos):

| | Antes | Después |
|---|---|---|
| Documentos que particionan | 2.238 (**12.42%**) | 18.017 (**100%**) ✅ |
| Violaciones totales | 270.771 | **0** |

Y contra el parser anterior, sobre HTML renderizado y BBCode reexportado: **6.672 de 6.672
documentos sin cierres huérfanos dan salida idéntica**. Los 11.345 restantes divergen exactamente
por el cambio intencionado.

> **Efecto secundario que no se buscaba:** el punto fijo de `parse → export → parse → export` pasó
> de **99.67% a 100%**. Borrar los huérfanos era en sí mismo una fuente de inestabilidad del
> round-trip.

Tests: `src/Tests/Partition.test.ts` — 40 casos, incluidos los tres defectos originales fijados por
su caso mínimo, "cada offset tiene exactamente un dueño", y 6.000 documentos de fuzz con semilla.

### 9. El incremental de verdad (S5) ✅

**Primero se midió cuán roto estaba.** Seis escenarios de edición realistas, comparando el árbol
resultante contra un rebuild completo del mismo texto final:

| | Antes |
|---|---|
| Escenarios con HTML **distinto** al del rebuild | **3 de 6** |
| Escenarios cuyo árbol no particionaba | 4 de 6 |
| Peor conteo de nodos | **1752 vs 1738** (14 nodos fantasma) |

Las tres causas: el subárbol se parseaba de `newSource.slice(start, end)` y se injertaba **sin
rebasar** (todos sus offsets desplazados por `start`); hermanos y ancestros conservaban rangos
viejos; y `reparse` devolvía `newRootRed.green`, o sea **el green root viejo**.

**Y luego, si merecía la pena arreglarlo** (§8, regla 5). Desglose de un rebuild completo:
lexer 0.74 ms + parser 0.52 ms + `greenToRedNode` 0.27 ms = 2.48 ms reales. El techo de un
incremental correcto que reparsee una región del 2-25%: **0.04-0.53 ms**, un ahorro del 79-98%.
Sí merecía.

**El diseño: todo sobre el árbol verde.** No es una preferencia — `RedNode.range` es una vista de
`green.range` (`RedNode.ts:132`), así que **un arreglo de rangos en rojo no es expresable**. Los
rangos viven en verde, luego las ediciones ocurren en verde.

1. Bajar hasta el **contenedor de bloque más profundo** cuyo *interior* contiene el cambio.
2. Reparsear ese interior solo, con `normalizeParagraphs: false` (el agrupado en párrafos es de
   raíz; aplicarlo aquí inventaría párrafos que un parseo completo nunca produce), y rebasarlo.
3. Reconstruir la espina de ancestros: los subárboles anteriores al splice se comparten **por
   referencia** y solo se desplaza lo que va detrás. Vive en `src/Syntax/greenEdit.ts`.

**Los guardas, y por qué existe cada uno.** Cuando alguna precondición falla, devuelve un rebuild
completo con el motivo en `lastReparseFallbackReason` — nunca un árbol plausible pero equivocado.

| Motivo | Qué evita |
|---|---|
| `region-not-isolated` | un `[` a medias (su `]` estaría fuera), un `[code]` sin cerrar, un cierre huérfano que casaría con un ancestro, o una etiqueta **del mismo kind que el contenedor** abierta al final de la región, que le robaría su `[/centre]` |
| `open-bracket-before` | un `[` sin cerrar **antes** de la región, que podría reclamar un `]` que la edición cree dentro |
| `no-container` | la edición está a nivel de documento |
| `stale-ranges` | el árbol no describe el texto previo |
| `region-too-large` / `document-too-small` | casos donde el rebuild es más barato (ver abajo) |

Los dos guardas de rendimiento salieron de medir, no de suponer:
- El guarda de aislamiento **lexaba la región y el parser la volvía a lexar**. En un documento cuyo
  contenedor abarca el 95% del texto, la ruta "rápida" medía **3-4× más lenta** que un rebuild. Se
  reescribió para trabajar sobre el árbol ya parseado —posible precisamente porque el punto 14 hace
  que el parser conserve el `[` suelto y el `[/tag]` huérfano como nodos `text`.
- Umbrales: región ≤ 70% del documento, documento ≥ 2500 chars. A 1.8 KB / 173 nodos el incremental
  era un **9% más lento**; a 3.5 KB / 341 nodos, un **50% más rápido**. Son opciones de constructor
  (`IncrementalParserOptions`), porque son afinado y no semántica: el árbol es el mismo.

**Validación diferencial.** La propiedad exigida no es "renderiza parecido" sino **idéntico**, nodo
a nodo, rango a rango, contra un rebuild del texto final:

| Suite | Ediciones | Desiguales | Partición rota |
|---|---|---|---|
| documento corto | 10.000 | 0 | 0 |
| con anidamiento | 7.500 | 0 | 0 |
| con `[code]` | 4.000 | 0 | 0 |
| fixture real 19.6 KB | 600 | 0 | 0 |
| **total** | **22.100** | **0** ✅ | **0** ✅ |

El fuzz encontró **61 divergencias** en la primera pasada, todas de la misma forma: teclear
`[centre]` dentro de un `[centre]`. Y **9 más** en la segunda, todas por el `[` sin cerrar previo a
la región. Ambas se cerraron con los guardas de arriba.

**Rendimiento con escritura real** (43 pulsaciones de texto normal dentro de un `[notice]` del
fixture de 19.6 KB, comparando `incremental: true` contra `incremental: false` — la misma ruta de
código en ambos, que es la única comparación honesta):

| | ms/pulsación |
|---|---|
| rebuild completo | 2.78 |
| **incremental** | **1.22** (−56%, estable en 3 tandas) |

Con **100% de aciertos**: los guardas no se disparan ni una vez escribiendo texto normal.

**Otros cambios:**
- `reparse()` ya no devuelve `null`. Cuando no puede hacer el splice, hace el rebuild él mismo,
  en vez de un `null` que el llamante tenía que interpretar.
- `DocumentModelOptions.incremental` (por defecto `true`) desactiva la ruta. Es un interruptor de
  rendimiento, no de corrección.
- El test de `IncrementalParser` exigía que los `id` de RedNode de bloques no tocados sobrevivieran.
  Ya no: el rojo se deriva del verde nuevo, igual que en un rebuild. Preservar esos `id` es
  justamente lo que hacía el splice en rojo que dejaba los rangos mintiendo, y nada depende de
  ellos — el `DOMMorpher` empareja por estructura (`isEqualNode`) desde el punto 12.

### Ficheros tocados

- `src/Syntax/partition.ts` 🆕 — la invariante, ejecutable.
- `src/Syntax/greenEdit.ts` 🆕 — `shiftGreen`, `spliceGreen`, `withChildren`.
- `src/Syntax/GreenNode.ts` — `leadingWidth`/`trailingWidth`; fuera `fullWidth`.
- `src/Syntax/GreenNodePool.ts` — anchuras propagadas.
- `src/BBCode/Parser.ts` — delimitadores como anchuras, saltos de línea disjuntos, huérfanos como
  texto, raíz completa, opción `normalizeParagraphs`.
- `src/Incremental/IncrementalParser.ts` — reescrito sobre el árbol verde.
- `src/Model/DocumentModel.ts`, `src/BBCode/BBCodeDocumentModel.ts` — opción `incremental`,
  `parseToGreen` con opciones, `lastReparseFallbackReason`.
- `src/Studio/StudioEffects.ts` — 7 sitios que usaban `fullWidth - width`.
- `src/Tests/Partition.test.ts` 🆕, `src/Incremental/__tests__/IncrementalParser.test.ts` reescrito.

### Qué queda

El **punto 5 / S2** (interning real con structural sharing) es lo único abierto, y el punto 14
acaba de darle lo que le faltaba: ahora que las anchuras son honestas, un `GreenNode` puede
identificarse por `(kind, text, hijos, anchuras)` sin su posición absoluta.

---

## 7-ter. Semana 5 — Structural sharing de verdad ✅

El último punto abierto: **5 / S2**, el interning. El punto 14 lo había desbloqueado, y este es
el cambio que lo cobra.

### El diagnóstico, otra vez distinto del que decía la auditoría

La auditoría trataba S2 como dos bugs sueltos. Son el mismo bug, y no tenía arreglo local:

- `internLeaf` cacheaba por `kind:text` **ignorando la posición**, así que el segundo `"Hello"`
  del documento recibía el nodo del primero, con **sus** offsets. Encender el interner hacía que
  todo lo que depende de posiciones mintiera en silencio.
- `internNode` hacía lo contrario: exigía `start` y `end` idénticos para deduplicar, cosa que dos
  apariciones distintas nunca cumplen. El mismo bloque pegado diez veces daba **0% de dedup y 100%
  del coste de escaneo**.

Ignorar la posición y mentir, o respetarla y no acertar nunca: no hay una tercera opción **mientras
la posición viva en el nodo verde**. Por eso el arreglo es quitarla.

### El cambio

```
ANTES                          DESPUÉS
GreenNode                      GreenNode
  range: {start, end}   →        (nada)
  width                          width          ← derivada, no pasada
  leadingWidth                   leadingWidth
  trailingWidth                  trailingWidth

RedNode.range → green.range    RedNode.range → acumulada al construir
```

Un nodo verde sabe **cuánto ocupa**, no **dónde está**. La posición es una propiedad del *lugar* de
un nodo en un árbol, así que vive en el nodo rojo, que es el que tiene lugar: `greenToRedNode` la
teje al bajar (una suma por nodo) y la guarda, de modo que `range` sigue siendo la propiedad O(1)
que todos los consumidores ya suponían.

**Efecto secundario de diseño, y no menor:** la anchura pasa a **derivarse** de los hijos más los
delimitadores propios, así que la invariante de partición del punto 14 dejó de ser una comprobación
que un llamante descuidado podía violar y pasó a ser aritmética del constructor. `partition.ts`
adelgazó: `sibling-gap`, `sibling-overlap`, `leading-mismatch` y `trailing-mismatch` se borraron
junto con la posibilidad de fallarlos. Quedan los dos que siguen siendo comprobables — que la raíz
cubra la fuente y que una hoja `text` mida lo que su texto.

Y `shiftGreen` desapareció: era una copia profunda de cada hermano posterior a una edición solo para
renumerarlo, el 14% del coste de un reparse incremental. Ahora un hermano posterior se comparte por
referencia igual que uno anterior.

### Validación

**El interner encendido debe ser indistinguible del apagado.** Sobre 18.016 documentos (2 fixtures
reales, 14 casos mínimos, 6 semillas × 3.000 aleatorios), en **los dos modos**:

| | `leaves` | `full` |
|---|---|---|
| Árbol idéntico | **100%** | **100%** |
| HTML idéntico | **100%** | **100%** |
| Export idéntico | **100%** | **100%** |
| Particiona | **100%** | **100%** |
| `collisionMisses` | 0 | 0 |

Y el fuzz diferencial del incremental repetido entero con el interner encendido: **22.100 ediciones,
0 divergencias**, igual que apagado.

**La deduplicación por fin ocurre.** Fixture de 19,6 KB: 1736 nodos alcanzables →
**702 objetos distintos (59,6% compartido)**. Antes: 0%, con `collisionHits: 0`.

### El coste, medido — y por qué se queda apagado por defecto

Aislando el parseo, el interning es caro; de punta a punta, es casi gratis. Las dos cosas son
ciertas y la segunda es la que importa:

| | parseo aislado | memoria del árbol | **coste por pulsación** |
|---|---|---|---|
| sin interning | 0,518 ms | 258 KB | **1,09 ms** |
| `leaves` | 0,600 ms (+16%) | 148 KB (−42%) | **1,09 ms** (neutro) |
| `full` | 1,090 ms (+110%) | 114 KB (−56%) | **1,15 ms** (+6%) |

*(Coste por pulsación: mediana de 4 tandas, 43 pulsaciones de texto normal dentro de un `[notice]`
del fixture, comparando `interning` a `true` y a `false` — la misma ruta de código en ambos.)*

**Decisión: correcto, disponible, y apagado por defecto.** El presupuesto declarado de este motor es
de latencia, no de memoria, y ningún consumidor tenía problema de memoria; encenderlo no compra nada
que haga falta hoy. `BBCodeDocumentModelOptions.interning` lo activa para quien tenga muchos
documentos vivos a la vez, y `'leaves'` es el modo por defecto del pool porque compra tres cuartas
partes del ahorro por un séptimo del coste: interning de un nodo interno obliga a hashear su
subárbol entero, mientras que una hoja cuesta una clave de string y un `Map.get` — y la duplicación
está en las hojas (930 hojas, 122 distintas).

> Nota metodológica: la primera medición de memoria dio que el interner gastaba **más**. Era ruido:
> `global.gc` no estaba disponible bajo `npx tsx`, así que nada se recogía entre tandas. Con
> `node --expose-gc --import .../tsx/dist/loader.mjs` el signo se invirtió. Ver §8, regla 8.

### Ficheros tocados

- `src/Syntax/GreenNode.ts` — fuera `range`; `width` derivada; `walkWithOffset`, `childOffsets`.
- `src/Syntax/RedNode.ts` — `_range` propio, acumulado al construir; `innerStart`/`innerEnd`.
- `src/Syntax/GreenNodePool.ts` — clave estructural correcta, `InterningMode`.
- `src/Syntax/greenEdit.ts` — `shiftGreen` borrado; `spliceGreen`/`withChildren` sin delta.
- `src/Syntax/partition.ts` — reescrito: solo lo que sigue siendo comprobable.
- `src/BBCode/Parser.ts`, `BBCodeToGreenNode.ts`, `BBCodeDocumentModel.ts` — construcción por
  anchuras, threading del offset, opción `interning`.
- `src/Incremental/IncrementalParser.ts` — desciende por el árbol rojo, que es quien tiene posiciones.
- 4 analyzers, 4 transforms, 4 transformers, `StudioEffects` (47 sitios), `treeTransformers`,
  `ASTOptimizer`, `TreeBuilder`, `NodeFactory`, `HTMLToGreenNode`, `MarkdownToGreenNode`,
  `UIBlocksToRedTree`, `Transaction` — 67 sitios de `green.range` en total.
- Tests: `Partition.test.ts` y `GreenNodePool.test.ts` reescritos.

> **Hallazgo lateral:** `ASTOptimizer` construía nodos verdes *vacíos* como cáscara y les colgaba
> hijos rojos después, así que su `range` no describía nada. Con la anchura derivada eso se volvió
> visible (ancho 0) y se arregló construyendo el verde a partir de los hijos que va a tener.

---

## 7-quater. Semana 6 — El lexer

Tras las semanas 4 y 5, el lexer era la fase más cara de un parseo completo (0,74 ms de
~1,5 ms). Solo se le había arreglado el cuadrático de la semana 1; el caso normal nunca se
tocó.

### Perfilado por ablación, no por intuición

Cada variante quita **un** coste, para medir su contribución en vez de suponerla. De 0,625 ms:

| coste | ms | % |
|---|---|---|
| regex por carácter en los nombres de etiqueta | 0,127 | 20% |
| `toLowerCase()` por etiqueta (1608×) | 0,110 | 18% |
| `TAG_NAME_RE.test` por etiqueta | 0,058 | 9% |
| memo de corchetes (`Map<number,number>`) | 0,043 | 7% |
| alojar 2538 objetos token | 0,042 | 7% |
| `toLowerCase()` del source entero | 0,030 | 5% |

Las tres primeras son la misma pregunta hecha tres veces. El lexer buscaba el final del
nombre con `/[a-zA-Z0-9_*]/.test(inner[i])` **carácter a carácter** —alojando un string de
un carácter y entrando al motor de regex para resolver lo que responden cuatro
comparaciones de enteros—, luego cortaba, luego bajaba a minúsculas, y luego **volvía a
validar** con una segunda regex lo que el escaneo ya había garantizado.

### Lo hecho

- **Un solo escaneo sobre `charCodeAt`** que encuentra el final del nombre, lo valida y
  detecta si hay mayúsculas, devolviendo longitud y flag empaquetados en un entero. La
  segunda regex desaparece: todo carácter que el escaneo aceptó es válido por definición.
- **`toLowerCase()` solo si hace falta.** La mayoría de nombres ya vienen en minúsculas y
  volvían como copias idénticas.
- **El `toLowerCase()` del source entero pasa a ser perezoso.** Solo lo usan los bloques
  `[code]`/`[c]`, y la mayoría de documentos no tiene ninguno — el fixture de referencia
  pagaba una copia de 19,6 KB para nada.
- **La ruta de texto plano** hacía tres comparaciones de string por carácter; ahora una de
  enteros. Es la que cubre casi todo el documento.
- Borrada ceremonia vestigial en los bloques raw: `rawVal` se calculaba **dos veces**.

### Validación

**El flujo de tokens debe ser idéntico, campo a campo.** Un lexer "equivalente en entrada
válida" no sirve: su trabajo es decidir sobre basura, y el buffer de un editor es basura
casi siempre.

| | |
|---|---|
| Documentos | **56.049** (2 fixtures, 47 casos mínimos, 7 semillas × 8.000) |
| Tokens comparados | **776.021** |
| Divergencias | **0** ✅ |
| Cobertura de la fuente rota | **0** ✅ |

El alfabeto del fuzz es hostil a propósito: `[`, `]`, `[[`, `[/`, `[]`, `[ ]`,
`[has space]`, `[123+456]`, `[b`, `b]`, `[=]`, `[CODE]`, `[box=[b]t[/b]]`.

### Lo que apareció al escribir los tests

**El lexer no tenía ni un test propio**, lo cual está del revés: su cometido es decidir
sobre entrada malformada, y eso no lo cubría nada. Al escribirlos apareció una asimetría
real que yo mismo había supuesto mal:

- En una **apertura**, el nombre es la tirada inicial de caracteres válidos y **todo lo
  demás pasa a atributos**: `[has space]` → `open:has(space)`, `[123+456]` →
  `open:123(+456)`.
- En un **cierre**, el nombre debe llenar el hueco entero: `[/has space]` → texto literal.

No es inofensivo por accidente: el parser convierte las etiquetas desconocidas en nodos
`text`, así que el usuario ve lo que escribió. Por eso nunca se notó. Queda fijado en
`src/Tests/Lexer.test.ts` (49 casos) para que un lector futuro no tropiece con ello.

---

## 7-quinquies. Semana 7 — Granularidad del incremental

Perfilar la pulsación real (regla 4) dejó ver que el lexer ya no era el problema: era el
**13,5%** de una pulsación. Los dos costes de verdad eran otros, y resultaron ser el mismo
problema visto desde dos lados.

### El diagnóstico

El incremental razonaba en **contenedores**: buscaba el bloque más profundo que envolviera
el cambio y reparseaba su interior entero. Dos consecuencias:

- Escribir dentro de un `[notice]` de 13 KB relexaba y reparseaba **el 66% del documento en
  cada pulsación**, porque el contenedor era casi todo.
- Escribir **al final del post** —la posición de caret más común que existe— no tenía ningún
  contenedor de bloque que la envolviera, así que caía a rebuild completo: **0 de 43
  pulsaciones** iban por la ruta rápida.

### El cambio

La unidad de una edición no es un nodo entero, es un **run de hermanos**. El target pasa a
ser un rango de hijos `[from, to)` del nodo más profundo que contenga el cambio, y el padre
puede ser el propio `document` — con lo que el segundo problema desaparece por
construcción.

La ventana se **ensancha en uno por cada lado**. No es margen de seguridad: es lo que
permite que un borrado **funda** dos nodos. Quitar la línea en blanco entre dos párrafos
solo toca el nodo de en medio, y sin un vecino a cada lado el reparseo no puede ver que los
dos supervivientes deben volverse uno.

### Lo que hay que dejar fuera, y por qué

Cuatro kinds son **opacos** al descenso, cada uno porque sus hijos los produce una regla que
mira **fuera** de ellos, que es justo lo que una ventana no puede ver:

| kind | por qué |
|---|---|
| `paragraph` | el agrupado en párrafos es de raíz; una ventana dentro no puede descubrir que una línea en blanco nueva debe **partirlo** |
| `code`, `inline_code` | bloques raw: su contenido es un token literal porque el **lexer** vio el `[code]`; reparsear ese texto solo lo lexa como BBCode y lo hace añicos |
| `list_item` | `[*]` auto-cierra el anterior, así que un `[*]` tecleado dentro es **hermano** en un parseo completo y sería **hijo** en uno aislado |

Y dos guardas nuevos, ambos encontrados por el fuzz, no por razonamiento previo:

- **La ventana no puede empezar a mitad de una tirada de saltos de línea.** El primero de
  una tirada es `spacing` y los siguientes `empty_line`: cuál es cuál depende de cuántos
  vinieron antes. Empezar a mitad hace que el primero de dentro se crea el primero de todos.
  Lo cazó un test propio antes que el fuzz.
- **Una etiqueta abierta al final de la ventana le roba el cierre a cualquier ANCESTRO de su
  tipo**, no solo al padre. El fuzz lo encontró con un `[centre]` dentro de un `[list]`
  dentro de un `[centre]`.

### Validación

El fuzz diferencial encontró **192 divergencias** en la primera pasada —todas bloques raw— y
**2** en la segunda —ambas el robo de cierre a un ancestro—. Tras cerrarlas:

| suite | ediciones | desiguales | partición rota |
|---|---|---|---|
| documento corto | 10.000 | 0 | 0 |
| raíz, muchos párrafos | 10.000 | 0 | 0 |
| con anidamiento | 7.500 | 0 | 0 |
| con `[code]` | 4.000 | 0 | 0 |
| fixture real 19,6 KB | 600 | 0 | 0 |
| **total** | **32.100** | **0** ✅ | **0** ✅ |

### Resultado, y lo que queda al descubierto

| caret | incremental | rebuild | aciertos |
|---|---|---|---|
| dentro de `[notice]` | **0,742 ms** | 2,04 ms | 43/43 |
| al final del post | **0,657 ms** | 1,92 ms | 43/43 |
| al principio del post | 2,13 ms | 2,17 ms | 0/43 |

Al principio no acierta, y está bien que no lo haga: el primer hijo del documento **es** casi
todo el documento, así que la ventana dispara `region-too-large` y el rebuild es más barato.

Con `parse` reducido a 0,01 ms, el reparse queda dominado por dos cosas nuevas:

1. **`buildRed` — 68-77% de la pulsación.** Reconstruye los 1736 nodos rojos enteros aunque
   solo cambie una ventana. Es la siguiente optimización grande, y el interning de la semana
   5 es lo que la hace posible.
2. **`bracketsCloseBefore` — 22% cuando el caret está al final.** Recorre todo el prefijo en
   cada pulsación. Se puede cachear, pero el razonamiento de corrección es sutil (una
   edición puede exponer un `]` que antes estaba tapado) y no merece un bug silencioso a
   cambio de 0,09 ms.

---

## 7-sexies. Semana 8 — El parser

Tras la semana 6 el parser era la fase más cara de un parseo completo, el doble que el
lexer, y no se había perfilado nunca.

### Ablación

De 0,49 ms:

| coste | ms | % |
|---|---|---|
| `new GreenNode` × 1736 | 0,280 | 57% |
| └ de eso, `Object.freeze([...hijos])` | 0,148 | **30%** |
| `tagToNodeKind` (dos llamadas por elemento) | ~0,08 | 17% |
| objetos de frame de la pila | 0,016 | 3% |
| normalización en párrafos | 0,002 | 0,5% |

### Lo hecho

- **Un array vacío congelado compartido** para los nodos sin hijos. Más de la mitad del
  árbol son hojas (930 de 1736) y cada una alojaba y congelaba su propio array vacío, que
  no puede diferir de ningún otro. −17% del parser.
- **`Object.freeze` solo fuera de producción.** Costaba el 30% del parser a cambio de una
  garantía en runtime contra una mutación que `readonly GreenNode[]` ya rechaza en tiempo de
  compilación. Fuera de producción la excepción sigue saltando donde se cometen los errores
  —desarrollo y la suite de tests, ambos verificados— y producción no paga por una
  comprobación que allí no ha saltado nunca.
- **`TAG_TO_KIND` pasa de objeto literal a `Map`.** Se escribe como objeto porque así se lee,
  pero se consulta con nombres de etiqueta que vienen de la fuente, así que V8 ve una clave
  megamórfica y cae a búsqueda en diccionario. Medido sobre 1608 consultas, el `Map` es el
  doble de rápido.
- **El kind se resuelve una vez por elemento**, al abrir, y viaja en el frame de la pila.
  Se calculaba dos veces: una para descartar `custom`, otra al cerrar.

> Cuidado deliberado: el frame conserva **también** el `tag` literal. El cierre empareja por
> tag, no por kind, y `[centre]`/`[center]` comparten kind sin cerrarse mutuamente. Es
> comportamiento existente y no se toca mientras se optimiza.

### Validación

| | |
|---|---|
| Documentos | **49.019** (2 fixtures, 17 casos mínimos, 7 semillas × 7.000) |
| Configuraciones | **4** — estricto y legacy × con y sin normalización de párrafos |
| Parseos comparados | **196.076** |
| Nodos comparados | **1.985.691** |
| Divergencias | **0** ✅ |

### Una falsa alarma que conviene recordar

Una medición suelta dio que `greenToRedNode` había pasado de 0,34 a 0,71 ms y que la
pulsación había **subido**. Era ruido entre procesos: el A/B alternado contra un worktree en
HEAD, tres tandas, dio `greenToRed` 0,278 → 0,273 ms y la pulsación 0,698 → 0,700 ms. Sin
regresión. Es la regla 7 de §8 otra vez, y sigue costando la misma disciplina.

---

## 7-septies. Semana 9 — El diff de `applyTextUpdate`

Perfilar la pulsación entera —y no solo el reparse, que es lo que el modelo instrumenta—
dejó ver que **el 39% del coste ocurría fuera del reparse**, en territorio nunca medido.
Casi todo estaba en una línea.

### El problema

`applyTextUpdate` tenía dos caminos rápidos por delante del caso general, uno para "añadir
al final" y otro para "borrar al final", ambos con `startsWith`. No eran atajos: los dos son
el mismo escaneo de prefijo con una respuesta concreta, y llegar a esa respuesta costaba
comparar el prefijo compartido entero — que el caso general volvía a recorrer desde cero.

Una edición en medio del documento pagaba el mismo prefijo **dos veces**: una para descartar
el camino rápido y otra para calcular el diff que iba a calcular de todas formas.

### La corrección

Una pasada hacia delante y una hacia atrás, y eso es todo el diff. Los dos casos siguen
saliendo bien, simplemente dejan de ser especiales: añadir al final deja `start === oldLen` y
la pasada hacia atrás se detiene en el sitio; borrar al final deja `start === newLen` e
igual.

### Validación

253.902 pares de textos (8 semillas × 40.000, con inserciones, borrados, appends, truncados
y textos completamente distintos, sobre un alfabeto con emoji y acentos): **el `TextChange`
resultante es idéntico al del algoritmo anterior en el 100%**, y en el 100% aplicar ese
cambio al texto viejo reconstruye el nuevo.

### El resultado, y una predicción mía que salió alta

| caret | antes | después |
|---|---|---|
| edición en medio | 0,702 ms | **0,620 ms** (−12%) |
| añadir al final | 0,617 ms | 0,627 ms (igual) |

**Había predicho un 19% y son un 12%.** El error viene de haber medido
`newSource.startsWith(source)` sobre la cadena completa: en una edición en medio,
`startsWith` falla en el punto de edición y no recorre el resto, así que el coste real era
la mitad del medido. La lección es la de siempre — una fase medida aislada no predice su
peso en la operación real — y esta vez el sesgo fue optimista.

Que el caso "añadir al final" no mejore es correcto y esperado: ahí el primer `startsWith`
acertaba a la primera, así que ya era una sola pasada.

---

## 7-octies. Semana 10 — `analyze()`

### Ablación

De 0,620 ms:

| coste | ms | % |
|---|---|---|
| pasada extra del árbol + `Map.set` para `allNodes` | 0,140 | **23%** |
| iterar el `Map` de validadores + `try/catch` por nodo | 0,057 | 9% |
| los validadores en sí (5 × 1736 llamadas) | ~0,28 | 45% |
| la pasada base del walk | 0,051 | 8% |

### El hallazgo, que es el de siempre

`analyze()` recorría el árbol **dos veces**: una para construir un `Map` de 1736 entradas de
id→nodo, y otra para validar. Ese índice existía para que `DocumentModel` pudiera buscar
después, por id, el nodo al que colgar cada diagnóstico.

Pero **cada diagnóstico se produce mientras se está visitando su propio nodo**. El índice, y
la pasada que lo construía, resolvían un problema creado por haber separado los dos pasos.
Y `context.allNodes` —el motivo declarado de que exista— **no lo lee ningún validador**, ni
uno de los cinco integrados ni nada en el repo.

### Lo hecho

- **Una sola pasada.** El validador cuelga el diagnóstico en el nodo que tiene delante.
- **`allNodes` pasa a ser un getter** en el contexto y en el resultado, así que se construye
  solo si alguien lo pide. La capacidad sigue disponible para un validador que de verdad
  necesite referencias cruzadas; el resto deja de pagarla.
- **Despacho por kind.** Tres de los cinco validadores integrados abren con una prueba de
  kind y nada más (`custom`, `code`/`inline_code`, `DEPRECATED_KINDS`), así que se llamaban
  1736 veces cada uno para responder algo que el despachador responde una vez. `Validator`
  gana un campo `kinds?` opcional — omitirlo mantiene el comportamiento anterior, así que la
  API no rompe a nadie.
- **Los validadores se recorren en array**, no iterando un `Map`, que alojaba un iterador y
  un par desestructurado por nodo. El `try/catch` sigue siendo por validador: uno que falle
  no debe llevarse por delante el resto del análisis.

### Validación

20.002 documentos (2 fixtures reales + 5 semillas × 4.000, con un alfabeto diseñado para
**disparar** validadores: etiquetas desconocidas, vacías, sin cerrar, obsoletas y `[code]`
con estructura dentro). **18.929 producen diagnósticos**, y la salida —los diagnósticos
emitidos y cuál queda colgado de qué nodo— es **byte a byte idéntica** a la anterior.

### Una cifra mía que hay que corregir

Durante varias sesiones se ha citado `analyze()` como **1,7 ms**. Ese número venía de restar
un `rebuild` con análisis menos uno sin él, lo que le atribuía costes que no eran suyos.
Medido directamente, eran **0,60 ms** en un documento limpio. El error no cambió ninguna
decisión —seguía siendo el candidato correcto— pero la cifra estaba inflada casi 3×.

---

## 7-nonies. Semana 11 — El memo de corchetes del lexer

Lo que quedaba del lexer tras la semana 6, medido: el memo de corchetes era el **15%** y
alojar los 2538 objetos token otro 15%. El segundo no se toca sin cambiar la API. El primero
resultó ser gratis.

### Instrumentar antes de suponer

El memo existe para arreglar el `O(n²)` de la semana 1. Contando aciertos de verdad:

| documento | consultas | aciertos | lecturas útiles |
|---|---|---|---|
| fixture 19,6 KB | 804 | **0** | **0** |
| `[` × 16.000 | 16.000 | 15.999 | 15.999 |
| atributos anidados | 400 | **0** | **0** |

Es **imprescindible** en el caso patológico y **completamente inútil** en todo lo demás. La
razón está en quién escribe cada entrada:

- La entrada para la posición consultada (`bracketMatch.set(from, result)`) **no se lee
  jamás**. El bucle principal nunca pregunta dos veces: si el escaneo acierta salta más allá
  del `]`, y si falla emite `[` como texto y avanza a `from + 1`. En ninguno de los dos casos
  vuelve. Eran 804 `set` desperdiciados por documento — y, peor, eran los que impedían que el
  mapa estuviera vacío, con lo que cada consulta pagaba un fallo de búsqueda.
- Las entradas de los corchetes encontrados **dentro** del escaneo sí sirven, pero solo
  cuando ese escaneo fracasa: entonces el bucle principal entra en ellos uno a uno. Es
  exactamente el caso patológico.

### Lo hecho

Dejar de registrar la entrada propia, y saltarse la consulta cuando el mapa está vacío —una
comparación de enteros es más barata que una búsqueda destinada a fallar—. En un documento
sin corchetes sueltos el mapa no llega a tener nada dentro.

### Validación

56.012 documentos y 882.752 tokens, con un alfabeto cargado de corchetes (`[[[[`, `[a[b]c]`,
`[box=[b]t`, `[`×500) porque es lo que ejercita el memo: **flujo de tokens idéntico**.

Y el número que de verdad importaba comprobar: `[`×16.000 sigue en **2,0 ms**. El arreglo del
cuadrático no se ha tocado.

---

## 8. Metodología de medición

**Fixture:** `src/problematic_sectionwgradient.milia` (19.6 KB, 2538 tokens, 1736 nodos).

**Harness:** 2 llamadas de warm-up + N iteraciones cronometradas, se reporta la media.
Para las comparaciones A/B: 7 tandas de 100 iteraciones, se reporta la **mediana** (el JIT hace que
una sola medición en frío sea inservible — la primera medición de `NodeMatcher` dio 15.5 ms frente
a 5.14 ms en régimen estacionario).

**Reproducir:**

```bash
cd packages/quasar
npm run verify          # typecheck + tests
QUASAR_FUZZ_SEED=2 npm test   # corpus que reproduce el bug de idempotencia
```

Los scripts de benchmark son de usar y tirar: se escriben en `packages/quasar/*-tmp.ts`, se ejecutan
con `npx tsx` y se borran. No se versionan para no ensuciar el paquete.

**Validación de cambios de núcleo:** cualquier cambio al lexer o al parser debe validarse
*diferencialmente* contra la implementación anterior (la del lexer comparó 149.894 posiciones y
50.000 documentos aleatorios). No basta con que pasen los tests.

**Reglas que costaron tiempo aprender:**

7. **Comparar rutas, no APIs distintas.** Medir `applyTextUpdate` (incremental) contra `rebuild`
   daba que el incremental perdía, pero `applyTextUpdate` arrastra change-tracking y un `setTimeout`
   de debounce que `rebuild` no tiene. La comparación honesta fue añadir
   `DocumentModelOptions.incremental` y medir la **misma** llamada con la opción a `true` y a
   `false`. Cambió el signo del resultado.
8. **Comprobar que `global.gc` existe antes de medir memoria.** Bajo `npx tsx` no está, así que
   nada se recogía entre tandas y el interner parecía gastar **más** memoria, no menos. Con
   `node --expose-gc --import /usr/lib/node_modules/tsx/dist/loader.mjs` el signo se invirtió:
   de "+68%" a "−49%". Imprimir `typeof global.gc` antes de creerse una cifra de heap.
9. **Una fase aislada no predice el coste de punta a punta.** El interning es un +110% sobre el
   parseo medido solo, y un +6% sobre el coste real por pulsación, porque el parseo es una fracción
   del trabajo. Decidir con la segunda cifra.

---

## Anexo — Cosas que la documentación afirma y el código no cumplía

| `QUASAR.MD` dice | Realidad medida | Estado |
|---|---|---|
| §3 "140 FPS, latencia < 0.2 ms" | 290 ms por pulsación | **1.09 ms** por pulsación tras la semana 4 (ruta incremental, sin análisis) — 266× mejor, aún 5× del objetivo declarado |
| §13 "Structural Sharing (Deduplicación de Memoria)" | El módulo lanzaba `TypeError` en su primera línea; con él arreglado, 0% de dedup | ✅ **59,6% de dedup real** — punto 5, semana 5. Opt-in: es memoria a cambio de latencia |
| §14 "Parseo Incremental" | Deja offsets corruptos y desincroniza green/red | ✅ Correcto y validado sobre 22.100 ediciones — punto 9, semana 4 |
| §3 "Tolerancia a Concurrencia gracias a inmutabilidad estricta" | Flag estático global; el árbol rojo se muta desde 4 sitios | ✅ `QUASAR.MD` corregido — punto 13 |
| `RedNodeStore.ts:21` "HTMLRenderer cache by canonicalId" | No existe tal caché |
| §2 "Estado de Ingeniería: Producción Industrial" | 48 errores de `tsc`, 4 tests rojos, fuzzer con 60% de flake |

Actualizar `QUASAR.MD` conforme se vayan cerrando las semanas 2 y 3 es parte del trabajo:
documentación que miente es peor que no tener documentación.

---

## Post-cierre — Sesión 2026-08-05: coherencia, conectividad e identidad estable

La auditoría de rendimiento sigue cerrada; esto es un frente distinto, salido de una revisión
de conectividad del motor completo. Decisión del usuario: los subsistemas sin consumidores
(~9.000 LOC: Analysis, Markdown, Commands, Transactions, Transformers, Plugins, Linter,
Symbols, Queries, Formatter, TreeDiffer, RenderPipeline…) **se conservan** — Quasar es
plataforma independiente y son su futuro (colaboración en tiempo real, plugins). No amputar.

### Arreglado (suite: 327 verdes; `ModelCoherence.test.ts` y `StableNodeIds.test.ts` nuevos)

1. **Diagnósticos frescos.** `applyChange` difiere `analyze()` (debounce de 10 ms), así que
   quien leía `model.diagnostics` justo tras `applyTextUpdate` veía los errores del texto
   ANTERIOR — el panel de errores iba una pulsación por detrás. Nuevo
   `DocumentModel.ensureAnalyzed()` vacía el trabajo pendiente; `BBCodePipeline` (app) lo
   llama tras cada edición.

2. **EventBus perezoso.** La app no tiene ni un suscriptor, pero cada `emit` guardaba el
   evento en un historial de 50 que nadie lee — y los eventos de rebuild/diagnostics llevan
   la closure del `nodeMatch` perezoso, que fija el árbol rojo+verde viejo entero (~258 KB
   por evento; megabytes por documento). Ahora: historial opt-in (`recordHistory`, off por
   defecto) y el modelo no construye eventos sin suscriptores (`hasListeners()`).

3. **`transact`/`undo`/`redo` coherentes.** Mutaban `_redRoot` sin tocar `_source` ni
   `_greenRoot` (el siguiente edit diffeaba contra un source que el árbol ya no cumplía), el
   `invert()` solo sabía invertir 1 de 6 kinds, y el flag `_applied` hacía del redo un no-op
   silencioso. Ahora `transact` aplica al rojo → `exportSource()` (override de
   `BBCodeDocumentModel` vía `BBCodeExporter` target `'miliastry'`) → `rebuild`: las tres
   representaciones siempre describen el mismo documento. Undo/redo reproducen **snapshots
   de texto** (`UndoManager` reescrito): texto siempre es reproducible, incluso tras rebuilds
   que reemplazan todos los ids.

4. **`"sideEffects": false`** en `package.json` (verificado: ningún módulo tiene efectos en
   import). Mantener los subsistemas aspiracionales en el repo ya no implica enviarlos al
   navegador.

### Identidad estable de nodos — el pendiente grande del cierre ✅

`src/Syntax/preserveNodeIds.ts`, enganchado en `rebuild` y en la ruta incremental de
`applyChange`. Calca la Fase 0 del `NodeMatcher` (lockstep + recorte de prefijo/sufijo) con
tres niveles: green ref-igual (el splice incremental comparte subárboles sin tocar — cubre
casi todo tecleando) → hash igual con verificación estructural y commit atómico (ruta de
rebuild completo) → mismo kind en la misma posición (el nodo editado conserva su identidad).
La unicidad sale por construcción: el recorrido es posicional, cada id viejo se adopta como
mucho una vez.

| Métrica | Valor |
|---|---|
| Ids conservados tecleando en el `[notice]` del fixture | **1736/1736 (100%)** |
| Coste de `preserveNodeIds` por pulsación | **0,077 ms** |
| Pulsación completa (¡ahora CON análisis síncrono!) | **~0,95 ms** — dentro de la banda 0,9-1,1 |
| Bloques `data-node-id` intactos tras morph (test e2e) | identidad DOM preservada, `isEqualNode` dispara |

Nota: el renderer ya solo emite `data-node-id` en bloques seleccionables
(`ID_BEARING_KINDS`), no en cada span — el problema del 38% de HTML en ids estaba mitigado;
lo que faltaba era que esos ids no cambiaran en cada parseo. Con esto, la Fase 1 del
`NodeMatcher` (match por id) deja de estar muerta por definición, y la identidad estable
queda lista como prerrequisito de colaboración.

### Añadido en la misma sesión: fuera el UUID por diagnóstico ✅

`createDiagnostic` acuñaba un `crypto.randomUUID()` (con fallback manual v4 para SSR) por
diagnóstico, para un campo `id` que **no leía nadie** — ni el motor, ni `ErrorCheckerWindow`
(usa `key={idx}`), ni `toDocumentErrors`. El campo se borró del tipo; un diagnóstico se
identifica por lo que dice y dónde: `(code, range, nodeId)`.

| `analyze()`, 900 diagnósticos | mediana de 7 tandas |
|---|---|
| Antes | 1,34 ms |
| Después | **0,69 ms** (−49%) |

Más de lo que predecía el 14% de la auditoría: el coste real incluía la presión de GC de
900 UUIDs de 36 caracteres por análisis. Suite: 327 verdes, `tsc` limpio.

### El plato fuerte: reutilización de subárboles rojos ✅ (2026-08-05)

`buildRed` reconstruía los ~1736 nodos rojos en cada pulsación aunque solo cambiara una
ventana — la fase más cara medida (0,30 de 0,94 ms). La observación que lo desbloquea: tras
las semanas 4-7, el splice incremental comparte por referencia todos los subárboles verdes
intactos, y la igualdad por referencia del verde es **prueba** de que el subárbol no cambió.
`greenToRedNodeReusing` (en `BBCodeToGreenNode.ts`) adopta el subárbol rojo viejo entero —
ids, metadata y diagnósticos incluidos — con el patrón de lockstep + prefijo/sufijo de la
Fase 0; la adopción cuesta un `parent` (lo pone `initChildren`) y, solo si el subárbol se
desplazó, un `setStart` que suma un delta a dos enteros por nodo.

**Contrato nuevo, documentado en el código:** el árbol rojo anterior queda CONSUMIDO tras
un `applyChange` (los subárboles adoptados se reparentan). Verificado que nadie recorre un
árbol rojo superado: la app ignora `existingAst` y el `IdentityResolver` del docblock de
`BBCodePipeline` no existe. Kill-switch: `DocumentModelOptions.reuseRed` (default `true`).

| Métrica | Antes | Después |
|---|---|---|
| `buildRed` por pulsación | 0,296-0,339 ms | **0,041-0,057 ms** (~6×) |
| Pulsación completa (con análisis síncrono) | ~0,95 ms | **~0,80 ms** |
| Fuzz diferencial contra rebuild completo | — | **120 ediciones, árbol idéntico** (kind, text, range, metadata) + HTML idéntico |
| Unicidad de ids tras adopción + frescos | — | 40 ediciones, 0 duplicados |

El test del kill-switch cazó un bug real de cableado: `BBCodeDocumentModel` no reenviaba
`reuseRed` en el `super()` — el patrón A5 (opciones tragadas en silencio) repitiéndose.
Además `preserveNodeIds` gana un tier 0 (mismo objeto → nada que copiar), así que su coste
baja a 0,048 ms y sus stats pasan a contar solo ids copiados entre objetos distintos.

Suite: **331 verdes** (`RedReuse.test.ts` nuevo, 4 tests).

### Consolidación de los handlers de efectos + kindToTagName ✅ (2026-08-05)

**Los "dos renderers de gradient" resultaron ser cuatro pares.** Cada efecto (gradient,
sinewave, grow, rainbow) duplicaba su matemática de segmentos entera entre `toBBCode` y
`toRenderNode` — misma progresión t, mismo easing/mixing/wave, distinta presentación. Ahora
hay UNA función `*Segments` por efecto y dos presentadores compartidos
(`segmentsToBBCode`/`segmentsToRenderNode`). TagRegistry: −101 líneas netas.

Validado por snapshot: las salidas de los 8 handlers sobre 9 casos (modo palabra,
`globalOffset`, texto vacío, un solo color) capturadas ANTES del refactor son **byte a byte
idénticas** después, y quedan fijadas en `EffectSegments.test.ts` + `.snapshot.json` (9
tests) para que la próxima mano que toque la matemática no pueda desincronizar los dos
formatos sin enterarse.

Aclaración que importa: `HTMLRenderer.renderGradient` NO es un duplicado de esto — el
preview pinta un `linear-gradient` CSS suave; estos segmentos reproducen los colores
DISCRETOS del BBCode exportado. Es una diferencia intencionada, ahora documentada en el
código en vez de parecer una divergencia accidental.

**`kindToTagName`**: el mapa de 30 claves se alojaba DENTRO del método — un objeto nuevo por
nodo exportado. Ahora es constante de módulo, con nota de por qué NO es intercambiable con
`nodeKindToTag` de BBCodeToGreenNode (grafía osu!: `centre`, `youtube`).

Suite: **340 verdes**.

### Frente plataforma — colaboración v0/v1 + plugins end-to-end ✅ (2026-08-05, tarde)

**Colaboración** (arquitectura completa en `QuasarCollab.MD` — leerlo antes de tocar nada):
decidido **texto-CRDT**: el texto es la unidad de sincronización, Quasar es función pura
`texto → vista` en cada cliente, el árbol nunca viaja por la red, el motor queda sin
dependencias (Yjs irá en la app). Hecho: `src/Collab/positions.ts`
(`transformOffset`/`transformRange`, sesgos documentados — caret pega a la derecha, los
rangos preservan exactamente su contenido) y `origin` en `applyChange`/`applyTextUpdate` →
eventos, para que la capa de sync distinga su propio eco. Propiedad validada con fuzz:
2.000 documentos × cada posición — el carácter apuntado antes es el apuntado después.

**Plugins**: el eslabón que faltaba era el parser — `tagToNodeKind` convertía cualquier tag
no-builtin en texto literal, así que un tag de plugin renderizaba y exportaba pero nunca
PARSEABA. Ahora `ParseOptions.extraTags` (mapa nombre→kind) deja nacer el frame;
`TagRegistry` distingue builtins de registros de plugin (`isBuiltin`, `customTags()`,
`version` para memoizar) y `BBCodeDocumentModel` lo cablea con coste cero sin plugins (una
comparación de enteros por parseo). El exporter serializa tags de plugin bajo su nombre
registrado — estrictamente limitado a NO-builtins: sinewave/rainbow/svg conservan su
serialización actual, de la que dependen los flujos de Studio. El renderer sin registry ya
no traga el contenido de kinds desconocidos (renderiza los hijos, omite solo el wrapper).

Test del ciclo completo (`PluginTags.test.ts`, 6 tests): lex → parse (con anidamiento,
attrs y partición intacta) → render (con y sin registry) → export (round-trip byte a byte,
punto fijo) → PluginAPI registra/desregistra → diferencial incremental vs rebuild con tags
de plugin. La prosa con `[90 misses]` sigue siendo texto visible.

Pulsación sin cambios (~0,7-0,8 ms). Suite: **356 verdes**.

Hallazgo aparcado para el pase de honestidad: `RenderTree.toHTML` ignora `style` en nodos
`text` — los toRenderNode de efectos pierden sus estilos por ese camino.

---

## Post-cierre — El suelo de ~60 ms del flush de la app (2026-08-05, noche)

Tras bajar el debounce, la pregunta pasó a ser el **bloqueo del hilo por flush**. Medido en
build de producción con Playwright + `Performance.getMetrics`, separando el coste de TECLEAR
(Monaco) del coste del FLUSH (parse + render + morph + React):

| Doc | tecleo (Monaco) | flush (pipeline) |
|---|---|---|
| 19,6 KB | 24,9 ms | **41,8 ms** (script 22,1 · style 4,2 · layout 0,8) |
| 196 KB | 116,4 ms | **48,2 ms** (script 16,7 · style 13,7 · layout 0,5) |

Dos cosas que corrigen creencias previas:

1. **En documentos grandes, el que domina es Monaco** (116 ms de tecleo contra 48 de flush),
   no nuestro pipeline. Optimizar el flush ahí no mueve la aguja.
2. **El coste del flush NO era el modo dev.** La auditoría de la app suponía que buena parte
   de los 57-77 ms de dev eran instrumentación de React; en producción son ~42 ms reales.

### Hipótesis probada y REFUTADA: render incremental por bloques

Un perfil de CPU de la ventana del flush dio **~30 de los ~42 ms en `(program)`** (trabajo
nativo) contra ~4 ms de todo nuestro JS junto. Como `morphHTML` hace
`template.innerHTML = htmlCompleto` antes de poder comparar, la lectura fue: *estamos
re-parseando 90 KB y 5.500 nodos por pulsación*. Se implementó `IncrementalPreview` — solo
re-renderiza y re-parsea el bloque de primer nivel que cambió, usando la identidad por
referencia que da la reutilización de subárboles rojos — con 9 tests y fuzz diferencial.

**A/B en producción, ambos caminos en la misma sesión, alternados:**

| Doc | morph completo (viejo) | por bloques (nuevo) |
|---|---|---|
| 19,6 KB | **43,1 ms** | 103,0 ms (style 4,6 → **34,2**) |
| 196 KB | **89,9 ms** | 313,3 ms (style 14,5 → **159,8**) |

**2-3,5× más lento.** La premisa era falsa: `(program)` no es sobre todo parseo de HTML,
es **style recalc + paint**, y eso lo minimiza justo el morph. Reemplazar el subárbol DOM de
un bloque toca miles de elementos; el morph toca los que cambiaron. Además el fixture real
tiene solo **7 bloques de primer nivel** (uno se come el 60% del post), así que la
granularidad de bloque tampoco acotaba el trabajo. Revertido; `IncrementalPreview` borrado.

> Regla que confirma §8: *la fase que un perfil señala como cara no es necesariamente la que
> se puede evitar*. `(program)` agrega parse + estilo + layout + pintado; atribuirlo entero
> al parseo costó una implementación completa. Un A/B alternado en la misma sesión lo habría
> dicho antes — la varianza entre tandas (tecleo 24,9 / 31,1 / 67,0 ms para el mismo
> documento) hace inútil comparar builds distintos.

### Lo que sí salió de aquí: dos bugs reales de identidad ✅

El fuzz diferencial del experimento (comparando el DOM incremental contra el completo)
destapó que `preserveNodeIds` **corrompía ids** en dos casos, y ambos arreglos se quedan:

1. **Doble mecanismo.** Con reutilización de rojos, un bloque intacto ES el nodo anterior y
   ya trae su id; correr encima el recorrido de ids lo emparejaba **posicionalmente** con su
   vecino y le sobrescribía el id — duplicando ids vivos y cambiando el `data-node-id` de
   bloques que no habían cambiado. Ahora la identidad la lleva **o** la adopción **o** el
   recorrido, nunca las dos: se decide contando adopciones reales (`reparse` puede hacer un
   rebuild completo por dentro aunque la reutilización esté activada, y entonces no adopta
   nada).
2. **Recorte demasiado laxo.** El trim de prefijo/sufijo avanzaba si los nodos compartían
   *kind*, lo cual es cierto de dos párrafos cualesquiera: **insertar un bloque hacía que el
   recorrido marchara por toda la lista emparejando cada superviviente con su vecino**, y
   renumeraba todo lo posterior a la inserción. Ahora exige evidencia de contenido (misma
   referencia verde o mismo hash).

Efecto colateral bueno: al no cambiar ya el `data-node-id` de los bloques que sobreviven a
una inserción, el camino rápido del `DOMMorpher` (`isEqualNode`) funciona también al insertar
y borrar bloques, no solo al teclear dentro de uno. Fijado en `StableNodeIds.test.ts`.

Suite: **357 verdes**.

### Qué queda del suelo, con datos

El flush son ~42 ms de los que ~30 son nativos (estilo + pintado + parse) sobre un preview
que refleja **5.500 nodos DOM** (30.000 en un post de 196 KB). El siguiente candidato real
no es cómo actualizamos el DOM, es **cuánto DOM hay**: el renderer emite un
`<span class="bb-text">` por cada nodo de texto y **`.bb-text` no tiene ni una regla CSS en
todo el repo** (el único lector es `HTMLToGreenNode`, que no usa nadie). Quitar ese envoltorio
recorta ~1 elemento por hoja de texto y ~27% del HTML emitido. No medido todavía: hacerlo con
A/B alternado, no comparando builds.

### El envoltorio `<span class="bb-text">`: fuera ✅ (2026-08-05, noche)

El candidato que dejó la sección anterior, ahora medido. El renderer envolvía **cada hoja de
texto** en un `<span class="bb-text">`, y esa clase **no tiene ni una regla CSS en todo el
repo**: no lleva `data-node-id` (el texto no es un kind con id, así que ni el clic ni el
resaltado la miraban jamás) y los estilos de una hoja siguen emitiendo su propio
`<span style="…">`. Era un elemento por hoja a cambio de nada.

**A/B en producción, estado estacionario, ciclos alternados** (la metodología que la sección
anterior aprendió a la fuerza):

| Doc | CON spans | SIN spans |
|---|---|---|
| 19,6 KB | 41,4 ms · **1.726** elementos | **39,7 ms** · **851** elementos |
| 196 KB | 55,4 ms · **17.251** elementos | **46,4 ms (−16%)** · **8.510** elementos |

**La mitad del DOM del preview**, ~27% menos HTML que serializar y parsear, y un flush
más barato — modesto en documentos normales, claro en los grandes. Confirmado tras hacerlo
permanente: 40,3 ms / 851 elementos y 60,8 ms / 8.510 elementos, con el preview mostrando
el contenido correcto.

Comprobado antes de tocar: `osu.css` scopea todo bajo `.bbcode-preview` con selectores de
etiqueta (sin reglas para `span`, sin selectores de hermanos), `dom-to-svg` recorre
`TEXT_NODE` explícitamente, y `usePreviewClick`/`useBlockHighlight` resuelven por
`data-node-id`, que solo llevan los bloques.

### De paso: dos tests que no verificaban nada ✅

Al quitar el span falló un `expect(html).toContain('class="bb-text"')`, y al abrirlo apareció
el patrón que la auditoría marcó como B5:

- **`VisualBuilderFidelity.test.ts`** guardaba 6 KB de "HTML esperado" que **nunca se
  comparaba** con nada, lo escribía a `visual-builder-expected.html` /
  `visual-builder-actual.html` —ficheros **rastreados por git**, ensuciados en cada
  ejecución— y solo asertaba dos `toContain`. Reescrito: 15 tags → elemento esperado,
  atributos, contenido raw de `[code]`, `data-node-id` solo en bloques, prosa final.
- **`ProblematicSectionHTML.test.ts`** no tenía **ni una aserción**: renderizaba dos
  variantes y las escribía a `orig.html` / `grad.html`. Reescrito: la capa de gradiente
  colorea el texto sin inventar ni perder bloques, y el render es determinista salvo ids.

Ya ningún test escribe en el árbol de trabajo. (Los `.html` que aparecen modificados en
`git status` son los restos de ejecuciones anteriores; se pueden restaurar con `git checkout`.)

Suite: **362 verdes**.

---

## Post-cierre — El coste de `data-node-id` va con el NÚMERO, no con la longitud (2026-08-05)

Con `HTMLRenderer.idMode = 'all'` el atributo lo llevan **808 de los 852 elementos** del
fixture, y eso se paga: el A/B en la app dio 48 → 56 ms de latencia y p95 72 → 104 ms
(ver el comentario de `idMode`). La pregunta natural es si se puede abaratar sin perder la
precisión del clic. La respuesta corta: **acortar el atributo no sirve de casi nada**, y la
razón es contraintuitiva.

### Primero, lo que YA no cuesta

| Métrica (fixture 19,6 KB) | `blocks` (9 ids) | `all` (808 ids) |
|---|---|---|
| HTML emitido | 31,4 KB | 47,7 KB (+52%) |
| `setAttribute` por pulsación (morph de 1 carácter) | 1 | **6** |
| `render` del documento completo | 0,315 ms | 0,351 ms |
| `applyTextUpdate` + `render` | 0,497 ms | 0,543 ms |

Los **6 `setAttribute`** son el dato importante: la identidad estable hizo su trabajo y
**el churn del morpher ya no existe**. Cuando los ids se regeneraban en cada parseo esto
eran 1665 escrituras sobre 1725 elementos. No queda nada que optimizar por ese lado.

Descartada también la sospecha de que el contador global infle los ids a lo largo de la
sesión: tras **500 pulsaciones** siguen en 5 dígitos (+522 bytes de HTML, y de esos 500 son
el texto tecleado). El camino incremental reutiliza subárboles rojos, así que acuña muy
pocos ids nuevos por tecla.

### El hallazgo: el parser cobra por atributo, no por byte

Parseo de `template.innerHTML`, jsdom, **mínimo de 10 rondas × 25 parseos, intercalando las
variantes** para cancelar la deriva. Se emite el id en una fracción de los elementos, en dos
formatos de longitud muy distinta:

| ids | formato largo (`data-node-id="n12345"`) | formato corto (`n=9ix`) |
|---|---|---|
| 0 | 31,93 ms · 31,3 KB | — |
| 202 | 32,64 ms · 35,4 KB | 32,70 ms · 32,3 KB |
| 404 | 33,58 ms · 39,5 KB | 33,76 ms · 33,4 KB |
| 808 | 35,14 ms · 47,7 KB | 34,42 ms · 35,5 KB |

Con 202 ids da igual que el HTML pese 35,4 KB o 32,3 KB: **32,64 contra 32,70 ms**. Con 404,
igual. El tiempo sigue la **cuenta** de elementos con atributo —lineal, ~3-4 µs por
elemento— y es casi indiferente a su longitud. El parser paga por crear la entrada del
atributo, no por leer sus caracteres.

Consecuencia práctica: **acortar el nombre recorta 12,2 KB de string y recupera 0,7 ms de
los 3,2** que separan `blocks` de `all`. El 78% restante solo se va bajando la cuenta.

> Regla, hermana de la que dejó el experimento de `IncrementalPreview`: *el tamaño del payload
> no es una proxy del coste de parsearlo*. Aquí la correlación tamaño↔latencia era real pero
> espuria — las dos crecían con el número de elementos con id, y solo la segunda causaba.
> Hizo falta variar las dos cosas por separado para verlo.

### Formatos medidos, para no repetir el ejercicio

Todos validados en jsdom: 808 elementos encontrados, `closest('[attr]')` resuelve, y el DOM
los **reserializa con comillas**, así que el formato sin comillas solo vive en la cadena que
emite el renderer (que es justo donde ahorraría). Sin comillas es HTML válido mientras el
valor no lleve espacios, comillas, `=`, `<`, `>` ni backtick — un base36 cumple.

| Formato | Bytes/elemento | HTML total |
|---|---|---|
| `data-node-id="n12345"` (hoy) | 22 | 47,7 KB |
| `data-i="9ix"` | 13 | 41,1 KB |
| `ni="9ix"` | 12 | 37,9 KB |
| `n="9ix"` | 10 | 37,1 KB |
| `n=9ix` | 8 | 35,5 KB |

Si algún día se hace, que sea **en minúscula**: el parser de HTML baja los nombres de
atributo a minúsculas, y `SVGRenderer` serializa a XML, donde esa diferencia sí importaría.
El precio es que un atributo que no es `data-*` no es conforme y pierde `dataset`; hoy da
igual (no hay ningún sanitizador en el pipeline y solo lo leen `getAttribute`, `closest` y
`querySelector`, más dos selectores en `MiliastryNovaFeatures/BBCode/styles.css:252` y `:258`).

### La única palanca real, y por qué no se tira

Bajar la cuenta de 808 a 9 sin perder precisión **es posible**: `closest()` da el bloque,
`caretPositionFromPoint` da el carácter, y un recorrido del subárbol del bloque acumulando
longitudes de texto renderizado da el nodo exacto. Preview→Monaco quedaría igual (el clic ya
resuelve a un `RedNode`, y el evento `miliastry:select-node` viaja con su id).

Lo que lo frena no es el rendimiento, es el **contrato de la dirección inversa**:
`useBlockHighlight` hace `querySelector('[data-node-id="X"]')`, y `EditorWindow` sube desde
el cursor solo hasta salir de `text`/`spacing`/`empty_line` — así que X puede ser un nodo
**inline**, que ya no tendría elemento que lo lleve. Habría que resaltar con Range + CSS
Custom Highlight API, o degradar al bloque.

**Decisión: no se hace.** 8 ms en la app (3,2 en la sonda) a cambio de rehacer el resaltado,
en un camino que ya está por debajo del umbral de percepción.

También medido y descartado: emitir el id solo donde un clic puede aterrizar. Por una
aproximación conservadora, solo **22 de los 808** son inalcanzables por `closest()`. Medio KB.

### Aviso de metodología

Todo esto es **jsdom, no Blink**. Las cifras absolutas no trasladan (los ~35 ms de parseo de
la sonda son un artefacto de jsdom; en producción el flush entero son ~42 ms). Lo que
traslada es la forma: el A/B de la app midió el mismo salto de 9 a 808 ids como 48 → 56 ms.
En Blink los bytes pesan algo más que aquí —hay que construir la cadena y transferirla— pero
la cuenta de atributos sigue dominando. Cualquier cambio en esto se valida con A/B alternado
en la app, no con esta sonda.
