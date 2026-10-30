/**
 * El `href` que osu! publica, no el que se escribió.
 *
 * osu! no escapa la URL de un `[url=…]` al guardarla: `BBCodeFromDB::parseUrl`
 * la mete cruda en el atributo (`<a href='\1'>`) y el HTML entero pasa después
 * por `HTMLPurifier` (`App\Singletons\CleanHTML`). Es el filtro de URI del
 * purificador el que decide el valor final — y también si el atributo
 * desaparece —, así que el preview tiene que hacer lo mismo o cada `href` con
 * un espacio, un acento o una comilla diverge de la página publicada.
 *
 * Esto es ese filtro, puerto de `HTMLPurifier_AttrDef_URI` con su parser
 * (`HTMLPurifier_URIParser`), su normalizador de porcentajes
 * (`HTMLPurifier_PercentEncoder`) y sus esquemas http/https/ftp/mailto/tel:
 *
 *   - `parseCDATA`: recorta los extremos (como PHP `trim`) y vuelve espacios
 *     los saltos de línea y tabuladores. De ahí el `[url=…/perfil ]` que
 *     publica sin el espacio final.
 *   - Los porcentajes se normalizan primero: `%7e`/`%41` vuelven a `~`/`A`
 *     (los caracteres que no se escapan nunca), el resto se pasa a MAYÚSCULAS
 *     (`%2f` → `%2F`) y un `%` que no abra dos dígitos hexadecimales se escapa
 *     a `%25` (`a%2` → `a%252`).
 *   - El parser corta el valor en esquema / autoridad / ruta / consulta /
 *     fragmento según RFC 3986, y su expresión trata `"`, `<` y `>` como
 *     delimitadores: lo que venga detrás de uno de ellos se pierde
 *     (`[url=https://x/a"b]` publica `https://x/a`), y un `#` sólo abre
 *     fragmento la primera vez (el segundo sale `%23`).
 *   - Cada parte se escapa con un juego de caracteres distinto (la ruta
 *     conserva `!$&'()*+,;=:@/`, la consulta y el fragmento además `?`), así
 *     que el espacio es `%20`, `\` es `%5C`, `[` es `%5B` y la `—` es
 *     `%E2%80%94`, byte a byte.
 *   - El host sólo admite IPv4, IPv6 entre corchetes o un nombre sin guiones
 *     bajos ni caracteres no ASCII; si no pasa, y el esquema exige host, el
 *     atributo entero se descarta (`https:///a`, `https://exa mple.com/a`).
 *     El esquema `data:`/`javascript:` y compañía tampoco están permitidos.
 *   - El puerto se cae si es 0 o pasa de 65535, y también si es el del esquema
 *     (`:443` en https). El `user@` se pierde en http(s), y el host conserva
 *     sus mayúsculas.
 *
 * Devuelve `null` cuando el purificador quita el atributo: la página publicada
 * muestra el texto sin enlace.
 */

/** Sub-delims que el purificador conserva (`URI.AllowedSymbols`). */
const ALLOWED_SYMBOLS = "!$&'()*+,;="

const ALNUM = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
/** Los que además nunca se escapan y por eso se deshacen de su `%xx`. */
const UNRESERVED = new Set([...ALNUM, '-', '.', '_', '~'])

const utf8 = new TextEncoder()

/** `PHP trim()`: espacio, `\t`, `\n`, `\r`, NUL, `\v`. Nada más. */
const phpTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '')

