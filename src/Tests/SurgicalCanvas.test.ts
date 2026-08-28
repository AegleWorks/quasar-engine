import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { reconcileVisualDOMToBBCode, computeTextDelta } from '../Reconciler/SurgicalReconciler'

/**
 * What "surgical" has to mean for the visual canvas.
 *
 * Editing in the WYSIWYG must change the bytes the user actually touched and
 * nothing else. Not the casing of a hex the renderer happened to parse, not the
 * indentation inside a box, not the quoting of a `[quote]` author, and above all
 * not the number of lines in the document.
 *
 * The canvas below is the real loop: paint from the tree the engine returns for
 * this source, reconcile against the (source, AST) pair the DOM was painted
 * from, and turn the result into edits for Monaco.
 */
function makeCanvas(source: string) {
  const model = new BBCodeDocumentModel({ source })
  const renderer = new HTMLRenderer()
  const container = document.createElement('div')

  let current = source
  let baseSource = source
  let baseAST = model.redRoot!
  container.innerHTML = renderer.render(baseAST)

  return {
    container,
    get source() { return current },
    /** One keystroke. The canvas is NOT repainted, exactly as in the component. */
    type(mutate: (c: HTMLElement) => void) {
      mutate(container)
      return this.flush()
    },
    /**
     * One reconcile pass, with no DOM change of its own.
     *
     * The component runs this from `onInput`, and a paste runs it twice in the
     * same tick — once by hand, once from the `input` event `execCommand`
     * fires. The delta is taken against what was last handed to the editor,
     * not against the `value` prop, which React has not re-sent yet.
     */
    flush() {
      const result = reconcileVisualDOMToBBCode(baseSource, baseAST, container)
      const edits = computeTextDelta(current, result.resultingSource)
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        current = current.slice(0, edit.start) + edit.text + current.slice(edit.end)
      }
      if (edits.length > 0) model.applyTextUpdate(current)
      return edits
    },
    /** An external change (Monaco) repaints the canvas and moves the baseline. */
    monaco(next: string) {
      current = next
      model.applyTextUpdate(next)
      this.repaint()
    },
    repaint() {
      baseSource = current
      baseAST = model.redRoot!
      container.innerHTML = renderer.render(baseAST)
    },
  }
}

const fillEmptyLine = (text: string, withBogusBr = false) => (c: HTMLElement) => {
  const el = c.querySelector('.bb-empty-line') as HTMLElement
  if (withBogusBr) {
    el.innerHTML = ''
    el.appendChild(document.createTextNode(text))
    el.appendChild(document.createElement('br'))
  } else {
    el.textContent = text
  }
}

const SEPARATOR = '[centre][color=#F472B6]━━━ ✦ ━━━[/color][/centre]\n\n[notice]Contenido[/notice]'
const FILLED = '[centre][color=#F472B6]━━━ ✦ ━━━[/color][/centre]\nMiliastry\n[notice]Contenido[/notice]'

