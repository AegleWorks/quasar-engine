import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * osu! convierte saltos de línea con UNA regla plana al final de todo
 * (`str_replace("\n", '<br />')` en `BBCodeFromDB::toHTML`). Toda la sutileza
 * está antes: cada pasada de bloque es una expresión regular que se come los
 * saltos que tocan sus propias etiquetas, y la cantidad cambia por etiqueta.
 *
 *   construcción          tras la apertura   antes del cierre   tras el cierre
 *   [box] [spoilerbox]    todos              todos              uno
 *   [notice]              todos              todos              uno
 *   [code]                todos              todos              uno
 *   [centre] [left]…      uno                —                  uno
 *   [imagemap]            —                  —                  uno
 *   [heading]             —                  —                  uno
 *   [*] (ítem de lista)   —                  —                  hasta dos
 *   [/list]               —                  todo el blanco     hasta dos
 *   [/quote]              —                  todo el blanco     hasta dos
 *
 * Cada caso de abajo sale de `osu-web`
 * (`app/Libraries/BBCodeFromDB.php`) y está contrastado contra los HTML de
 * `tests/Libraries/bbcode_examples`, que son el render de osu byte a byte.
 *
 * NO va condicionado por dialecto: Miliastry es "osu con esteroides" y rompe
 * líneas igual. Cada aserción se comprueba en los dos dialectos.
 */

function html(source: string, dialect: 'osu' | 'miliastry'): string {
  const root = new BBCodeDocumentModel({ source }).redRoot!
  return new HTMLRenderer({ dialect }).render(root).replace(/ data-node-id="[^"]*"/g, '')
}

/** Cuántos saltos de línea sobreviven al render, en ambos dialectos. */
function breaks(source: string): number {
  const counts = (['osu', 'miliastry'] as const).map(
    (d) => (html(source, d).match(/<br[^>]*>/g) ?? []).length,
  )
  expect(counts[1], 'miliastry debe romper líneas igual que osu').toBe(counts[0])
  return counts[0]
}

/**
 * El HTML tal cual, para las aserciones de FORMA.
 *
 * Contar saltos no basta para saber qué se ve: una racha de N saltos se parte
 * en un `spacing` (el primero) y N-1 `empty_line`, y cada uno se renderiza
 * distinto — `<br>` el primero, `<div class="bb-empty-line"><br></div>` los
 * demás. Como ese div lleva su propio `<br>` dentro, `breaks()` sigue contando
 * uno por salto y da el número correcto; lo que NO se puede hacer es sumar
 * `<br>` y `bb-empty-line` por separado, porque entonces una sola línea en
 * blanco cuenta dos veces. Esa suma doble es lo que hizo creer que
 * `[/notice]\n\n` no se comía ningún salto: se come el `spacing` y deja el
 * `empty_line`, que es exactamente el `<br />` único de osu.
 *
 * Medido en Chromium, `<div class="bb-empty-line"><br></div>` entre dos
 * bloques ocupa el mismo alto que el `<br />` suelto de osu (63 px contra
 * 63 px con `line-height: 1.5` y 14 px de fuente), así que la diferencia de
 * forma no es una diferencia de altura.
 */
function shape(source: string): string {
  return html(source, 'osu')
}

