import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * Una APERTURA de bloque escrita dentro del TÍTULO de un box.
 *
 * El emparejado de osu! corre sobre el texto completo con el título en crudo,
 * así que un `[centre]` ahí dentro compite por el MISMO presupuesto que los
 * reales: gana el cierre más cercano hacia adelante, sea real o de otro título
 * (`Osu/osuPairing.ts`). De ahí salen tres formas, todas medidas con el harness
 * real (BBCodeForDB → BBCodeFromDB → HTMLPurifier) y guardadas como goldens en
 * `docs/ai/osu-cases/box-title-opener-*.bbcode`:
 *
 *   [centre][box=X[/centre][centre]]body[/box][/centre]          (—sealed)
 *   → <div centre><div box><a…>X</a></div><div centre>
 *     <div body>body</div></div></div>
 *   — el `[centre]` del título se sella con el `[/centre]` del FINAL del
 *   documento, así que su `<div>` se abre ahí y el cuerpo cae dentro.
 *
 *   [centre][box=X[/centre][centre]]body[/box]                   (—surplus)
 *   → …X</a></div>[centre]<div body>body</div></div>
 *   — sin cierre libre, osu! publica el `[centre]` LITERAL entre el link y el
 *   cuerpo.
 *
 *   [centre][box=X[/centre][centre]]body[/box][box=Y[/centre]]    (—order)
 *   → el `[centre]` del título de X se sella con el `[/centre]` del título de
 *   Y: X abre su div, Y se parte tras su link y el cuerpo de Y sale hermano.
 *
 *   [box=[centre]T[/centre]]body[/box]                           (—pair-inside)
 *   → par completo dentro del título: su `<div>` vive entero en el rótulo y la
 *   caja NO se parte (el par no produce evento alguno).
 *
 * El árbol abre un nodo `title_div` por cada apertura sellada que siga viva al
 * empezar el cuerpo (`Parser.ts`, sin bytes propios: `leadingWidth` 0) y el
 * renderer mete el `<div>` del cuerpo DENTRO de él
 * (`HTMLRenderer.renderOsuSpoilerbox`).
 *
 * Medido y curado (—late-closer):
 *
 *   [centre][box=X[/centre][centre]]A[/centre]B[/box]
 *   → osu! publica `<div centre><div box><a…>X</a></div><div centre>
 *     <div body>A</div>B</div></div>`: el `[/centre]` real cierra primero el div
 *   del CUERPO, porque el cuerpo está abierto dentro del div del título y es el
 *   más interno de los dos, así que `B` queda en el div del título. El árbol ya
 *   lo dejaba así (el cierre gasta el `title_div` y `B` queda hijo de la caja);
 *   el renderer metía los hijos posteriores al frame dentro del div del cuerpo.
 *   Ahora sólo el contenido del frame va en el cuerpo y el resto se publica tras
 *   su `</div>`, aún dentro del frame.
 *
 * Medido y AÚN ABIERTO (`.claude/rules/osu.md`):
 *
 *   [box=[centre]]body[/box][/centre]                             (—open-wrapper)
 *   → la estructura coincide (sin cierre en el título, el wrapper sigue
 *   abierto) pero osu! reabre el `<a href="#">` del link alrededor del texto
 *   que HTMLPurifier reconstruye ahí dentro, así que el texto queda con estilo
 *   de enlace. El preview no representa elementos inline reabiertos.
 */

const strip = (html: string): string =>
  html.replace(/ data-node-id="[^"]*"/g, '').replace(/<span data-bb-nl[^>]*><\/span>/g, '')

function render(source: string, pairing: 'quasar' | 'osu' = 'osu'): string {
  const doc = new BBCodeDocumentModel({ source, dialect: 'osu', pairing, incremental: false })
  return strip(new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(doc.redRoot!))
}

const LINK = '<div class="js-spoilerbox bbcode-spoilerbox"><a class="js-spoilerbox__link bbcode-spoilerbox__link" href="#">' +
  '<span class="bbcode-spoilerbox__link-icon"></span>'
const BOX_BODY = '<div class="js-spoilerbox__body bbcode-spoilerbox__body">'
// El rótulo rico parsea el título entero, así que el `[centre]` del título deja
// además un div vacío DENTRO del link-text: no pinta nada (sin texto), pero no
// se toca — mover ese parseo es otra unidad.
const EMPTY_DIV = '<div class="bbcode__align-centre"></div>'

describe('box title opener — an opener inside the title competes for the same budget', () => {
  it('seals against a still-free closer and wraps the body in its div', () => {
    const html = render('[centre][box=X[/centre][centre]]body[/box][/centre]')
    expect(html).toBe(
      '<div class="bbcode__align-centre">' + LINK +
      `<span class="bbcode-spoilerbox__link-text">X${EMPTY_DIV}</span></a></div>` +
      `<div class="bbcode__align-centre">${BOX_BODY}body</div></div></div>`,
    )
  })

  it('the trailing closer the title opener consumed is not published', () => {
    const html = render('[centre][box=X[/centre][centre]]body[/box][/centre]')
    expect(html).not.toContain('[/centre]')
  })

  it('surplus opener: with no closer left osu! keeps it literal between link and body', () => {
    const html = render('[centre][box=X[/centre][centre]]body[/box]')
    expect(html).toBe(
      '<div class="bbcode__align-centre">' + LINK +
      `<span class="bbcode-spoilerbox__link-text">X${EMPTY_DIV}</span></a></div>` +
      `[centre]${BOX_BODY}body</div></div>`,
    )
  })

  it('document order: the opener of one title takes the closer written in ANOTHER title', () => {
    const html = render('[centre][box=X[/centre][centre]]body[/box][box=Y[/centre]]')
    // X abre su div alrededor del cuerpo; Y se parte tras su link (su rótulo ya
    // no lleva el `[/centre]`, que se lo llevó la apertura de X).
    expect(html).toContain(`<div class="bbcode__align-centre">${BOX_BODY}body</div></div>`)
    expect(html).toContain(`<span class="bbcode-spoilerbox__link-text">Y</span></a></div>${BOX_BODY}</div>`)
    expect(html).not.toContain('[/centre]')
  })

  it('a real closer after the frame closes the body first and the rest stays in the frame', () => {
    const html = render('[centre][box=X[/centre][centre]]A[/centre]B[/box]')
    expect(html).toBe(
      '<div class="bbcode__align-centre">' + LINK +
      `<span class="bbcode-spoilerbox__link-text">X${EMPTY_DIV}</span></a></div>` +
      `<div class="bbcode__align-centre">${BOX_BODY}A</div>B</div></div>`,
    )
  })

  it('a complete pair inside the title stays in the label: no frame, no split', () => {
    const html = render('[box=[centre]T[/centre]]body[/box]')
    expect(html).toContain(`<span class="bbcode-spoilerbox__link-text"><div class="bbcode__align-centre">T</div></span>`)
    expect(html).toContain(`</a>${BOX_BODY}body</div></div>`)
    expect(html).not.toContain(`</a></div>${BOX_BODY}`)
  })

  it('the same title under the editor pairing brings no frame either', () => {
    const html = render('[centre][box=X[/centre][centre]]body[/box][/centre]', 'quasar')
    expect(html).not.toContain(`<div class="bbcode__align-centre">${BOX_BODY}`)
  })

  it('does not throw on a title that is only tags, nor on an empty one', () => {
    expect(() => render('[centre][box=[[/centre][centre]]body[/box]')).not.toThrow()
    expect(() => render('[box=]body[/box]')).not.toThrow()
    expect(() => render('[box=[centre]]body[/box][/centre]')).not.toThrow()
  })
})
