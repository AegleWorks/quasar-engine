import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { CanvasDocument, OwnedCanvasHost, spanOf, changeBetween, type CanvasHost } from '../Reconciler/CanvasDocument'
import type { TextChange } from '../Incremental/ChangeTracker'
import { REFERENCE_DOCUMENT } from './referenceDocument'

/**
 * The incremental canvas (`Reconciler/CanvasDocument.ts`): a view of a
 * document it does not own. Every edit goes to the host and comes back as a
 * windowed patch, and the canvas stays exactly the render of the host's tree —
 * checked byte for byte after every step.
 */

type Dialect = 'miliastry' | 'osu'

const model = (dialect: Dialect) => (s: string) => new BBCodeDocumentModel({ source: s, dialect, autoAnalyze: false })

function view(host: CanvasHost, dialect: Dialect) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const renderer = new HTMLRenderer({ dialect })
  const doc = new CanvasDocument(container, { host, renderer, exporter: new BBCodeExporter(undefined, dialect) })
  doc.show()
  // Both sides as the DOM spells them (`hidden` → `hidden=""`).
  const probe = document.createElement('div')
  const matchesRender = () => {
    probe.innerHTML = renderer.render(doc.root!)
    return container.innerHTML === probe.innerHTML
  }
  return { container, doc, renderer, matchesRender }
}

function canvas(source: string, dialect: Dialect) {
  const host = new OwnedCanvasHost(model(dialect))
  host.load(source)
  return { host, ...view(host, dialect) }
}

function apply(source: string, changes: readonly TextChange[]): string {
  let out = source
  for (const c of [...changes].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end)
  return out
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('spanOf and changeBetween', () => {
  it('many changes are the one change that spans them', () => {
    const source = 'Hola mundo cruel'
    const changes = [{ start: 5, end: 5, text: '[b]' }, { start: 10, end: 10, text: '[/b]' }]
    const span = spanOf(source, changes)!
    expect(apply(source, [span])).toBe(apply(source, changes))
    expect(span).toEqual({ start: 5, end: 10, text: '[b]mundo[/b]' })
  })

  it('two texts differ by one change, their common ends kept', () => {
    expect(changeBetween('Hola mundo', 'Hola gran mundo')).toEqual({ start: 5, end: 5, text: 'gran ' })
    expect(changeBetween('igual', 'igual')).toBeNull()
  })
})

describe.each(['miliastry', 'osu'] as Dialect[])('CanvasDocument (%s)', (dialect) => {
  it('after every edit the canvas is exactly the render of its tree', () => {
    const { doc, matchesRender } = canvas(REFERENCE_DOCUMENT, dialect)
    expect(matchesRender()).toBe(true)
    const rand = mulberry32(3)
    const TOKENS = ['x', ' ', '\n', '\n\n', '[b]', '[/b]', '[box=Nuevo]\nhola\n[/box]', '[*]', 'texto ']
    let source = REFERENCE_DOCUMENT
    for (let i = 0; i < 120; i++) {
      const start = Math.floor(rand() * (source.length + 1))
      const end = Math.min(source.length, start + (rand() < 0.5 ? 0 : Math.floor(rand() * 40)))
      const change = { start, end, text: TOKENS[Math.floor(rand() * TOKENS.length)] }
      source = apply(source, [change])
      doc.edit([change])
      expect(doc.source).toBe(source)
      expect(matchesRender(), `step ${i}`).toBe(true)
    }
  })

  it('an edit made elsewhere is synced the same way', () => {
    const { host, doc, matchesRender } = canvas(REFERENCE_DOCUMENT, dialect)
    const edited = REFERENCE_DOCUMENT.replace('sigo fallando', 'ya no fallo')
    host.sync(edited)
    doc.show()
    expect(doc.source).toBe(edited)
    expect(matchesRender()).toBe(true)
  })

  it('a keystroke reconciles only the block it touched, and the canvas matches again after applying it', () => {
    const { container, doc, matchesRender } = canvas(REFERENCE_DOCUMENT, dialect)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let target: Text | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue!.includes('Skins minimalistas')) target = n as Text
    target!.nodeValue = target!.nodeValue!.replace('Skins', 'SkinsX')
    const r = doc.reconcile()
    expect(doc.lastDirtyBlocks).toBe(1)
    expect(r.route).toBe('surgical')
    expect(r.resultingSource).toBe(REFERENCE_DOCUMENT.replace('Skins minimalistas', 'SkinsX minimalistas'))
    doc.edit(r.edits)
    expect(matchesRender()).toBe(true)
    // Its own patch is not the user's: nothing left to reconcile.
    expect(doc.reconcile().route).toBe('unchanged')
  })

  it('a block removed from the canvas takes the full path, and is deleted', () => {
    const source = 'uno\n\n[notice]aviso[/notice]\n\ndos'
    const { container, doc } = canvas(source, dialect)
    const notice = container.querySelector('.notice, .well')!
    notice.remove()
    const r = doc.reconcile()
    expect(doc.lastDirtyBlocks).toBeNull()
    expect(r.resultingSource).not.toContain('aviso')
  })
})