describe('typing into a blank line', () => {
  it('fills the line, leaving the separator and the block untouched', () => {
    const canvas = makeCanvas(SEPARATOR)
    canvas.type(fillEmptyLine('Miliastry'))
    expect(canvas.source).toBe(FILLED)
  })

  it('reaches the same source one keystroke at a time', () => {
    const canvas = makeCanvas(SEPARATOR)
    const el = canvas.container.querySelector('.bb-empty-line') as HTMLElement
    for (let i = 1; i <= 'Miliastry'.length; i++) {
      canvas.type(() => { el.textContent = 'Miliastry'.slice(0, i) })
    }
    expect(canvas.source).toBe(FILLED)
  })

  it('ignores the placeholder <br> a contenteditable leaves behind', () => {
    const canvas = makeCanvas(SEPARATOR)
    canvas.type(fillEmptyLine('Miliastry', true))
    expect(canvas.source).toBe(FILLED)
  })

  it('fills the second of two consecutive blank lines', () => {
    const canvas = makeCanvas('a\n\n\nb')
    canvas.type(c => { (c.querySelectorAll('.bb-empty-line')[1] as HTMLElement).textContent = 'X' })
    expect(canvas.source).toBe('a\n\nX\nb')
  })

  it('fills two separate blank lines in sequence', () => {
    const canvas = makeCanvas('a\n\nb\n\nc')
    canvas.type(c => { (c.querySelectorAll('.bb-empty-line')[0] as HTMLElement).textContent = 'UNO' })
    canvas.repaint()
    canvas.type(c => { (c.querySelectorAll('.bb-empty-line')[0] as HTMLElement).textContent = 'DOS' })
    expect(canvas.source).toBe('a\nUNO\nb\nDOS\nc')
  })

  it('takes unicode and emoji verbatim', () => {
    const canvas = makeCanvas('[centre]━━━[/centre]\n\n[notice]y[/notice]')
    canvas.type(fillEmptyLine('『✦』 hola 👋🏽'))
    expect(canvas.source).toBe('[centre]━━━[/centre]\n『✦』 hola 👋🏽\n[notice]y[/notice]')
  })

  it('lets the line go blank again', () => {
    const canvas = makeCanvas('a\n\nb')
    canvas.type(fillEmptyLine('X'))
    canvas.repaint()
    canvas.type(c => {
      const el = Array.from(c.querySelectorAll('.bb-paragraph')).find(e => e.textContent === 'X')!
      el.textContent = ''
    })
    expect(canvas.source).toBe('a\n\nb')
  })
})

describe('a paste that reconciles twice in one tick', () => {
  it('does not apply the same insertion a second time', () => {
    const pasted = '[centre][color=#F472B6]hola[/color][/centre]\n\n[notice]mundo[/notice]'

    // An empty canvas: no source, no tree — what the component holds before
    // anything is typed into it.
    const container = document.createElement('div')
    container.innerHTML =
      new HTMLRenderer().render(new BBCodeDocumentModel({ source: pasted }).redRoot!)

    // `handlePaste` drops the rendered BBCode in and reconciles by hand; the
    // browser's own `input` event, fired by `execCommand`, reconciles again in
    // the same tick. The delta has to be taken against what was last handed to
    // the editor — the `value` prop has not come back round yet.
    let editor = ''
    let emitted = ''
    const flush = () => {
      const result = reconcileVisualDOMToBBCode('', null, container)
      const edits = computeTextDelta(emitted, result.resultingSource)
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        editor = editor.slice(0, edit.start) + edit.text + editor.slice(edit.end)
      }
      if (edits.length > 0) emitted = result.resultingSource
      return edits
    }

    expect(flush()).toHaveLength(1)
    const afterFirst = editor
    expect(afterFirst.length).toBeGreaterThan(0)

    expect(flush()).toEqual([])
    expect(editor).toBe(afterFirst)
  })
})

