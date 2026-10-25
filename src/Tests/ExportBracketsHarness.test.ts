import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter, type ExportTarget } from '../Visitors/BBCodeExporter'
import { TagRegistry, extractTextContent } from '../Model/TagRegistry'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

/**
 * Harness de corchetes en el exportador BBCode.
 *
 * El caso reportado: un `[rainbow]` sobre `[ hxovc ]` salía con `\[` y `\]`,
 * porque `segmentsToBBCode` escapaba los corchetes con una barra invertida.
 * BBCode no tiene carácter de escape: osu! muestra la barra tal cual y al
 * reimportar el texto la barra queda dentro del documento. El mismo camino
 * (`segmentsToBBCode`) lo comparten TODOS los generadores de efecto, así que
 * la prueba no se limita a rainbow.
 *
 * Qué cubre:
 *  1. El registro: si mañana aparece otro tag con `toBBCode`, este harness
 *     falla hasta que se lo agregue a la matriz de generadores.
 *  2. Los cinco generadores actuales (gradient, sinewave, grow, paint,
 *     rainbow) × nueve formas de corchete × tres dialectos × tres targets.
 *  3. Todos los tags builtin con hijos (formato, layout, cajas, media…) con
 *     el mismo payload literal, para demostrar que el escape nunca fue una
 *     conducta del exportador normal.
 *  4. El documento exacto del reporte, su texto visible, la paridad con la
 *     vista previa y la estabilidad de un segundo export.
 */

interface GeneratorCase {
  readonly name: string
  readonly open: string
  readonly close: string
}

const GENERATORS: readonly GeneratorCase[] = [
  { name: 'gradient', open: '[gradient=#ff0000,#00ff00]', close: '[/gradient]' },
  { name: 'sinewave', open: '[sinewave]', close: '[/sinewave]' },
  { name: 'grow', open: '[grow]', close: '[/grow]' },
  // Un grid 1×1 hace que paint realmente pinte: sin `map`, el efecto no
  // produce segmentos con estilo y el caso no tocaría la rama del escape.
  { name: 'paint', open: '[paint=cols=1;rows=1;pal=ff0000;map=1]', close: '[/paint]' },
  { name: 'rainbow', open: '[rainbow]', close: '[/rainbow]' },
]

const GENERATOR_NAMES: ReadonlySet<string> = new Set(GENERATORS.map((g) => g.name))

/**
 * Formas de corchete que un usuario escribe como texto, no como tag. La
 * primera es la del reporte; las demás atacan los bordes: corchetes sueltos,
 * vacíos, dobles y un tag desconocido, que el parser debe conservar como
 * texto en vez de convertirlo en una etiqueta viva.
 */
const BRACKET_PAYLOADS = [
  '[ hxovc ]',
  '[hxovc]',
  'a [ b',
  'a ] b',
  '[',
  ']',
  '[]',
  '[[x]]',
  'x[y]z',
] as const

const DIALECTS: readonly BBCodeDialect[] = ['miliastry', 'lyne', 'osu']
const TARGETS: readonly ExportTarget[] = ['osu', 'lyne', 'miliastry']

/** `\[` o `\]`: exactamente lo que no debe aparecer jamás en una salida. */
const ESCAPED_BRACKET = /\\[\[\]]/

/** Tags que el propio exportador inventa al expandir un efecto. */
const GENERATED_WRAPPER = /\[\/?(?:color|size)(?:=[^\]]*)?\]/g

function parse(source: string, dialect: BBCodeDialect): BBCodeDocumentModel {
  return new BBCodeDocumentModel({ source, dialect, autoAnalyze: false })
}

function exportSource(source: string, dialect: BBCodeDialect, target: ExportTarget): string {
  const model = parse(source, dialect)
  expect(model.redRoot, `el parser no produjo árbol para ${JSON.stringify(source)}`).not.toBeNull()
  return new BBCodeExporter(model.tagRegistry, target).export(model.redRoot!)
}

/** Texto que ve el lector, sin importar cuántos tags lo envuelvan. */
function visibleText(source: string, dialect: BBCodeDialect): string {
  const model = parse(source, dialect)
  expect(model.redRoot).not.toBeNull()
  return extractTextContent(model.redRoot!)
}

/** Quita solo los wrappers que genera un efecto, no los corchetes del autor. */
function effectVisibleText(bbcode: string): string {
  return bbcode.replace(GENERATED_WRAPPER, '')
}

const REPORTED_SOURCE = `[size=85][color=#ffcc66]★ JUGADOR 1 ★[/color][/size]
[size=200][b][rainbow][ hxovc ][/rainbow][/b][/size]
[color=#c8b6ff]Clase: Mago del Ritmo ◆ Nv. 99[/color]
[code]HP [########..]   MP [#####.....]   EXP [#########.][/code]`

describe('exportación de corchetes — cobertura del harness', () => {
  it('enumera todos los tags con handler de exportación del registro', () => {
    const registered = new TagRegistry()
      .getAll()
      .filter((def) => typeof def.toBBCode === 'function')
      .map((def) => def.name)
      .sort()

    expect(registered).toEqual(GENERATORS.map((g) => g.name).sort())
  })
})

