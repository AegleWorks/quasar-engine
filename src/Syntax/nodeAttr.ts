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