describe('osu newline swallowing', () => {
  it('un salto suelto entre texto siempre es un <br>', () => {
    expect(breaks('a\nb')).toBe(1)
    expect(breaks('a\n\nb')).toBe(2)
    expect(breaks('a\n\n\nb')).toBe(3)
  })

  // ── [box] / [spoilerbox] — todos / todos / uno ───────────────────────────

  describe('[box] y [spoilerbox]', () => {
    it('se come TODOS los saltos tras la apertura', () => {
      expect(breaks('[box=t]\n\n\nx[/box]')).toBe(0)
      expect(breaks('[spoilerbox]\n\n\nx[/spoilerbox]')).toBe(0)
    })

    it('se come TODOS los saltos antes del cierre', () => {
      expect(breaks('[box=t]x\n\n\n[/box]')).toBe(0)
      expect(breaks('[spoilerbox]x\n\n\n[/spoilerbox]')).toBe(0)
    })

    it('se come UNO tras el cierre, no más', () => {
      expect(breaks('[box=t]x[/box]\ny')).toBe(0)
      expect(breaks('[box=t]x[/box]\n\ny')).toBe(1)
      expect(breaks('[box=t]x[/box]\n\n\ny')).toBe(2)
    })

    it('no toca los saltos que van ANTES de la apertura', () => {
      // `box_with_surrounding_newlines`: "Upper line text.<br />" seguido del box.
      expect(breaks('a\n[box=t]x[/box]')).toBe(1)
      expect(breaks('a\n\n[box=t]x[/box]')).toBe(2)
    })
  })

  // ── [notice] — todos / todos / uno ───────────────────────────────────────

  describe('[notice]', () => {
    it('se come todos los saltos por dentro y uno por fuera', () => {
      expect(breaks('[notice]\n\nx\n\n[/notice]')).toBe(0)
      expect(breaks('[notice]x[/notice]\ny')).toBe(0)
      expect(breaks('[notice]x[/notice]\n\ny')).toBe(1)
    })
  })

  // ── [code] — todos / todos / uno ─────────────────────────────────────────

  describe('[code]', () => {
    it('se come todos los saltos por dentro de sus bordes', () => {
      // `code_with_surrounding_newlines`: "No surrounding newlines or br".
      expect(breaks('[code]\n\nx\n\n[/code]')).toBe(0)
    })

    it('se come UNO tras el cierre', () => {
      expect(breaks('[code]x[/code]\ny')).toBe(0)
      expect(breaks('[code]x[/code]\n\ny')).toBe(1)
    })

    it('NO se come los saltos anteriores a la apertura', () => {
      // La heurística vieja los borraba; ninguna pasada de osu los toca.
      expect(breaks('a\n\n[code]x[/code]')).toBe(2)
    })
  })

  // ── [centre] / [left] / [right] — uno / — / uno ──────────────────────────

  describe('[centre], [left] y [right]', () => {
    it('se come EXACTAMENTE uno tras la apertura', () => {
      expect(breaks('[centre]\nx[/centre]')).toBe(0)
      expect(breaks('[centre]\n\nx[/centre]')).toBe(1)
      expect(breaks('[left]\n\nx[/left]')).toBe(1)
      expect(breaks('[right]\n\nx[/right]')).toBe(1)
    })

    it('NO se come nada antes del cierre', () => {
      // `strtr` sólo conoce `[/centre]\n`, nunca `\n[/centre]`.
      expect(breaks('[centre]x\n[/centre]')).toBe(1)
    })

    it('se come EXACTAMENTE uno tras el cierre', () => {
      expect(breaks('[centre]x[/centre]\ny')).toBe(0)
      expect(breaks('[centre]x[/centre]\n\ny')).toBe(1)
    })
  })

  // ── [imagemap] — — / — / uno ─────────────────────────────────────────────

  describe('[imagemap]', () => {
    const map = '[imagemap]\nhttps://a.example/i.png\n0 0 10 10 https://osu.ppy.sh\n[/imagemap]'

    it('se come UNO tras el cierre y deja el segundo', () => {
      // `imagemap`: entre dos mapas consecutivos osu deja exactamente un <br />.
      expect(breaks(`${map}\n\n${map}`)).toBe(1)
      expect(breaks(`${map}\ny`)).toBe(0)
      expect(breaks(`${map}\n\n\ny`)).toBe(2)
    })
  })

  // ── [heading] — — / — / uno ──────────────────────────────────────────────

  describe('[heading]', () => {
    it('se come UNO tras el cierre y nada por dentro', () => {
      expect(breaks('[heading]x[/heading]\ny')).toBe(0)
      expect(breaks('[heading]x[/heading]\n\ny')).toBe(1)
      expect(breaks('[heading]x\n[/heading]y')).toBe(1)
    })
  })

  // ── [*] — el cierre de ítem no existe en el origen ───────────────────────

  describe('ítem de lista', () => {
    /**
     * La tabla de osu da `\[/\*\]\n?\n?` — hasta dos saltos tras el cierre del
     * ítem. Ese cierre sólo aparece en filas heredadas de phpBB: `BBCodeForDB`
     * nunca escribe un `[/*]`, así que en Quasar el ítem termina donde empieza
     * el siguiente `[*]` o el `[/list]`. Los dos saltos se los lleva el `\s*`
     * del ítem siguiente — misma salida por otro camino.
     */
    it('los saltos entre dos ítems desaparecen (hasta dos, y más también)', () => {
      expect(breaks('[list][*]a\n[*]b[/list]')).toBe(0)
      expect(breaks('[list][*]a\n\n[*]b[/list]')).toBe(0)
      expect(breaks('[list][*]a\n\n\n[*]b[/list]')).toBe(0)
    })

    it('el blanco anterior a un ítem se va entero, no sólo los saltos', () => {
      expect(breaks('[list]\n  [*]a\n  [*]b[/list]')).toBe(0)
    })

    it('un salto que NO precede a un ítem se queda', () => {
      // `basic_list`: "<li>here<br />" antes de la lista anidada.
      expect(breaks('[list][*]a\n[list][*]b[/list][/list]')).toBe(1)
    })

    it('la apertura del ítem no se come lo que va detrás', () => {
      expect(breaks('[list][*]\na[/list]')).toBe(1)
    })
  })

  // ── [/list] — — / todo el blanco / hasta dos ─────────────────────────────

  describe('[/list]', () => {
    it('se come todo el blanco previo, no sólo los saltos', () => {
      expect(breaks('[list][*]a\n\n\n[/list]')).toBe(0)
      expect(breaks('[list][*]a\n  \n[/list]')).toBe(0)
    })

    it('se come HASTA DOS saltos tras el cierre', () => {
      expect(breaks('[list][*]a[/list]\ny')).toBe(0)
      expect(breaks('[list][*]a[/list]\n\ny')).toBe(0)
      expect(breaks('[list][*]a[/list]\n\n\ny')).toBe(1)
    })

    it('la apertura de la lista no se come nada por sí sola', () => {
      // `[list]\s*[\*]` necesita un ítem: sin él los saltos sobreviven.
      expect(breaks('[list]\n\nsuelto[*]a[/list]')).toBe(2)
    })
  })

  // ── [/quote] — — / todo el blanco / hasta dos ────────────────────────────

  describe('[quote]', () => {
    it('se come todo el blanco tras la apertura', () => {
      expect(breaks('[quote]\n\n\nx[/quote]')).toBe(0)
      expect(breaks('[quote="n"]\n\nx[/quote]')).toBe(0)
    })

    it('se come todo el blanco antes del cierre', () => {
      expect(breaks('[quote]x\n\n\n[/quote]')).toBe(0)
    })

    it('se come HASTA DOS saltos tras el cierre', () => {
      // `quote_newline`: "</blockquote>" pegado al texto que sigue.
      expect(breaks('[quote]x[/quote]\n\ny')).toBe(0)
      expect(breaks('[quote]x[/quote]\n\n\ny')).toBe(1)
    })

    it('NO toca los saltos anteriores a la apertura', () => {
      // `quote_newline`: "Some text goes here.<br />\n<br />" antes de la cita.
      expect(breaks('a\n\n[quote]x[/quote]')).toBe(2)
    })
  })

  // ── Fronteras compuestas — las tres divergencias medidas ─────────────────

  describe('fronteras encadenadas', () => {
    it('[/box][/notice][/centre]\\n \\n[centre]: sólo el primer salto se va', () => {
      // El espacio corta la racha: el segundo salto ya no toca al `[/centre]`.
      expect(breaks('[centre][notice][box=t]x[/box][/notice][/centre]\n \n[centre]y[/centre]')).toBe(1)
    })

    it('[/centre][/notice]\\n\\n[url]: el [notice] se come uno y deja el otro', () => {
      expect(breaks('[notice][centre]x[/centre][/notice]\n\n[url=https://a.example]y[/url]')).toBe(1)
    })

    it('el bloque interior no gasta el presupuesto del exterior', () => {
      // `[/box]\n?` se lleva uno; `\s*[/list]` se lleva el resto.
      expect(breaks('[list][*][box=t]x[/box]\n\n[/list]')).toBe(0)
      // `[/box]\n?` se lleva uno, `[/centre]` no come nada por dentro.
      expect(breaks('[centre][box=t]x[/box]\n\n[/centre]')).toBe(1)
    })
  })

  // ── Cierre de bloque + LÍNEA EN BLANCO ───────────────────────────────────

  /**
   * `[/tag]\n\n` — la forma habitual de separar secciones, y el caso que se
   * sospechó roto. Las reglas de osu son todas "hasta N", nunca "exactamente
   * N": con dos saltos se come el primero igual que con uno, y el que queda es
   * el `<br />` único que emite osu.
   *
   * Los fixtures de `bbcode_examples` SÍ traen el patrón —
   * `box_with_surrounding_newlines.base.txt` termina en `[/box]\n\nBottom line
   * text.` y su HTML de referencia tiene un solo `<br />`— y por eso pasaban:
   * el motor ya acertaba. Lo que faltaba era decirlo aquí en una aserción de
   * FORMA, para que nadie vuelva a leer el `<br>` de dentro del
   * `bb-empty-line` como una segunda línea.
   */
  describe('cierre de bloque seguido de línea en blanco', () => {
    const imagemap = '[imagemap]\nhttps://a.example/i.png\n0 0 10 10 https://osu.ppy.sh\n[/imagemap]'

    it('deja UN salto, no dos, en todo cierre de presupuesto uno', () => {
      expect(breaks('[box=t]x[/box]\n\nDESPUES')).toBe(1)
      expect(breaks('[spoilerbox]x[/spoilerbox]\n\nDESPUES')).toBe(1)
      expect(breaks('[notice]x[/notice]\n\nDESPUES')).toBe(1)
      expect(breaks('[code]x[/code]\n\nDESPUES')).toBe(1)
      expect(breaks('[heading]x[/heading]\n\nDESPUES')).toBe(1)
      expect(breaks('[centre]x[/centre]\n\nDESPUES')).toBe(1)
      expect(breaks('[left]x[/left]\n\nDESPUES')).toBe(1)
      expect(breaks('[right]x[/right]\n\nDESPUES')).toBe(1)
      expect(breaks(`${imagemap}\n\nDESPUES`)).toBe(1)
    })

    it('no deja NINGUNO en los cierres de presupuesto dos', () => {
      expect(breaks('[list][*]x[/list]\n\nDESPUES')).toBe(0)
      expect(breaks('[quote]x[/quote]\n\nDESPUES')).toBe(0)
    })

    it('entre dos bloques del mismo tipo tampoco se duplica', () => {
      expect(breaks('[centre]A[/centre]\n\n[centre]B[/centre]')).toBe(1)
      expect(breaks('[notice]A[/notice]\n\n[notice]B[/notice]')).toBe(1)
      expect(breaks(`${imagemap}\n\n${imagemap}`)).toBe(1)
    })

    it('el salto superviviente es UN nodo, no un <br> más una línea vacía', () => {
      // El `\n` suelto del HTML es el `spacing` que se comió el `[/notice]`:
      // no se renderiza. Detrás va un único nodo de salto.
      expect(shape('[notice]x[/notice]\n\nDESPUES')).toBe(
        '<div class="well">x</div>\n'
        + '<div class="bb-empty-line"><br></div>'
        + '<span class="bb-paragraph">DESPUES</span>',
      )
      // Con un solo salto no queda nada en absoluto.
      expect(shape('[notice]x[/notice]\nDESPUES')).toBe(
        '<div class="well">x</div>\n'
        + '<span class="bb-paragraph">DESPUES</span>',
      )
    })
  })
})
