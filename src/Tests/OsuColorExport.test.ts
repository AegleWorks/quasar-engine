import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter, type ExportTarget } from '../Visitors/BBCodeExporter'
import { RedNode } from '../Syntax/RedNode'
import { greenNode, greenLeaf } from '../Syntax/GreenNode'

/**
 * `[color=…]` al exportar hacia osu!.
 *
 * `BBCodeForDB::parseColour` sólo acepta `#` + 6 dígitos hex o una secuencia
 * puramente alfabética. Con cualquier otro valor osu! deja el opener y el
 * `[/color]` como texto literal en la página publicada, así que exportar el
 * valor del autor verbatim publica la página rota.
 *
 * La expansión vive en `normalizeColorToHex` y depende del target: bajo
 * 'miliastry' (y 'lyne') no se reescribe nada, porque su vocabulario de color
 * es más rico a propósito y `Analysis/RoundTrip` fija esa fidelidad.
 */

const exportSource = (source: string, target: ExportTarget): string =>
  new BBCodeExporter(undefined, target).export(
    new BBCodeDocumentModel({ source }).redRoot!,
  )

/**
 * Un `[color]` SIN metadata, con el atributo sólo en el texto del nodo: es la
 * rama de fallback del exportador, distinta de la rama de metadata que produce
 * el parser normal.
 */
function bareColorNode(attrText: string): RedNode {
  const leaf = greenLeaf('text', 'x')
  const green = greenNode('color', attrText, [leaf])
  const node = new RedNode(green, { kind: 'color', metadata: {} })
  node.initChildren([new RedNode(leaf, { kind: 'text' })])
  return node
}

const exportBare = (attrText: string, target: ExportTarget): string =>
  new BBCodeExporter(undefined, target).export(bareColorNode(attrText))

describe('normalización de [color] hacia osu!', () => {
  describe('rama de metadata (documento parseado)', () => {
    const cases: Array<[string, string]> = [
      ['[color=#fff]x[/color]', '[color=#ffffff]x[/color]'],
      ['[color=#F00]x[/color]', '[color=#FF0000]x[/color]'],
      ['[color=#ffff]x[/color]', '[color=#ffffff]x[/color]'],
      ['[color=#ffffffff]x[/color]', '[color=#ffffff]x[/color]'],
      ['[color=#12345678]x[/color]', '[color=#123456]x[/color]'],
      ['[color=ff0000]x[/color]', '[color=#ff0000]x[/color]'],
      ['[color=f00]x[/color]', '[color=#ff0000]x[/color]'],
      ['[color=f00a]x[/color]', '[color=#ff0000]x[/color]'],
      ['[color=12345678]x[/color]', '[color=#123456]x[/color]'],
    ]

    it.each(cases)('%s → %s', (source, expected) => {
      expect(exportSource(source, 'osu')).toBe(expected)
    })

    it('deja intacto un hex de 6 dígitos, con las mayúsculas del autor', () => {
      expect(exportSource('[color=#AbCdEf]x[/color]', 'osu')).toBe('[color=#AbCdEf]x[/color]')
    })

    it('deja intacto un nombre alfabético, que osu! sí acepta', () => {
      expect(exportSource('[color=red]x[/color]', 'osu')).toBe('[color=red]x[/color]')
      expect(exportSource('[color=white]x[/color]', 'osu')).toBe('[color=white]x[/color]')
    })

    it('no toca una palabra alfabética aunque sus letras sean hex válidas', () => {
      // `beef` matchea la alternativa `[[:alpha:]]+` de osu!: convertirla en
      // `#bbeeee` cambiaría el color pedido por el autor.
      expect(exportSource('[color=beef]x[/color]', 'osu')).toBe('[color=beef]x[/color]')
    })

    it('sigue convirtiendo rgb() a hex de 6', () => {
      expect(exportSource('[color=rgb(255, 0, 0)]x[/color]', 'osu')).toBe('[color=#ff0000]x[/color]')
    })
  })

  describe('rama de fallback (atributo sólo en el texto del nodo)', () => {
    it.each([
      ['=#fff', '[color=#ffffff]x[/color]'],
      ['=#ffff', '[color=#ffffff]x[/color]'],
      ['=#ffffffff', '[color=#ffffff]x[/color]'],
      ['=ff0000', '[color=#ff0000]x[/color]'],
      ['=#AbCdEf', '[color=#AbCdEf]x[/color]'],
      ['=red', '[color=red]x[/color]'],
    ])('%s → %s', (attrText, expected) => {
      expect(exportBare(attrText, 'osu')).toBe(expected)
    })

    it('bajo miliastry no reescribe nada', () => {
      expect(exportBare('=#F00', 'miliastry')).toBe('[color=#F00]x[/color]')
      expect(exportBare('=#ffffffff', 'miliastry')).toBe('[color=#ffffffff]x[/color]')
    })
  })

  describe('los otros targets no se enteran', () => {
    it.each(['miliastry', 'lyne'] as const)('%s exporta el valor del autor', (target) => {
      expect(exportSource('[color=#F00]x[/color]', target)).toBe('[color=#F00]x[/color]')
      expect(exportSource('[color=#ffffffff]x[/color]', target)).toBe('[color=#ffffffff]x[/color]')
      expect(exportSource('[color=ff0000]x[/color]', target)).toBe('[color=ff0000]x[/color]')
    })
  })
})
