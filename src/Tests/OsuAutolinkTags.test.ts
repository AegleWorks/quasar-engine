import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * El autolink de osu! que se traga los tags que vienen detrás.
 *
 * `BBCodeForDB::parseLinks` corre al final, sobre el texto que todavía lleva
 * sus tags (`[b:1]`, `[size=150:1]`…), así que el target de una URL suelta es
 * `[^\s]+?`: no para en un `[`, y su lookahead sólo acepta etiquetas y
 * puntuación hasta el espacio o el final de la línea. Cuando la cola no le
 * sirve, el target crece hasta el siguiente espacio — tags incluidos.
 *
 * Publicar eso no es lo mismo que guardarlo: `BBCodeFromDB` convierte los
 * `:uid` de dentro del `href` en HTML, y HTMLPurifier corta el atributo en el
 * primer `<`. El resultado tiene tres piezas distintas, y cada fila de abajo
 * las mide por separado:
 *
 *   1. el `href`, que llega hasta el primer tag que produce HTML;
 *   2. el texto del ancla, que sigue hasta el final del target (los tags
 *      renderizados y la cola incluidos);
 *   3. los tags absorbidos, que se publican DENTRO del ancla.
 *
 * Medido con el harness (`~/Main Bridge/osu-harness/run.php`). La página
 * curada `docs/ai/osu-cases/url-autolink-tags.bbcode` cubre lo mismo extremo a
 * extremo (la recorre `OsuGoldens.test.ts`).
 *
 * Fuera de esta forma quedan dos familias medidas y NO reproducidas, porque su
 * salida no es "el ancla con el target renderizado" sino una reparación de
 * HTMLPurifier sobre el atributo roto (las tres están anotadas en
 * `.claude/rules/osu.md`): los tags cuyo HTML lleva comillas simples
 * (`[color]`, `[spoiler]`, `[profile]`, `[url]`, `[email]` dejan el resto del
 * tag como texto dentro del ancla), los tags de bloque (`[box]`, `[quote]`,
 * `[code]`, `[list]`, que reparan la estructura alrededor del ancla), y un
 * target que acaba DENTRO de un elemento con texto detrás.
 */

const render = (source: string): string =>
  new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(
    new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false }).redRoot!,
  )

/** Los `data-*` del editor no forman parte de lo que se mide. */
const bare = (html: string): string => html.replace(/ data-[a-z-]+="[^"]*"/g, '')

interface Anchor {
  href: string | null
  text: string | null
  html: string
}

/** El ancla `index` del render, con su href, su texto y su contenido. */
function anchor(source: string, index = 0): Anchor | null {
  const root = document.createElement('div')
  root.innerHTML = render(source)
  const a = root.querySelectorAll('a')[index]
  if (!a) return null
  return { href: a.getAttribute('href'), text: a.textContent, html: bare(a.innerHTML) }
}

