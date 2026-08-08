import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'

/**
 * `findNodeAtOffset` con rangos semiabiertos.
 *
 * Regresión concreta: en un degradado cada carácter es su propio nodo de
 * color. Preguntar por el principio de un nodo devolvía el nodo ANTERIOR,
 * porque con el final inclusivo ese offset pertenecía a los dos y ganaba el
 * primero en el recorrido. En el preview, hacer clic en la `m` de «Welcome»
 * resaltaba la `o`.
 */
describe('findNodeAtOffset — fronteras', () => {
  const gradiente = '[color=#111111]W[/color][color=#222222]e[/color][color=#333333]l[/color]'

  it('el principio de un nodo devuelve ESE nodo, no el anterior', () => {
    const model = new BBCodeDocumentModel({ source: gradiente })
    const raiz = model.redRoot!

    // Los tres nodos de color, en orden.
    const colores: typeof raiz[] = []
    raiz.walk(n => { if (n.kind === 'color') colores.push(n) })
    expect(colores).toHaveLength(3)

    for (const nodo of colores) {
      const encontrado = model.redRoot!.findNodeAtOffset(nodo.range.start)
      // El nodo encontrado debe ser el propio o un descendiente suyo, nunca
      // el vecino de la izquierda.
      let actual = encontrado
      let esDescendiente = false
      while (actual) {
        if (actual === nodo) { esDescendiente = true; break }
        actual = actual.parent
      }
      expect(esDescendiente, `offset ${nodo.range.start} cayó fuera de su nodo`).toBe(true)
    }
  })

  it('cada carácter del texto resuelve a su propio nodo de color', () => {
    const model = new BBCodeDocumentModel({ source: gradiente })
    // Offsets de las letras W, e, l dentro de sus etiquetas.
    for (const letra of ['W', 'e', 'l']) {
      const offset = gradiente.indexOf(`]${letra}[`) + 1
      const nodo = model.redRoot!.findNodeAtOffset(offset)
      expect(nodo, `letra ${letra}`).toBeTruthy()
      expect(nodo!.text || nodo!.parent?.text).toBeDefined()
      // El texto alcanzable desde el nodo debe ser esa letra.
      let texto = ''
      nodo!.walk(n => { if (n.kind === 'text') texto += n.text })
      expect(texto || nodo!.text, `letra ${letra}`).toBe(letra)
    }
  })

  it('el final del documento devuelve la raíz en vez de null', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    const raiz = model.redRoot!
    expect(model.redRoot!.findNodeAtOffset(raiz.range.end)).toBe(raiz)
  })

  it('un offset fuera del documento sigue siendo null', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    expect(model.redRoot!.findNodeAtOffset(999)).toBeNull()
    expect(model.redRoot!.findNodeAtOffset(-1)).toBeNull()
  })
})
