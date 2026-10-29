/**
 * Cómo se lee el atributo de una etiqueta BBCode, y qué valores se aceptan.
 *
 * ── Por qué esto vive fuera del renderizador ───────────────────────────────
 *
 * Era privado de `HTMLRenderer`, así que cualquier otro consumidor que
 * necesitara el mismo dato tenía que reinventarlo — y se reinventó mal. Los
 * presets del lienzo de BBCodeCanvas leían `node.text` en crudo, con el `=`
 * pegado delante: `[color=#ff0000]` acababa produciendo `color: "=#ff0000"`,
 * que es CSS inválido, así que el color no se pintaba en absoluto. Lo mismo con
 * `font_size` y `url`.
 *
 * No es un helper nuevo: es el mismo código, movido a donde los dos lo ven. Si
 * el renderizador y el lienzo vuelven a divergir, al menos divergirán desde el
 * mismo sitio.
 */

import type { RedNode } from './RedNode'
import type { TokenResolverFn } from '../Tokens'

/** #rgb / #rgba / #rrggbb / #rrggbbaa, una palabra clave CSS, o rgb()/hsl(). */
const CSS_COLOR_RE =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]{3,20}|(?:rgb|hsl)a?\([0-9a-z.,%\s/+-]{1,64}\))$/i

/** Número desnudo — se interpola como porcentaje. */
const CSS_SIZE_RE = /^\d{1,4}(?:\.\d{1,2})?$/

/** Lista de familias. Las comillas se rechazan; sin comillas es CSS válido. */
const CSS_FONT_RE = /^[A-Za-z0-9 ,_-]{1,120}$/

const BARE_HEX_RE = /^[0-9a-f]{3,8}$/i

/**
 * El valor del atributo de un nodo.
 *
 * Los atributos BBCode vienen como `=VALOR` (`=#61afef`, `="Autor"`,
 * `=https://osu.ppy.sh`): se quita el `=` y las comillas envolventes. Una
 * etiqueta sin atributo —el contenido de un `[img]`, por ejemplo— devuelve su
 * texto tal cual.
 *
 * Con `key`, gana lo que haya en `metadata`: es lo que escribe el Inspector al
 * editar una propiedad, y tiene que pesar más que el texto original del
 * documento, que todavía no se ha reescrito.
 */
export function nodeAttrValue(node: RedNode, key?: string): string {
  if (key) {
    const meta = node.metadata?.[key]
    if (typeof meta === 'string' && meta) return meta
  }

  const text = node.text || ''
  if (!text) return ''

  const eqIdx = text.indexOf('=')
  if (eqIdx < 0) return text

  let value = text.slice(eqIdx + 1)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value
}

/**
 * Un color que se puede meter en un `style`, o `null`.
 *
 * Devolver `null` en vez de el valor crudo no es remilgo: `[color=red;"
 * onmouseover="alert(1)]` cierra el atributo e inyecta un manejador de eventos.
 * Escapar solo neutralizaría la inyección, pero dejaría CSS roto, así que se
 * valida la FORMA y se descarta lo que no sea un valor que quisiéramos admitir.
 *
 * Un hex sin `#` se completa: `[color=ff0000]` es como lo escribe medio mundo.
 */
export function sanitizeColor(raw: string, resolver?: TokenResolverFn): string | null {
  // Atajo para `#RRGGBB`, que es la forma que produce el propio motor y con
  // la que llega la inmensa mayoría de las llamadas. Un degradado sin
  // fusionar emite UN SEGMENTO POR CARÁCTER y cada uno pasaba por `trim`,
  // dos expresiones regulares y el `startsWith` de los tokens. La comprobación
  // por códigos de carácter acepta exactamente el mismo conjunto que
  // `CSS_COLOR_RE` para siete caracteres, así que la garantía no cambia:
  // sigue siendo imposible que salga de aquí algo que no sea un color.
  if (raw.length === 7 && raw.charCodeAt(0) === 35 /* # */ && isPlainHex6(raw)) return raw

  let v = raw.trim()
  if (!v) return null
  if (v.startsWith('$') && resolver) {
    const resolved = resolver(v.slice(1)) ?? resolver(v)
    if (resolved !== undefined) {
      v = resolved.trim()
    }
  }
  if (BARE_HEX_RE.test(v) && (v.length === 3 || v.length === 4 || v.length === 6 || v.length === 8)) {
    v = '#' + v
  }
  return CSS_COLOR_RE.test(v) ? v : null
}

/**
 * Los 148 nombres de color de `HTMLPurifier_Config` (`Core.ColorKeywords`),
 * con el hex al que osu! los publica.
 *
 * `BBCodeForDB::parseColour` sella cualquier valor `[[:alpha:]]+`, pero el
 * `<span style="color:rose;">` resultante lo publica HTMLPurifier, que sólo
 * admite las palabras clave CSS; el resto lo tira y deja el `<span>` SIN
 * `style`. Medido con el harness: `[color=rose]x[/color]` → `<span>x</span>`,
 * `[color=Red]` → `color:#FF0000`, `[color=abc]` → `color:#abc` (HTMLPurifier
 * acepta un hex de 3/6 sin `#`), `[color=beef]` → sin estilo (4 caracteres no
 * son hex válidos).
 */
