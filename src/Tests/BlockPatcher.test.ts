/**
 * BlockPatcher tests — equivalence and incremental correctness.
 *
 * The invariant: `patchBlocksInto(container, root, { renderer })` must produce
 * the same DOM as `morphHTML(container, renderer.render(root))`.
 *
 * data-node-id values are stripped for cross-model comparisons because the
 * global counter makes them differ between separately-constructed models.
 */

import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { morphHTML } from '../Visitors/DOMMorpher'
import { patchBlocksInto } from '../Visitors/BlockPatcher'
import { RedNode } from '../Syntax/RedNode'

const renderer = new HTMLRenderer()

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

/** Same-model reference: patchBlocksInto on the given model's root. */
function patchDOM(model: BBCodeDocumentModel): HTMLDivElement {
  const el = document.createElement('div')
  patchBlocksInto(el, model.redRoot!, { renderer })
  return el
}

describe('patchBlocksInto — equivalence', () => {
  const sources = [
    'hola mundo',
    '[box]caja[/box]\n\n[center][b]negrita[/b][/center]\n\nparrafo suelto',
    '[list][*]uno[*]dos[/list]\n[quote]cita[/quote]',
    '[heading]Título[/heading]\n\n[notice]aviso[/notice]\n\nempty_line\n\nfinal',
    '[spoilerbox]contenido oculto[/spoilerbox]',
    '[b]solo bold[/b]',
    '[code]print(hello)[/code]',
    '',
  ]

  for (const src of sources) {
    it(`produce el mismo DOM que un morph completo para: "${src.slice(0, 40)}"`, () => {
      const model = new BBCodeDocumentModel({ source: src })
      const elMorph = morphDOM(model)
      const elPatch = patchDOM(model)
      expect(stripIds(elPatch.innerHTML)).toBe(stripIds(elMorph.innerHTML))
    })
  }
})

