import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * Un cierre de ANCESTRO escrito dentro del TÍTULO de un box.
 *
 * osu! no parsea el título: mete el texto en crudo en el `link-text` y sus
 * pasadas de familia corren sobre el HTML/texto COMPLETO, así que un cierre
 * ahí dentro empareja como cualquier otro y sale como un `</div>` en su sitio.
 * HTMLPurifier repara el cruce. Todo lo de este fichero está medido con el
 * harness real (BBCodeForDB → BBCodeFromDB → HTMLPurifier) sobre los probes de
 * `~/.cache/osu-title-probe`:
 *
 *   [centre][box=T[/centre]]body[/box]
 *   → <div class="bbcode__align-centre"><div class="js-spoilerbox…"><a…>T</a>
 *     </div><div class="js-spoilerbox__body…">body</div></div>
 *   — el centro abre (su único cierre está en el título), la caja se parte tras
 *   su link, el cuerpo queda como HERMANO dentro del centro.
 *
 *   [centre][notice][box=T[/notice]]body[/box]
 *   → `[centre]` LITERAL (no tiene cierre), well + caja partida: el cierre del
 *   título es del notice, no del centro.
 *
 *   [box=T[/centre]]body[/box]
 *   → cierre sin ancestro abierto: literal en el rótulo, cuerpo DENTRO.
 *
 *   [centre][box=T[/centre]]body[/box][/centre]
 *   → el cierre del título es el más cercano y se come el hueco del
 *   presupuesto; el `[/centre]` sobrante se publica LITERAL tras el centro.
 *
 * Fuera de alcance aquí (medido y abierto, ver `.claude/rules/osu.md`): un tag
 * inline SIN pareja dentro del título (`[box=[b]T[/centre]]` publica `[b]T`
 * literal) — el preview lo parsea en aislado y lo pinta `<strong>T</strong>`.
 */

const strip = (html: string): string =>
  html.replace(/ data-node-id="[^"]*"/g, '').replace(/<span data-bb-nl[^>]*><\/span>/g, '')

function render(source: string, pairing: 'quasar' | 'osu' = 'osu'): string {
  const doc = new BBCodeDocumentModel({ source, dialect: 'osu', pairing, incremental: false })
  return strip(new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(doc.redRoot!))
}

const SPLIT = '</a></div><div class="js-spoilerbox__body bbcode-spoilerbox__body">body</div>'
const INSIDE = '</a><div class="js-spoilerbox__body bbcode-spoilerbox__body">body</div></div>'

describe('box title closer — osu! runs the family passes over the raw title', () => {
  it('opens the ancestor whose only closer is inside the box title, and splits the box', () => {
    const html = render('[centre][box=T[/centre]]body[/box]')
    expect(html).not.toContain('[/centre]')
    expect(html).not.toContain('[centre]')
    expect(html).toContain('<div class="bbcode__align-centre">')
    expect(html).toContain(SPLIT)
    expect(html).toContain('<span class="bbcode-spoilerbox__link-text">T</span>')
  })

  it('the same shape with newlines around the box', () => {
    const html = render('[centre]\n[box=T[/centre]]\nbody\n[/box]')
    expect(html).toContain('<div class="bbcode__align-centre">')
    expect(html).toContain(SPLIT)
  })

  it('the notice ancestor opens and keeps the body inside its well', () => {
    const html = render('[notice][box=T[/notice]]body[/box]')
    expect(html).toContain('<div class="well">')
    expect(html).toContain(SPLIT)
  })

  it('a tag with no closer at all stays literal — the title closer is the notice´s, not the centre´s', () => {
    const html = render('[centre][notice][box=T[/notice]]body[/box]')
    expect(html).toContain('[centre]')
    expect(html).toContain('<div class="well">')
    expect(html).toContain(SPLIT)
  })

  it('the editor parse (quasar pairing) renders the same measured shape', () => {
    expect(render('[centre][box=T[/centre]]body[/box]', 'quasar')).toContain(SPLIT)
  })

  it('no ancestor open: the closer stays literal and the body stays inside the box', () => {
    const html = render('[box=T[/centre]]body[/box]')
    expect(html).toContain('T[/centre]')
    expect(html).toContain(INSIDE)
    expect(html).not.toContain('</a></div><div class="js-spoilerbox__body')
  })

  it('a closer of a tag with no ancestor of that kind is not consumed', () => {
    const html = render('[centre][notice][box=T[/notice]]body[/box]')
    expect(html).toContain('<div class="well">')
    expect(html).not.toContain('</div></div><div class="js-spoilerbox__body')
  })

  it('an inline closer ([/b]) does not split the box', () => {
    const html = render('[b][box=skill-card[/b]]body[/box]')
    expect(html).toContain('skill-card')
    expect(html).toContain(INSIDE)
  })

  it('the surplus closer the title displaced is published literally', () => {
    const html = render('[centre][box=T[/centre]]body[/box][/centre]')
    expect(html).toContain(SPLIT)
    expect(html).toContain('>[/centre]<')
  })
})
