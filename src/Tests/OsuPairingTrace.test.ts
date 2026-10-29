import { describe, it, expect } from 'vitest'
import { scanBBCode } from '../Lexer/BBCodeLexer'
import { applyOsuPairing, traceOsuPairing, type OsuPairingStep } from '../Osu/osuPairing'

/**
 * `traceOsuPairing` es la instrumentación opt-in de `applyOsuPairing`: una
 * decisión REAL por token `open`/`close`, en orden de documento. Sirve para
 * separar «el token no se selló» de «se selló y el árbol lo colgó en otro
 * sitio» antes de tocar nada — ver `.claude/rules/osu.md`.
 */
function trace(source: string, range?: { from?: number; to?: number }): OsuPairingStep[] {
  return traceOsuPairing(scanBBCode(source, { pairing: 'osu' }), source, range)
}

const byTag = (steps: OsuPairingStep[], tag: string) => steps.filter(s => s.tag === tag)

describe('osuPairing — traza opt-in', () => {
  it('un par normal: apertura y cierre sellados, cada uno con el índice del otro', () => {
    const steps = trace('[b]x[/b]')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'open', tag: 'b', action: 'seal', reason: 'paired' })
    expect(steps[0].detail).toMatchObject({ closer: 2 })
    expect(steps[1]).toMatchObject({ kind: 'close', tag: 'b', action: 'seal', reason: 'closer-of' })
    expect(steps[1].detail).toMatchObject({ opener: 0 })
  })

  it('un token que osu! nunca sella dice por qué: caso, alias, valor o falta de cierre', () => {
    expect(trace('[B]x[/B]')[0]).toMatchObject({ action: 'literal', reason: 'case', pass: 'lazy:b' })
    expect(trace('[center]x[/center]')[0]).toMatchObject({ action: 'literal', reason: 'not-osu-syntax', pass: 'neverSeal' })
    expect(trace('[size=abc]x[/size]')[0]).toMatchObject({ action: 'literal', reason: 'bad-value' })
    expect(trace('[b]x')[0]).toMatchObject({ action: 'literal', reason: 'no-closer' })
  })

  it('el presupuesto de list/quote se ve en el detalle: cuántas aperturas, cuántos cierres y el límite', () => {
    // 1 apertura, 2 cierres → límite 1: el segundo cierre es literal.
    const steps = trace('[list][*]a[/list][/list]')
    expect(steps[0]).toMatchObject({ action: 'seal', reason: 'within-limit' })
    expect(steps[0].detail).toMatchObject({ openers: 1, closers: 2, limit: 1 })
    const closers = byTag(steps, 'list').filter(s => s.kind === 'close')
    expect(closers[0]).toMatchObject({ action: 'seal', reason: 'within-limit' })
    expect(closers[1]).toMatchObject({ action: 'literal', reason: 'over-limit' })
  })

  it('el `[*]` no lo toca ninguna pasada de osu! y sale como untouched', () => {
    const step = byTag(trace('[list][*]a[/list]'), '*')[0]
    expect(step).toMatchObject({ action: 'untouched', reason: 'not-an-osu-tag', pass: '—' })
  })

  it('una lista sellada dentro de un box: los dos lados se sellan, el árbol es otro problema', () => {
    // El caso mínimo de `osu/37876237`: `[/list]` cae dentro del box. Todas
    // las llaves son etiquetas reales (no hay emparejamiento perdido), así
    // que la divergencia no está aquí: está en qué unidad cierra el árbol
    // (`Parser.ts`, cierre por conteo de divs).
    const source = '[list]title\n[box=][*]a\n[*]b\n[/list]\ntail[/box]'
    const steps = trace(source)
    expect(byTag(steps, 'list').map(s => s.action)).toEqual(['seal', 'seal'])
    expect(byTag(steps, 'box').map(s => s.action)).toEqual(['seal', 'seal'])
    // Y el texto detrás del cierre no produce ningún token: no se decide aquí.
    expect(steps.some(s => source.slice(s.start, s.end).includes('tail'))).toBe(false)
  })

  it('el rango deja la traza de una región concreta, para depurar una página sin volcarla entera', () => {
    const source = '[b]x[/b]\n[i]y[/i]'
    const from = source.indexOf('[i]')
    const steps = trace(source, { from, to: source.length })
    expect(steps).toHaveLength(2)
    expect(steps.every(s => s.start >= from)).toBe(true)
  })

  it('es determinista: dos ejecuciones dan exactamente los mismos pasos', () => {
    const source = '[list]t\n[box=][*]a\n[/list]\n[b]x[/b][/box]'
    expect(trace(source)).toEqual(trace(source))
  })

  it('la traza no cambia el resultado del sellado', () => {
    const sources = [
      '[b]x[/b]', '[B]x[/B]', '[list][*]a[/list][/list]', '[list]t\n[box=][*]a\n[/list]\ntail[/box]',
      '[imagemap]\nhttps://a.b/i.png\n0 0 10 10 # Tip\n[/imagemap][b]y[/b]', '[box=[b]T]x[/box]',
    ]
    for (const source of sources) {
      const tokens = scanBBCode(source, { pairing: 'osu' })
      const withoutTrace = applyOsuPairing(tokens, source)
      const withTrace = applyOsuPairing(tokens, source, { onDecision: () => {} })
      expect(withTrace).toEqual(withoutTrace)
    }
  })
})