describe('patchBlocksInto — incremental', () => {
  it('editar texto dentro de un bloque solo parchea ese bloque (mode=blocks, patched≥1)', () => {
    const model = new BBCodeDocumentModel({ source: 'primer parrafo\n\nsegundo parrafo' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    // Editar el segundo párrafo
    model.applyTextUpdate('primer parrafo\n\nsegundo parrafo EDITADO')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    expect(stats.patched).toBeGreaterThanOrEqual(1)

    // El DOM resultante debe ser idéntico al morph completo del mismo modelo
    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('no re-morph cuando el contenido no cambió (patched=0, mode=blocks)', () => {
    const model = new BBCodeDocumentModel({ source: '[box]a[/box]\n\nparrafo b' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    // Editar un bloque distinto (el parrafo); el box debe quedar intacto
    model.applyTextUpdate('[box]a[/box]\n\nparrafo EDITADO')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    // El box no cambió, el parrafo sí → patched 1 (solo el parrafo)
    expect(stats.patched).toBe(1)

    // Aplicar el mismo cambio otra vez (no-op): el cache ya tiene el HTML
    // del parrafo editado → patched 0
    model.applyTextUpdate('[box]a[/box]\n\nparrafo EDITADO')
    model.ensureAnalyzed()
    const stats2 = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats2.mode).toBe('blocks')
    expect(stats2.patched).toBe(0)

    // Y el DOM final equivale al morph completo
    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('una inserción de bloque inserta solo el bloque nuevo (mode=blocks, patched≥1)', () => {
    const model = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('[heading]Título nuevo[/heading]\n\na\n\nb\n\nc')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    expect(stats.patched).toBeGreaterThanOrEqual(1)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('una eliminación de bloque quita solo los bloques afectados (mode=blocks)', () => {
    const model = new BBCodeDocumentModel({ source: '[box]a[/box]\n\n[box]b[/box]' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })
    const boxA = el.querySelector('details')

    model.applyTextUpdate('[box]a[/box]')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    // El box que sobrevive es el MISMO nodo DOM (identidad intacta).
    expect(el.querySelector('details')).toBe(boxA)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('árbol nulo limpia el contenedor', () => {
    const el = document.createElement('div')
    el.innerHTML = '<p>viejo</p>'
    const stats = patchBlocksInto(el, null, { renderer })
    expect(el.innerHTML).toBe('')
    expect(stats.mode).toBe('full')
    expect(stats.total).toBe(0)
  })

  it('nodos sin id (spacing/empty_line) se reemplazan sin romper la estructura', () => {
    const model = new BBCodeDocumentModel({ source: 'uno\n\n\n\n\ncinco' })
    const el = patchDOM(model)
    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })
})

describe('patchBlocksInto — keyed reconciliation', () => {
  it('insertar un bloque al inicio conserva los demás: la caja abierta sigue abierta y es el MISMO nodo', () => {
    const model = new BBCodeDocumentModel({ source: '[box]uno[/box]\n\n[box]dos[/box]' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    const details = el.querySelectorAll('details')
    const box1 = details[0]
    const box2 = details[1]
    ;(box1 as HTMLDetailsElement).open = true

    // Cambio estructural real: prepend de un heading (como Enter al inicio).
    model.applyTextUpdate('[heading]Top[/heading]\n\n[box]uno[/box]\n\n[box]dos[/box]')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')

    const after = el.querySelectorAll('details')
    expect(after.length).toBe(2)
    // Los boxes se desplazaron pero NO se reconstruyeron: mismo nodo, mismo estado.
    expect(after[0]).toBe(box1)
    expect((after[0] as HTMLDetailsElement).open).toBe(true)
    expect(after[1]).toBe(box2)
    expect(el.querySelector('h2')?.textContent).toBe('Top')

    // El patch preserva el estado runtime (open) que un render fresco no tiene:
    // la equivalencia estructural se compara ignorando ese atributo.
    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML).replace(/ open=""/g, '')).toBe(stripIds(elExpected.innerHTML))
  })

  it('reordenar un bloque mueve el MISMO elemento DOM (estado runtime conservado)', () => {
    const model = new BBCodeDocumentModel({ source: '[box]uno[/box]\n\n[box]dos[/box]\n\n[box]tres[/box]' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    const details = el.querySelectorAll('details')
    const one = details[0]
    const three = details[2]
    ;(one as HTMLDetailsElement).open = true

    // Mover 'uno' al final con la misma API del visual builder (removeChild +
    // insertChildAt), sin re-parsear.
    const root = model.redRoot!
    RedNode.allowMutation(() => {
      const firstBox = root.children.find((c) => c.kind === 'box')!
      root.removeChild(firstBox.id)
      root.insertChildAt(root.children.length, firstBox)
    })

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')

    const after = el.querySelectorAll('details')
    expect(after.length).toBe(3)
    // El MISMO nodo DOM llegó al final — abierto sigue abierto.
    expect(after[2]).toBe(one)
    expect((after[2] as HTMLDetailsElement).open).toBe(true)
    expect(after[1]).toBe(three)

    // El DOM final equivale al morph completo del mismo árbol, ignorando el
    // `open` que el patch conservó (un render fresco no conoce el estado).
    const elExpected = document.createElement('div')
    morphHTML(elExpected, renderer.render(model.redRoot!))
    expect(stripIds(el.innerHTML).replace(/ open=""/g, '')).toBe(stripIds(elExpected.innerHTML))
  })

  it('un documento nuevo en el mismo contenedor (ids regenerados) cae a full rebuild', () => {
    const modelA = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc' })
    const modelB = new BBCodeDocumentModel({ source: 'x\n\ny\n\nz\n\nw' })
    const el = document.createElement('div')
    patchBlocksInto(el, modelA.redRoot!, { renderer })

    // Model B es otra instancia: sus ids (contador global) son todos nuevos.
    const stats = patchBlocksInto(el, modelB.redRoot!, { renderer })
    expect(stats.mode).toBe('full')

    const elExpected = morphDOM(modelB)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('el cache no acumula entradas de bloques eliminados (prune tras keyed)', () => {
    const model = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc\n\nd' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('a\n\nb\n\nc')
    model.ensureAnalyzed()
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('a\n\nb')
    model.ensureAnalyzed()
    patchBlocksInto(el, model.redRoot!, { renderer })

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('insertar al inicio de un doc grande NO mueve los bloques sobrevivientes (regresión 6.2s)', () => {
    // El bug medido en Chrome con el doc de 40k líneas: teclear al INICIO
    // re-identaba el primer bloque, su run viejo quedaba huérfano en la cola,
    // y el reconciler movía CADA run sobreviviente un slot (79997 insertBefore
    // ≈ 6.2s). El fix elimina el huérfano ANTES del loop y camina el anchor
    // con nextSibling → un shift puro mueve 0 nodos.
    //
    // Test determinista con un MutationObserver: el DOM solo debe ver la
    // eliminación del huérfano + la inserción del bloque nuevo — NO N mutaciones
    // proporcionales al tamaño del documento.
    const lines: string[] = []
    for (let i = 0; i < 400; i++) lines.push(`linea ${i}`)
    const src = lines.join('\n')

    const model = new BBCodeDocumentModel({ source: src })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })
    const runCount = model.redRoot!.children.length
    expect(runCount).toBeGreaterThan(100)

    // Insertar texto al inicio (equivale a teclear en la primera línea).
    model.applyTextUpdate('AAA' + src)
    model.ensureAnalyzed()

    // `takeRecords()` (no el callback): el callback es un microtask que corre
    // DESPUÉS de este bloque síncrono, y `disconnect()` descarta la cola — así
    // que contar en el callback siempre daría 0 (test vacuo). takeRecords lee
    // la cola síncronamente, justo tras el patch.
    const mo = new MutationObserver(() => {})
    mo.observe(el, { childList: true })
    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    const mutations = mo.takeRecords().length
    mo.disconnect()

    expect(stats.mode).toBe('blocks')
    // O(1) en el número de bloques: huérfano (1) + bloque nuevo (1) — no O(n).
    // Tolerancia a la implementación: NUNCA proporcional a los 400 bloques.
    expect(mutations).toBeLessThanOrEqual(4)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('borrar al inicio de un doc grande también es O(1) en mutaciones DOM', () => {
    const lines: string[] = []
    for (let i = 0; i < 400; i++) lines.push(`linea ${i}`)
    const src = lines.join('\n')

    const model = new BBCodeDocumentModel({ source: 'AAA' + src })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    // Eliminar el prefijo: el primer bloque (con AAA) desaparece.
    model.applyTextUpdate(src)
    model.ensureAnalyzed()

    const mo = new MutationObserver(() => {})
    mo.observe(el, { childList: true })
    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    const mutations = mo.takeRecords().length
    mo.disconnect()

    expect(stats.mode).toBe('blocks')
    expect(mutations).toBeLessThanOrEqual(4)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })
})

describe('patchBlocksInto — text runs (HTML text-node merging)', () => {
  it('un doc con text run (spacing+empty_line \'\n\' antes de [code]) mantiene la alineación', () => {
    // El \n\n antes de [code] renderiza spacing('\n') + empty_line('\n'): dos
    // bloques de texto adyacentes que el parser de HTML fusiona en UN textNode.
    // La reconciliación debe alinearse contra ese nodo fusionado sin desviarse.
    const model = new BBCodeDocumentModel({ source: '[quote]cita[/quote]\n\n[code]x[/code]' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })
    expect(el.childNodes.length).toBeLessThan(model.redRoot!.children.length)

    // Editar DENTRO del quote (después del run): los nodos no deben desalinearse.
    model.applyTextUpdate('[quote]cita EDITADA[/quote]\n\n[code]x[/code]')
    model.ensureAnalyzed()
    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    expect(stats.patched).toBeGreaterThanOrEqual(1)

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('cambiar el contenido del text run mismo lo actualiza sin romper la alineación', () => {
    const model = new BBCodeDocumentModel({ source: '[code]a[/code]\n\n[code]b[/code]' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    // Más líneas en blanco → el text run crece de '\n\n' a '\n\n\n\n'.
    model.applyTextUpdate('[code]a[/code]\n\n\n\n[code]b[/code]')
    model.ensureAnalyzed()
    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })
})

describe('patchBlocksInto — casos borde', () => {
  it('varias ediciones rápidas en el mismo bloque acumulan un solo patch', () => {
    const model = new BBCodeDocumentModel({ source: 'x' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('xx'); model.ensureAnalyzed()
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('xxx'); model.ensureAnalyzed()
    const stats = patchBlocksInto(el, model.redRoot!, { renderer })

    expect(stats.mode).toBe('blocks')
    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('una imagen que cambia de src se actualiza (elemento hoja se reemplaza)', () => {
    const model = new BBCodeDocumentModel({
      source: '[img]https://a.example/1.png[/img]',
    })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    model.applyTextUpdate('[img]https://b.example/2.png[/img]')
    model.ensureAnalyzed()

    const stats = patchBlocksInto(el, model.redRoot!, { renderer })
    expect(stats.mode).toBe('blocks')
    // El <img> es un bloque hoja: la URL debe haber cambiado en el DOM
    expect(el.querySelector('img')!.getAttribute('src')).toBe('https://b.example/2.png')

    const elExpected = morphDOM(model)
    expect(stripIds(el.innerHTML)).toBe(stripIds(elExpected.innerHTML))
  })

  it('un renderer que lanza en el render de un bloque cae a full rebuild sin lanzar al llamante', () => {
    const model = new BBCodeDocumentModel({ source: 'a\n\nb\n\nc' })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer })

    // Renderer que lanza UNA vez en el primer render tras la edición: el
    // camino incremental debe atraparlo (onError) y reconstruir completo,
    // nunca propagar la excepción hacia el Preview.
    const throwing = new HTMLRenderer()
    const orig = throwing.render.bind(throwing)
    let armed = true
    ;(throwing as unknown as { render: (n: RedNode) => string }).render = (n: RedNode) => {
      if (armed) { armed = false; throw new Error('boom') }
      return orig(n)
    }

    let notified: unknown = null
    model.applyTextUpdate('a\n\nb EDITADO\n\nc')
    model.ensureAnalyzed()
    const stats = patchBlocksInto(el, model.redRoot!, {
      renderer: throwing,
      onError: (err) => { notified = err },
    })

    expect(notified).toBeInstanceOf(Error)
    expect(stats.mode).toBe('full')
    expect(el.textContent).toContain('b EDITADO')
  })

  it('el cache se limpia automáticamente cuando el contenedor se descarta (WeakMap)', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    patchBlocksInto(el1, model.redRoot!, { renderer })
    patchBlocksInto(el2, model.redRoot!, { renderer })
    expect(stripIds(el1.innerHTML)).toBe(stripIds(el2.innerHTML))
  })
})