/** `HTMLPurifier_PercentEncoder::normalize`. */
function normalizePercent(s: string): string {
  if (s === '') return ''
  const parts = s.split('%')
  let out = parts.shift() as string
  for (const part of parts) {
    if (part.length < 2) { out += '%25' + part; continue }
    const hi = hexValue(part.charCodeAt(0))
    const lo = hexValue(part.charCodeAt(1))
    if (hi < 0 || lo < 0) { out += '%25' + part; continue }
    const code = (hi << 4) | lo
    if (UNRESERVED.has(String.fromCharCode(code))) { out += String.fromCharCode(code) + part.slice(2); continue }
    out += '%' + part.slice(0, 2).toUpperCase() + part.slice(2)
  }
  return out
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

/**
 * The keep-set per `preserve` suffix. `percentEncode` runs for every path,
 * query and fragment of every URL; rebuilding the same Set each time was
 * pure allocation in the hot loop.
 */
const KEEP_SETS = new Map<string, Set<string>>()
function keepSet(preserve: string): Set<string> {
  let keep = KEEP_SETS.get(preserve)
  if (keep === undefined) {
    keep = new Set([...UNRESERVED, ...preserve])
    KEEP_SETS.set(preserve, keep)
  }
  return keep
}

/** El bloque ASCII de cada `preserve`; las URLs normales no tocan el encoder UTF-8. */
const ASCII_KEEP = new Map<string, Uint8Array>()
function asciiKeep(preserve: string): Uint8Array {
  let table = ASCII_KEEP.get(preserve)
  if (table === undefined) {
    table = new Uint8Array(128)
    for (const ch of keepSet(preserve)) {
      const code = ch.charCodeAt(0)
      if (code < 128) table[code] = 1
    }
    ASCII_KEEP.set(preserve, table)
  }
  return table
}

/** `HTMLPurifier_PercentEncoder::encode`, byte a byte: conserva `%` y `preserve`. */
function percentEncode(s: string, preserve: string): string {
  const keep = asciiKeep(preserve)
  let out = ''
  // Most path/query/fragment pieces are already in the keep set; returning the
  // original string then saves one copy (and one rope flatten) per URL part.
  let changed = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 128) {
      if (code !== 0x25 && keep[code] === 0) {
        out += '%' + code.toString(16).toUpperCase().padStart(2, '0')
        changed = true
      } else {
        out += s[i]
      }
      continue
    }
    // A non-ASCII code point is always escaped, one UTF-8 byte at a time.
    const ch = code >= 0xd800 && code <= 0xdbff && i + 1 < s.length
      ? s.slice(i, i + 2)
      : s[i]
    for (const byte of utf8.encode(ch)) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
    changed = true
    if (ch.length === 2) i++
  }
  return changed ? out : s
}

/** `HTMLPurifier_AttrDef_URI_Host::validate`: `''`, IPv6, IPv4 o nombre DNS. */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const DNS_HOST_RE = new RegExp(`^(?:${DNS_LABEL}\\.)*(${DNS_LABEL})\\.?$`, 'i')
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const DIGITS_RE = /^\d+$/

function validHost(host: string): string | false {
  if (host === '') return ''
  if (host.length > 1 && host.startsWith('[') && host.endsWith(']')) return host
  // IPv4 literal: cuatro octetos, o la forma entera que también acepta el purificador.
  if (IPV4_HOST_RE.test(host) || DIGITS_RE.test(host)) return host
  // Nombre DNS: sin guiones bajos ni no-ASCII (el purificador los punycodearía,
  // pero osu-web no tiene la extensión `intl`, así que un host acentuado se cae).
  const m = DNS_HOST_RE.exec(host)
  if (m && !DIGITS_RE.test(m[1])) return host
  return false
}

interface Uri {
  scheme: string | null
  userinfo: string | null
  host: string | null
  port: number | null
  path: string
  query: string | null
  fragment: string | null
}

/** Los esquemas del purificador, con lo que cada uno hace con sus partes. */
function schemeShape(scheme: string | null) {
  switch (scheme) {
    case 'https': return { allowed: true, defaultPort: 443, mayOmitHost: false }
    case 'http': return { allowed: true, defaultPort: 80, mayOmitHost: false }
    case 'ftp': return { allowed: true, defaultPort: 21, mayOmitHost: false }
    case 'mailto': return { allowed: true, defaultPort: null, mayOmitHost: true }
    case 'tel': return { allowed: true, defaultPort: null, mayOmitHost: true }
    case null: return { allowed: true, defaultPort: 80, mayOmitHost: false } // `URI.DefaultScheme` = http
    default: return { allowed: false, defaultPort: null, mayOmitHost: false }
  }
}

/**
 * Result cache: the same avatars, profile links and image hosts appear over
 * and over across a page and across pages. Pure function, bounded FIFO so a
 * long-lived renderer cannot grow without limit.
 */
