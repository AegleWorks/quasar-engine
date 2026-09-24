import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

/**
 * `BBCodeExporter` reconstruye BBCode a partir del árbol, no de los bytes
 * originales (ver `quasar-exporter-no-trivia`). Para un cierre extraviado
 * (`discarded_tag`/`discarded_box_close` — el cierre de una etiqueta que un
 * cruce ya auto-cerró antes), el árbol nunca vuelve a llevar su corchete, así
 * que nada queda en el texto exportado para comerse los saltos de línea que
 * `HTMLRenderer` sí se comía en el render — hasta este arreglo, el
 * exportador dejaba esos saltos como texto literal, y osu! los mostraba como
 * `<br>` que la vista previa nunca mostró.
 *
 * `exportChildren` (`BBCodeExporter.ts`) resuelve esto con la MISMA tabla de
 * presupuestos que el render (`NEWLINE_RULES`, expuesta vía
 * `HTMLRenderer.closingBudget`/`isNewlineSwallowedPublic`): un cierre real
 * que sobrevive a la exportación se come sus propios saltos adyacentes solo
 * con volver a analizarse (por eso esos saltos se dejan tal cual); un cierre
 * extraviado no sobrevive, así que sus saltos se eliminan explícitamente —
 * pero solo los que el cierre real que quede adyacente NO vaya a comerse por
 * su cuenta, para no comerse la misma costura dos veces (medido en
 * `docs/ai/examples/perfil sarou.txt`, ver el comentario de `exportChildren`).
 *
 * Cada caso de abajo está medido contra el pipeline real de osu! (`docker
 * run php:8.4-cli` sobre `BBCodeForDB`/`BBCodeFromDB`, ver la nota de sesión)
 * comparando el total de `<br>` de `osu(export(src))` contra el de la vista
 * previa por defecto (`pairing: 'quasar'`) del mismo `src`.
 */

function exportOsu(source: string): string {
  const model = new BBCodeDocumentModel({
    source, dialect: 'osu', pairing: 'quasar', incremental: false, autoAnalyze: false,
  } as any)
  return new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)
}

