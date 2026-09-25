import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { OsuPreviewTree } from '../Osu/OsuPreviewTree'
import { AnchorSet, type TextEdit } from '../Anchors/AnchorSet'
import { anchorForNode, resolveNode } from '../Anchors/bind'
import type { RedNode } from '../Syntax/RedNode'

const BOXES = new Set(['box', 'spoilerbox'])

const parse = (source: string) =>
  new BBCodeDocumentModel({ source, dialect: 'osu', incremental: false, autoAnalyze: false }).redRoot!
const osuParse = (source: string) => new OsuPreviewTree({ dialect: 'osu' }).update(source)

function boxes(root: RedNode): RedNode[] {
  const out: RedNode[] = []
  const walk = (n: RedNode): void => {
    if (BOXES.has(n.kind)) out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

const where = (n: RedNode | null) => (n ? `${n.kind}@${n.range.start}-${n.range.end}` : null)

describe('anchors ⇄ nodes', () => {
  const SOURCE = 'intro\n[box=Uno]a\n[box=Dos]b[/box]\n[/box]\n[spoilerbox]c[/spoilerbox]\nfin'

  it('finds the same box in the default tree, the osu! tree and a fresh parse', () => {
    const set = new AnchorSet(SOURCE)
    const inner = boxes(parse(SOURCE)).find((b) => b.metadata?.title === 'Dos' || b.text.includes('Dos'))!
    const a = anchorForNode(set, inner)
    expect(set.textOf(a)).toBe('[box=Dos]')
    expect(where(resolveNode(parse(SOURCE), a, BOXES))).toBe(where(inner))
    expect(resolveNode(osuParse(SOURCE), a, BOXES)?.range.start).toBe(inner.range.start)
  })

  it('follows the box through edits in its body, around it, and in its title', () => {
    const set = new AnchorSet(SOURCE)
    const a = anchorForNode(set, boxes(parse(SOURCE))[1])
    const edit = (e: TextEdit) => set.applyChange(e)
    edit({ start: 0, end: 0, text: 'más texto antes\n' })
    const bodyAt = set.get(a.id)!.end
    edit({ start: bodyAt, end: bodyAt, text: 'cuerpo nuevo ' })
    edit({ start: set.get(a.id)!.start + 5, end: set.get(a.id)!.start + 8, text: 'Segundo' })
    const now = set.get(a.id)!
    expect(set.textOf(now)).toBe('[box=Segundo]')
    const found = resolveNode(parse(set.text), now, BOXES)
    expect(found?.kind).toBe('box')
    expect(set.text.slice(found!.range.start).startsWith('[box=Segundo]cuerpo nuevo b')).toBe(true)
  })

  it('resolves to nothing once the opener is deleted or stops opening a box', () => {
    const set = new AnchorSet(SOURCE)
    const a = anchorForNode(set, boxes(parse(SOURCE))[1])
    const at = set.get(a.id)!.start
    set.applyChange({ start: at, end: at + 1, text: '' }) // "box=Dos]" is text now
    expect(resolveNode(parse(set.text), set.get(a.id)!, BOXES)).toBeNull()
    set.applyChange({ start: at - 1, end: at + 12, text: '' })
    expect(set.get(a.id)!.deleted).toBe(true)
    expect(resolveNode(parse(set.text), set.get(a.id)!, BOXES)).toBeNull()
  })
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BLOCK = '[box=Titulo]\ntexto [b]negrita[/b]\n[notice]aviso[/notice]\n[spoilerbox]oculto[/spoilerbox]\n[/box]\n\n'
  + '[centre]centro[/centre]\n[list]\n[*]uno\n[/list]\n\n'
const TOKENS = ['x', ' ', '\n', '\n\n', '[b]', '[/b]', '[box=T]', '[/box]', '[notice]', '[/notice]', '[spoilerbox]',
  '[/spoilerbox]', '[centre]', '[/centre]', '[*]']

describe('anchors ⇄ nodes — through incremental edits, in both trees', () => {
  it('each anchor resolves in the patched trees exactly as in a fresh parse', () => {
    const base = Array.from({ length: 25 }, (_, i) => `${BLOCK}${i}\n`).join('')
    const model = new BBCodeDocumentModel({ source: base, dialect: 'osu', autoAnalyze: false })
    const osuTree = new OsuPreviewTree({ dialect: 'osu' })
    osuTree.update(base)
    const set = new AnchorSet(base)
    const openers = boxes(model.redRoot!).map((b) => anchorForNode(set, b))
    const rand = mulberry32(7)
    let incremental = 0
    let resolved = 0
    let steps = 0
    while (steps < 200) {
      const at = Math.floor(rand() * (base.length + 1))
      const end = Math.min(base.length, at + (rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 8)))
      // Only edits that leave every opener alone: the property is about the
      // box moving and its tree being patched, not about editing the anchor.
      if (openers.some((a) => end >= a.start && at <= a.end)) continue
      steps++
      const edit = { start: at, end, text: TOKENS[Math.floor(rand() * TOKENS.length)] }
      const edited = base.slice(0, at) + edit.text + base.slice(end)
      set.applyChange(edit)
      model.applyTextUpdate(edited)
      if (model.lastReparsePath === 'incremental') incremental++
      osuTree.update(edited)
      const fresh = parse(edited)
      const freshOsu = osuParse(edited)
      for (const a0 of openers) {
        const a = set.get(a0.id)!
        const got = resolveNode(model.redRoot!, a, BOXES)
        expect(where(got), `step ${steps}`).toBe(where(resolveNode(fresh, a, BOXES)))
        expect(where(resolveNode(osuTree.root!, a, BOXES)), `step ${steps} (osu!)`).toBe(where(resolveNode(freshOsu, a, BOXES)))
        if (got) resolved++
      }
      // Undo, through the same paths.
      set.applyChange({ start: at, end: at + edit.text.length, text: base.slice(at, end) })
      model.applyTextUpdate(base)
      osuTree.update(base)
      for (const a0 of openers) expect(set.get(a0.id)).toMatchObject({ start: a0.start, end: a0.end, deleted: false })
    }
    // Not vacuous: most anchors resolve, and the default tree was really
    // patched often enough. Measured: 46 of 200 edits incremental — nested
    // boxes make many regions impossible to isolate, which the parser then
    // reparses in full by design; the osu! tree reuses unchanged blocks on
    // every update regardless.
    expect(resolved).toBeGreaterThan(200 * openers.length * 0.8)
    expect(incremental).toBeGreaterThan(30)
  })
})
