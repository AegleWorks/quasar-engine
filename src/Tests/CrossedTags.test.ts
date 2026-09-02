import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic, DiagnosticFix } from '../Types/diagnostics'

/**
 * Etiquetas cruzadas: los cierres están todos, pero en el orden equivocado.
 *
 * El parser ya lo resolvía como osu! — el cierre que llega tarde se guarda como
 * `discarded_tag`, que conserva su rango justo para que esto se pueda contestar
 * después — pero el checker no lo miraba. `isUnclosedTag` solo pregunta si el
 * texto inmediatamente posterior al nodo dice `[/name]`, así que anunciaba dos
 * etiquetas SIN CERRAR mientras sus `[/tag]` estaban a la vista unas líneas más
 * abajo, y ofrecía insertar un cierre duplicado como corrección automática.
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

/** El caso que trajo el usuario, reducido a lo que importa. */
const CROSSED_POST = '[centre][notice][size=150]hola[/size]\n[box=t]\ncontenido\n[/centre]\n[/box]\n[/notice]'

describe('etiquetas cruzadas', () => {
  describe('detección', () => {
    it('reconoce el cruce inline más simple', () => {
      expect(codesOf('[b][i]x[/b][/i]')).toContain('crossed-tags')
    })

    it('NO lo llama «sin cerrar»: el cierre existe, solo llega tarde', () => {
      expect(codesOf('[b][i]x[/b][/i]')).not.toContain('unclosed-tag')
    })

    it('señala la apertura que quedó cerrada antes de tiempo', () => {
      const d = only('[b][i]x[/b][/i]', 'crossed-tags')
      // `[i]` abre en 3 y el parser lo cerró en 7, donde empieza `[/b]`.
      expect(d.range).toEqual({ start: 3, end: 7 })
    })

    it('apunta al cierre ignorado como información relacionada', () => {
      const d = only('[b][i]x[/b][/i]', 'crossed-tags')
      expect(d.related?.[0].range).toEqual({ start: 11, end: 15 })
    })

    it('reporta un cruce por cada etiqueta que el cierre se llevó por delante', () => {
      const crossed = diagnose(CROSSED_POST).filter(d => d.code === 'crossed-tags')
      expect(crossed.map(d => d.nodeKind).sort()).toEqual(['box', 'notice'])
    })

    it('deja de emitir los «sin cerrar» falsos del post cruzado', () => {
      expect(codesOf(CROSSED_POST)).not.toContain('unclosed-tag')
    })
  })

  describe('lo que NO es un cruce', () => {
    it('una etiqueta sin cerrar de verdad sigue siendo unclosed-tag', () => {
      const codes = codesOf('[b]sin cerrar')
      expect(codes).toContain('unclosed-tag')
      expect(codes).not.toContain('crossed-tags')
    })

    it('un cierre sin ninguna apertura no cruza nada', () => {
      // El parser lo conserva como texto literal, no como `discarded_tag`.
      expect(codesOf('hola[/b]')).not.toContain('crossed-tags')
    })

    it('un documento bien anidado no produce ninguno', () => {
      expect(codesOf('[b][i]x[/i][/b]')).not.toContain('crossed-tags')
    })

    it('un cierre tardío no reclama una apertura que seguía abierta', () => {
      // `[/i]` cierra por su cuenta; nada quedó descolocado antes de él.
      expect(codesOf('[i]x[/i][b]y[/b]')).not.toContain('crossed-tags')
    })
  })

  describe('corrección', () => {
    it('mueve el cierre a donde el parser ya cerraba', () => {
      const d = only('[b][i]x[/b][/i]', 'crossed-tags')
      expect(applyFix('[b][i]x[/b][/i]', d.fixes![0])).toBe('[b][i]x[/i][/b]')
    })

    it('deja el documento sin ese hallazgo', () => {
      const d = only('[b][i]x[/b][/i]', 'crossed-tags')
      const fixed = applyFix('[b][i]x[/b][/i]', d.fixes![0])
      expect(codesOf(fixed)).not.toContain('crossed-tags')
      expect(codesOf(fixed)).not.toContain('unclosed-tag')
    })

    it('NO es automática: mover el cierre puede mover un salto de línea', () => {
      // El resto de correcciones del analizador son seguras porque solo
      // escriben la decisión que el parser ya había tomado. Esta cambia lo que
      // se ve: el espacio en blanco que rodeaba al cierre descartado se queda
      // donde estaba, y acaba dentro del contenedor o convertido en línea en
      // blanco. Por eso queda fuera de «Corregir todo».
      const d = only('[b][i]x[/b][/i]', 'crossed-tags')
      expect(d.fixes![0].isAutomatic).toBe(false)
    })

    it('nunca ofrece insertar un cierre duplicado', () => {
      // La regresión concreta: los dos `unclosed-tag` insertaban `[/box]` y
      // `[/notice]` en el mismo offset y dejaban intactos los originales, que
      // se quedaban huérfanos y el parser pintaba como TEXTO LITERAL.
      const fixed = diagnose(CROSSED_POST)
        .filter(d => d.fixes?.some(f => f.isAutomatic))
      expect(fixed).toEqual([])
    })
  })
})
