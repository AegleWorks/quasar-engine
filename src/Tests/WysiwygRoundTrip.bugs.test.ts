import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { HTMLDocumentModel } from '../HTML/HTMLDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { reconcileVisualDOMToBBCode, computeTextDelta } from '../Reconciler/SurgicalReconciler'

/**
 * Known-broken round trips between the WYSIWYG canvas and the BBCode source.
 *
 * Every case here uses `it.fails`: it asserts the behaviour we want, and passes
 * only because the assertion currently throws. When a fix lands, the case turns
 * red — that is the signal to drop `.fails` and keep the assertion.
 *
 * The two layers under test:
 *
 *  1. `reconcileVisualDOMToBBCode` matches DOM elements to AST nodes by
 *     `data-node-id`. When a single id fails to match it abandons the surgical
 *     path and re-serialises the whole document through HTML -> BBCode.
 *  2. That HTML -> BBCode path (`HTMLToGreenNode` + `BBCodeExporter`) is lossy.
 *
 * In production the ids never match — see `renders through a second model`
 * below — so layer 2 runs on every keystroke.
 */

/** source -> HTML -> source, the exact path the fallback takes. */
function roundTrip(source: string): string {
  const doc = new BBCodeDocumentModel({ source })
  const html = new HTMLRenderer().render(doc.redRoot!).replace(/​/g, '').trim()
  const back = HTMLDocumentModel.fromHTML(html)
  return back.redRoot ? new BBCodeExporter().export(back.redRoot) : ''
}

/**
 * Mirrors what `QuasarWYSIWYG` does now: the canvas is painted from the tree the
 * engine returns for that exact source, and every reconcile runs against the
 * (source, AST) pair the DOM was painted from — not against the newest source.
 * The resulting source is then turned into edits for Monaco with
 * `computeTextDelta`.
 *
 * Painting and reconciling from the same tree is the whole point: `data-node-id`
 * comes from a global counter, so a tree parsed by anyone else carries ids the
 * reconciler will never find.
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
    /** One keystroke: mutate the DOM, reconcile, push the delta into the document. */
    type(mutate: (c: HTMLElement) => void) {
      mutate(container)
      const result = reconcileVisualDOMToBBCode(baseSource, baseAST, container)
      const edits = computeTextDelta(current, result.resultingSource)
      if (edits.length === 0) return
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        current = current.slice(0, edit.start) + edit.text + current.slice(edit.end)
      }
      model.applyTextUpdate(current)
      // The canvas is NOT repainted: the baseline stays where it was.
    },
    /** An external change (Monaco) repaints the canvas and moves the baseline. */
    repaint() {
      baseSource = current
      baseAST = model.redRoot!
      container.innerHTML = renderer.render(baseAST)
    },
  }
}

describe('WYSIWYG -> BBCode: the canvas keeps the document intact', () => {
  it('reconciles against the very tree the canvas was painted from', () => {
    const model = new BBCodeDocumentModel({ source: 'Parrafo 1\n\nParrafo 2' })
    const container = document.createElement('div')
    container.innerHTML = new HTMLRenderer().render(model.redRoot!)

    const astIds: string[] = []
    model.redRoot!.walk(n => { astIds.push(String(n.id)) })
    const domIds = Array.from(container.querySelectorAll('[data-node-id]'))
      .map(el => el.getAttribute('data-node-id')!)

    expect(domIds.length).toBeGreaterThan(0)
    expect(domIds.filter(id => !astIds.includes(id))).toEqual([])
  })

  it('fills the empty line in place, gluing nothing and inventing nothing', () => {
    const canvas = makeCanvas('[centre][color=#f472b6]━━━ ✦ ━━━[/color][/centre]\n\n[box=Contenido]\ntexto\n[/box]')
    canvas.type(c => { (c.querySelector('.bb-empty-line') as HTMLElement).textContent = 'Miliastry' })

    // The line that was blank now holds the word. Line count does not change.
    expect(canvas.source).toBe(
      '[centre][color=#f472b6]━━━ ✦ ━━━[/color][/centre]\nMiliastry\n[box=Contenido]\ntexto\n[/box]'
    )
  })

  it('does not re-insert the text on every keystroke while the canvas is stale', () => {
    const canvas = makeCanvas('Parrafo 1\n\nParrafo 2')
    const emptyLine = canvas.container.querySelector('.bb-empty-line') as HTMLElement

    for (const typed of ['M', 'Mi', 'Mil', 'Mili']) {
      canvas.type(() => { emptyLine.textContent = typed })
    }

    expect(canvas.source).toBe('Parrafo 1\nMili\nParrafo 2')
  })

  it('survives a repaint between keystrokes', () => {
    const canvas = makeCanvas('uno\n\ndos')
    canvas.type(c => { (c.querySelector('.bb-empty-line') as HTMLElement).textContent = 'ab' })
    canvas.repaint()
    canvas.type(c => {
      const el = Array.from(c.querySelectorAll('.bb-paragraph')).find(e => e.textContent === 'ab')!
      el.textContent = 'abc'
    })

    expect(canvas.source).toBe('uno\nabc\ndos')
  })

  it('leaves an untouched document alone', () => {
    const canvas = makeCanvas('[notice]hola[/notice]\n\n[box=t]x[/box]')
    canvas.type(() => {})
    expect(canvas.source).toBe('[notice]hola[/notice]\n\n[box=t]x[/box]')
  })
})