describe('CanvasDocument keeps view state', () => {
  it('opening a box is not an edit: the next keystroke does not compare it', () => {
    const { container, doc } = canvas('[box=T]\nuno\n[/box]\n\nfin', 'miliastry')
    container.querySelector('details')!.open = true
    expect(doc.reconcile().route).toBe('unchanged')
    expect(doc.lastDirtyBlocks).toBe(0)
  })

  it('an open box stays open when an edit re-renders it', () => {
    const { container, doc } = canvas('[box=T]\nuno\n[/box]\n\nfin', 'miliastry')
    const details = container.querySelector('details')!
    details.open = true
    doc.edit([{ start: 8, end: 8, text: 'X' }])
    expect(container.querySelector('details')!.open).toBe(true)
    expect(doc.source).toBe('[box=T]\nXuno\n[/box]\n\nfin')
  })
})

describe('one document, many views', () => {
  it('an edit made on one canvas is what the other shows — no copy of the text in between', () => {
    const host = new OwnedCanvasHost(model('miliastry'))
    host.load(REFERENCE_DOCUMENT)
    const a = view(host, 'miliastry')
    const b = view(host, 'miliastry')
    a.doc.edit([{ start: 0, end: 0, text: '[b]Hola[/b] ' }])
    // B reads the same snapshot: the same text AND the same tree.
    expect(b.doc.show()).not.toBeNull()
    expect(b.doc.root).toBe(a.doc.root)
    expect(b.doc.source).toBe(host.current().source)
    expect(b.matchesRender()).toBe(true)
    // Nothing new: nothing to paint.
    expect(b.doc.show()).toBeNull()
  })

  it('a view that missed several versions catches up in one show', () => {
    const { host, doc, matchesRender } = canvas(REFERENCE_DOCUMENT, 'osu')
    const rand = mulberry32(11)
    let source = REFERENCE_DOCUMENT
    for (let i = 0; i < 25; i++) {
      const start = Math.floor(rand() * source.length)
      const change = { start, end: Math.min(source.length, start + 3), text: ['[i]x[/i]', '\n\n', 'ab'][i % 3] }
      source = apply(source, [change])
      host.apply([change])
    }
    doc.show()
    expect(doc.source).toBe(source)
    expect(matchesRender()).toBe(true)
  })

  it('the same text parsed again (another tree) is compared block by block', () => {
    const source = 'uno\n\n[notice]aviso[/notice]\n\ndos'
    const { host, doc, matchesRender } = canvas(source, 'miliastry')
    host.load(source)
    expect(doc.show()).not.toBeNull()
    expect(matchesRender()).toBe(true)
  })

  it('a document that refuses the edit takes the keystroke back out of the canvas', () => {
    const inner = new OwnedCanvasHost(model('miliastry'))
    inner.load('Hola mundo')
    const readOnly: CanvasHost = { current: () => inner.current(), apply: () => {} }
    const { container, doc, matchesRender } = view(readOnly, 'miliastry')
    const text = container.querySelector('p')?.firstChild ?? container.firstChild!.firstChild!
    ;(text as Text).nodeValue = 'Hola mundoX'
    const r = doc.reconcile()
    expect(r.edits.length).toBeGreaterThan(0)
    doc.edit(r.edits)
    expect(doc.source).toBe('Hola mundo')
    expect(container.textContent).not.toContain('mundoX')
    expect(matchesRender()).toBe(true)
  })
})
