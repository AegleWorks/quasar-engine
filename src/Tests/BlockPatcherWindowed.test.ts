/**
 * BlockPatcher — windowed (O(edit)) reconciliation tests.
 *
 * The windowed path is the 500k-character fast path: when the model knows the
 * source range of the edit (`TextChangeRange`, attached to the root as
 * `__changeRange` by `DocumentModel.applyTextUpdate`), `patchBlocksInto`
 * reconciles ONLY the runs overlapping that range instead of walking every
 * run of the document.
 *
 * The invariant is the same as the full path: the patched DOM must equal
 * `morphHTML(container, renderer.render(root))`. The differential loops below
 * check that after EVERY edit — the windowed path must never leave the DOM
 * diverging, no matter where the edit lands (start, middle, end, run
 * boundaries, block insertions/deletions).
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { morphHTML } from '../Visitors/DOMMorpher'
import { patchBlocksInto } from '../Visitors/BlockPatcher'

const renderer = new HTMLRenderer()

/**
 * Force the windowed path on small documents. Production defaults to
 * `MIN_WINDOWED_BLOCKS` (200) — below it the full keyed walk beats the
 * windowed bookkeeping — but these tests must exercise the window machinery
 * itself, so they opt in with `0`.
 */
const WIN_OPTS = { renderer, minWindowedBlocks: 0 }

/** Strip data-node-id attributes so cross-model comparisons are structural. */
function stripIds(html: string): string {
  return html.replace(/ data-node-id="[^"]*"/g, '')
}

/** Same-model reference: morphHTML on the given model's root. */
function morphDOM(model: BBCodeDocumentModel): HTMLDivElement {
  const el = document.createElement('div')
  if (model.redRoot) morphHTML(el, renderer.render(model.redRoot))
  return el
}

/**
 * Un documento GRANDE (≥2500 chars) con `n` párrafos de relleno ANTES del
 * contenido real.
 *
 * El camino por ventana exige DOS cosas que solo pasan en documentos grandes:
 *  1. el parser incremental (umbral `MIN_SOURCE_LENGTH` = 2500 chars) — sin
 *     reparse incremental no hay green-sharing ni reference-identity;
 *  2. que la ventana de edición sea menor que la mitad del documento.
 * El relleno da ambas a la vez: los bloques fuera de la ventana son los MISMOS
 * objetos RedNode que cacheó el patch anterior.
 */
function padded(prefix: string, n = 240): string {
  const filler: string[] = []
  for (let i = 0; i < n; i++) filler.push(`relleno ${i}`)
  return filler.join('\n') + '\n\n' + prefix
}

