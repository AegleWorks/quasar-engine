import { describe, expect, it } from 'vitest'
import { osuCssColor } from '../Syntax/nodeAttr'
import { previewHTML } from './support/visibleLines'

/**
 * El `[color=…]` que osu! publica, medido con el harness.
 *
 * `BBCodeForDB::parseColour` sella `#RRGGBB` o `[[:alpha:]]+`, pero quien
 * escribe el `style` es HTMLPurifier: una palabra que no está en su tabla
 * (`Core.ColorKeywords`) deja el `<span>` SIN color, y un valor alfabético de
 * 3/6 caracteres hex se publica como hex sin `#` (`[color=abc]` → `#abc`).
 * Antes el preview escribía `color:rose` / `color:abc` y el comparador veía un
 * color que la página no tiene (4 páginas del corpus).
 */
describe('osu! colour values after HTMLPurifier', () => {
  const rows: Array<[string, string | null]> = [
    ['#ff0000', '#ff0000'],
    ['#FF0000', '#FF0000'],
    ['Red', '#ff0000'],
    ['grey', '#808080'],
    ['turquoise', '#40e0d0'],
    ['abc', '#abc'],
    ['abcabc', '#abcabc'],
    ['rose', null],
    ['transparent', null],
    ['beef', null],
    ['fade', null],
    ['cccc', null],
    ['ffff00', null],
    ['#fff', null],
  ]

  it.each(rows)('%s → %s', (value, expected) => {
    expect(osuCssColor(value)).toBe(expected)
  })

  it('the preview drops the style for a name the purifier does not know', () => {
    expect(previewHTML('[color=rose]x[/color]')).not.toMatch(/color:/)
    expect(previewHTML('[color=abc]x[/color]')).toContain('color:#abc')
  })
})