describe('WYSIWYG -> BBCode: what the fallback destroys', () => {
  it('keeps the image URL', () => {
    expect(roundTrip('[img]https://y.png[/img]')).toBe('[img]https://y.png[/img]')
  })

  it('keeps the image size attribute', () => {
    expect(roundTrip('[img=200x100]https://y.png[/img]')).toBe('[img=200x100]https://y.png[/img]')
  })

  it('keeps the youtube tag', () => {
    expect(roundTrip('[youtube]dQw4w9WgXcQ[/youtube]')).toBe('[youtube]dQw4w9WgXcQ[/youtube]')
  })

  it('keeps the audio source', () => {
    expect(roundTrip('[audio]https://a.mp3[/audio]')).toBe('[audio]https://a.mp3[/audio]')
  })

  it('keeps the email address', () => {
    expect(roundTrip('[email]a@b.com[/email]')).toBe('[email]a@b.com[/email]')
  })

  it('keeps the profile tag instead of desugaring it to a raw link', () => {
    expect(roundTrip('[profile]peppy[/profile]')).toBe('[profile]peppy[/profile]')
  })

  it('keeps the newlines of a code block', () => {
    const code = '[code]\nconst a = 1\nconst b = 2\n[/code]'
    expect(roundTrip(code)).toBe(code)
  })

  it('keeps the quotes around a multi-word quote author', () => {
    expect(roundTrip('[quote="Peppy the Dev"]hola[/quote]')).toBe('[quote="Peppy the Dev"]hola[/quote]')
  })

  it('does not invent a title for an untitled box', () => {
    expect(roundTrip('[box]sin titulo[/box]')).toBe('[box]sin titulo[/box]')
  })

  it('does not invent a title for a spoilerbox', () => {
    expect(roundTrip('[spoilerbox]secreto[/spoilerbox]')).toBe('[spoilerbox]secreto[/spoilerbox]')
  })

  it('does not pin a level onto a bare heading', () => {
    expect(roundTrip('[heading]Titulo[/heading]')).toBe('[heading]Titulo[/heading]')
  })

  it('keeps the space between two adjacent inline tags', () => {
    expect(roundTrip('[s]tachado[/s] [spoiler]oculto[/spoiler]')).toBe('[s]tachado[/s] [spoiler]oculto[/spoiler]')
  })

  it('keeps the hex exactly as the author spelled it', () => {
    // Reading the colour back through CSSOM re-spelled it in lowercase, so any
    // block that got re-serialised had every hex in it rewritten.
    expect(roundTrip('[color=#FF00AA]x[/color]')).toBe('[color=#FF00AA]x[/color]')
  })

  it('turns a filled empty line into a paragraph on that same line', () => {
    // Even the coarse path must not add or drop lines: the blank line becomes
    // the paragraph, and the lines around it are left exactly as written.
    const doc = new BBCodeDocumentModel({ source: 'hola\n\n[notice]x[/notice]' })
    const container = document.createElement('div')
    container.innerHTML = new HTMLRenderer().render(doc.redRoot!)
    ;(container.querySelector('.bb-empty-line') as HTMLElement).textContent = 'medio'

    const back = HTMLDocumentModel.fromHTML(container.innerHTML.replace(/\u200B/g, '').trim())
    const out = new BBCodeExporter().export(back.redRoot!)
    expect(out).toBe('hola\nmedio\n[notice]x[/notice]')
  })

  it('keeps an empty [img][/img] instead of writing the renderer notice into it', () => {
    // A media tag with no URL renders as a placeholder saying so. Read back as
    // content, that sentence replaced the tag: `docs/ai/hxovc.bbcode` has seven
    // of them, and each edit inside their box turned another one into prose.
    expect(roundTrip('[img][/img]')).toBe('[img][/img]')
    expect(roundTrip('[box=T][img][/img]\ntexto\n[/box]')).toBe('[box=T][img][/img]\ntexto\n[/box]')
    expect(roundTrip('[img][/img]')).not.toContain('missing source URL')
  })

  it('keeps the id of a profile written with one', () => {
    expect(roundTrip('[profile=5458323]ElMick33[/profile]')).toBe('[profile=5458323]ElMick33[/profile]')
  })

  it('never leaks a renderer error message into the source', () => {
    // Once the URL is gone the renderer emits `[img] missing source URL`, and the
    // next round trip reads that placeholder back as document content.
    const once = roundTrip('[box=G]\n[img]https://i.imgur.com/abc.png[/img]\n[/box]')
    expect(roundTrip(once)).not.toContain('missing source URL')
  })
})
