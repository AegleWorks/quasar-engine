import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { TagRegistry } from '../Model/TagRegistry'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { Diagnostic, DiagnosticFix } from '../Types/diagnostics'

/**
 * Las correcciones que emiten los validadores.
 *
 * Antes de esto NINGÚN validador rellenaba `fixes`: el tipo `DiagnosticFix`
 * existía, `ErrorCheckerWindow` ya dibujaba el botón «Aplicar corrección», y
 * ese botón no se renderizó nunca porque la condición que lo destapa
 * (`err.fixes?.length`) jamás fue cierta.
 *
 * El contrato que fijan estos tests es el que hace la corrección segura: una
 * corrección automática NO puede cambiar lo que se ve. Escribe en el fuente la
 * decisión que el parser ya había tomado por su cuenta.
 */

function diagnose(source: string): Diagnostic[] {
  return new BBCodeDocumentModel({ source }).analyze().diagnostics.items
}

/** El fuente resultante de aplicar un fix, de atrás hacia delante. */
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

/**
 * El HTML sin los ids de nodo, que son un contador global y por tanto nunca
 * coinciden entre dos parseos distintos.
 */
function renderNormalized(source: string): string {
  const model = new BBCodeDocumentModel({ source })
  model.analyze()
  return new HTMLRenderer({ registry: new TagRegistry() })
    .render(model.redRoot!)
    .replace(/\s*data-(node-id|block-id|id)="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function onlyFix(source: string, code: string): DiagnosticFix {
  const found = diagnose(source).find(d => d.code === code)
  expect(found, `no se emitió ningún '${code}' para ${JSON.stringify(source)}`).toBeDefined()
  expect(found!.fixes?.length, `'${code}' no trae corrección`).toBeGreaterThan(0)
  return found!.fixes![0]
}

describe('correcciones de diagnóstico', () => {
  describe('unclosed-tag', () => {
    it('escribe el cierre donde el parser ya lo había puesto', () => {
      const source = '[b]sin cerrar'
      expect(applyFix(source, onlyFix(source, 'unclosed-tag'))).toBe('[b]sin cerrar[/b]')
    })

    it('no cambia el render: el parser ya cerraba ahí', () => {
      const source = '[b]sin cerrar'
      const fixed = applyFix(source, onlyFix(source, 'unclosed-tag'))
      expect(renderNormalized(fixed)).toBe(renderNormalized(source))
    })

    it('deja el documento sin ese hallazgo', () => {
      const source = '[b]sin cerrar'
      const fixed = applyFix(source, onlyFix(source, 'unclosed-tag'))
      expect(diagnose(fixed).map(d => d.code)).not.toContain('unclosed-tag')
    })
  })

  describe('deprecated-tag', () => {
    it('renombra apertura Y cierre, no solo la apertura', () => {
      const source = '[strike]x[/strike]'
      // Media corrección deja un `[/strike]` huérfano que osu! pinta como
      // texto literal: peor que la deprecación que venía a arreglar.
      expect(applyFix(source, onlyFix(source, 'deprecated-tag'))).toBe('[s]x[/s]')
    })

    it('renombra [center] a [centre]', () => {
      const source = '[center]x[/center]'
      expect(applyFix(source, onlyFix(source, 'deprecated-tag'))).toBe('[centre]x[/centre]')
    })

    it('no cambia el render', () => {
      const source = '[strike]x[/strike]'
      const fixed = applyFix(source, onlyFix(source, 'deprecated-tag'))
      expect(renderNormalized(fixed)).toBe(renderNormalized(source))
    })

    it('renombra solo la apertura cuando el autor no cerró', () => {
      const source = '[strike]sin cerrar'
      const fix = onlyFix(source, 'deprecated-tag')
      expect(fix.operations).toHaveLength(1)
      expect(applyFix(source, fix)).toBe('[s]sin cerrar')
    })
  })

  describe('empty-tag', () => {
    it('borra la etiqueta entera', () => {
      const source = 'antes [i][/i] fin'
      expect(applyFix(source, onlyFix(source, 'empty-tag'))).toBe('antes  fin')
    })

    it('deja el documento sin ese hallazgo', () => {
      const source = 'antes [i][/i] fin'
      const fixed = applyFix(source, onlyFix(source, 'empty-tag'))
      expect(diagnose(fixed).map(d => d.code)).not.toContain('empty-tag')
    })
  })

  describe('lo que NO se corrige solo', () => {
    it('nested-tags-in-code no trae corrección automática', () => {
      // Quitar las etiquetas cambiaría la intención del autor, que puede
      // quererlas literales; y dejarlas es exactamente lo que osu! hace.
      const found = diagnose('[code][b]x[/b][/code]').find(d => d.code === 'nested-tags-in-code')
      if (found) expect(found.fixes).toBeUndefined()
    })
  })
})
