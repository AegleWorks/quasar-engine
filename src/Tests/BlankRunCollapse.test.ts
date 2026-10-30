import { describe, it, expect } from 'vitest'
import { renderBBCode } from '../BBCode/BBCodeBatch'

/**
 * `collapseBlankRuns` es la forma de sólo lectura de las rachas de saltos: en
 * vez de un `<div class="bb-empty-line"><br></div>` por línea vacía, el primer
 * salto queda igual y el resto se paga con un solo espaciador de `n - 1` lh.
 *
 * Lo que hay que fijar aquí es que sea EXACTAMENTE el mismo alto y el mismo
 * flujo: expandir los espaciadores tiene que devolver el HTML sin colapsar
 * carácter a carácter. La igualdad de alturas se midió en Chromium sobre la
 * página patológica (51.909 saltos, mismo `scrollHeight`); estas aserciones
 * protegen el contrato del que eso depende.
 */

const osu = { dialect: 'osu', theme: 'osu', pairing: 'osu' } as const
const plain = (source: string): string => renderBBCode(source, osu)
const collapsed = (source: string): string =>
  renderBBCode(source, { ...osu, collapseBlankRuns: true })

const SPACER = /<div class="bb-blank-run" style="height:(\d+)lh"><\/div>/g

/** Vuelve a poner las líneas vacías que el espaciador resume. */
function expand(html: string): string {
  return html.replace(
    SPACER,
    (_, lines: string) => '<div class="bb-empty-line"><br></div>'.repeat(Number(lines)),
  )
}

describe('collapseBlankRuns', () => {
  it('una racha de n saltos sale como su primer salto más n - 1 lh', () => {
    expect(collapsed('a\n\n\nb')).toBe(
      '<span class="bb-paragraph">a</span><br>'
      + '<div class="bb-blank-run" style="height:2lh"></div>'
      + '<span class="bb-paragraph">b</span>',
    )
    expect(collapsed('a\n\n\n\nb')).toContain('<div class="bb-blank-run" style="height:3lh"></div>')
  })

  it('cada racha se colapsa por separado', () => {
    const html = collapsed('a\n\n\n\nb\n\n\n\nc')
    expect(html.match(SPACER)).toHaveLength(2)
    expect(html).not.toContain('bb-empty-line')
  })

  it('un salto suelto no se toca', () => {
    expect(collapsed('a\nb')).toBe(plain('a\nb'))
    expect(collapsed('a\nb')).not.toContain('bb-blank-run')
  })

  it('expande al HTML sin colapsar, carácter a carácter', () => {
    for (const source of [
      'a\n\n\nb',
      'a\n\n\n\nb\n\n\n\nc',
      '[box=t]a\n\n\nb[/box]',
      '[spoilerbox]a\n\n\nb[/spoilerbox]',
      '[notice]a\n\n\nb[/notice]',
      '[quote]a\n\n\nb[/quote]',
      '[centre]a\n\n\nb[/centre]',
    ]) {
      expect(expand(collapsed(source)), source).toBe(plain(source))
    }
  })

  it('también dentro de los bloques cuyo contenido admite bloques', () => {
    for (const source of [
      '[box=t]a\n\n\nb[/box]',
      '[spoilerbox]a\n\n\nb[/spoilerbox]',
      '[notice]a\n\n\nb[/notice]',
      '[quote]a\n\n\nb[/quote]',
      '[centre]a\n\n\nb[/centre]',
    ]) {
      expect(collapsed(source), source).toContain('<div class="bb-blank-run" style="height:2lh"></div>')
    }
  })

  it('no mete un bloque dentro de un inline', () => {
    // `<span>` sólo admite contenido de fraseo: un `<div>` ahí no es HTML
    // válido y el navegador lo partiría, así que la racha se queda como está.
    const source = '[size=50]a\n\n\nb[/size]'
    expect(collapsed(source)).toBe(plain(source))
    expect(collapsed(source)).not.toContain('bb-blank-run')
  })

  it('los saltos que osu! se come no se pintan y los visibles conservan su altura', () => {
    // De los tres saltos tras `[/notice]`, osu! se come el primero: quedan dos
    // líneas. El marcador oculto del salto comido sólo sirve al editor, así que
    // en el render de sólo lectura desaparece y el espaciador resume las dos
    // que sí se ven.
    expect(collapsed('[notice]x[/notice]\n\n\nDESPUES')).toBe(
      '<div class="well">x</div>'
      + '<div class="bb-empty-line"><br></div>'
      + '<div class="bb-blank-run" style="height:1lh"></div>'
      + '<span class="bb-paragraph">DESPUES</span>',
    )
    expect(collapsed('[notice]x[/notice]\n\n\nDESPUES')).not.toContain('data-bb-nl')
  })

  it('está apagado por defecto', () => {
    expect(plain('a\n\n\nb')).not.toContain('bb-blank-run')
    expect(plain('a\n\n\nb')).toContain('<div class="bb-empty-line"><br></div>')
  })
})
