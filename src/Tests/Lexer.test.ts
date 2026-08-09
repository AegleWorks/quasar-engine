/**
 * BBCodeLexer — decisions on malformed input.
 *
 * The lexer had no tests of its own, which is backwards: its whole job is to
 * make a defensible decision about garbage, and an editor's buffer is garbage
 * most of the time — half-typed tags, lone brackets, unclosed raw blocks. The
 * happy path was covered incidentally by every other suite; the states that
 * actually exercise it were covered by nothing.
 *
 * Two properties matter here beyond "it returns the right tokens":
 *
 *  - **Coverage.** Tokens must tile `[0..source.length)` with no gap and no
 *    overlap. The parser builds the partition invariant (point 14) on top of
 *    this, so a hole here becomes a hole in the tree.
 *  - **Case folding.** Tag names are lower-cased, and the fast path skips the
 *    allocation when there is nothing to fold. `[COLOR]` and `[color]` must
 *    stay indistinguishable to everything downstream.
 */
import { describe, it, expect } from 'vitest'
import { REFERENCE_DOCUMENT, REFERENCE_DOCUMENT_WITH_GRADIENT } from './referenceDocument'
import { scanBBCode, type BBCodeToken } from '../Lexer/BBCodeLexer'

/** Compact form of a token stream, for readable expectations. */
const brief = (source: string): string[] =>
  scanBBCode(source).map(t => {
    switch (t.kind) {
      case 'open': return `open:${t.tag}${t.attrs ? `(${t.attrs})` : ''}`
      case 'close': return `close:${t.tag}`
      case 'text': return `text:${JSON.stringify(t.value)}`
      case 'newline': return `nl:${JSON.stringify(t.value)}`
    }
  })

/** Tokens must tile the source exactly — no gaps, no overlaps, nothing dropped. */
function coverageGap(source: string): string | null {
  let expected = 0
  for (const t of scanBBCode(source)) {
    if (t.start !== expected) {
      return `token en [${t.start}..${t.end}] pero se esperaba empezar en ${expected}`
    }
    expected = t.end
  }
  return expected === source.length
    ? null
    : `los tokens acaban en ${expected}, la fuente mide ${source.length}`
}

/** Every token's span must contain exactly the text it claims. */
function textMismatch(source: string): string | null {
  for (const t of scanBBCode(source) as BBCodeToken[]) {
    if (t.kind === 'text' || t.kind === 'newline') {
      const slice = source.slice(t.start, t.end)
      if (slice !== t.value) {
        return `[${t.start}..${t.end}] contiene ${JSON.stringify(slice)} pero el token dice ${JSON.stringify(t.value)}`
      }
    }
  }
  return null
}

