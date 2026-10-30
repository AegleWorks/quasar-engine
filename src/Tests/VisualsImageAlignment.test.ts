import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Las imágenes enlazadas y las sueltas tienen que compartir línea.
 *
 * osu! no hace distinción: el `img { vertical-align: middle }` de Bootstrap
 * alinea todas igual, y `.bbcode img` sólo añade `max-width`. Con la imagen
 * suelta en la línea base y la enlazada centrada, una fila de trozos de collage
 * caía media imagen más abajo (medido en Chrome con `osu/4166621`: +57 px en la
 * fila de 121 px y +135 px en la de 279 px). Al revés —suelta centrada y
 * enlazada en la base— pasa lo mismo en el otro sentido, así que la regla es
 * `middle` para *todas* las imágenes.
 *
 * `middle` además quita la fina línea que se veía entre dos filas del mosaico:
 * una imagen sobre la línea base deja su descendente bajo las letras, y la línea
 * siguiente empieza ahí. Centrada, la fila siguiente arranca en el borde de la
 * imagen.
 *
 * jsdom no calcula layout, así que la prueba vigila la regla de la hoja: es el
 * contrato que mantiene la medición.
 */
const CSS = readFileSync(resolve(__dirname, '../Visuals/osu.css'), 'utf8')

interface Rule {
  selector: string
  body: string
}

function rules(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Rule[] = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    found.push({ selector: match[1].trim(), body: match[2] })
  }
  return found
}

const PREFIX = '.bbcode-preview:not(.bbcode-preview-lyne):not(.theme-lyne)'
const LINK_SELECTOR = `${PREFIX} a:has(img)`
const IMAGE_SELECTOR = `${PREFIX} img`
const LINKED_IMAGE_SELECTOR = `${PREFIX} a img`

function declarations(selector: string, property: string): string[] {
  return rules(CSS)
    .filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
    .flatMap((rule) =>
      [...rule.body.matchAll(new RegExp(`${property}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim()),
    )
}

describe('osu.css · alineación de imágenes', () => {
  it('la imagen se centra en la línea, como el Bootstrap de osu!', () => {
    expect(declarations(IMAGE_SELECTOR, 'vertical-align')).toEqual(['middle'])
  })

  it('la imagen enlazada hereda la misma alineación que una suelta', () => {
    expect(declarations(LINKED_IMAGE_SELECTOR, 'vertical-align')).toEqual([])
  })

  it('el enlace de imagen se queda en la línea base para no bajar la caja', () => {
    expect(declarations(LINK_SELECTOR, 'vertical-align')).toEqual(['baseline'])
  })
})
