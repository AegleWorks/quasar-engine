/**
 * La traza de decisión del parcheador.
 *
 * `patchBlocksInto` devuelve `mode`, pero no POR QUÉ. Esa diferencia importó:
 * en la app, cada pulsación sobre el documento de 547 KB caía a `fullRebuild`
 * y averiguar el motivo desde fuera exigió desminificar a mano una función
 * dentro de una línea de 75.000 caracteres de un chunk de 1,3 MB. La traza
 * contesta la pregunta en una lectura de `globalThis.__BP_LAST__`.
 *
 * Estos tests fijan las dos propiedades de las que depende su utilidad:
 * apagada no deja rastro (nada que pagar en producción), y encendida nombra el
 * camino real — incluido el motivo por el que NO se tomó el incremental.
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { patchBlocksInto, clearPatchCache } from '../Visitors/BlockPatcher'

type TraceGlobals = {
  __BP_TRACE__?: boolean
  __BP_LAST__?: { why?: string } | undefined
  __BP_CLEARS__?: number
}
const g = globalThis as TraceGlobals

afterEach(() => {
  g.__BP_TRACE__ = undefined
  g.__BP_LAST__ = undefined
  g.__BP_CLEARS__ = undefined
})

const DOC = ['[b]uno[/b]', '', 'texto suelto', '', '[i]dos[/i]'].join('\n')

describe('BlockPatcher — traza de decisión', () => {
  it('apagada no deja rastro en globalThis', () => {
    const model = new BBCodeDocumentModel({ source: DOC, dialect: 'miliastry' })
    const container = document.createElement('div')
    patchBlocksInto(container, model.redRoot!, { renderer: new HTMLRenderer() })
    clearPatchCache(container)

    expect(g.__BP_LAST__).toBeUndefined()
    expect(g.__BP_CLEARS__).toBeUndefined()
  })

  it('encendida nombra el camino incremental al teclear', () => {
    g.__BP_TRACE__ = true
    const model = new BBCodeDocumentModel({ source: DOC, dialect: 'miliastry' })
    const container = document.createElement('div')
    const renderer = new HTMLRenderer()

    patchBlocksInto(container, model.redRoot!, { renderer })
    model.applyTextUpdate(DOC + 'X')
    patchBlocksInto(container, model.redRoot!, { renderer })

    // Documento pequeño: por debajo de `MIN_WINDOWED_BLOCKS` el camino barato
    // es la reconciliación por clave, no la ventana. Lo que importa es que NO
    // sea una reconstrucción completa.
    expect(g.__BP_LAST__?.why).toBe('keyed')
  })

  it('encendida explica la caída a reconstrucción completa', () => {
    g.__BP_TRACE__ = true
    const model = new BBCodeDocumentModel({ source: DOC, dialect: 'miliastry' })
    const container = document.createElement('div')
    const renderer = new HTMLRenderer()

    patchBlocksInto(container, model.redRoot!, { renderer })

    // Esto es exactamente lo que hacía la app en cada tecla: invalidar la
    // caché entre parcheos. El parcheador ve el DOM vivo contra una caché
    // vacía y no le queda otra que reconstruir — y ahora lo DICE.
    clearPatchCache(container)
    model.applyTextUpdate(DOC + 'X')
    const stats = patchBlocksInto(container, model.redRoot!, { renderer })

    expect(stats.mode).toBe('full')
    expect(g.__BP_LAST__?.why).toBe('desync')
    expect(g.__BP_CLEARS__).toBe(1)
  })
})
