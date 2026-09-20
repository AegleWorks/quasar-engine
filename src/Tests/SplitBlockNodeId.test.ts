import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { reconcileVisualDOMToBBCode } from '../Reconciler/SurgicalReconciler'

/**
 * Partir un bloque con Enter no puede perder lo que hay dentro.
 *
 * Un contenteditable parte el elemento en dos cuando se pulsa Enter dentro, y
 * COPIA todos sus atributos a la mitad nueva — `data-node-id` incluido. La
 * reconciliación empareja DOM y AST por ese id, y dos elementos respondiendo
 * al mismo id resolvían los dos al mismo nodo: cada uno emitía una edición
 * sobre el mismo rango y ganaba la mitad vacía.
 *
 * Medido en la app: Enter al inicio de un `[notice]` dejaba «Aviso» en
 * pantalla y lo sacaba del documento. Es pérdida de datos, no un problema de
 * pintado, porque el documento es lo que se guarda.
 */

/** Lo que hace el navegador al pulsar Enter al inicio de un bloque. */
function partirBloqueComoElNavegador(el: HTMLElement): void {
  const vacio = el.cloneNode(false) as HTMLElement
  vacio.appendChild(el.ownerDocument.createElement('br'))
  el.parentElement!.insertBefore(vacio, el)
}

function escenario() {
  const source = '[b]Titulo[/b]\n[notice]Aviso[/notice]\n'
  const doc = new BBCodeDocumentModel({ source })
  const container = document.createElement('div')
  container.innerHTML = new HTMLRenderer().render(doc.redRoot!)
  return { source, doc, container }
}

describe('un bloque partido por el navegador', () => {
  it('deja dos elementos con el MISMO data-node-id', () => {
    // La premisa de todo lo demás. Si un día el navegador dejara de copiar el
    // atributo, este test avisa de que el guard ya no hace falta.
    const { container } = escenario()
    const bloque = container.querySelector('.notice, .well') as HTMLElement
    partirBloqueComoElNavegador(bloque)

    const ids = [...container.querySelectorAll('[data-node-id]')].map((e) =>
      e.getAttribute('data-node-id'),
    )
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(repetidos.length).toBeGreaterThan(0)
  })

  it('conserva el contenido de la mitad que lo lleva', () => {
    const { source, doc, container } = escenario()
    const bloque = container.querySelector('.notice, .well') as HTMLElement
    partirBloqueComoElNavegador(bloque)

    const res = reconcileVisualDOMToBBCode(source, doc.redRoot, container)

    // Lo que se perdía. El texto está en el DOM, así que tiene que estar en el
    // documento: lo que se ve y lo que se guarda son lo mismo.
    expect(res.resultingSource).toContain('Aviso')
  })

  it('produce los DOS avisos, no uno', () => {
    const { source, doc, container } = escenario()
    const bloque = container.querySelector('.notice, .well') as HTMLElement
    partirBloqueComoElNavegador(bloque)

    const res = reconcileVisualDOMToBBCode(source, doc.redRoot, container)
    expect(res.resultingSource.match(/\[notice\]/g)?.length).toBe(2)
  })

  it('no toca el bloque de al lado', () => {
    const { source, doc, container } = escenario()
    const bloque = container.querySelector('.notice, .well') as HTMLElement
    partirBloqueComoElNavegador(bloque)

    const res = reconcileVisualDOMToBBCode(source, doc.redRoot, container)
    expect(res.resultingSource).toContain('[b]Titulo[/b]')
  })

  it('sin ids repetidos sigue reconciliando en pequeño', () => {
    // El guard manda al camino completo, que reescribe el documento entero. No
    // puede dispararse cuando no hay duplicados, o una edición normal dejaría
    // de ser quirúrgica y se llevaría por delante el formato que el autor puso
    // a mano en los bloques que ni tocó.
    const { source, doc, container } = escenario()
    const bloque = container.querySelector('.notice, .well') as HTMLElement
    bloque.textContent = 'Aviso editado'

    const res = reconcileVisualDOMToBBCode(source, doc.redRoot, container)
    expect(res.resultingSource).toContain('Aviso editado')
    expect(res.edits.length).toBe(1)
  })
})