describe('untouched bytes stay untouched', () => {
  const RICH = [
    '[centre][color=#F472B6]━━━ ✦ ━━━[/color][/centre]',
    '',
    '[box=Mi Galeria]',
    '  [img]https://i.imgur.com/ABC.png[/img]',
    '[/box]',
    '',
    '[quote="Peppy the Dev"]cita[/quote]',
    '',
    '[code]',
    'const a = 1',
    '[/code]',
    '',
    '[youtube]dQw4w9WgXcQ[/youtube]',
  ].join('\n')

  it('rewrites one line of a rich document and leaves the rest byte for byte', () => {
    const canvas = makeCanvas(RICH)
    canvas.type(fillEmptyLine('Miliastry'))
    expect(canvas.source).toBe(RICH.replace('[/centre]\n\n', '[/centre]\nMiliastry\n'))
  })

  it('survives twelve keystrokes without corroding the rest', () => {
    const canvas = makeCanvas(RICH)
    const el = canvas.container.querySelector('.bb-empty-line') as HTMLElement
    for (let i = 1; i <= 12; i++) canvas.type(() => { el.textContent = 'x'.repeat(i) })
    expect(canvas.source).toBe(RICH.replace('[/centre]\n\n', `[/centre]\n${'x'.repeat(12)}\n`))
  })

  it('edits text inside a colour without touching the hex the author wrote', () => {
    const canvas = makeCanvas('[centre][color=#F472B6]hola mundo[/color][/centre]\n\n[notice]x[/notice]')
    const edits = canvas.type(c => {
      const el = c.querySelector('[style*="color"]') as HTMLElement
      el.firstChild!.nodeValue = 'hola MUNDO'
    })

    expect(canvas.source).toBe('[centre][color=#F472B6]hola MUNDO[/color][/centre]\n\n[notice]x[/notice]')
    // One edit, five characters wide: the definition of surgical.
    expect(edits).toEqual([{ start: 28, end: 33, text: 'MUNDO' }])
  })

  it('edits text next to an image without dropping its URL', () => {
    const canvas = makeCanvas('[notice]Mira [img]https://Y.png[/img] esto[/notice]')
    canvas.type(c => { (c.querySelector('.notice') as HTMLElement).firstChild!.nodeValue = 'MIRA ' })
    expect(canvas.source).toBe('[notice]MIRA [img]https://Y.png[/img] esto[/notice]')
  })

  it('keeps the box indentation when the title is renamed', () => {
    const canvas = makeCanvas('[box=Titulo]\n  cuerpo\n[/box]\n\n[color=#ABCDEF]intacto[/color]')
    canvas.type(c => { (c.querySelector('.bb-box-heading') as HTMLElement).textContent = 'Otro' })
    expect(canvas.source).toBe('[box=Otro]\n  cuerpo\n[/box]\n\n[color=#ABCDEF]intacto[/color]')
  })

  it('keeps the quoted author when the quote body is edited', () => {
    const canvas = makeCanvas('[quote="Peppy the Dev"]cita[/quote]\n\n[color=#ABCDEF]intacto[/color]')
    canvas.type(c => { (c.querySelector('blockquote') as HTMLElement).lastChild!.nodeValue = 'CITA' })
    expect(canvas.source).toBe('[quote="Peppy the Dev"]CITA[/quote]\n\n[color=#ABCDEF]intacto[/color]')
  })

  it('keeps the padding newlines when a code block is edited', () => {
    const canvas = makeCanvas('[code]\nconst a = 1\n[/code]\n\n[color=#ABCDEF]intacto[/color]')
    canvas.type(c => { (c.querySelector('code') as HTMLElement).textContent = 'const a = 2' })
    expect(canvas.source).toBe('[code]\nconst a = 2\n[/code]\n\n[color=#ABCDEF]intacto[/color]')
  })

  it('writes nothing at all when the user changed nothing', () => {
    const source = '[box=T]\n  sangrado raro\n[/box]\n\n[color=#ABCDEF]x[/color]'
    const canvas = makeCanvas(source)
    expect(canvas.type(() => {})).toEqual([])
    expect(canvas.source).toBe(source)
  })
})

describe('structure changes', () => {
  it('applies a deletion instead of silently dropping it', () => {
    const canvas = makeCanvas('[notice]a[/notice]\n\n[notice]b[/notice]\n\n[color=#ABCDEF]c[/color]')
    canvas.type(c => { c.querySelectorAll('.notice')[1].remove() })
    expect(canvas.source).not.toContain('[notice]b[/notice]')
    expect(canvas.source).toContain('[color=#ABCDEF]c[/color]')
  })

  it('applies bold without disturbing the block after it', () => {
    const canvas = makeCanvas('[notice]hola mundo[/notice]\n\n[color=#ABCDEF]intacto[/color]')
    canvas.type(c => { (c.querySelector('.notice') as HTMLElement).innerHTML = 'hola <strong>mundo</strong>' })
    expect(canvas.source).toBe('[notice]hola [b]mundo[/b][/notice]\n\n[color=#ABCDEF]intacto[/color]')
  })

  it('round trips an edit made in Monaco and then in the canvas', () => {
    const canvas = makeCanvas('[b]uno[/b]\n\n[i]dos[/i]')
    canvas.monaco('[b]uno[/b]\n\n[i]dos[/i]\n\n[u]tres[/u]')
    canvas.type(c => {
      const el = Array.from(c.querySelectorAll('u')).find(e => e.textContent === 'tres')!
      el.textContent = 'TRES'
    })
    expect(canvas.source).toBe('[b]uno[/b]\n\n[i]dos[/i]\n\n[u]TRES[/u]')
  })
})