describe('el ancla abarca el target entero; el href corta en el primer tag', () => {
  it.each([
    // El `[/url]` es un cierre huérfano: no lo convierte ningún pase de
    // FromDB, así que se queda escrito DENTRO del href (`[` y `]` escapados).
    ['https://a.example/x[/url][b]B[/b]TAIL', 'https://a.example/x%5B/url%5D', 'https://a.example/x[/url]BTAIL', '<strong>B</strong>'],
    // Sin cierre ajeno, el href es sólo la dirección.
    ['https://a.example/x[b]B[/b]TAIL', 'https://a.example/x', 'https://a.example/xBTAIL', '<strong>B</strong>'],
    ['https://a.example/x[i]I[/i]TAIL', 'https://a.example/x', 'https://a.example/xITAIL', '<em>I</em>'],
    ['https://a.example/x[u]U[/u]TAIL', 'https://a.example/x', 'https://a.example/xUTAIL', '<u>U</u>'],
    ['https://a.example/x[s]S[/s]TAIL', 'https://a.example/x', 'https://a.example/xSTAIL', '<s>S</s>'],
    ['https://a.example/x[c]C[/c]TAIL', 'https://a.example/x', 'https://a.example/xCTAIL', '<code>C</code>'],
    ['https://a.example/x[size=150]S[/size]TAIL', 'https://a.example/x', 'https://a.example/xSTAIL', '<span style="font-size:150%;">S</span>'],
    ['https://a.example/x[b]B[/b][i]I[/i]TAIL', 'https://a.example/x', 'https://a.example/xBITAIL', '<strong>B</strong><em>I</em>'],
    ['https://a.example/x[i][b]B[/b][/i]TAIL', 'https://a.example/x', 'https://a.example/xBTAIL', '<em><strong>B</strong></em>'],
    // Y lo mismo con texto delante: la URL sigue siendo la que abre el ancla.
    ['pre https://a.example/x[/url][b]B[/b]TAIL', 'https://a.example/x%5B/url%5D', 'https://a.example/x[/url]BTAIL', '<strong>B</strong>'],
  ])('%s', (source, href, text, inside) => {
    const a = anchor(source)
    expect(a?.href).toBe(href)
    expect(a?.text).toBe(text)
    // El tag absorbido no se escapa: se publica como elemento del ancla.
    expect(a?.html).toContain(inside)
  })

  it('una imagen y un youtube también quedan dentro, sin texto que los siga', () => {
    const img = anchor('https://a.example/x[img]https://i.example/a.png[/img]TAIL')
    expect(img?.href).toBe('https://a.example/x')
    expect(img?.text).toBe('https://a.example/xTAIL')
    expect(img?.html).toContain('<img')
    expect(img?.html).toContain('src="https://i.example/a.png"')

    const video = anchor('https://a.example/x[youtube]abc[/youtube]TAIL')
    expect(video?.href).toBe('https://a.example/x')
    expect(video?.text).toBe('https://a.example/xTAIL')
    expect(video?.html).toContain('youtube.com/embed/abc')
  })
})

describe('la cola que sí es puntuación no se traga', () => {
  // El lookahead `(?:\[.+?\]|[.:)\]])*(?:$|\s)` se queda con estas colas: el
  // target es la URL sola y el tag sigue fuera del ancla.
  it.each([
    ['https://a.example/x[/url][b]B[/b]', 'https://a.example/x', 'https://a.example/x'],
    ['https://a.example/x[/url][b]B[/b].', 'https://a.example/x', 'https://a.example/x'],
    ['https://a.example/x[/url][b]B[/b] TAIL', 'https://a.example/x', 'https://a.example/x'],
    ['https://a.example/x[/url] TAIL', 'https://a.example/x', 'https://a.example/x'],
  ])('%s', (source, href, text) => {
    const a = anchor(source)
    expect(a?.href).toBe(href)
    expect(a?.text).toBe(text)
    expect(a?.html).not.toContain('strong')
  })

  it('un cierre huérfano es texto: no corta el href', () => {
    // `[/b]` no lo convierte `BBCodeFromDB` (no es un tag `:uid`), así que
    // viaja dentro del href igual que `[/url]`.
    const a = anchor('https://a.example/x[/b]TAIL')
    expect(a?.href).toBe('https://a.example/x%5B/b%5DTAIL')
    expect(a?.text).toBe('https://a.example/x[/b]TAIL')
  })

  it('sin tags en el target, todo el texto queda en el href', () => {
    const a = anchor('https://a.example/x[/url]TAIL')
    expect(a?.href).toBe('https://a.example/x%5B/url%5DTAIL')
    expect(a?.text).toBe('https://a.example/x[/url]TAIL')
  })
})

