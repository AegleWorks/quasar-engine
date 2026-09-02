import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic, DiagnosticFix } from '../Types/diagnostics'

/**
 * Etiquetas desconocidas que el autor SÍ cerró.
 *
 * La regla existía y no podía dispararse nunca: esperaba nodos `custom`, que
 * `Parser` intercepta antes de construirlos para emitir el texto literal de la
 * etiqueta — a propósito, porque `[Gateron]` en prosa tiene que verse. Así que
 * `[bold]x[/bold]` se publicaba como basura visible y el checker callaba,
 * mientras la app ya traía traducción y etiqueta de regla para el hallazgo.
 *
 * Lo que la hace utilizable es el emparejado. Una etiqueta desconocida suelta
 * no es evidencia de nada — en 53 userpages reales hay `[gb]`, `[insane]`,
 * `[rm120]` y una docena más — pero nadie cierra un aparte entre corchetes.
 * Ese mismo corpus tiene CERO pares desconocidos: ese es el presupuesto de
 * falsos positivos que gasta la regla.
 */

function diagnose(source: string): Diagnostic[] {
  return new BBCodeDocumentModel({ source }).analyze().diagnostics.items
}

function codesOf(source: string): string[] {
  return diagnose(source).map(d => d.code)
}

function only(source: string, code: string): Diagnostic {
  const found = diagnose(source).filter(d => d.code === code)
  expect(found.length, `se esperaba un único '${code}' en ${JSON.stringify(source)}`).toBe(1)
  return found[0]
}

function applyFix(source: string, fix: DiagnosticFix): string {
  const edits = fix.operations.map(op => {
    switch (op.kind) {
      case 'replace_text': return { start: op.range.start, end: op.range.end, text: op.newText }
      case 'insert_text': return { start: op.position, end: op.position, text: op.text }
      case 'delete_range': return { start: op.range.start, end: op.range.end, text: '' }
      case 'wrap_in_tag': return { start: op.range.start, end: op.range.start, text: `[${op.tagName}]` }
    }
  }).sort((a, b) => b.start - a.start)

  let out = source
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

describe('etiquetas desconocidas', () => {
  describe('detección', () => {
    it('avisa de una etiqueta desconocida que el autor cerró', () => {
      expect(codesOf('[bold]x[/bold]')).toContain('unknown-tag')
    })

    it('dice que se está publicando como texto literal', () => {
      expect(only('[bold]x[/bold]', 'unknown-tag').message).toContain('literal text')
    })

    it('señala la apertura y apunta al cierre', () => {
      const d = only('[bold]x[/bold]', 'unknown-tag')
      expect(d.range).toEqual({ start: 0, end: 6 })
      expect(d.related?.[0].range).toEqual({ start: 7, end: 14 })
    })

    it('no depende de la etiqueta concreta', () => {
      expect(codesOf('[Chocolate]x[/Chocolate]')).toContain('unknown-tag')
    })
  })

  describe('lo que tiene que seguir callado', () => {
    it('una etiqueta desconocida SUELTA es prosa, no un error', () => {
      // El parser la conserva visible a propósito.
      expect(codesOf('[Gateron] es un fabricante')).not.toContain('unknown-tag')
    })

    it.each(['[gb]', '[insane]', '[rm120]', '[my]', '[szy]'])(
      'calla ante %s, que sale tal cual en userpages reales',
      tag => { expect(codesOf(`intro ${tag} resto`)).not.toContain('unknown-tag') },
    )

    it('calla ante una marca de tiempo entre corchetes', () => {
      expect(codesOf('a las [06:24] paso algo')).not.toContain('unknown-tag')
    })

    it('no toca lo que hay dentro de [code]: ahí los corchetes son contenido', () => {
      const codes = codesOf('[code][bold]x[/bold][/code]')
      expect(codes).not.toContain('unknown-tag')
      expect(codes).toContain('nested-tags-in-code')
    })

    it('una etiqueta válida no es desconocida', () => {
      expect(codesOf('[centre]ok[/centre]')).not.toContain('unknown-tag')
    })

    it('el cierre no cuenta si llega ANTES que la apertura', () => {
      expect(codesOf('[/bold] texto [bold]')).not.toContain('unknown-tag')
    })
  })

  describe('sugerencia', () => {
    it.each([
      ['[bold]x[/bold]', 'b'],
      ['[italic]x[/italic]', 'i'],
      ['[underline]x[/underline]', 'u'],
      ['[image]x[/image]', 'img'],
      ['[header]x[/header]', 'heading'],
    ])('%s → propone [%s] aunque la distancia de edición no lo encontraría', (source, expected) => {
      const d = only(source, 'unknown-tag')
      expect(d.fixes?.[0].description).toBe(`Replace [${source.slice(1, source.indexOf(']'))}] with [${expected}]`)
    })

    it.each([
      ['[notce]x[/notce]', 'notice'],
      ['[quotee]x[/quotee]', 'quote'],
      ['[centr]x[/centr]', 'centre'],
    ])('%s → corrige el typo a [%s]', (source, expected) => {
      expect(only(source, 'unknown-tag').fixes?.[0].description).toContain(`with [${expected}]`)
    })

    it('no adivina cuando no se parece a nada', () => {
      expect(only('[Chocolate]x[/Chocolate]', 'unknown-tag').fixes).toBeUndefined()
    })

    it('no adivina con nombres de menos de cuatro letras', () => {
      // Con dos ediciones de margen, `[xyz]` alcanzaría media docena de tags.
      expect(only('[xyz]x[/xyz]', 'unknown-tag').fixes).toBeUndefined()
    })
  })

  describe('corrección', () => {
    it('renombra apertura Y cierre', () => {
      // Media corrección deja un `[/bold]` huérfano que osu! pinta como texto
      // literal: peor que la etiqueta desconocida que venía a arreglar.
      const d = only('[bold]x[/bold]', 'unknown-tag')
      expect(applyFix('[bold]x[/bold]', d.fixes![0])).toBe('[b]x[/b]')
    })

    it('deja el documento sin ese hallazgo', () => {
      const d = only('[bold]x[/bold]', 'unknown-tag')
      expect(codesOf(applyFix('[bold]x[/bold]', d.fixes![0]))).not.toContain('unknown-tag')
    })

    it('NO es automática: cambia lo que se ve, que es justo para lo que existe', () => {
      // El resto de correcciones automáticas son seguras porque NO cambian el
      // render. Esta convierte texto literal en negrita: es lo que el autor
      // quería, pero es una conjetura sobre su intención y la acepta él.
      expect(only('[bold]x[/bold]', 'unknown-tag').fixes![0].isAutomatic).toBe(false)
    })
  })
})
