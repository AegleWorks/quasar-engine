import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic, DiagnosticFix } from '../Types/diagnostics'

/**
 * Cierres que no cierran nada.
 *
 * El parser conserva un `[/tag]` sin apertura como texto literal para que
 * ningún carácter de la fuente pertenezca a nadie — lo que significa que se
 * IMPRIME, y hasta ahora nada lo decía: el checker daba el documento por limpio
 * mientras la vista previa sacaba `[/notice][/centre]` como cuerpo del post.
 * Apareció abriendo el editor, no en un test ni en el barrido del corpus.
 *
 * osu! y Quasar discrepan aquí de verdad: osu! descarta la etiqueta, Quasar la
 * pinta, y `OsuNestingFidelity` lo fija — borrar los huérfanos es justo lo que
 * hace que el texto visible coincida con el oráculo verificado a mano.
 *
 * En 53 userpages reales solo aparecen en los rotos a propósito: 12 repartidos
 * entre los tres NyuPenyu, 0 en los otros cincuenta.
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

describe('cierres huérfanos', () => {
  describe('detección', () => {
    it('avisa de un cierre sin apertura', () => {
      expect(codesOf('hola[/b]')).toContain('orphan-closing-tag')
    })

    it('dice que osu! lo descarta y que la vista previa no', () => {
      // Sin las dos mitades el autor no sabe si le miente el preview o su post.
      const message = only('hola[/b]', 'orphan-closing-tag').message
      expect(message).toContain('osu!')
      expect(message).toContain('text')
    })

    it('marca el rango exacto de la etiqueta', () => {
      expect(only('hola[/b]', 'orphan-closing-tag').range).toEqual({ start: 4, end: 8 })
    })

    it('reporta uno por cada cierre sobrante', () => {
      // El caso que apareció en el editor: el auto-cierre del editor dejó dos
      // cierres de más después de reparar un cruce.
      const source = '[centre][notice]h[/notice][/centre][/notice][/centre]'
      expect(codesOf(source).filter(c => c === 'orphan-closing-tag')).toHaveLength(2)
    })

    it('también cuando el nombre es desconocido', () => {
      expect(codesOf('[/bold] antes [bold]')).toContain('orphan-closing-tag')
    })
  })

  describe('lo que NO es un huérfano', () => {
    it('un documento bien anidado no produce ninguno', () => {
      expect(codesOf('[b]x[/b]')).not.toContain('orphan-closing-tag')
    })

    it('el cierre de una etiqueta desconocida emparejada pertenece a su pareja', () => {
      // `[/bold]` es la evidencia que convierte a `[bold]` en un typo, y
      // `unknown-tag` ya reporta el par: contarlo dos veces sería ruido.
      const codes = codesOf('[bold]x[/bold]')
      expect(codes).toContain('unknown-tag')
      expect(codes).not.toContain('orphan-closing-tag')
    })

    it('no toca lo que hay dentro de [code]', () => {
      const codes = codesOf('[code]hola[/b][/code]')
      expect(codes).not.toContain('orphan-closing-tag')
      expect(codes).toContain('nested-tags-in-code')
    })

    it('un cierre tardío es un cruce, no un huérfano', () => {
      // Ese lo conserva el parser como `discarded_tag`, no como texto.
      const codes = codesOf('[b][i]x[/b][/i]')
      expect(codes).toContain('crossed-tags')
      expect(codes).not.toContain('orphan-closing-tag')
    })
  })

  describe('corrección', () => {
    it('borra la etiqueta y solo la etiqueta', () => {
      const d = only('hola[/b] mundo', 'orphan-closing-tag')
      expect(applyFix('hola[/b] mundo', d.fixes![0])).toBe('hola mundo')
    })

    it('deja el documento sin ese hallazgo', () => {
      const d = only('hola[/b]', 'orphan-closing-tag')
      expect(codesOf(applyFix('hola[/b]', d.fixes![0]))).not.toContain('orphan-closing-tag')
    })

    it('NO es automática: quita algo que la vista previa está mostrando', () => {
      expect(only('hola[/b]', 'orphan-closing-tag').fixes![0].isAutomatic).toBe(false)
    })
  })
})