describe('patchBlocksInto — windowed path (model-attached change range)', () => {
  it('editar texto en medio corre por ventana (stats.windowed=true) y equivale al morph', () => {
    const model = new BBCodeDocumentModel({
      source: padded('uno\n\n[box]caja[/box]\n\n[quote]cita[/quote]\n\nfinal'),
    })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    model.applyTextUpdate(padded('uno\n\n[box]caja EDITADA[/box]\n\n[quote]cita[/quote]\n\nfinal'))
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.mode).toBe('blocks')
    expect(stats.windowed).toBe(true)
    expect(stats.patched).toBeGreaterThanOrEqual(1)
    // El rango viaja con el root: el modelo lo adjuntó tras applyTextUpdate.
    expect((model.redRoot as unknown as { __changeRange?: unknown }).__changeRange).toBeTruthy()

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('insertar al inicio es O(1) en mutaciones DOM a 400 bloques (regresión 500k)', () => {
    const lines: string[] = []
    for (let i = 0; i < 400; i++) lines.push(`linea ${i}`)
    const src = lines.join('\n')

    const model = new BBCodeDocumentModel({ source: src })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    model.applyTextUpdate('AAA' + src)
    model.ensureAnalyzed()

    const mo = new MutationObserver(() => {})
    mo.observe(el, { childList: true })
    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    const mutations = mo.takeRecords().length
    mo.disconnect()

    expect(stats.windowed).toBe(true)
    // O(1): huérfano (1) + bloque nuevo (1) + margen del parser — nunca O(n).
    expect(mutations).toBeLessThanOrEqual(6)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('bloques FUERA de la ventana conservan su identidad DOM y estado runtime', () => {
    // Box a al INICIO, relleno en el medio, box c al FINAL. Editar un párrafo
    // del relleno deja ambos boxes fuera de la ventana de edición.
    const filler: string[] = []
    for (let i = 0; i < 240; i++) filler.push(`relleno ${i}`)
    const body = filler.join('\n')

    const model = new BBCodeDocumentModel({ source: `[box]a[/box]\n\n${body}\n\n[box]c[/box]` })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    const details = el.querySelectorAll('details')
    const boxA = details[0]
    const boxC = details[1]
    ;(boxA as HTMLDetailsElement).open = true

    model.applyTextUpdate(`[box]a[/box]\n\n${body.replace('relleno 5', 'relleno 5 EDITADO')}\n\n[box]c[/box]`)
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBe(true)

    const after = el.querySelectorAll('details')
    // Fuera de la ventana: ni se movieron ni se reconstruyeron.
    expect(after[0]).toBe(boxA)
    expect((after[0] as HTMLDetailsElement).open).toBe(true)
    expect(after[1]).toBe(boxC)
    // Y el contenido editado del medio sí llegó.
    expect(el.textContent).toContain('relleno 5 EDITADO')
  })

  it('borrar una región ENTERA del medio (ventana antigua por endOld) no deja nodos fantasma', () => {
    // El escenario que rompía un windowing por índice: borrar muchos bloques
    // del medio. La ventana vieja se ubica con endOld (coordenadas viejas),
    // así que todos los runs eliminados quedan dentro y se quitan del DOM.
    const lines: string[] = []
    for (let i = 0; i < 200; i++) lines.push(`linea ${i}`)
    const src = ['[box]inicio[/box]', ...lines, '[box]fin[/box]'].join('\n')

    const model = new BBCodeDocumentModel({ source: src })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    // Borrar las 200 líneas del medio.
    const newSrc = '[box]inicio[/box]\n[box]fin[/box]'
    model.applyTextUpdate(newSrc)
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    // La ventana cubre casi todo el doc viejo → full reconcile es lo correcto,
    // pero el DOM debe quedar exacto (sin nodos fantasma).
    expect(stats.mode).toBe('blocks')

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
    // Exactamente 2 details, no 202.
    expect(el.querySelectorAll('details').length).toBe(2)
  })

  it('cambiar el text run antes de [code] (fusión de textNodes) mantiene la alineación por ventana', () => {
    const model = new BBCodeDocumentModel({ source: padded('[quote]cita[/quote]\n\n[code]x[/code]') })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    // Más líneas en blanco → el run de '\n\n' crece a '\n\n\n\n'.
    model.applyTextUpdate(padded('[quote]cita[/quote]\n\n\n\n[code]x[/code]'))
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBe(true)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('append al final (cambio tras el último bloque) funciona por ventana', () => {
    const model = new BBCodeDocumentModel({ source: padded('uno\n\ndos\n\ntres') })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    model.applyTextUpdate(padded('uno\n\ndos\n\ntres\n\ncuatro agregado'))
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBe(true)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('backspace al final (edición en EOF, ningún bloque nuevo extiende el rango) no crashea', () => {
    // Regresión: en EOF el árbol NUEVO no tiene ningún bloque con
    // `range.end > change.start` (el último bloque termina justo en el punto
    // de la edición) → `firstChanged` quedaba en `n` → `winEnd = n+1` →
    // `blocks[winEnd - 1]` era undefined (TypeError fuera del try/catch).
    const model = new BBCodeDocumentModel({ source: padded('uno\n\ndos\n\nfinal') })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    // Borrar la última letra: el nuevo último bloque termina EXACTO en el
    // punto de la edición (caso que antes crasheaba).
    model.applyTextUpdate(padded('uno\n\ndos\n\nfina'))
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBe(true)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
    expect(el.textContent).toContain('fina')
    expect(el.textContent).not.toContain('final')
  })

  it('borrar el último bloque completo (región de cola) funciona por ventana', () => {
    const model = new BBCodeDocumentModel({ source: padded('uno\n\ndos\n\n[box]caja final[/box]') })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    // Quitar el último bloque: el rango de cambio llega hasta el final del doc.
    model.applyTextUpdate(padded('uno\n\ndos'))
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBe(true)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
    expect(el.querySelectorAll('details').length).toBe(0)
  })

  it('un editor completo de mitad de doc (ventana enorme) cae al camino full y es correcto', () => {
    const model = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc\n\nd\n\ne' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    // Reemplazar casi todo: la ventana supera la mitad → full reconcile.
    model.applyTextUpdate('a\n\n[heading]NUEVO[/heading]\n\n[box]contenido[/box]\n\nz')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
    expect(stats.windowed).toBeUndefined()

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('un documento nuevo en el mismo contenedor (hint presente pero todo churn) cae al camino full', () => {
    const modelA = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc' })
    const el = document.createElement('div')
    patchBlocksInto(el, modelA.redRoot!, WIN_OPTS)

    // Model B: otra instancia, ids completamente nuevos. Pasar un change chico
    // (hint desactualizado/incompatible) debe ser detectado por el churn guard
    // (bloques fuera de la ventana no son reference-identical) → full reconcile.
    const modelB = new BBCodeDocumentModel({ source: 'x\n\ny\n\nz\n\nw' })
    const stats = patchBlocksInto(el, modelB.redRoot!, {
      renderer,
      minWindowedBlocks: 0,
      change: { start: 1, end: 2, endOld: 2 },
    })
    expect(stats.windowed).toBeUndefined()
    expect(stats.mode).toBe('full')

    const elExpected = morphDOM(modelB)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('secuencia diferencial: el DOM patcheado equivale al morph completo tras cada edición', () => {
    // Doc GRANDE para que el reparse incremental (≥2500 chars) active el
    // camino por ventana en cada paso: el relleno nunca cambia, así que todos
    // los bloques fuera de la ventana son reference-identical.
    const big = padded('')
    // Cada fuente es el resultado realista de la edición anterior: inline en
    // el medio, prepend (re-key del primer bloque), cambio de elemento con
    // hijos, append, borrado de bloque, insert tipo Enter, run boundaries,
    // borrado de bloque del medio, edición de [code].
    const sources = [
      '[box]a[/box]\n\nprimer parrafo\n\n[quote]cita original[/quote]\n\n[code]code[/code]\n\nfinal',
      // inline en el medio
      '[box]a[/box]\n\nprimer parrafo EDITADO\n\n[quote]cita original[/quote]\n\n[code]code[/code]\n\nfinal',
      // prepend de un heading
      '[heading]Top[/heading]\n\n[box]a[/box]\n\nprimer parrafo EDITADO\n\n[quote]cita original[/quote]\n\n[code]code[/code]\n\nfinal',
      // cambio de quote (elemento con hijos)
      '[heading]Top[/heading]\n\n[box]a[/box]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n[code]code[/code]\n\nfinal',
      // append al final
      '[heading]Top[/heading]\n\n[box]a[/box]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n[code]code[/code]\n\nfinal\n\nultimo bloque nuevo',
      // borrar el box inicial
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n[code]code[/code]\n\nfinal\n\nultimo bloque nuevo',
      // insert tipo Enter en el medio
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[center]centrado[/center]\n\n[quote]cita MODIFICADA[/quote]\n\n[code]code[/code]\n\nfinal\n\nultimo bloque nuevo',
      // crecer el text run antes de [code]
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[center]centrado[/center]\n\n[quote]cita MODIFICADA[/quote]\n\n\n\n\n[code]code[/code]\n\nfinal\n\nultimo bloque nuevo',
      // borrar el centro
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n\n\n\n[code]code[/code]\n\nfinal\n\nultimo bloque nuevo',
      // editar el código
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n\n\n\n[code]code EDITADO[/code]\n\nfinal\n\nultimo bloque nuevo',
      // editar el último bloque (append región)
      '[heading]Top[/heading]\n\nprimer parrafo EDITADO\n\n[quote]cita MODIFICADA[/quote]\n\n\n\n\n[code]code EDITADO[/code]\n\nfinal\n\nultimo bloque NUEVO',
    ]

    const bigSources = sources.map((s) => big + '\n\n' + s)
    const model = new BBCodeDocumentModel({ source: bigSources[0] })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, WIN_OPTS)

    for (let i = 1; i < bigSources.length; i++) {
      model.applyTextUpdate(bigSources[i])
      model.ensureAnalyzed()

      const stats = patchBlocksInto(el, model.redRoot!, WIN_OPTS)
      expect(stats.mode).toBe('blocks')

      const elExpected = morphDOM(model)
      expect(
        stripIds(el.innerHTML),
        `divergencia tras la edición ${i}: ${bigSources[i].slice(0, 60)}`,
      ).toBe(stripIds(elExpected.innerHTML))
    }
  })
})

describe('DocumentModel — lastChangeRange (fuente del hint)', () => {
  it('applyTextUpdate expone {start, end, endOld} en coordenadas nuevas/viejas', () => {
    const model = new BBCodeDocumentModel({ source: 'hola mundo' })
    expect(model.lastChangeRange).toBeNull() // el bootstrap es un rebuild

    // Editar "mundo" → "MUNDO": 5 caracteres en la posición 5..10.
    model.applyTextUpdate('hola MUNDO')
    const range = model.lastChangeRange!
    expect(range.start).toBe(5)
    expect(range.end).toBe(10) // 'MUNDO' (5 chars) desde 5
    expect(range.endOld).toBe(10) // 'mundo' (5 chars) viejo
  })

  it('un rebuild limpia el rango y el root no lleva hint', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    model.applyTextUpdate('hola mundo')
    expect(model.lastChangeRange).not.toBeNull()

    model.rebuild('otro documento')
    expect(model.lastChangeRange).toBeNull()
    expect(
      (model.redRoot as unknown as { __changeRange?: unknown }).__changeRange,
    ).toBeNull()
  })

  it('el rango viaja adjunto al root que lo produjo', () => {
    const model = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc' })
    model.applyTextUpdate('a\n\nb EDITADO\n\nc')
    const carried = (model.redRoot as unknown as { __changeRange?: { start: number } }).__changeRange
    expect(carried?.start).toBeGreaterThanOrEqual(0)
  })
})


