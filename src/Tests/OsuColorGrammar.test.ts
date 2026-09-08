import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { HTMLRendererOptions } from '../Visitors/HTMLRenderer'

/**
 * `[color=…]` con la gramática de osu!.
 *
 * osu! sella el tag sólo si el valor matchea `#[[:xdigit:]]{6}` o `[[:alpha:]]+`.
 * Todo lo demás — `#fff`, `#ffffffff`, `rgb(...)`, `$token` — no se sella, la
 * segunda pasada lo ignora, y la página publicada muestra el opener y el closer
 * como texto (confirmado por el fixture `basic_color` de osu-web). El editor
 * mostraba texto de color ahí, o sea mentía en silencio.
 *
 * Bajo el dialecto por defecto (`miliastry`) nada de esto aplica: su vocabulario
 * de color es más rico a propósito.
 */

const parse = (source: string) => new BBCodeDocumentModel({ source }).redRoot!

const render = (source: string, options: HTMLRendererOptions = {}): string =>
  new HTMLRenderer(options).render(parse(source)).replace(/ data-node-id="[^"]*"/g, '')

const osu = (source: string) => render(source, { dialect: 'osu' })

describe('[color] bajo el dialecto osu', () => {
  it('deja literal un hex de 3 dígitos', () => {
    const html = osu('[color=#fff]Failing at colored text![/color]')
    expect(html).toContain('[color=#fff]')
    expect(html).toContain('[/color]')
    expect(html).not.toContain('style="color:')
  })

  it('deja literal un hex de 8 dígitos', () => {
    const html = osu('[color=#ffffffff]nope[/color]')
    expect(html).toContain('[color=#ffffffff]')
    expect(html).toContain('[/color]')
    expect(html).not.toContain('style="color:')
  })

  it('renderiza igual los hijos del tag literal', () => {
    const html = osu('[color=#fff]a[b]bold[/b]c[/color]')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toMatch(/\[color=#fff\]a<strong>bold<\/strong>c\[\/color\]/)
  })

  it('acepta un hex de 6 dígitos, en minúscula y en mayúscula', () => {
    expect(osu('[color=#ffffff]ok[/color]')).toContain('style="color:#ffffff;"')
    expect(osu('[color=#FFFFFF]ok[/color]')).toContain('style="color:#FFFFFF;"')
  })

  it('acepta un nombre puramente alfabético', () => {
    const html = osu('[color=white]ok[/color]')
    expect(html).toContain('<span')
    expect(html).toContain('style="color:')
    expect(html).not.toContain('[color=white]')
  })

  it('no toca el dialecto por defecto (miliastry)', () => {
    const html = render('[color=#fff]Colored text![/color]')
    expect(html).toContain('style="color:#fff;"')
    expect(html).not.toContain('[color=#fff]')
  })

  it('tampoco toca lyne', () => {
    const html = render('[color=#fff]Colored text![/color]', { dialect: 'lyne' })
    expect(html).toContain('style="color:#fff;"')
  })
})
