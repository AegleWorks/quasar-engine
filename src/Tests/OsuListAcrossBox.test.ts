import { describe, it, expect } from 'vitest'
import { previewDoc, renderPreview, visibleLines } from './support/visibleLines'

/**
 * Una `[list]` sellada cuyo TÍTULO cruza el cierre de una caja.
 *
 * osu! no construye un árbol: `BBCodeFromDB::parseList` corre después de
 * `parseBox` y su regla de título `[list:uid](.+?)(<li>|</ol>)` captura el HTML
 * del `</div>` ya emitido y el del bloque siguiente. El `<ol>` nuevo nace en el
 * primer `<li>` de la lista siguiente (la PORTADORA) y el `[/list]` de la cabeza
 * —que es el primero que llega— lo cierra a él, no a la portadora. HTMLPurifier
 * repara el cruce dejando el `<ol>` de la cabeza DENTRO del primer ítem de la
 * portadora; los `[*]`/`[list]` que siguen cuelgan de ese mismo ítem hasta que
 * un `[*]` lo releva, y el último `[/list]` cierra la portadora.
 *
 * El árbol no puede mover el cuerpo de la cabeza a la portadora (los dos bloques
 * son hermanos y el título ya está en el primero), así que `Parser.ts` sintetiza
 * ese cuerpo en el primer `[*]` de la portadora (`Osu/osuPairing.ts`,
 * `findListCarriers`). Sin portadora (la cabeza no tiene otra lista delante de
 * su primer ítem, como en `osu/9501845`), el cuerpo sintético envuelve el propio
 * `[*]`.
 *
 * Medido con el harness real (`BBCodeForDB` → `BBCodeFromDB` → HTMLPurifier) y
 * guardado como `docs/ai/osu-cases/list-across-box*.bbcode`. Corpus (scan68 vs
 * scan65, mismos 8.761 goldens): 8.443 → 8.449 match, **0 perdidas**, 0 primeros
 * diffs movidos; recupera `osu/10696665`, `osu/11285958`, `osu/9501845`,
 * `osu/4751054`, `osu/9809910` y `osu/9072586` (el último, por la adopción del
 * `\s*` previo al primer ítem).
 */

const lines = (source: string): string[] => visibleLines(renderPreview(previewDoc(source)))

const CARRIER = '[box=a][list][/box][box=b][list]\n[*]x[/list][list]\n[*]y[/list][/box]'
const CHAIN = '[box=a][list][/box]\n[list]\n[*]x[/list][list]\n[*]y[/list][list]\n[*]z[/list]'
const NO_CARRIER = '[box=a][list]\ntitle\n[/box]\n[*]x\n[*]y[/list]'
const NO_CARRIER_WHITESPACE = '[box=a][list][/box]\n[centre]c[/centre]\n\n[*]x[/list]'

const BOX = 'bbcode-spoilerbox.js-spoilerbox'
const BODY = 'bbcode-spoilerbox.js-spoilerbox>bbcode-spoilerbox__body.js-spoilerbox__body'
const LINK = '|{[[\"href\",\"#\"]]}'

describe('a sealed list whose title capture crosses a box closer', () => {
  it('the next list opens the head body inside its first item; the literal opener stays there', () => {
    expect(lines(CARRIER)).toEqual([
      `${BOX}${LINK}a`,
      `${BOX}${LINK}b`,
      `${BODY}>list>item>list>item|{[]}x`,
      `${BODY}>list>item|{[]}[list]`,
      `${BODY}>list>item|{[]}y`,
    ])
  })

  it('later lists nest inside that first item, and the last item is a sibling of the carrier', () => {
    expect(lines(CHAIN)).toEqual([
      `${BOX}${LINK}a`,
      'list>item>list>item|{[]}x',
      'list>item>list>item|{[]}y',
      'list>item|{[]}[list]',
      'list>item|{[]}z',
    ])
  })

  it('with no carrier, the first item after the box opens the head body around itself', () => {
    expect(lines(NO_CARRIER)).toEqual([
      `${BOX}${LINK}a`,
      `${BODY}>bbcode__list-title.list>item|`,
      `${BODY}>bbcode__list-title.list>item|{[]}title`,
      'list>item|{[]}x',
      'list>item|{[]}y',
    ])
  })

  it('eats the whitespace `\s*[*]` would have eaten, even outside the synthetic list', () => {
    // osu/9072586: el `\n\n` entre el centro y el primer ítem queda en el
    // bucket del padre; la lista sintética lo adopta para que la regla
    // `beforeOpen` del ítem lo coma, en vez de publicarlo como línea vacía.
    expect(lines(NO_CARRIER_WHITESPACE)).toEqual([
      `${BOX}${LINK}a`,
      'bbcode__align-centre|{[]}c',
      'list>item|{[]}x',
    ])
  })

  it('the head keeps its title inside the first box and its body is the nested item', () => {
    const out = lines(CARRIER)
    // La cabeza (sin ítems propios en la caja a) publica su `<ul
    // class="bbcode__list-title">` vacío allí; el `x` de la portadora vive en
    // el cuerpo sintetizado de la cabeza, no directamente en el ítem portador.
    expect(out[2]).toContain('list>item>list>item|{[]}x')
    expect(out.some((l) => l.includes('>item|{[]}x') && !l.includes('>list>item'))).toBe(false)
  })
})