describe('el documento exacto del reporte', () => {
  it('no escribe barras invertidas y conserva [ hxovc ] como texto', () => {
    const output = exportSource(REPORTED_SOURCE, 'miliastry', 'osu')

    expect(output).not.toMatch(ESCAPED_BRACKET)
    expect(output).not.toContain('\\')
    // Los corchetes quedan dentro de su color, sin escapar.
    expect(output).toContain('[color=#EB4747][[/color]')
    expect(output).toContain('[color=#EB47EB]][/color]')
  })

  it('el texto visible del export coincide con el del documento', () => {
    const output = exportSource(REPORTED_SOURCE, 'miliastry', 'osu')
    const sourceVisible = visibleText(REPORTED_SOURCE, 'miliastry')
    const exportedVisible = visibleText(output, 'osu')

    expect(sourceVisible).toContain('[ hxovc ]')
    expect(exportedVisible).toBe(sourceVisible)
  })

  it('la vista previa y el export muestran el mismo texto', () => {
    const model = parse(REPORTED_SOURCE, 'miliastry')
    const preview = model.toHTML().replace(/<[^>]*>/g, '')
    const exported = visibleText(
      exportSource(REPORTED_SOURCE, 'miliastry', 'osu'),
      'osu',
    )
    // La vista previa expresa los saltos como bloques HTML, no como `\n`;
    // comparamos el texto sin esos saltos, que es lo que ve el lector.
    const withoutLineBreaks = (text: string) => text.replace(/\r?\n/g, '').trim()

    expect(withoutLineBreaks(preview)).toBe(withoutLineBreaks(exported))
    expect(preview).toContain('[ hxovc ]')
    expect(preview).not.toContain('\\')
  })

  it('reexportar la salida no la cambia', () => {
    const once = exportSource(REPORTED_SOURCE, 'miliastry', 'osu')
    const twice = exportSource(once, 'osu', 'osu')

    expect(twice).toBe(once)
    expect(twice).not.toContain('\\')
  })
})

describe.each(GENERATORS)('generador [$name]', ({ name, open, close }) => {
  it.each(BRACKET_PAYLOADS)('preserva %j en los tres targets', (payload) => {
    const source = `${open}${payload}${close}`

    for (const target of TARGETS) {
      const output = exportSource(source, 'miliastry', target)
      const where = `${name} → ${target} con ${JSON.stringify(payload)}`

      expect(output, where).not.toMatch(ESCAPED_BRACKET)
      expect(output, where).not.toContain('\\')

      if (target === 'miliastry') {
        // Este target conserva el tag nativo; el payload sigue adentro.
        expect(output, where).toContain(payload)
      } else {
        // osu! y lyne reciben la expansión a [color]/[size]; al quitar solo
        // esos wrappers debe quedar el payload byte por byte.
        expect(effectVisibleText(output), where).toBe(payload)
      }
    }
  })

  it.each(BRACKET_PAYLOADS)('reexportar %j es estable', (payload) => {
    const once = exportSource(`${open}${payload}${close}`, 'miliastry', 'osu')
    const twice = exportSource(once, 'osu', 'osu')

    expect(twice).toBe(once)
  })
})

describe('matriz dialecto de origen × target', () => {
  it.each(DIALECTS)('el dialecto %s nunca introduce escapes', (dialect) => {
    for (const generator of GENERATORS) {
      for (const payload of BRACKET_PAYLOADS) {
        for (const target of TARGETS) {
          const output = exportSource(
            `${generator.open}${payload}${generator.close}`,
            dialect,
            target,
          )
          const where = `${dialect} → ${target} · ${generator.name} · ${JSON.stringify(payload)}`

          expect(output, where).not.toMatch(ESCAPED_BRACKET)
          expect(output, where).not.toContain('\\')
        }
      }
    }
  })
})

/**
 * Todo tag builtin que acepta hijos, no solo los de formato: layout, cajas,
 * quote, listas, code, media y los efectos de Lyne. El exportador normal
 * jamás escapó corchetes; esta matriz lo fija para que una futura rama de
 * exportación no reintroduzca el comportamiento en otro tipo de tag.
 */
const NORMAL_TAGS = new TagRegistry()
  .getAll()
  .filter(
    (def) =>
      def.canHaveChildren &&
      !def.isSelfClosing &&
      def.name !== '*' &&
      !GENERATOR_NAMES.has(def.name),
  )

describe('tags normales', () => {
  it('cubre una muestra amplia del catálogo', () => {
    expect(NORMAL_TAGS.length).toBeGreaterThanOrEqual(30)
  })

  it.each(NORMAL_TAGS.map((def) => def.name))('[%s] conserva los corchetes literales', (name) => {
    for (const payload of BRACKET_PAYLOADS) {
      const source = `[${name}]${payload}[/${name}]`
      const output = exportSource(source, 'miliastry', 'osu')
      const where = `[${name}] con ${JSON.stringify(payload)}`

      expect(output, where).not.toMatch(ESCAPED_BRACKET)
      expect(output, where).not.toContain('\\')
      expect(output, where).toContain(payload)
      // Tags que osu! no conoce (`square`, `boxw`, `imagemap`…) no se pueden
      // reparsear con dialecto osu sin que sus propios corchetes pasen a
      // verse como texto. El árbol de origen sí prueba que el payload llegó
      // intacto al exportador.
      expect(visibleText(source, 'miliastry'), where).toContain(payload)
    }
  })
})

describe('documento mixto', () => {
  it('varios generadores y tags normales conviven sin un solo escape', () => {
    const source = [
      ...GENERATORS.map(
        (g) => `[b]${g.open}[ ${g.name} ][${g.close.slice(2, -1)}][/b]`,
      ),
      '[quote][ hxovc ][/quote]',
      '[code]literal [ b ] y [ /b ][/code]',
    ].join('\n')
    const output = exportSource(source, 'miliastry', 'osu')

    expect(output).not.toMatch(ESCAPED_BRACKET)
    expect(output).not.toContain('\\')
    expect(visibleText(output, 'osu')).toBe(visibleText(source, 'miliastry'))
    for (const payload of ['[ gradient ]', '[ rainbow ]', '[ hxovc ]']) {
      expect(visibleText(output, 'osu')).toContain(payload)
    }
  })
})
