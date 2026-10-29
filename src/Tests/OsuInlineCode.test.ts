import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * `[c]` frente a `[code]`: qué pasa con los tags de dentro.
 *
 * osu! tiene dos tags que se parecen y no se comportan igual, porque son dos
 * pases distintos de `BBCodeForDB`:
 *
 * - `parseCode` (`[code]`) ESCAPA su cuerpo con `extraEscapes` (cada `\n` pasa
 *   a `&#10;`, cada `[` a `&#91;`) y corre de los primeros, así que nada de
 *   dentro vuelve a ser una etiqueta: se publica el texto.
 * - `parseInlineSimple` (`[c]`) sólo RODEA su cuerpo con los marcadores
 *   `:uid`; no escapa nada y corre casi al final, así que todo lo que
 *   escribas dentro sigue vivo para el resto de pases — los que ya corrieron
 *   (box, quote, list, heading, code…) y los que quedan (url, email, size,
 *   colour, youtube, autolink). Medido: `[c][url=https://x]T[/url][/c]`
 *   publica `<code><a href="https://x">T</a></code>` mientras el mismo texto
 *   dentro de `[code]` publica `[url=https://x]T[/url]`.
 *
 * De ahí que la familia de `c` en `Osu/osuPairing.ts` sea `lazy` (sólo decide
 * la PAREJA: desnuda, sin cruzar saltos, contenido vacío permitido) y que el
 * lexer no lo aísle bajo `pairing: 'osu'`: el cuerpo tiene que llegar
 * tokenizado para que el árbol cuelgue tags de verdad dentro de
 * `inline_code`.
 *
 * Cada fila está medida con el harness (`~/Main Bridge/osu-harness/run.php`).
 * Las páginas curadas `docs/ai/osu-cases/c-tags-inside.bbcode`,
 * `c-vs-code.bbcode`, `c-edges.bbcode` y `attrs-unexpected.bbcode` cubren lo
 * mismo extremo a extremo (las recorre `OsuGoldens.test.ts`).
 */

const render = (source: string): string =>
  new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(
    new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false }).redRoot!,
  )

/** El HTML del preview sin los `data-*` que pone el editor. */
const bare = (html: string): string => html.replace(/ data-[a-z-]+="[^"]*"/g, '')

describe('el contenido de un [c] sellado sigue siendo contenido vivo', () => {
  it.each([
    ['[c]a[b]x[/b]b[/c]', '<code>a<strong>x</strong>b</code>'],
    ['[c][i]i[/i][u]u[/u][s]s[/s][/c]', '<code><em>i</em><u>u</u><s>s</s></code>'],
    ['[c][url=https://a.example/x]T[/url][/c]', '<code><a href="https://a.example/x"'],
    ['[c][url]https://a.example/x[/url][/c]', '<code><a href="https://a.example/x"'],
    ['[c][email]a@b.com[/email][/c]', '<code><a href="mailto:a@b.com"'],
    ['[c][size=50]s[/size][/c]', '<code><span style="font-size:50%;">s</span></code>'],
    ['[c][color=#ff0000]c[/color][/c]', '<code><span style="color:#ff0000;">c</span></code>'],
    ['[c]https://a.example/x[/c]', '<code><a href="https://a.example/x"'],
  ])('%s', (source, expected) => {
    expect(bare(render(source))).toContain(expected)
  })

  it('un bloque dentro del [c] publica el <code> partido, como osu!', () => {
    // `parseInlineSimple` corre DESPUÉS de los tags de bloque, así que el
    // `<div class="well">` sale entero y el `<code>` se cierra antes, se
    // reabre dentro y vuelve a abrirse después (el corte de HTMLPurifier).
    const html = bare(render('[c][notice]n[/notice][/c]'))
    expect(html).toContain('<code></code><code><div class="well">n</div></code><code></code>')
  })

  it('una lista dentro del [c] se aplana, como osu!', () => {
    // Medido: `[c][list][*]a[*]b[/list][/c]` publica `<code></code><code>ab
    // </code>` — sin `<ol>`, sin `<li>`, sin `<br>` entre los dos ítems.
    const html = bare(render('[c][list][*]a[*]b[/list][/c]'))
    expect(html).toContain('<code>ab</code>')
    expect(html).not.toContain('<ol')
    expect(html).not.toContain('<li')
  })

  it('un [code] dentro del [c] escapa su propio cuerpo', () => {
    // `parseCode` corre mucho antes que `parseInlineSimple`, así que el `[code]`
    // se protege igual y el `[c]` lo único que hace es rodearlo.
    const html = bare(render('[c][code]x[/code][/c]'))
    expect(html).toContain('<pre><code>x</code></pre>')
    expect(html).not.toContain('[code]x[/code]')
  })
})