const CSS_COLOR_KEYWORDS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff', beige: '#f5f5dc',
  bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e', coral: '#ff7f50',
  cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c', cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b', darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000',
  darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969',
  dimgrey: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
  fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080',
  green: '#008000', greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5', lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff',
  maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db',
  mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500',
  orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee',
  palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd',
  powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1',
  saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d',
  silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa',
  springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8', tomato: '#ff6347',
  turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

/**
 * El `color` que osu! publica de verdad para un `[color=…]` ya sellado.
 *
 * `null` significa que HTMLPurifier tira la declaración: el `<span>` sale sin
 * `style`, no con un color que el navegador ignoraría. `#rrggbb` se deja tal
 * cual; un `[[:alpha:]]+` pasa por la tabla (y se publica en hex), y si no es
 * palabra clave pero mide 3 o 6 caracteres todos hex, HTMLPurifier lo toma
 * como hex sin `#` y lo completa. Cualquier otra cosa no llega aquí como
 * color: `renderColor` ya dejó el tag literal (ver `OSU_COLOR_RE`).
 */
export function osuCssColor(raw: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw
  if (!/^[a-zA-Z]+$/.test(raw)) return null
  const named = CSS_COLOR_KEYWORDS[raw.toLowerCase()]
  if (named !== undefined) return named
  if (/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return '#' + raw
  return null
}

/** `true` si `s[1..7]` son seis dígitos hexadecimales. Sin asignar nada. */
function isPlainHex6(s: string): boolean {
  for (let i = 1; i < 7; i++) {
    const c = s.charCodeAt(i)
    const isDigit = c >= 0x30 && c <= 0x39
    const isLower = c >= 0x61 && c <= 0x66
    const isUpper = c >= 0x41 && c <= 0x46
    if (!isDigit && !isLower && !isUpper) return false
  }
  return true
}

/** El tamaño de `[size=…]` como número, o `null`. Se interpola en `%`. */
export function sanitizeFontSize(raw: string, resolver?: TokenResolverFn): string | null {
  let v = raw.trim()
  if (v.startsWith('$') && resolver) {
    const resolved = resolver(v.slice(1)) ?? resolver(v)
    if (resolved !== undefined) {
      v = resolved.trim()
      if (v.endsWith('%')) {
        v = v.slice(0, -1).trim()
      }
    }
  }
  return CSS_SIZE_RE.test(v) ? v : null
}

/**
 * El mayor tamaño de letra dentro de `node`, relativo al suyo.
 *
 * Un degradado se pinta con `background-clip: text`, así que su caja de fondo
 * sólo mide lo que mide SU tipografía. Un `[size=200]` dentro de él dibuja
 * glifos del doble de alto, y lo que cae fuera de la caja de fondo se imprime
 * transparente: el texto aparecía cortado por arriba y por abajo. Quien pinta
 * el degradado usa este factor para agrandar la caja.
 *
 * Los tamaños anidados se multiplican, como en CSS: `[size=150][size=150]`
 * pinta al 225 %. Se corta en 4 (el 400 % que admite Lyne) para que un
 * `[size=9999]` no genere un padding absurdo antes de que el renderizador lo
 * tope.
 */
export function maxFontSizeScale(node: RedNode, resolver?: TokenResolverFn): number {
  let max = 1
  const visit = (current: RedNode, inherited: number) => {
    let scale = inherited
    if (current.kind === 'font_size') {
      const size = sanitizeFontSize(nodeAttrValue(current, 'size'), resolver)
      const percent = size ? Number(size) : NaN
      if (Number.isFinite(percent) && percent > 0) scale *= percent / 100
    }
    if (scale > max) max = scale
    for (const child of current.children) visit(child, scale)
  }
  for (const child of node.children) visit(child, 1)
  return Math.min(4, max)
}

/** La familia de `[font=…]`, o `null`. */
export function sanitizeFontFamily(raw: string, resolver?: TokenResolverFn): string | null {
  let v = raw.trim()
  if (v.startsWith('$') && resolver) {
    const resolved = resolver(v.slice(1)) ?? resolver(v)
    if (resolved !== undefined) {
      v = resolved.trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1).trim()
      }
    }
  }
  return CSS_FONT_RE.test(v) ? v : null
}

/** Lo que puede significar el atributo de un `[img=…]`. */
export interface ImgAttr {
  w?: number
  h?: number
  round?: boolean
  shadow?: boolean
  float?: boolean
}

/**
 * El modificador de una imagen: `[img=200x100]`, `[img=round]`, `[img=shadow]`,
 * `[img=float]`.
 *
 * Vive aquí y no en el renderizador porque es interpretación del ATRIBUTO, no
 * de cómo se pinta: quien quiera respetar un `round` necesita este mismo
 * significado, y hasta ahora el lienzo simplemente lo ignoraba.
 */
export function parseImgAttr(v: string | null): ImgAttr {
  if (!v) return {}
  const t = v.trim().toLowerCase()
  if (t === 'round') return { round: true }
  if (t === 'shadow') return { shadow: true }
  if (t === 'float') return { float: true }
  const m = /^(\d{1,4})x(\d{1,4})$/i.exec(t)
  if (m) return { w: Math.min(2000, parseInt(m[1], 10)), h: Math.min(2000, parseInt(m[2], 10)) }
  return {}
}
