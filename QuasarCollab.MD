# 🛰️ Quasar — Colaboración en tiempo real: arquitectura

> Documento de decisión, escrito el **2026-08-05**, antes de la primera línea de código.
> Si alguien propone cambiar la arquitectura, primero tiene que refutar este documento.

## La decisión: texto-CRDT

**La unidad de sincronización es el texto fuente, no el árbol.** Cada cliente mantiene el
source en un CRDT de texto (Yjs/`Y.Text` o equivalente); Quasar actúa en cada cliente como
función pura `texto → árbol → vista`. Una edición remota entra al motor por el mismo camino
que una pulsación local: un `TextChange` por `applyChange`.

### Por qué (resumen del razonamiento completo)

1. **La verdad de Quasar ya es el texto.** El árbol es estado derivado — `transact` exporta
   a texto y reparsea; todo entra por `parse`. Se sincroniza la verdad, se deriva el resto.
2. **El parseo total absorbe cualquier fusión.** El parser produce un árbol válido para
   *cualquier* texto (los tags rotos quedan como texto visible, semana 4). El peor caso de
   una fusión concurrente fea es markup literal en pantalla, corregible; nunca corrupción
   estructural.
3. **El parseo es determinista y barato.** Validado sobre cientos de miles de documentos:
   mismo texto ⇒ mismo árbol en todos los clientes, sin sincronizar nada más. El
   incremental (0,8 ms/pulsación) absorbe las ediciones remotas al mismo coste que las
   locales.
4. **El precedente correcto es el editor de código**, no el de texto rico: Miliastry es un
   sitio donde se teclea markup a mano en Monaco. Árbol-como-verdad (ProseMirror) exige una
   superficie donde no se pueda teclear medio tag — lo contrario de este producto.

### Por qué NO árbol-como-verdad (para el futuro lector)

- Cada pulsación en Monaco habría que traducirla a operaciones de árbol… parseando. Se
  paga el parseo igual, más la carga de expresarlo como ops.
- Los estados intermedios (`[b` a medio teclear) no tienen representación de árbol.
- El árbol pierde información a propósito (`[s]` vs `[strike]`, `centre` vs `center`):
  `árbol → texto` no es exacto hoy, y hacerlo exacto exige trivia estilo Roslyn en cada
  nodo.
- Fusión por pares de operaciones, ids globales, undo reescrito.

Si algún día BBCodeCanvas es LA superficie principal, se revisita. No antes.

## Reparto de responsabilidades

| Capa | Responsable de | NO responsable de |
|---|---|---|
| **Quasar (motor)** | transformación de posiciones a través de `TextChange`; `origin` en eventos (distinguir local/remoto); parseo determinista e incremental | transporte, awareness, persistencia, resolución de conflictos (la hace el CRDT) |
| **CRDT (Yjs u otro, capa app)** | convergencia del texto; undo por origen; historial | conocer el árbol |
| **App (Miliastry)** | transporte (WebSocket/WebRTC), presencia, cursores remotos pintados, permisos | tocar el motor |

El motor se mantiene **sin dependencias** (package.json: cero deps). Yjs vive en la app.

## API del motor para colaboración

### v0 — posiciones (esta sesión) ✅

`src/Collab/positions.ts`:

- `transformOffset(offset, change, bias?)` — dónde queda una posición tras un
  `TextChange`. `bias: 'left' | 'right'` decide el lado cuando la edición cae exactamente
  en la posición (un caret quiere `'right'` para que lo tecleado por otro delante suyo lo
  empuje; el inicio de un highlight suele querer `'left'`).
- `transformRange(range, change)` — ambos extremos, sin invertirse jamás.
- Ambos aceptan una **secuencia** de cambios (composición en orden).

Con esto la app puede mantener carets y selecciones propias y remotas correctos a través
de cualquier edición, local o remota.

### v1 — origen de los cambios (esta sesión) ✅

`applyChange(change, origin?)` / `applyTextUpdate(source, origin?)` — el `origin` viaja en
los eventos (`document_changed.origin`). Sin él, la capa de sync no puede distinguir el eco
de sus propios cambios de las ediciones del usuario (bucle infinito clásico). Default:
`'local'`.

### v2 — la sesión (hecha, en la app) ✅

`MiliastryNovaFeatures/BBCode/Collab/CollabSession.ts` — el binding Y.Doc ↔ modelo,
**agnóstico de transporte** (los tests son el transporte: dos clientes en memoria
intercambiando updates). Vive en el feature, no en el motor: `yjs@13.6.32` es dependencia
de la app; el motor sigue con cero. La sesión conoce un **contrato** (`CollabDocument`:
`source` + `applyTextUpdate`), no `BBCodeDocumentModel` (Ley VII).

- `updateFromLocal(texto)` → splice mínimo al `Y.Text` (diff prefijo/sufijo — la calidad
  de fusión del CRDT depende de que las ediciones estén DONDE ocurrieron) + modelo con
  origin `'local'`. El observer ignora el propio eco por `tx.origin`.
- Remoto → observer → `applyTextUpdate(texto, 'remote')`.
- Undo: `Y.UndoManager` con `trackedOrigins = [sesión]` — deshace solo lo propio, jamás lo
  del compañero. Llega al modelo como `'local-undo'`.
- Cursores: `createCursor`/`resolveCursor` sobre `Y.RelativePosition` — sobreviven a
  ediciones remotas apuntando al mismo contenido.
- Seeding: texto compartido vacío adopta el modelo (crear sesión); no vacío manda sobre el
  modelo (unirse). Desde ese momento el CRDT es la autoridad.

Validado en `CollabSession.test.ts` (7 tests): convergencia de texto+árbol+HTML, ediciones
concurrentes sin conexión que convergen, undo por cliente, anclaje de cursores, orígenes, y
`destroy` sin tocar el doc compartido.

### v3 — lo que queda (transporte y presencia, código app)

- Provider real (y-websocket/y-webrtc) enchufado a `session.doc` — una línea cuando exista
  servidor.
- Presencia: awareness (`y-protocols`) + cursores remotos pintados —
  `resolveCursor` + `findNodeAtOffset` para resaltar el bloque de cada quien (los ids
  estables lo hacen barato).
- Integración con `DocumentInstance`/Monaco: las ediciones del editor entran por
  `session.updateFromLocal` en vez de directo al pipeline; el evento `'remote'` refresca el
  buffer de Monaco sin re-disparar el círculo.

## Qué NO vamos a construir

- **OT propio.** La convergencia es del CRDT. `transformOffset` transforma *posiciones*,
  no cambios contra cambios.
- **Sincronización del árbol.** Nunca viaja un nodo por la red.
- **Servidor.** El motor no sabe que existe una red.