const HREF_CACHE_MAX = 131072
const HREF_CACHE_MAX_LENGTH = 4096
const HREF_CACHE = new Map<string, string | null>()
/**
 * Insertion order, so eviction never has to ask the Map for its oldest key.
 *
 * `Map.keys().next()` LOOKS like an O(1) FIFO, and it is not: once the cache
 * is full the oldest entry is deleted on every miss, so the iterator starts
 * over a table full of holes and walks past all of them to find the next live
 * entry. With a working set just above the cap — the corpus has 143,773
 * distinct URLs against a cap of 131,072 — every single call missed and the
 * eviction alone made the function **ten times slower** than computing the
 * answer from scratch. A ring buffer of the keys keeps it at O(1).
 */
const HREF_CACHE_KEYS: string[] = []
let HREF_CACHE_AT = 0

/**
 * The shape of a URL the purifier leaves byte-for-byte alone: lowercase
 * http(s), a DNS/IPv4 host with no userinfo or port, and path/query/fragment
 * characters all in the set `percentEncode` preserves. No `%` (its
 * normalization can rewrite it), no brackets, quotes, backslashes, spaces or
 * non-ASCII. This is the overwhelming majority of avatar and image URLs in a
 * feed, and skipping the parser, normalizer and encoder for them removes most
 * of the first-pass cost of the URL cache.
 */
