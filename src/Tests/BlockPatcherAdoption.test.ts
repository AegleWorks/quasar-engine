import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { patchBlocksInto } from '../Visitors/BlockPatcher'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * The incremental parser gives the block under an edit a new id, so the patcher
 * used to treat it as brand new and replace its element: every keystroke typed
 * inside an open `[box]` closed it in the preview, and paid a full re-parse and
 * relayout of the block. `adoptOrphanRuns` morphs the old element instead.
 *
 * Both reconcile paths are covered: documents under `MIN_WINDOWED_BLOCKS` go
 * through the keyed reconcile, bigger ones through the windowed one.
 */
function typeInsideOpenBox(filler: number) {
  const pad = Array.from({ length: filler }, (_, i) => `line ${i}`).join('\n\n')
  const source = `${pad}\n\n[box=Title]hello world[/box]\n\n${pad}`
  const model = new BBCodeDocumentModel({ source, dialect: 'miliastry', autoAnalyze: false })
  const renderer = new HTMLRenderer({ dialect: 'miliastry' })
  const container = document.createElement('div')
  patchBlocksInto(container, model.redRoot!, { renderer })

  const box = container.querySelector('details') as HTMLDetailsElement
  box.open = true

  let at = source.indexOf('hello') + 5
  for (const ch of 'XYZ') {
    model.applyChange({ start: at, end: at, text: ch })
    patchBlocksInto(container, model.redRoot!, { renderer })
    at++
  }

  const full = document.createElement('div')
  full.innerHTML = renderer.render(model.redRoot!)
  return { box, container, full }
}

const stripIds = (html: string) => html.replace(/ data-node-id="[^"]*"/g, '')

describe('BlockPatcher — the block under the cursor keeps its element', () => {
  it.each([
    ['keyed reconcile (small document)', 10],
    ['windowed reconcile (large document)', 300],
  ])('%s: an open box stays open and matches a full render', (_path, filler) => {
    const { box, container, full } = typeInsideOpenBox(filler)
    const after = container.querySelector('details') as HTMLDetailsElement

    expect(after).toBe(box)
    expect(after.open).toBe(true)
    expect(after.textContent).toContain('helloXYZ world')

    after.removeAttribute('open')
    expect(stripIds(container.innerHTML)).toBe(stripIds(full.innerHTML))
  })
})