describe('[code] escapa: el mismo texto queda escrito', () => {
  it.each([
    ['[code][url=https://a.example/x]T[/url][/code]', '[url=https://a.example/x]T[/url]'],
    ['[code][b]x[/b][/code]', '[b]x[/b]'],
    ['[code][heading]h[/heading][/code]', '[heading]h[/heading]'],
    ['[code][img]https://a.example/x.png[/img][/code]', '[img]https://a.example/x.png[/img]'],
  ])('%s', (source, expected) => {
    expect(bare(render(source))).toContain(`<pre><code>${expected}</code></pre>`)
  })
})

describe('la pareja de [c]: desnuda, sin cruzar saltos, vacío permitido', () => {
  it.each([
    // Sella: contenido vacío (`(.*?)` lo acepta).
    ['[c][/c]', '<code></code>'],
    // Sella con un tag de dentro que sí procesa su propio pase.
    ['[c]a[/b]b[/c]', '<code>a[/b]b</code>'],
  ])('%s', (source, expected) => {
    expect(bare(render(source))).toContain(expected)
  })

  it.each([
    // Un salto entre apertura y cierre: `#\[c](.*?)\[/c\]#` no lleva `/s`.
    ['[c]a\nb[/c]', '[c]a'],
    // Sin cierre.
    ['[c]sin cierre', '[c]sin cierre'],
    // Con `=valor`: el regex escribe `[c]` desnudo.
    ['[c=1]a[/c]', '[c=1]a[/c]'],
    // Ni con un espacio: `[c ]` tampoco es `[c]`.
    ['[c ]a[/c]', '[c ]a[/c]'],
  ])('%s queda escrito', (source, expected) => {
    const html = bare(render(source))
    expect(html).toContain(expected)
    expect(html).not.toContain('<code>')
  })

  it('el cierre que nadie consume sale escrito, y el de dentro se traga', () => {
    // `preg_replace` sólo transforma el tramo que casa: el `[/c]` de dentro
    // cierra el tag (osu! no anida) y el de fuera es texto.
    expect(bare(render('[c]a[/c]b[/c]'))).toContain('<code>a</code>b[/c]')
    expect(bare(render('[c]a[c]b[/c]c[/c]'))).toContain('<code>a[c]b</code>c[/c]')
  })

  it('un [c] sin sellar no protege nada: los tags de dentro se procesan igual', () => {
    // El `[b]` corre antes que `c` en osu!, así que el fallo de `c` no le
    // afecta; el `[c]` se queda escrito.
    expect(bare(render('[c]a\n[b]x[/b][/c]'))).toContain('[c]a')
    expect(bare(render('[c]a\n[b]x[/b][/c]'))).toContain('<strong>x</strong>')
  })
})

describe('el cuerpo de [code] es `.+?`: un cierre pegado no basta', () => {
  it('`[code][/code]` sin ningún cierre detrás queda escrito', () => {
    const html = bare(render('[code][/code]'))
    expect(html).toContain('[code][/code]')
    expect(html).not.toContain('<pre>')
  })

  it('pero con otro `[/code]` más adelante sella, y el cuerpo se lo come todo', () => {
    // Medido: este texto publica UN `<pre>[/code]\n[code]x</pre>` — el escaneo
    // perezoso crece hasta el primer cierre que deje un carácter de cuerpo.
    const html = bare(render('[code][/code]\n[code]x[/code]'))
    expect(html).toContain('<pre><code>[/code]\n[code]x</code></pre>')
    expect(html.match(/<pre>/g)).toHaveLength(1)
  })
})

describe('un atributo que osu! no contempla deja el tag escrito', () => {
  it.each([
    '[b=x]a[/b]',
    '[heading=2]a[/heading]',
    '[centre=x]a[/centre]',
    '[notice=x]a[/notice]',
    '[spoiler=x]a[/spoiler]',
    '[youtube=x]abc[/youtube]',
    '[profile=x]peppy[/profile]',
    '[c=1]a[/c]',
    '[code=x]a[/code]',
  ])('%s', (source) => {
    const html = bare(render(source))
    expect(html).toContain(source)
    // Y el tag no produjo NADA: ni negrita, ni heading, ni caja…
    expect(html).not.toMatch(/<(strong|h2|em|blockquote|div|pre|code)\b/)
  })

  it('`[img round]` no es una imagen, pero su URL sí se autolinkifica', () => {
    // La etiqueta queda escrita y la dirección suelta la enlaza `parseLinks`.
    const html = bare(render('[img round]https://a.example/x.png[/img]'))
    expect(html).toContain('[img round]<a href="https://a.example/x.png"')
    expect(html).not.toContain('<img')
  })

  it('la forma bien escrita sigue sellando (control)', () => {
    const html = bare(render('[b]a[/b] [heading]h[/heading]'))
    expect(html).toContain('<strong>a</strong>')
    expect(html).toContain('<h2>h</h2>')
  })
})