describe('un enlace ya hecho y un `[c]` cortan el target', () => {
  it('`[url]…[/url]` convierte el tag antes de parseLinks: el ancla es sólo la URL', () => {
    const a = anchor('[url]https://a.example/x[/url][b]B[/b]TAIL')
    expect(a?.href).toBe('https://a.example/x')
    expect(a?.text).toBe('https://a.example/x')
    expect(a?.html).not.toContain('strong')
  })

  it('el cierre del contenedor pegado también cierra la frontera', () => {
    // `[box=…]…TAIL[/box]`: el `]` de `[/box:1]` deja que el lookahead termine
    // en la URL, así que osu! publica el ancla sólo con la dirección y el tag
    // sigue fuera. Con un salto antes del cierre, en cambio, sí se traga (ver
    // el test de `lineHandles`).
    const root = document.createElement('div')
    root.innerHTML = render('[box=Caja]https://a.example/x[/url][b]B[/b]TAIL[/box]')
    const a = [...root.querySelectorAll('a')].find((el) => el.textContent?.includes('a.example'))
    expect(a?.getAttribute('href')).toBe('https://a.example/x')
    expect(a?.textContent).toBe('https://a.example/x')
    expect(a?.innerHTML).not.toContain('strong')
  })

  it('dentro de un `[c]` el `[/c:1]` cierra la frontera: no se traga nada', () => {
    // El cierre `[/c:1]` ya está en el texto cuando parseLinks corre, y su `]`
    // deja que el lookahead termine en la URL: medido, osu! publica el ancla
    // sólo con la dirección y los tags fuera.
    const source = '[c]https://a.example/x[/url][b]B[/b]TAIL[/c]'
    const a = anchor(source)
    expect(a?.href).toBe('https://a.example/x')
    expect(a?.text).toBe('https://a.example/x')
    expect(a?.html).not.toContain('strong')
  })
})

describe('el preview del editor (lineHandles) usa el mismo plan', () => {
  it('dentro de un box, el ancla sigue cruzando los hijos de la línea', () => {
    // `lineHandles` envuelve cada línea de un contenedor en su `<span>`; el
    // ancla que cruza hijos tiene que caber DENTRO de esa línea. El salto
    // antes del `[/box]` es lo que deja al target acabar en la línea: con el
    // cierre pegado, su `]` le da al lookahead el tag que necesita y osu! NO
    // se traga nada (medido, y el control de abajo lo fija).
    const source = '[box=Caja]https://a.example/x[/url][b]B[/b]TAIL\n[/box]'
    const root = document.createElement('div')
    root.innerHTML = new HTMLRenderer({ dialect: 'osu', theme: 'osu', lineHandles: true }).render(
      new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false }).redRoot!,
    )
    expect(root.querySelector('.bb-line')).not.toBeNull()
    // El box pinta su propio enlace de título (`href="#"`): se busca el ancla
    // del autolink por su texto, no la primera `<a>` del HTML.
    const a = [...root.querySelectorAll('a')].find((el) => el.textContent?.includes('a.example'))
    expect(a?.getAttribute('href')).toBe('https://a.example/x%5B/url%5D')
    expect(a?.textContent).toBe('https://a.example/x[/url]BTAIL')
    expect(bare(a?.innerHTML ?? '')).toContain('<strong>B</strong>')
  })
})

describe('el target que acaba en medio de una hoja', () => {
  it('cierra el ancla antes del espacio y no absorbe la URL siguiente', () => {
    // `TAIL https://b.example/y`: el target del primero termina en el espacio
    // de la hoja, así que el `</a>` cae en medio de ella y el segundo enlace
    // se planifica aparte.
    const source = 'https://a.example/x[/url][b]B[/b]TAIL https://b.example/y'
    const first = anchor(source, 0)
    expect(first?.href).toBe('https://a.example/x%5B/url%5D')
    expect(first?.text).toBe('https://a.example/x[/url]BTAIL')
    expect(first?.html).toContain('<strong>B</strong>')

    const second = anchor(source, 1)
    expect(second?.href).toBe('https://b.example/y')
    expect(second?.text).toBe('https://b.example/y')
  })
})