describe('BBCodeLexer', () => {
  describe('etiquetas válidas', () => {
    it('abre y cierra', () => {
      expect(brief('[b]x[/b]')).toEqual(['open:b', 'text:"x"', 'close:b'])
    })

    it('separa el nombre de los atributos', () => {
      expect(brief('[color=#FF0000]x[/color]'))
        .toEqual(['open:color(=#FF0000)', 'text:"x"', 'close:color'])
    })

    it('resuelve el `]` correcto con BBCode anidado en los atributos', () => {
      expect(brief('[box=[b]t[/b]]c[/box]'))
        .toEqual(['open:box(=[b]t[/b])', 'text:"c"', 'close:box'])
    })

    it('acepta `_` y `*` en el nombre', () => {
      expect(brief('[*]')).toEqual(['open:*'])
      expect(brief('[_custom]')).toEqual(['open:_custom'])
    })
  })

  describe('normalización de mayúsculas', () => {
    // El camino rápido evita `toLowerCase()` cuando no hay nada que plegar,
    // así que hay que comprobar las dos ramas.
    it('pliega el nombre pero NO los atributos', () => {
      expect(brief('[COLOR=#E8B04B]x[/COLOR]'))
        .toEqual(['open:color(=#E8B04B)', 'text:"x"', 'close:color'])
    })

    it('mayúsculas y minúsculas dan el mismo nombre', () => {
      for (const [a, b] of [['[B]', '[b]'], ['[/B]', '[/b]'], ['[BoX=1]', '[box=1]']]) {
        expect([a, brief(a)]).toEqual([a, brief(b).map(x => x)])
      }
    })

    it('un nombre mixto se pliega entero', () => {
      expect(brief('[SpOiLeRbOx]')).toEqual(['open:spoilerbox'])
    })
  })

  describe('sintaxis inválida → texto literal', () => {
    const cases: [string, string[]][] = [
      ['[', ['text:"["']],
      [']', ['text:"]"']],
      ['[]', ['text:"["', 'text:"]"']],
      ['[/]', ['text:"["', 'text:"/]"']],
      ['[ ]', ['text:"["', 'text:" ]"']],
      ['[=]', ['text:"["', 'text:"=]"']],
      ['[/has space]', ['text:"["', 'text:"/has space]"']],
      ['x[y', ['text:"x"', 'text:"["', 'text:"y"']],
    ]
    for (const [source, expected] of cases) {
      it(JSON.stringify(source), () => {
        expect(brief(source)).toEqual(expected)
      })
    }
  })

  describe('apertura y cierre NO son simétricos', () => {
    // Esto sorprende y es deliberado, así que queda fijado aquí.
    //
    // En una APERTURA el nombre es la tirada inicial de caracteres válidos y
    // todo lo demás pasa a ser atributos, por permisiva que quede la etiqueta.
    // En un CIERRE el nombre debe llenar el hueco entero.
    //
    // No es inofensivo por accidente: el parser convierte las etiquetas que no
    // conoce (`has`, `123`) en nodos `text`, así que el usuario ve lo que
    // escribió. Por eso nadie lo había notado.
    it('en apertura, lo que no es nombre se vuelve atributos', () => {
      expect(brief('[has space]')).toEqual(['open:has(space)'])
      expect(brief('[123+456]')).toEqual(['open:123(+456)'])
    })

    it('en cierre, el nombre debe llenar todo el hueco', () => {
      expect(brief('[/has space]')).toEqual(['text:"["', 'text:"/has space]"'])
      expect(brief('[/b x]')).toEqual(['text:"["', 'text:"/b x]"'])
    })
  })

  describe('saltos de línea', () => {
    it('emite \\r\\n como un solo token', () => {
      expect(brief('a\r\nb')).toEqual(['text:"a"', 'nl:"\\r\\n"', 'text:"b"'])
    })

    it('emite \\n y \\r sueltos por separado', () => {
      expect(brief('a\n\rb')).toEqual(['text:"a"', 'nl:"\\n"', 'nl:"\\r"', 'text:"b"'])
    })
  })

  describe('bloques raw', () => {
    it('el contenido de [code] es literal', () => {
      expect(brief('[code]raw [b]x[/b][/code]'))
        .toEqual(['open:code', 'text:"raw [b]x[/b]"', 'close:code'])
    })

    it('[c] se comporta igual', () => {
      expect(brief('[c][i]y[/i][/c]')).toEqual(['open:c', 'text:"[i]y[/i]"', 'close:c'])
    })

    it('un [code] sin cerrar se traga el resto', () => {
      expect(brief('[code]resto [b]x')).toEqual(['open:code', 'text:"resto [b]x"'])
    })

    it('encuentra el cierre aunque difiera en mayúsculas', () => {
      // El source en minúsculas se calcula de forma perezosa; este es el único
      // caso que lo necesita, y por eso importa que siga funcionando.
      expect(brief('[code]x[/CODE]')).toEqual(['open:code', 'text:"x"', 'close:code'])
    })

    it('[code] vacío no emite token de texto', () => {
      expect(brief('[code][/code]')).toEqual(['open:code', 'close:code'])
    })
  })

  describe('los tokens cubren la fuente exactamente', () => {
    // Was two untracked `.milia` files read from disk; they vanished and took
    // seven tests with them. See `referenceDocument.ts`.
    const fixtures = {
      'reference document': REFERENCE_DOCUMENT,
      'reference document with gradient': REFERENCE_DOCUMENT_WITH_GRADIENT,
    }
    for (const [name, source] of Object.entries(fixtures)) {
      it(`fixture ${name}`, () => {
        expect(coverageGap(source)).toBeNull()
        expect(textMismatch(source)).toBeNull()
      })
    }

    const cases = [
      '', '[', ']', '[]', '[b]', '[/b]', '[b]x[/b]', '[[[[[[', ']]]]]]',
      '[code]x', '[code]x[/code]', '[c]x', 'a\r\nb', '\r', '\n\n\n',
      '[box=[b]t[/b]]c[/box]', '🎵[b]á€ñ[/b]🎵', '[has space]', '[/b x]',
    ]
    for (const source of cases) {
      it(JSON.stringify(source), () => {
        expect(coverageGap(source)).toBeNull()
        expect(textMismatch(source)).toBeNull()
      })
    }
  })

  describe('fuzz con semilla', () => {
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    const PIECES = [
      '[b]', '[/b]', '[COLOR=#FF0000]', '[/COLOR]', '[size=50]', '[', ']', '[[',
      ']]', '[/', '[]', '[/]', '[ ]', '[has space]', '[123+456]', '[_custom]',
      '[*]', '[code]', '[/code]', '[c]', '[/c]', '[box=[b]t[/b]]', 'texto',
      ' ', '\n', '\r\n', '🎵', 'á€ñ', '[b', 'b]', '[=]', '[b =x]',
    ]

    for (const seed of [1, 42, 1337, 0x5eed1a57]) {
      it(`semilla ${seed}: 2000 documentos se cubren enteros`, () => {
        const rnd = mulberry32(seed)
        for (let i = 0; i < 2000; i++) {
          const n = 1 + Math.floor(rnd() * 30)
          let source = ''
          for (let j = 0; j < n; j++) source += PIECES[Math.floor(rnd() * PIECES.length)]

          const gap = coverageGap(source)
          if (gap) throw new Error(`semilla ${seed} #${i}: ${gap}\n  src=${JSON.stringify(source)}`)
          const mismatch = textMismatch(source)
          if (mismatch) throw new Error(`semilla ${seed} #${i}: ${mismatch}\n  src=${JSON.stringify(source)}`)
        }
      })
    }
  })
})