const SIMPLE_HREF_RE =
  /^(https?):\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(\/[A-Za-z0-9._~!$&'()*+,;=:@\/-]*)?(\?[A-Za-z0-9._~!$&'()*+,;=:@\/?-]*)?(#[A-Za-z0-9._~!$&'()*+,;=:@\/?-]*)?$/

function rememberHref(value: string, result: string | null): void {
  if (HREF_CACHE_KEYS.length < HREF_CACHE_MAX) {
    HREF_CACHE_KEYS.push(value)
  } else {
    HREF_CACHE.delete(HREF_CACHE_KEYS[HREF_CACHE_AT])
    HREF_CACHE_KEYS[HREF_CACHE_AT] = value
    HREF_CACHE_AT = (HREF_CACHE_AT + 1) % HREF_CACHE_MAX
  }
  HREF_CACHE.set(value, result)
}

/**
 * El valor final de un atributo URI de osu!, o `null` si el purificador lo
 * quita. La entrada es el texto tal como llegó al atributo, ya sin entidades
 * HTML (el purificador las decodifica antes de validar).
 */
export function osuPurifiedHref(value: string): string | null {
  if (value.length > HREF_CACHE_MAX_LENGTH) return purifyHref(value)
  // One lookup: `null` is a real cached answer (the purifier dropped the
  // attribute), so `undefined` is the only miss marker. The corpus calls this
  // 253k times over 8.7k pages; a `has` + `get` pair made every hit twice as
  // expensive as it needed to be.
  const cached = HREF_CACHE.get(value)
  if (cached !== undefined) return cached
  const simple = SIMPLE_HREF_RE.exec(value)
  if (simple !== null && validHost(simple[2]) !== false) {
    rememberHref(value, value)
    return value
  }
  const result = purifyHref(value)
  rememberHref(value, result)
  return result
}

function purifyHref(value: string): string | null {
  const text = phpTrim(value).replace(/[\n\t\r]/g, ' ')
  // `normalizePercent` splits on `%` and allocates an array even when there is
  // none, which is the vast majority of URLs; the scan below is the check.
  const normalized = text.indexOf('%') === -1 ? text : normalizePercent(text)

  // Appendix B del RFC 3986, con `"` y `<>` de más: son delimitadores externos.
  const m = /^(([A-Za-z0-9.+-]+):)?(\/\/([^/?#"<>]*))?([^?#"<>]*)(\?([^#"<>]*))?(#([^"<>]*))?/.exec(normalized)
  if (!m) return null
  const uri: Uri = {
    scheme: m[2] ? (m[2] === m[2].toLowerCase() ? m[2] : m[2].toLowerCase()) : null,
    userinfo: null,
    host: null,
    port: null,
    path: m[5] ?? '',
    query: m[7] !== undefined ? m[7] : null,
    fragment: m[9] !== undefined ? m[9] : null,
  }
  if (m[3] !== undefined) {
    const a = /^((.+?)@)?(\[[^\]]+\]|[^:]*)(:(\d*))?/.exec(m[4])
    uri.userinfo = a?.[2] ?? null
    uri.host = a?.[3] ?? ''
    uri.port = a?.[4] !== undefined ? Number(a[5] || 0) : null
  }

  // `HTMLPurifier_URI::validate` — el host primero: si no pasa, se pierde entero.
  if (uri.host !== null) {
    const host = validHost(uri.host)
    if (host === false) uri.host = null
    else uri.host = host
  }
  if ((uri.scheme !== null && uri.host === null) || uri.host === '') {
    if (uri.scheme === 'http') uri.scheme = null // el esquema por defecto se cae
  }
  if (uri.userinfo !== null) uri.userinfo = percentEncode(uri.userinfo, ALLOWED_SYMBOLS + ':')
  if (uri.port !== null && (uri.port < 1 || uri.port > 65535)) uri.port = null

  const pchar = ALLOWED_SYMBOLS + ':@'
  if (uri.host !== null) {
    uri.path = percentEncode(uri.path, pchar + '/')
  } else if (uri.path !== '') {
    if (uri.path[0] === '/') {
      // `http://` con el host perdido: `//path` se queda sin ruta.
      uri.path = uri.path.length >= 2 && uri.path[1] === '/' ? '' : percentEncode(uri.path, pchar + '/')
    } else if (uri.scheme !== null) {
      uri.path = percentEncode(uri.path, pchar + '/')
    } else {
      const slash = uri.path.indexOf('/')
      uri.path = slash === -1
        ? percentEncode(uri.path, pchar + '@')
        : percentEncode(uri.path.slice(0, slash), pchar + '@') + percentEncode(uri.path.slice(slash), pchar + '/')
    }
  } else {
    uri.path = ''
  }
  if (uri.query !== null) uri.query = percentEncode(uri.query, pchar + '/?')
  if (uri.fragment !== null) uri.fragment = percentEncode(uri.fragment, pchar + '/?')

  // Filtros de `HTMLPurifier_URIDefinition`: ninguno está activo en osu-web
  // (sin `URI.Host`, `URI.Base`, `URI.Munge` ni listas negras), así que el
  // URI llega tal cual al esquema.
  const shape = schemeShape(uri.scheme)
  if (!shape.allowed) return null
  if (shape.defaultPort !== null && uri.port === shape.defaultPort) uri.port = null

  // `HTMLPurifier_URIScheme::validate`: sin host y con esquema, se rechaza
  // (`URI.Host` está vacío, así que no hay a quién recurrir).
  if (!shape.mayOmitHost) {
    if (uri.scheme !== null && (uri.host === '' || uri.host === null)) return null
    if (uri.scheme === null && uri.host === '') {
      if (!uri.path.startsWith('//')) uri.host = null
      else return null
    }
  }

  switch (uri.scheme) {
    case 'http':
    case 'https':
      uri.userinfo = null
      break
    case 'ftp': {
      uri.query = null
      // Código de tipo del final de la ruta (`;type=a`): se conserva si es bueno.
      const at = uri.path.lastIndexOf(';')
      if (at !== -1) {
        const type = uri.path.slice(at + 1)
        const eq = type.indexOf('=')
        let keep = ''
        let rest = type
        if (eq !== -1) {
          const [key, code] = [type.slice(0, eq), type.slice(eq + 1)]
          if (key === 'type') {
            rest = ''
            if (code === 'a' || code === 'i' || code === 'd') keep = `;type=${code}`
          }
        } else {
          rest = ''
        }
        uri.path = uri.path.slice(0, at) + (rest ? `%3B${rest}` : '')
        uri.path = uri.path.replace(/;/g, '%3B') + keep
      }
      break
    }
    case 'mailto':
      uri.userinfo = null
      uri.host = null
      uri.port = null
      break
    case 'tel':
      uri.userinfo = null
      uri.host = null
      uri.port = null
      uri.path = decodeURIComponentSafe(uri.path).replace(/X/g, 'x').replace(/(?!^\+)[^\dx,]/g, '')
      break
  }

  // `HTMLPurifier_URI::toString`
  let out = ''
  if (uri.host !== null) {
    out = '//' + (uri.userinfo !== null ? `${uri.userinfo}@` : '') + uri.host + (uri.port !== null ? `:${uri.port}` : '')
  }
  if (uri.scheme !== null) out = uri.scheme + ':' + out
  out += uri.path
  if (uri.query !== null) out += '?' + uri.query
  if (uri.fragment !== null) out += '#' + uri.fragment
  return out
}

/** `rawurldecode`, sin morir en una secuencia que no lo es. */
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
