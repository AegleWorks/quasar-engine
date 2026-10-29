import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * El cierre de los tags de enlace — dónde termina el `[url=…]` y cuándo el tag
 * es un enlace siquiera.
 *
 * osu! no tiene una regla de "tag bien formado": tiene `BBCodeForDB::parseUrl`
 * / `parseEmail`, y sólo reescribe el tag cuando su VALOR (o, en la forma
 * desnuda, su CUERPO) casa con su propia expresión. Lo que no casa se queda
 * escrito en la página publicada — y como `parseUrl` captura el valor con un
 * `.+?\]` perezoso, el atributo termina en el PRIMER `]`, corchetes dentro o no.
 *
 * Cada fila está medida con el harness (`~/Main Bridge/osu-harness/run.php`,
 * la misma tubería ForDB → FromDB → purificador que publica la página): el
 * `href` y el texto de cada ancla son los que salen allí. La página curada
 * `docs/ai/osu-cases/url-closure.bbcode` cubre los 49 casos extremo a extremo
 * (los recorre `OsuGoldens.test.ts` sin necesidad de Docker).
 */

const render = (source: string): string =>
  new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(
    new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false }).redRoot!,
  )

/** El primer ancla del preview como `href → texto`, o null si no hay ninguna. */
function anchor(source: string): string | null {
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(render(source))
  if (m === null) return null
  const href = /href="([^"]*)"/.exec(m[0])?.[1] ?? '(sin href)'
  return `${href} → ${m[1].replace(/<[^>]*>/g, '')}`
}

describe('el valor de un [url=…] es parte de la regla de cierre', () => {
  it.each([
    // El esquema exacto de osu!: `http`, `https` o `ftp`, en minúsculas.
    ['[url=https://a.example/x]T[/url]', 'https://a.example/x → T'],
    ['[url=http://a.example/x]T[/url]', 'http://a.example/x → T'],
    // El `href` sale tal cual: el purificador de osu! no admite `ftp` y el
    // preview no le añade un `https://` encima (medido: C14).
    ['[url=ftp://a.example/x]T[/url]', 'ftp://a.example/x → T'],
    // Y el texto puede ser cualquiera: `.+?` no lo mira.
    ['[url=https://a.example/x][b]T[/b][/url]', 'https://a.example/x → T'],
    ['[url=https://a.example/x]a]b[/url]', 'https://a.example/x → a]b'],
  ])('%s', (source, expected) => {
    expect(anchor(source)).toBe(expected)
  })

  it.each([
    '[url=]T[/url]',
    '[url=pepe]T[/url]',
    '[url=www.a.example/x]T[/url]',
    '[url=//a.example/x]T[/url]',
    '[url=mailto:a@b.com]T[/url]',
    '[url=javascript:alert(1)]T[/url]',
    // El esquema es sensible a mayúsculas: osu! no lleva `/i`.
    '[url=HTTPS://a.example/x]T[/url]',
  ])('%s queda escrito, sin enlace', (source) => {
    expect(anchor(source)).toBeNull()
    expect(render(source)).toContain(source.slice(1, -1).split(']')[0] + ']')
  })

  it('`[url = x]` no es un tag y aun así la URL de dentro se autolinkifica', () => {
    // Medido (C38): osu! publica `[url = ` + el enlace + `[/url]`, porque el
    // texto conserva la URL suelta y `parseLinks` corre sobre el texto entero.
    expect(anchor('[url = https://a.example/x]T[/url]')).toBe('https://a.example/x%5DT → https://a.example/x]T')
  })
})

describe('el atributo termina en el primer `]` (lazy `.+?\\]`)', () => {
  it.each([
    // El `[/url]` de dentro del valor no abre corchete: cierra el tag, y el
    // texto del enlace empieza detrás (C03).
    ['[url=https://a.example/x[/url]T[/url]', 'https://a.example/x%5B/url → T'],
    // Igual con un tag de verdad dentro del valor (C18/C30).
    ['[url=https://a.example/x[i:1]T[/url]', 'https://a.example/x%5Bi:1 → T'],
    // Corchetes equilibrados: el valor corta en el primero y el resto es texto (C04).
    ['[url=https://a.example/x[a]b]T[/url]', 'https://a.example/x%5Ba → b]T'],
    // Un cierre pegado deja el contenido vacío y osu! sigue buscando: ese
    // `[/url]` acaba DENTRO del enlace, y el último es el que cierra (C39).
    ['[url=https://a.example/x][/url]T[/url]', 'https://a.example/x → [/url]T'],
  ])('%s', (source, expected) => {
    expect(anchor(source)).toBe(expected)
  })
})

describe('la forma desnuda lleva la dirección en el cuerpo', () => {
  it.each([
    ['[url]https://a.example/x[/url]', 'https://a.example/x → https://a.example/x'],
    // El cuerpo de `.+?` sí admite espacios, y el `href` los publica escapados.
    ['[url]https://a.example/x y[/url]', 'https://a.example/x%20y → https://a.example/x y'],
    ['[email]a@b.com[/email]', 'mailto:a@b.com → a@b.com'],
  ])('%s', (source, expected) => {
    expect(anchor(source)).toBe(expected)
  })

  it.each([
    // osu! aplica su misma expresión al cuerpo: lo que no es dirección, no enlaza.
    '[url]pepe[/url]',
    '[url]a@b[/url]',
    '[email]notanemail[/email]',
    '[email=a@b.com]T[/email]'.replace('a@b.com', 'nope'),
  ])('%s queda escrito, sin enlace', (source) => {
    expect(anchor(source)).toBeNull()
  })
})
