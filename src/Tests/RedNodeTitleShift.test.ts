import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { RedNode } from '../Syntax/RedNode'

/**
 * A displaced box must carry its title nodes with it.
 *
 * The red tree behind a rich heading — `[box=[b]Titulo[/b]]` — is not stored in
 * `children`. `buildTitleNodes` parses the attribute into its own little tree
 * and hangs it off `metadata.titleNodes`, reparenting each root at the box.
 * Anything that walks `children` therefore misses it.
 *
 * That is what `materialize()` used to do. `applyShift` handled both branches;
 * `materialize`, a near copy of the same body, applied the pending delta to
 * `_range` and then recursed over `children` alone — so after a displacing edit
 * the box's own range was right while its title kept pre-edit offsets. The
 * consequence is user-visible rather than internal: `findNodeAtOffset` consults
 * `metadata.titleNodes` BEFORE `children`, so caret, hover and selection inside
 * a box heading resolved to the wrong node, or to none.
 *
 * `setStart` is the entry point under test because it is exactly what adoption
 * calls: `greenToRedNodeReusing` invokes it on every subtree root it carries
 * over from the previous parse, and a titled box is one of those roots. Driving
 * it directly keeps the test on the shift mechanism instead of on the
 * incremental parser's heuristics for when reuse happens at all.
 */
describe('RedNode.materialize — displaced box titles', () => {
  const SOURCE = 'texto previo\n\n[box=[b]Titulo[/b]]contenido[/box]'
  const DELTA = 17

  const titledBox = (root: RedNode): RedNode => {
    let hit: RedNode | null = null
    root.walk((node: RedNode) => {
      if (!hit && (node.metadata as { titleNodes?: RedNode[] })?.titleNodes) hit = node
    })
    if (!hit) throw new Error('fixture no longer produces a box with titleNodes')
    return hit
  }

  const titleNodesOf = (box: RedNode): RedNode[] =>
    ((box.metadata as { titleNodes?: RedNode[] }).titleNodes ?? [])

  /** A model whose titled box has been displaced by `DELTA`, shift still pending. */
  const displaced = () => {
    const model = new BBCodeDocumentModel({ source: SOURCE })
    model.ensureAnalyzed()
    const box = titledBox(model.redRoot!)

    const boxStart = box.range.start
    const titleStarts = titleNodesOf(box).map(node => node.range.start)
    const childStarts = box.children.map(child => child.range.start)

    box.setStart(boxStart + DELTA)
    return { box, boxStart, titleStarts, childStarts }
  }

  it('the fixture really has title nodes outside children', () => {
    const model = new BBCodeDocumentModel({ source: SOURCE })
    model.ensureAnalyzed()
    const box = titledBox(model.redRoot!)
    const titles = titleNodesOf(box)

    expect(titles.length).toBeGreaterThan(0)
    // The premise of the whole bug: they are reachable only through metadata.
    for (const title of titles) {
      expect(box.children).not.toContain(title)
    }
    expect(SOURCE.slice(titles[0].range.start, titles[0].range.end)).toBe('[b]Titulo[/b]')
  })

  it('shifts the title nodes by the same delta as the box', () => {
    const { box, boxStart, titleStarts } = displaced()

    // Reading the range is what forces the pending shift to materialize.
    expect(box.range.start).toBe(boxStart + DELTA)

    const shifted = titleNodesOf(box).map(node => node.range.start)
    expect(shifted).toEqual(titleStarts.map(start => start + DELTA))
  })

  it('shifts the title nodes as it already shifted the children', () => {
    const { box, childStarts } = displaced()
    box.range // force materialization

    // The control: `children` was never the broken branch. Asserting both in
    // one place is what pins the two branches together.
    expect(box.children.map(child => child.range.start))
      .toEqual(childStarts.map(start => start + DELTA))
  })

  it('still resolves an offset inside the displaced title', () => {
    const { box, titleStarts } = displaced()

    // The symptom the bug produced in the editor: an offset landing on the
    // title's own text resolved to the box (or to nothing) instead of to the
    // node under the caret.
    const insideTitle = titleStarts[0] + DELTA + 4 // past `[b]`, on `Titulo`
    const found = box.findNodeAtOffset(insideTitle)

    expect(found).not.toBeNull()
    expect(found).not.toBe(box)
    expect(found!.range.start).toBeGreaterThanOrEqual(titleStarts[0] + DELTA)
    expect(found!.range.end).toBeLessThanOrEqual(titleStarts[0] + DELTA + '[b]Titulo[/b]'.length)
  })
})
