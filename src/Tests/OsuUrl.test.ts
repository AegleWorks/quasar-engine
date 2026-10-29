import { describe, it, expect } from 'vitest'
import { osuPurifiedHref } from '../Osu/osuUrl'

/**
 * El `href` que osu! publica, contra la tabla del purificador mismo.
 *
 * Estas filas salen de correr `HTMLPurifier` con la configuración de osu-web
 * (`App\Singletons\CleanHTML`) sobre `<a href=VALUE>` — el mismo camino que
 * sigue un `[url=…]` publicado, porque `BBCodeFromDB::parseUrl` mete la URL
 * cruda en el atributo — y se comprobaron además extremo a extremo contra el
 * pipeline ForDB → FromDB → purificador del harness. El caso curado
 * `docs/ai/osu-cases/url-href-purifier.bbcode` cubre la parte de renderizado.
 */
describe('href de osu! — el filtro de URI del purificador', () => {
  // Tabla del purificador: valor del href → valor publicado.
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['//example.com/a', '//example.com/a'],
    ['/relative/a', '/relative/a'],
    ['relative/a', 'relative/a'],
    ['?q=1', '?q=1'],
    ['mailto:a@b.com', 'mailto:a@b.com'],
    ['mailto:a b@c.com', 'mailto:a%20b@c.com'],
    ['tel:+123456', 'tel:+123456'],
    ['https://example.com/a%2Fb', 'https://example.com/a%2Fb'],
    ['https://example.com/a—b', 'https://example.com/a%E2%80%94b'],
    ['https://example.com/a%00b', 'https://example.com/a%00b'],
    // `"`, `<` y `>` son delimitadores del parser: lo que sigue se pierde.
    ['https://example.com/a"', 'https://example.com/a'],
    ['https://example.com/a"b/c', 'https://example.com/a'],
    ['https://example.com/?q="x"', 'https://example.com/?q='],
    ['https://example.com/a<b>c', 'https://example.com/a'],
    // El `#` sólo abre fragmento la primera vez.
    ['https://example.com/#f#g', 'https://example.com/#f%23g'],
    // El `user@` se pierde en http(s).
    ['https://user@example.com/a', 'https://example.com/a'],
    ['https://[::1]/a', 'https://[::1]/a'],
    ['https://example.com/a b?c d#e f', 'https://example.com/a%20b?c%20d#e%20f'],
    ['ftp://example.com/a b', 'ftp://example.com/a%20b'],
    // El esquema se pasa a minúsculas, el host conserva sus mayúsculas.
    ['HTTPS://EXAMPLE.COM/A', 'https://EXAMPLE.COM/A'],
    ['https://EXAMPLE.COM/A', 'https://EXAMPLE.COM/A'],
    ['https://example.com', 'https://example.com'],
    // El puerto se cae si no es un puerto, y si es el del esquema.
    ['https://example.com:0/a', 'https://example.com/a'],
    ['https://example.com:65536/a', 'https://example.com/a'],
    ['https://example.com:/a', 'https://example.com/a'],
    // Porcentajes: se deshacen los que nunca se escapan, el resto en MAYÚSCULAS,
    // y un `%` suelto se escapa.
    ['https://example.com/a?q=%41%2f%7e%7E%zz', 'https://example.com/a?q=A%2F~~%25zz'],
    ['https://example.com/%', 'https://example.com/%25'],
    ['https://example.com/a%2', 'https://example.com/a%252'],
    ['https://example.com/a「b」', 'https://example.com/a%E3%80%8Cb%E3%80%8D'],
    ['https://example.com/a\'b"c', 'https://example.com/a\'b'],
    ['https://example.com/a&b', 'https://example.com/a&b'],
    ['https://example.com/a b', 'https://example.com/a%20b'],
    // `parseCDATA`: los extremos se recortan.
    ['  https://example.com/a', 'https://example.com/a'],
    ['https://example.com/a?x=1&y=2', 'https://example.com/a?x=1&y=2'],
  ])('%s', (value, published) => {
    expect(osuPurifiedHref(value)).toBe(published)
  })

  // El atributo desaparece cuando el valor no es un URI publicable: la página
  // publicada muestra el texto sin enlace.
  it.each([
    'https:///a',
    'https:////a',
    'javascript:alert(1)',
    'data:text/plain,x',
    'https://exa mple.com/a',
    'https://exa_mple.com/a',
    'https://éxample.com/a',
    'steam://run/1',
    'https://',
  ])('%s deja el enlace sin href', (value) => {
    expect(osuPurifiedHref(value)).toBeNull()
  })
})