describe('BBCodeExporter — paridad con la vista previa por defecto en cierres extraviados', () => {
  it('el repro original: centre/notice/box cruzados', () => {
    const source = '[centre][notice]a\n[box=t]x\n[/centre]\n[/box]\n[/notice]\nfin'
    expect(exportOsu(source)).toBe('[centre][notice]a\n[box=t]x\n[/box][/notice][/centre]\nfin')
  })

  // Familia: `[centre][TAG]x{{NL}}[/centre]{{NL}}[/TAG]{{NL}}fin` — TAG se
  // auto-cierra en el cruce, su `[/TAG]` propio queda extraviado más
  // adelante. NL en {0,1,2} saltos. Medido contra osu! real; ver el
  // comentario del archivo para qué representa cada número.
  it.each([
    ['box', 0, '[centre][box=t]x[/centre][/box]fin', '[centre][box=t]x[/box][/centre]fin'],
    ['box', 1, '[centre][box=t]x\n[/centre]\n[/box]\nfin', '[centre][box=t]x\n[/box][/centre]\nfin'],
    ['box', 2, '[centre][box=t]x\n\n[/centre]\n\n[/box]\n\nfin', '[centre][box=t]x\n\n[/box][/centre]\n\nfin'],
    // Un `[spoilerbox=…]` con título sale como `[box=…]`: osu! solo sella el
    // spoilerbox desnudo, y con título lo publicaba como texto literal.
    ['spoilerbox', 0, '[centre][spoilerbox=t]x[/centre][/spoilerbox]fin', '[centre][box=t]x[/box][/centre]fin'],
    ['spoilerbox', 1, '[centre][spoilerbox=t]x\n[/centre]\n[/spoilerbox]\nfin', '[centre][box=t]x\n[/box][/centre]\nfin'],
    ['spoilerbox', 2, '[centre][spoilerbox=t]x\n\n[/centre]\n\n[/spoilerbox]\n\nfin', '[centre][box=t]x\n\n[/box][/centre]\n\nfin'],
    ['quote', 0, '[centre][quote]x[/centre][/quote]fin', '[centre][quote]x[/quote][/centre]fin'],
    ['quote', 1, '[centre][quote]x\n[/centre]\n[/quote]\nfin', '[centre][quote]x\n[/quote][/centre]\nfin'],
    ['quote', 2, '[centre][quote]x\n\n[/centre]\n\n[/quote]\n\nfin', '[centre][quote]x\n\n[/quote][/centre]\nfin'],
    ['list', 0, '[centre][list][*]x[/centre][/list]fin', '[centre][list][*]x[/list][/centre]fin'],
    ['list', 1, '[centre][list][*]x\n[/centre]\n[/list]\nfin', '[centre][list][*]x\n[/list][/centre]\nfin'],
    ['list', 2, '[centre][list][*]x\n\n[/centre]\n\n[/list]\n\nfin', '[centre][list][*]x\n\n[/list][/centre]\nfin'],
    ['left', 0, '[centre][left]x[/centre][/left]fin', '[centre][left]x[/left][/centre]fin'],
    ['left', 1, '[centre][left]x\n[/centre]\n[/left]\nfin', '[centre][left]x\n[/left][/centre]\nfin'],
    ['left', 2, '[centre][left]x\n\n[/centre]\n\n[/left]\n\nfin', '[centre][left]x\n\n[/left][/centre]\n\n\nfin'],
    ['right', 0, '[centre][right]x[/centre][/right]fin', '[centre][right]x[/right][/centre]fin'],
    ['right', 1, '[centre][right]x\n[/centre]\n[/right]\nfin', '[centre][right]x\n[/right][/centre]\nfin'],
    ['right', 2, '[centre][right]x\n\n[/centre]\n\n[/right]\n\nfin', '[centre][right]x\n\n[/right][/centre]\n\n\nfin'],
  ] as const)('%s con %i saltos', (_name, _n, source, expected) => {
    expect(exportOsu(source)).toBe(expected)
  })

  it.each([
    ['notice', 0, '[centre][notice]x[/centre][/notice]fin', '[centre][notice]x[/notice][/centre]fin'],
  ] as const)('%s con %i saltos', (_name, _n, source, expected) => {
    expect(exportOsu(source)).toBe(expected)
  })

  /**
   * `notice`/`centre`/`left`/`right` (pero NO `box`/`spoilerbox`) tienen,
   * además del arreglo de esta tarea, una limitación estructural DISTINTA y
   * ya conocida: cuando se auto-cierran en el cruce, su propio `beforeClose`
   * nunca corrió contra el contenido — así que ese salto queda VISIBLE en la
   * vista previa (`x<br>`) — pero al re-exportarse como BBCode limpio y
   * anidado, ese cierre pasa a ser real y adyacente, y osu! SÍ le aplica su
   * propio `beforeClose` al reanalizarlo. Ninguna edición de bytes en el
   * exportador puede evitarlo sin insertar contenido protector (fuera del
   * alcance de este arreglo: solo cubre los saltos de un cierre EXTRAVIADO,
   * no el contenido que precede a un cierre REAL, aunque ese cierre real
   * solo exista por un cruce). Medido contra osu! real (`notice` con 1 y 2
   * saltos): la vista previa muestra 1 y 3 `<br>` respectivamente; el HTML
   * de `osu(export(...))` muestra 0 y 1. Estos dos casos documentan el
   * comportamiento ACTUAL del exportador, no paridad — ver el informe de
   * esta tarea para el detalle.
   */
  it.each([
    [1, '[centre][notice]x\n[/centre]\n[/notice]\nfin', '[centre][notice]x\n[/notice][/centre]\nfin'],
    [2, '[centre][notice]x\n\n[/centre]\n\n[/notice]\n\nfin', '[centre][notice]x\n\n[/notice][/centre]\n\nfin'],
  ] as const)('notice con %i saltos (límite conocido, no paridad total)', (_n, source, expected) => {
    expect(exportOsu(source)).toBe(expected)
  })
})

/**
 * Gramática de osu! que la vista previa perdona y osu! no: las dos formas se
 * publicaban como texto literal. Cada salida esperada está renderizada contra
 * el pipeline real de osu! (spoilerbox con su título; imagemap como imagemap).
 */
describe('BBCodeExporter — gramática estricta de osu!', () => {
  it.each([
    ['[spoilerbox=Mi título]oculto[/spoilerbox]', '[box=Mi título]oculto[/box]'],
    ['[spoilerbox]oculto[/spoilerbox]', '[spoilerbox]oculto[/spoilerbox]'],
    [
      '[imagemap]https://e.com/a.png\n10 10 20 20 https://e.com clic[/imagemap]',
      '[imagemap]\nhttps://e.com/a.png\n10 10 20 20 https://e.com clic\n[/imagemap]',
    ],
    [
      '[imagemap]\nhttps://e.com/a.png\n10 10 20 20 https://e.com clic\n[/imagemap]\ndespués',
      '[imagemap]\nhttps://e.com/a.png\n10 10 20 20 https://e.com clic\n[/imagemap]\ndespués',
    ],
  ])('%j → %j, y reexportarlo no cambia nada', (source, expected) => {
    const exported = exportOsu(source)
    expect(exported).toBe(expected)
    expect(exportOsu(exported)).toBe(exported)
  })
})
